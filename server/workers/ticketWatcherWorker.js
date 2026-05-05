'use strict';

// Ticket Watcher — runs as a worker_threads thread inside prevoyant-server.
// Polls watched Jira tickets on a configurable schedule, invokes Claude CLI
// with the configured Jira MCP (same pattern as claudeRunner.js) to build a
// progress digest, then emails it via the existing SMTP stack.
// Persists state to ~/.prevoyant/server/watched-tickets.json.

const { workerData, parentPort } = require('worker_threads');
const { spawn }  = require('child_process');
const crypto     = require('crypto');
const http       = require('http');
const https      = require('https');
const net        = require('net');
const tls        = require('tls');
const fs         = require('fs');
const os         = require('os');
const path       = require('path');

// workerData carries SMTP config so the worker can email without re-reading .env.
// All other config (Jira, project root, etc.) is read from process.env directly —
// worker threads share the parent's process.env.
const {
  smtpHost = '',
  smtpPort = '587',
  smtpUser = '',
  smtpPass = '',
} = workerData || {};

// Resolve SMTP recipient at call time so Settings changes take effect without restart.
function emailTo() { return process.env.PRX_EMAIL_TO || ''; }

// ── Project paths ─────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const MCP_CONFIG   = path.resolve(__dirname, '../../.mcp.json');
const LOG_DIR      = path.join(os.homedir(), '.prevoyant', 'watch', 'logs');

// ── Watch store ───────────────────────────────────────────────────────────────

const STORE_DIR  = path.join(os.homedir(), '.prevoyant', 'server');
const STORE_FILE = path.join(STORE_DIR, 'watched-tickets.json');

const INTERVAL_MS = { '1h': 3600000, '1d': 86400000, '2d': 172800000, '5d': 432000000 };
function intervalMs(iv) { return INTERVAL_MS[iv] || 86400000; }

function loadStore() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) ? raw : {};
  } catch (_) { return {}; }
}

function saveStore(tickets) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(tickets, null, 2), 'utf8');
  } catch (err) { log('error', `Store save failed: ${err.message}`); }
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [ticket-watcher/${level}] ${msg}`);
}

// ── MCP config builder (same as claudeRunner.js) ─────────────────────────────

function buildMcpConfig() {
  const jiraUrl      = process.env.JIRA_URL          || '';
  const jiraUsername = process.env.JIRA_USERNAME      || '';
  const jiraToken    = process.env.JIRA_API_TOKEN     || '';

  if (!jiraUrl || !jiraUsername || !jiraToken) return MCP_CONFIG;

  const tmp = path.join(os.tmpdir(), `prevoyant-watch-mcp-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    mcpServers: {
      jira: {
        command: 'uvx',
        args:    ['mcp-atlassian'],
        env: { JIRA_URL: jiraUrl, JIRA_USERNAME: jiraUsername, JIRA_API_TOKEN: jiraToken },
      },
    },
  }));
  return tmp;
}

// ── Watch prompt ──────────────────────────────────────────────────────────────

function buildWatchPrompt(key) {
  return [
    `You are the Prevoyant ticket watcher. Analyse Jira ticket ${key} and produce a structured progress digest.`,
    '',
    'Follow these steps exactly, announcing each one before you start it:',
    '',
    '### Step W0 — KB Query',
    `Query any available knowledge base for prior context on ${key}. If nothing is found, state "No prior KB context."`,
    '',
    '### Step W1 — Fetch Ticket',
    `Use the Jira tools to fetch the full details of ${key}: summary, description, status, assignee, priority, fix version, all comments (newest first), and attachment metadata.`,
    'Output a concise Ticket Snapshot block.',
    '',
    '### Step W2 — Progress Analysis',
    'Analyse the full ticket content (description + all comments) to assess current progress.',
    'Consider: what has been done, is work moving forward or stalled, are there blockers or open questions, are any deadlines at risk.',
    '',
    '### Step W3 — Digest Output',
    'Produce the final digest using EXACTLY these section headers (do not change them):',
    '',
    '## Ticket Summary',
    `What is ${key} about? 2–3 sentences covering the purpose, scope, and business context for a reader who has not seen it before.`,
    '',
    '## Progress Assessment',
    'What has been accomplished? Is work moving forward at a reasonable pace?',
    '',
    '## Blockers & Concerns',
    'What is blocking progress or causing concern? List specific issues and unanswered questions.',
    '',
    '## What Should Happen Next',
    'Concrete, actionable next steps — who should do what.',
    '',
    '## Overall Verdict',
    'ONE OF: ON TRACK | NEEDS ATTENTION | BLOCKED | STALLED',
    'Brief explanation (1–2 sentences).',
    '',
    'Keep each section under 100 words. Be direct and actionable.',
  ].join('\n');
}

