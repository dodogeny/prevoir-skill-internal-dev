'use strict';

// Disk monitor — runs as a worker_threads thread inside prevoyant-server.
// Periodically measures disk usage of ~/.prevoyant/ against a configured quota.
// Alerts via email when the folder size exceeds that quota.
// Marks a pending-cleanup flag when the cleanup interval has elapsed;
// the dashboard shows a confirmation UI before any files are deleted.

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFile } = require('child_process');
const net  = require('net');
const tls  = require('tls');

const {
  intervalMins        = 60,
  cleanupIntervalDays = 7,
  maxSizeMB           = 500,
  alertPct            = 80,
  smtpHost            = '',
  smtpPort            = '587',
  smtpUser            = '',
  smtpPass            = '',
  emailTo             = '',
} = workerData || {};

const alertThresholdMB = maxSizeMB * (alertPct / 100);

const PREVOYANT_DIR  = path.join(os.homedir(), '.prevoyant');
const SERVER_DIR     = path.join(PREVOYANT_DIR, 'server');
const STATUS_FILE    = path.join(SERVER_DIR, 'disk-status.json');
const LOG_FILE       = path.join(SERVER_DIR, 'disk-log.json');
const MAX_LOG        = 720;   // 30 days at hourly checks
const ALERT_COOLDOWN = 4 * 60 * 60 * 1000; // 4 hours between repeated DOWN alerts

