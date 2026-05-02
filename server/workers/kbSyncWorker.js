'use strict';

// KB sync polling worker — runs as a worker_threads thread.
// Polls Upstash Redis XREAD every pollSecs seconds.
// On a new notification from another machine → git pull --rebase → tells parent to invalidate cache.
// No KB content ever leaves/enters Redis. Git carries the actual files.

const { workerData, parentPort } = require('worker_threads');
const { execSync } = require('child_process');
const https        = require('https');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

const {
  upstashUrl   = '',
  upstashToken = '',
  kbDir        = '',
  machineName  = os.hostname(),
  pollSecs     = 10,
} = workerData || {};

const STREAM_KEY   = 'prevoyant:kb-updates';
const STATE_FILE   = path.join(os.homedir(), '.prevoyant', 'server', 'kb-sync-state.json');

// ── State persistence ─────────────────────────────────────────────────────────

function loadLastId() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastId || '0-0'; }
  catch (_) { return '0-0'; }
}

function saveLastId(id) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastId: id, updatedAt: new Date().toISOString() }));
  } catch (_) { /* non-fatal */ }
}

// ── Upstash REST (identical to kbSync.js — worker thread can't share modules) ─

function upstashPost(command) {
  if (!upstashUrl || !upstashToken) {
    return Promise.reject(new Error('Upstash URL/token not configured'));
  }
  const parsed  = new URL(upstashUrl.endsWith('/') ? upstashUrl.slice(0, -1) : upstashUrl);
  const payload = Buffer.from(JSON.stringify(command));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path:     '/',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${upstashToken}`,
        'Content-Type':   'application/json',
        'Content-Length': payload.length,
      },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.error) return reject(new Error(`Upstash: ${body.error}`));
          resolve(body.result);
        } catch (e) {
          reject(new Error(`Upstash parse error: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Upstash timeout')));
    req.write(payload);
    req.end();
  });
}

async function xread(lastId) {
  const result = await upstashPost([
    'XREAD', 'COUNT', '20',
    'STREAMS', STREAM_KEY,
    lastId || '0-0',
  ]);
  if (!result) return [];
  const entries = result[0]?.[1] ?? [];
  return entries.map(([id, fields]) => {
    const obj = { id };
    for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
    return obj;
  });
}

// ── Git pull ──────────────────────────────────────────────────────────────────

function gitPull(dir) {
  execSync('git pull --rebase origin main', {
    cwd: dir, encoding: 'utf8', timeout: 60000, stdio: 'pipe',
  });
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

let halted  = false;
let lastId  = loadLastId();

if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') halted = true;
  });
}

async function pollOnce() {
  let entries;
  try { entries = await xread(lastId); }
  catch (e) {
    console.warn('[kb-sync-worker] poll error:', e.message);
    return;
  }

  for (const entry of entries) {
    lastId = entry.id;

    // Skip our own notifications — we already pushed.
    if (entry.machine === machineName) continue;

    console.log(`[kb-sync-worker] Notification from ${entry.machine} — ticket: ${entry.ticket} commit: ${entry.commit}`);

    if (kbDir) {
      try {
        gitPull(kbDir);
        console.log(`[kb-sync-worker] KB pulled from remote (${entry.machine}/${entry.ticket})`);
        if (parentPort) parentPort.postMessage({ type: 'kb-synced', entry });
      } catch (e) {
        console.warn('[kb-sync-worker] git pull failed:', e.message.split('\n')[0]);
      }
    }
  }

  if (entries.length > 0) saveLastId(lastId);
}

(async () => {
  console.log(`[kb-sync-worker] Started — polling every ${pollSecs}s, machine=${machineName}`);

  while (!halted) {
    await pollOnce();
    // Sleep, but wake immediately if halted.
    await new Promise(r => setTimeout(r, pollSecs * 1000));
  }

  console.log('[kb-sync-worker] Stopped');
})();