// ── Jira change detection ─────────────────────────────────────────────────────

// Returns { hash, snapshot } or null when Jira is unreachable / not configured.
// Snapshot covers the fields that indicate meaningful ticket progress.
function fetchJiraSnapshot(key) {
  return new Promise(resolve => {
    const jiraUrl  = (process.env.JIRA_URL || '').replace(/\/$/, '');
    const user     = process.env.JIRA_USERNAME  || '';
    const token    = process.env.JIRA_API_TOKEN || '';
    if (!jiraUrl || !user || !token) return resolve(null);

    const auth    = Buffer.from(`${user}:${token}`).toString('base64');
    const apiPath = `/rest/api/2/issue/${encodeURIComponent(key)}?fields=updated,comment,status`;
    let urlObj;
    try { urlObj = new URL(jiraUrl + apiPath); } catch (_) { return resolve(null); }

    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers:  { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => {
        try {
          const issue    = JSON.parse(data);
          const fields   = issue.fields || {};
          const comments = fields.comment || {};
          const lastCmt  = (comments.comments || []).slice(-1)[0];
          const snapshot = {
            updated:            fields.updated       || '',
            commentCount:       comments.total        || 0,
            lastCommentUpdated: lastCmt?.updated      || null,
            status:             fields.status?.name   || '',
          };
          const hash = crypto.createHash('sha1').update(JSON.stringify(snapshot)).digest('hex');
          resolve({ hash, snapshot });
        } catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Activity recording ────────────────────────────────────────────────────────

function recordActivity(event, key, details) {
  if (parentPort) parentPort.postMessage({ type: 'activity', event, key: key || null, details: details || {} });
}

// ── Step-announcement regex (matches ### Step W0 — ... lines) ────────────────

const STEP_RE = /(?:^|[*#\s])Step\s+((?:W|R|E)?\d+[a-z]?)\s*[—–]/m;

function appendPollLog(key, entry) {
  const tickets = loadStore();
  if (!tickets[key]) return;
  if (!Array.isArray(tickets[key].pollLog)) tickets[key].pollLog = [];
  tickets[key].pollLog.push(entry);
  saveStore(tickets);
  broadcast(tickets);
}

function setPollingNow(key, value) {
  const tickets = loadStore();
  if (!tickets[key]) return;
  tickets[key].pollingNow = value;
  if (value) tickets[key].pollLog = [];
  saveStore(tickets);
  broadcast(tickets);
}

// ── Claude invocation ─────────────────────────────────────────────────────────

// onText(chunk) is called for every text block emitted by Claude (for log streaming).
function runClaudeWatch(key, onText) {
  return new Promise((resolve, reject) => {
    const mcpConfig    = buildMcpConfig();
    const usingTmpConf = mcpConfig !== MCP_CONFIG;
    const prompt       = buildWatchPrompt(key);

    const proc = spawn(
      'claude',
      [
        '--dangerously-skip-permissions',
        '--print', prompt,
        '--mcp-config', mcpConfig,
        '--output-format', 'stream-json',
        '--verbose',
      ],
      {
        cwd:   PROJECT_ROOT,
        env:   { ...process.env, AUTO_MODE: 'Y' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let text    = '';
    let lineBuf = '';

    proc.stdout.on('data', chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'assistant') {
            for (const block of (ev.message?.content || [])) {
              if (block.type === 'text' && block.text?.trim()) {
                text += block.text;
                if (onText) onText(block.text);
                // Detect step announcements (### Step W0 — ...) for live progress
                const stepMatch = block.text.match(STEP_RE);
                if (stepMatch) {
                  const label = block.text.match(/###\s*Step\s+\S+\s*[—–]\s*(.+)/)?.[1]?.trim() || stepMatch[1];
                  appendPollLog(key, { ts: new Date().toISOString(), step: stepMatch[1], label });
                }
              }
            }
          }
        } catch (_) {
          // Not JSON — ignore stream framing noise
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const msg = chunk.toString().trim();
      if (msg) {
        log('warn', `[${key}] claude stderr: ${msg.slice(0, 200)}`);
        if (onText) onText(`[stderr] ${msg}\n`);
      }
    });

    proc.on('error', err => {
      if (usingTmpConf) try { fs.unlinkSync(mcpConfig); } catch (_) {}
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', code => {
      if (usingTmpConf) try { fs.unlinkSync(mcpConfig); } catch (_) {}
      // Flush any remaining partial line
      if (lineBuf.trim()) {
        try {
          const ev = JSON.parse(lineBuf);
          if (ev.type === 'assistant') {
            for (const block of (ev.message?.content || [])) {
              if (block.type === 'text' && block.text?.trim()) text += block.text;
            }
          }
        } catch (_) {}
      }
      if (code === 0 || text.trim()) resolve(text.trim() || '(no digest produced)');
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

// ── SMTP (same raw implementation as healthMonitor.js) ────────────────────────

function sendEmail(subject, body) {
  const to = emailTo();
  if (!smtpHost || !smtpUser || !smtpPass || !to) {
    log('warn', 'Email skipped — SMTP not fully configured');
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const USE_SSL = parseInt(smtpPort, 10) === 465;
    let sock = null, active = null, buf = '', phase = 'greeting', settled = false;

    function done(err) {
      if (settled) return; settled = true;
      try { (active || sock) && (active || sock).destroy(); } catch (_) {}
      err ? reject(err) : resolve();
    }
    function write(s) { active.write(s + '\r\n'); }
    function handle(code) {
      switch (phase) {
        case 'greeting':  if (code !== 220) return done(new Error(`Greeting ${code}`));
                          phase = 'ehlo1'; write('EHLO prevoyant-watcher'); break;
        case 'ehlo1':     if (code === 250) { if (USE_SSL) { phase = 'auth'; write('AUTH LOGIN'); }
                            else { phase = 'starttls'; write('STARTTLS'); } } break;
        case 'starttls':  if (code !== 220) return done(new Error(`STARTTLS ${code}`));
                          phase = 'ehlo2';
                          { const up = tls.connect({ socket: sock, host: smtpHost, rejectUnauthorized: false });
                            up.on('secureConnect', () => { active = up; write('EHLO prevoyant-watcher'); });
                            up.on('data', onData); up.on('error', done); }
                          break;
        case 'ehlo2':     if (code === 250) { phase = 'auth'; write('AUTH LOGIN'); } break;
        case 'auth':      if (code !== 334) return done(new Error(`AUTH ${code}`));
                          phase = 'user'; write(Buffer.from(smtpUser).toString('base64')); break;
        case 'user':      if (code !== 334) return done(new Error(`USER ${code}`));
                          phase = 'pass'; write(Buffer.from(smtpPass).toString('base64')); break;
        case 'pass':      if (code !== 235) return done(new Error(`PASS ${code}`));
                          phase = 'mail'; write(`MAIL FROM:<${smtpUser}>`); break;
        case 'mail':      if (code !== 250) return done(new Error(`MAIL ${code}`));
                          phase = 'rcpt'; write(`RCPT TO:<${to}>`); break;
        case 'rcpt':      if (code !== 250) return done(new Error(`RCPT ${code}`));
                          phase = 'data'; write('DATA'); break;
        case 'data':      if (code !== 354) return done(new Error(`DATA ${code}`));
                          phase = 'body';
                          write(`From: Prevoyant Watcher <${smtpUser}>`);
                          write(`To: ${to}`);
                          write(`Subject: ${subject}`);
                          write(`Date: ${new Date().toUTCString()}`);
                          write('MIME-Version: 1.0');
                          write('Content-Type: text/plain; charset=utf-8');
                          write('');
                          for (const line of body.split('\n')) write(line.startsWith('.') ? '.' + line : line);
                          write('.');
                          break;
        case 'body':      if (code !== 250) return done(new Error(`MSG ${code}`));
                          phase = 'quit'; write('QUIT'); break;
        case 'quit':      done(null); break;
      }
    }
    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        if (line[3] !== '-' && !isNaN(code)) handle(code);
      }
    }
    const co = { host: smtpHost, port: parseInt(smtpPort, 10), rejectUnauthorized: false };
    sock = USE_SSL ? tls.connect(co) : net.connect(co);
    active = sock;
    sock.on('data', onData); sock.on('error', done);
    sock.setTimeout(20000, () => done(new Error('SMTP timeout')));
  });
}

// ── Poll a single ticket ──────────────────────────────────────────────────────

const _inFlight = new Set();

// ── Log file helpers ─────────────────────────────────────────────────────────

function safeTimestamp() {
  // Produces a filesystem-safe ISO timestamp: 2026-05-03_14-30-00
  return new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

function openLogStream(key, pollNum) {
  const logDir  = path.join(LOG_DIR, key);
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  const logFile = `${safeTimestamp()}_poll-${pollNum}.log`;
  const logPath = path.join(logDir, logFile);
  const stream  = fs.createWriteStream(logPath, { encoding: 'utf8' });
  return { stream, logFile };
}

// ── Poll a single ticket ──────────────────────────────────────────────────────

async function pollTicket(key) {
  log('info', `Polling ${key} via Claude CLI + Jira MCP`);
  const tickets = loadStore();
  const entry   = tickets[key];
  if (!entry || entry.status !== 'watching') return;

  const pollNum  = (entry.pollCount || 0) + 1;
  const { stream: logStream, logFile } = openLogStream(key, pollNum);
  const startedAt = new Date();

  logStream.write(
    `=== Watch Poll: ${key}  #${pollNum} ===\n` +
    `Started : ${startedAt.toISOString()}\n` +
    `Interval: ${entry.interval}${entry.maxPolls > 0 ? `  MaxPolls: ${entry.maxPolls}` : ''}\n` +
    `${'─'.repeat(60)}\n\n`
  );

  setPollingNow(key, true);
  // Record the current log file immediately so the dashboard can tail it
  {
    const s = loadStore();
    if (s[key]) { s[key].lastLogFile = logFile; saveStore(s); }
  }
  recordActivity('watch_poll_started', key, { pollNum, interval: entry.interval });

  try {
    // Cheap Jira snapshot check — skip Claude if ticket hasn't changed
    const snap = await fetchJiraSnapshot(key);
    if (snap && snap.hash && snap.hash === entry.lastSnapshotHash) {
      logStream.write(`No Jira changes detected (hash ${snap.hash}) — Claude run skipped.\nFinished: ${new Date().toISOString()}\n`);
      logStream.end();
      log('info', `No Jira changes for ${key} — skipping poll`);
      recordActivity('watch_poll_skipped', key, { pollNum, reason: 'no_jira_changes' });
      const s = loadStore();
      if (s[key]) {
        s[key].pollingNow  = false;
        s[key].lastPollAt  = new Date().toISOString();
        s[key].lastLogFile = logFile;
        s[key].nextPollAt  = new Date(Date.now() + intervalMs(s[key].interval)).toISOString();
        saveStore(s);
        broadcast(s);
      }
      return;
    }

    const digest = await runClaudeWatch(key, text => { logStream.write(text); });

    const digestHash = crypto.createHash('sha1').update(digest).digest('hex');
    const unchanged  = digest.trim() && digestHash === entry.lastDigestHash;

    if (unchanged) {
      logStream.write(`\n${'─'.repeat(60)}\nNo changes detected — email skipped.\nFinished: ${new Date().toISOString()}\n`);
    } else {
      logStream.write(`\n${'─'.repeat(60)}\n=== Poll complete ===\nFinished: ${new Date().toISOString()}\n`);
    }
    logStream.end();

    // Reload store — it may have been written by another message while claude ran
    const fresh = loadStore();
    const t     = fresh[key];
    if (!t || t.status !== 'watching') return;

    t.pollCount++;
    t.lastPollAt      = new Date().toISOString();
    t.lastDigest      = digest;
    t.lastDigestAt    = new Date().toISOString();
    t.lastDigestHash  = digestHash;
    if (snap?.hash) t.lastSnapshotHash = snap.hash;
    t.lastError    = null;
    t.lastLogFile  = logFile;

    if (t.maxPolls > 0 && t.pollCount >= t.maxPolls) {
      t.status     = 'completed';
      t.nextPollAt = null;
      log('info', `${key} reached max polls (${t.maxPolls}) — completed`);
    } else {
      t.nextPollAt = new Date(Date.now() + intervalMs(t.interval)).toISOString();
    }
    t.pollingNow = false;
    saveStore(fresh);
    broadcast(fresh);

    if (unchanged) {
      log('info', `No changes detected for ${key} (poll #${t.pollCount}) — email skipped`);
      recordActivity('watch_poll_completed', key, {
        pollCount: t.pollCount, emailed: false, reason: 'digest_unchanged',
        completed: t.status === 'completed',
      });
    } else {
      const jiraBase = (process.env.JIRA_URL || '').replace(/\/$/, '');
      const subject  = `[Prevoyant Watch] ${key} digest · poll #${t.pollCount}`;
      const divider  = '─'.repeat(60);
      const emailBody = [
        `Ticket Watch Digest — ${key}`,
        `Poll #${t.pollCount}${t.maxPolls > 0 ? ` of ${t.maxPolls}` : ''}  ·  ${new Date().toUTCString()}`,
        `Interval: ${t.interval}`,
        divider,
        '',
        digest,
        '',
        divider,
        jiraBase ? `Ticket URL : ${jiraBase}/browse/${key}` : `Ticket: ${key}`,
        t.nextPollAt
          ? `Next poll  : ${new Date(t.nextPollAt).toUTCString()}`
          : `Watching completed (${t.pollCount} polls done)`,
      ].join('\n');

      await sendEmail(subject, emailBody)
        .catch(e => log('error', `Email failed for ${key}: ${e.message}`));

      log('info', `Poll complete for ${key} (poll #${t.pollCount}) — digest emailed`);
      recordActivity('watch_poll_completed', key, {
        pollCount: t.pollCount, emailed: true,
        completed: t.status === 'completed',
      });
    }

    if (t.status === 'completed') {
      recordActivity('watch_completed', key, { totalPolls: t.pollCount });
    }

  } catch (err) {
    logStream.write(`\n${'─'.repeat(60)}\n=== Poll FAILED: ${err.message} ===\n${new Date().toISOString()}\n`);
    logStream.end();

    log('error', `Poll failed for ${key}: ${err.message}`);
    recordActivity('watch_poll_failed', key, { error: err.message });
    const t2 = loadStore();
    if (t2[key]) {
      t2[key].pollingNow = false;
      t2[key].lastError  = err.message;
      t2[key].lastLogFile = logFile;
      t2[key].nextPollAt = new Date(Date.now() + intervalMs(t2[key].interval)).toISOString();
      saveStore(t2);
      broadcast(t2);
    }
  }
}

// ── State broadcast ───────────────────────────────────────────────────────────

function broadcast(ticketsOrNull) {
  if (!parentPort) return;
  const tickets = ticketsOrNull || loadStore();
  parentPort.postMessage({ type: 'state', tickets: Object.values(tickets) });
}

// ── Polling tick (every 60 s) ─────────────────────────────────────────────────

let halted = false;

async function tick() {
  if (halted) return;
  const tickets = loadStore();
  const now     = Date.now();

  for (const entry of Object.values(tickets)) {
    if (entry.status !== 'watching') continue;
    if (_inFlight.has(entry.key)) continue;
    if (!entry.nextPollAt) continue;
    if (new Date(entry.nextPollAt).getTime() > now) continue;

    _inFlight.add(entry.key);
    pollTicket(entry.key).finally(() => _inFlight.delete(entry.key));
  }

  broadcast(tickets);
}

// ── Messages from main thread ─────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', msg => {
    if (!msg) return;

    if (msg.type === 'graceful-stop') {
      halted = true;
      log('info', 'Graceful-stop — ticket watcher halted');
      setTimeout(() => process.exit(0), 500);
      return;
    }

    if (msg.type === 'add-ticket') {
      const { key, interval, maxPolls } = msg;
      const tickets  = loadStore();
      const existing = tickets[key];

      if (existing && existing.status === 'watching') {
        log('warn', `${key} is already being watched`);
        broadcast(tickets);
        return;
      }

      const now = Date.now();
      tickets[key] = {
        key,
        addedAt:          new Date(now).toISOString(),
        interval:         interval || '1d',
        maxPolls:         parseInt(maxPolls) || 0,
        pollCount:        0,
        lastPollAt:       null,
        nextPollAt:       new Date(now + intervalMs(interval || '1d')).toISOString(),
        status:           'watching',
        lastDigest:       null,
        lastDigestAt:     null,
        lastDigestHash:   null,
        lastSnapshotHash: null,
        lastError:        null,
        pollingNow:       false,
        pollLog:          [],
      };
      saveStore(tickets);
      log('info', `Now watching ${key} (interval: ${interval || '1d'}, maxPolls: ${maxPolls || 'unlimited'})`);
      broadcast(tickets);

      _inFlight.add(key);
      pollTicket(key).finally(() => _inFlight.delete(key));
      return;
    }

    if (msg.type === 'stop-ticket') {
      const { key } = msg;
      const tickets = loadStore();
      if (tickets[key]) {
        tickets[key].status    = 'stopped';
        tickets[key].nextPollAt = null;
        saveStore(tickets);
        log('info', `Stopped watching ${key}`);
        broadcast(tickets);
      }
      return;
    }

    if (msg.type === 'resume-ticket') {
      const { key } = msg;
      const tickets = loadStore();
      if (tickets[key]) {
        tickets[key].status    = 'watching';
        tickets[key].nextPollAt = new Date(Date.now() + intervalMs(tickets[key].interval)).toISOString();
        tickets[key].lastError  = null;
        saveStore(tickets);
        log('info', `Resumed watching ${key}`);
        broadcast(tickets);

        _inFlight.add(key);
        pollTicket(key).finally(() => _inFlight.delete(key));
      }
      return;
    }

    if (msg.type === 'poll-now') {
      const { key } = msg;
      if (_inFlight.has(key)) {
        log('warn', `Poll already in flight for ${key}`);
        return;
      }
      const tickets = loadStore();
      if (tickets[key] && tickets[key].status === 'watching') {
        _inFlight.add(key);
        pollTicket(key).finally(() => _inFlight.delete(key));
      }
      return;
    }

    if (msg.type === 'get-state') {
      broadcast(null);
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const activeCount = Object.values(loadStore()).filter(t => t.status === 'watching').length;
log('info', `Started — ${activeCount} ticket(s) already being watched`);
tick();
setInterval(tick, 60 * 1000);