let halted      = false;
let lastAlertAt = null;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [disk-monitor/${level}] ${msg}`);
}

// ── SMTP client (identical pattern to healthMonitor — no external deps) ───────

function sendEmail(subject, body) {
  if (!smtpHost || !smtpUser || !smtpPass || !emailTo) {
    log('warn', 'Email alert skipped — SMTP not fully configured');
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const USE_SSL = parseInt(smtpPort, 10) === 465;
    let sock      = null;
    let active    = null;
    let buf       = '';
    let phase     = 'greeting';
    let settled   = false;

    function done(err) {
      if (settled) return;
      settled = true;
      try { (active || sock) && (active || sock).destroy(); } catch (_) {}
      if (err) reject(err);
      else resolve();
    }

    function write(s) { active.write(s + '\r\n'); }

    function handle(code) {
      switch (phase) {
        case 'greeting':
          if (code !== 220) return done(new Error(`Unexpected greeting ${code}`));
          phase = 'ehlo1';
          write('EHLO prevoyant-disk-monitor');
          break;
        case 'ehlo1':
          if (code === 250) {
            if (USE_SSL) { phase = 'auth';     write('AUTH LOGIN'); }
            else         { phase = 'starttls'; write('STARTTLS');   }
          }
          break;
        case 'starttls':
          if (code !== 220) return done(new Error(`STARTTLS rejected: ${code}`));
          phase = 'ehlo2';
          {
            const upgraded = tls.connect({ socket: sock, host: smtpHost, rejectUnauthorized: false });
            upgraded.on('secureConnect', () => { active = upgraded; write('EHLO prevoyant-disk-monitor'); });
            upgraded.on('data', onData);
            upgraded.on('error', done);
          }
          break;
        case 'ehlo2':
          if (code === 250) { phase = 'auth'; write('AUTH LOGIN'); }
          break;
        case 'auth':
          if (code !== 334) return done(new Error(`AUTH rejected: ${code}`));
          phase = 'user';
          write(Buffer.from(smtpUser).toString('base64'));
          break;
        case 'user':
          if (code !== 334) return done(new Error(`AUTH username rejected: ${code}`));
          phase = 'pass';
          write(Buffer.from(smtpPass).toString('base64'));
          break;
        case 'pass':
          if (code !== 235) return done(new Error(`AUTH failed: ${code}`));
          phase = 'mail';
          write(`MAIL FROM:<${smtpUser}>`);
          break;
        case 'mail':
          if (code !== 250) return done(new Error(`MAIL FROM rejected: ${code}`));
          phase = 'rcpt';
          write(`RCPT TO:<${emailTo}>`);
          break;
        case 'rcpt':
          if (code !== 250) return done(new Error(`RCPT TO rejected: ${code}`));
          phase = 'data';
          write('DATA');
          break;
        case 'data':
          if (code !== 354) return done(new Error(`DATA rejected: ${code}`));
          phase = 'body';
          write(`From: Prevoyant Disk Monitor <${smtpUser}>`);
          write(`To: ${emailTo}`);
          write(`Subject: ${subject}`);
          write(`Date: ${new Date().toUTCString()}`);
          write('MIME-Version: 1.0');
          write('Content-Type: text/plain; charset=utf-8');
          write('');
          for (const line of body.split('\n')) {
            write(line.startsWith('.') ? '.' + line : line);
          }
          write('.');
          break;
        case 'body':
          if (code !== 250) return done(new Error(`Message rejected: ${code}`));
          phase = 'quit';
          write('QUIT');
          break;
        case 'quit':
          done(null);
          break;
        default:
          break;
      }
    }

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const cont = line[3] === '-';
        if (!cont && !isNaN(code)) handle(code);
      }
    }

    const connectOpts = { host: smtpHost, port: parseInt(smtpPort, 10), rejectUnauthorized: false };
    sock   = USE_SSL ? tls.connect(connectOpts) : net.connect(connectOpts);
    active = sock;
    sock.on('data', onData);
    sock.on('error', done);
    sock.setTimeout(20000, () => done(new Error('SMTP connect timeout')));
  });
}

// ── Disk usage ────────────────────────────────────────────────────────────────

function getDirSizeBytes(dir) {
  let total = 0;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); }
    catch (_) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else {
        try { total += fs.statSync(full).size; }
        catch (_) {}
      }
    }
  }
  walk(dir);
  return total;
}

function getDiskCapacity() {
  return new Promise((resolve) => {
    // df -k: 1024-byte block counts, works on both macOS and Linux
    execFile('df', ['-k', os.homedir()], { timeout: 5000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const lines = stdout.trim().split('\n').filter(Boolean);
      // last line is the data row (first line is header)
      const parts = lines[lines.length - 1].trim().split(/\s+/);
      if (parts.length < 4) { resolve(null); return; }
      const total = parseInt(parts[1], 10) * 1024;
      const used  = parseInt(parts[2], 10) * 1024;
      const avail = parseInt(parts[3], 10) * 1024;
      if (isNaN(total) || isNaN(used)) { resolve(null); return; }
      resolve({ total, used, avail });
    });
  });
}

// ── Status / log persistence ──────────────────────────────────────────────────

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch (_) {
    return { lastCleanupAt: null, pendingCleanup: false, lastAlertAt: null };
  }
}

function writeStatus(data) {
  try {
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('warn', `Could not write disk status: ${e.message}`);
  }
}

function appendLog(entry) {
  let log_ = [];
  try { log_ = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); }
  catch (_) {}
  if (!Array.isArray(log_)) log_ = [];
  log_.push(entry);
  if (log_.length > MAX_LOG) log_ = log_.slice(-MAX_LOG);
  try {
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(log_));
  } catch (e) {
    log('warn', `Could not write disk log: ${e.message}`);
  }
}

// ── Alert builders ────────────────────────────────────────────────────────────

function diskAlert(prevoyantMB, freeGB) {
  const subject = `[Prevoyant] WARNING — .prevoyant folder at ${prevoyantMB.toFixed(0)} MB (${alertPct}% of ${maxSizeMB} MB quota)`;
  const body = [
    `Prevoyant Server has detected that the ~/.prevoyant/ folder has reached ${alertPct}% of its configured size quota.`,
    '',
    `  .prevoyant size   : ${prevoyantMB.toFixed(1)} MB`,
    `  Alert threshold   : ${alertThresholdMB.toFixed(0)} MB (${alertPct}% of ${maxSizeMB} MB quota)`,
    `  Size quota        : ${maxSizeMB} MB`,
    `  Free disk space   : ${freeGB.toFixed(1)} GB`,
    `  Detected at       : ${new Date().toUTCString()}`,
    '',
    'To free up space, visit the dashboard and use the Disk Monitor cleanup tool:',
    '  http://127.0.0.1:3000/dashboard/disk',
    '',
    'Cleanup will remove old session files and trim server logs.',
  ].join('\n');
  return { subject, body };
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tick() {
  if (halted) return;

  const prevoyantBytes = fs.existsSync(PREVOYANT_DIR)
    ? getDirSizeBytes(PREVOYANT_DIR)
    : 0;
  const prevoyantMB = prevoyantBytes / (1024 * 1024);

  const cap = await getDiskCapacity();
  const diskTotal = cap ? cap.total : 0;
  const diskUsed  = cap ? cap.used  : 0;
  const diskFree  = cap ? cap.avail : 0;
  const usedPct   = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
  const freeGB    = diskFree / (1024 * 1024 * 1024);

  log('info', `Usage: ${usedPct}% disk, ${prevoyantMB.toFixed(1)} MB in .prevoyant`);

  const existing    = readStatus();
  const lastCleanup = existing.lastCleanupAt ? new Date(existing.lastCleanupAt) : null;
  const now         = new Date();

  // Determine whether cleanup is pending
  let pendingCleanup = existing.pendingCleanup || false;
  if (cleanupIntervalDays > 0) {
    if (!lastCleanup) {
      // No cleanup ever done — mark pending after first interval elapses
      // Use server start as reference: don't immediately prompt on first boot
      // Only mark pending if prevoyant dir is non-trivial (>= 1 MB)
      if (prevoyantMB >= 1) pendingCleanup = true;
    } else {
      const daysSince = (now - lastCleanup) / (1000 * 60 * 60 * 24);
      if (daysSince >= cleanupIntervalDays) pendingCleanup = true;
    }
  }

  const status = {
    updatedAt:       now.toISOString(),
    prevoyantBytes,
    prevoyantMB:     parseFloat(prevoyantMB.toFixed(2)),
    diskTotal,
    diskUsed,
    diskFree,
    diskUsedPct:     usedPct,
    lastCleanupAt:   existing.lastCleanupAt || null,
    pendingCleanup,
    maxSizeMB,
    alertPct,
    alertThresholdMB: parseFloat(alertThresholdMB.toFixed(0)),
    cleanupIntervalDays,
  };
  writeStatus(status);

  appendLog({
    ts:            now.toISOString(),
    prevoyantMB:   parseFloat(prevoyantMB.toFixed(2)),
    diskUsedPct:   usedPct,
  });

  if (parentPort) {
    parentPort.postMessage({ type: 'status', ...status });
  }

  // Alert when .prevoyant reaches alertPct% of its quota (with cooldown to avoid spam)
  if (prevoyantMB >= alertThresholdMB) {
    const cooldownOk = !lastAlertAt || (Date.now() - lastAlertAt) >= ALERT_COOLDOWN;
    if (cooldownOk) {
      lastAlertAt = Date.now();
      const { subject, body } = diskAlert(prevoyantMB, freeGB);
      log('warn', `.prevoyant at ${prevoyantMB.toFixed(1)} MB — ${alertPct}% of ${maxSizeMB} MB quota — sending alert to ${emailTo}`);
      await sendEmail(subject, body).catch(e => log('error', `Alert send failed: ${e.message}`));
    }
  }
}

// ── Messages from main thread ─────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', msg => {
    if (!msg) return;
    if (msg.type === 'graceful-stop') {
      halted = true;
      log('info', 'Graceful-stop received — monitoring halted');
      setTimeout(() => process.exit(0), 300);
    }
    if (msg.type === 'cleanup-done') {
      // Main thread performed cleanup — update status file accordingly
      const existing = readStatus();
      writeStatus({ ...existing, pendingCleanup: false, lastCleanupAt: new Date().toISOString() });
      log('info', 'Cleanup confirmed by main thread — status updated');
    }
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

log('info', `Started — checking every ${intervalMins}m, alert at ${alertPct}% of ${maxSizeMB} MB quota (${alertThresholdMB.toFixed(0)} MB)`);
tick();
setInterval(tick, intervalMins * 60 * 1000);
