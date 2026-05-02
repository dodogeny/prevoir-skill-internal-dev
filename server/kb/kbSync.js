'use strict';

// KB real-time sync: Redis is the doorbell, Git is the mail carrier.
//
// notify(ticketKey) — called after a session: git push → XADD to Upstash.
// No KB content ever touches Redis. Payload is ~100 bytes:
//   { machine, ticket, commit }

const { execSync } = require('child_process');
const https        = require('https');
const os           = require('os');

const STREAM_KEY = 'prevoyant:kb-updates';
const STREAM_MAXLEN = '1000';

function isEnabled() {
  return process.env.PRX_REALTIME_KB_SYNC === 'Y';
}

function isDistributed() {
  return (process.env.PRX_KB_MODE || 'local') === 'distributed';
}

function machineName() {
  return (process.env.PRX_KB_SYNC_MACHINE || os.hostname()).trim();
}

// Resolve the local KB clone directory (mirrors kbCache.kbDir for distributed).
function kbCloneDir() {
  const { kbDir } = require('./kbCache');
  return kbDir();
}

// ── Upstash REST API (no driver dependency) ──────────────────────────────────

function upstashPost(command) {
  const url   = process.env.PRX_UPSTASH_REDIS_URL   || '';
  const token = process.env.PRX_UPSTASH_REDIS_TOKEN  || '';

  if (!url || !token) {
    throw new Error('PRX_UPSTASH_REDIS_URL and PRX_UPSTASH_REDIS_TOKEN must be set');
  }

  const parsed  = new URL(url.endsWith('/') ? url.slice(0, -1) : url);
  const payload = Buffer.from(JSON.stringify(command));

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path:     '/',
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': payload.length,
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          const body = JSON.parse(raw);
          if (body.error) return reject(new Error(`Upstash error: ${body.error}`));
          resolve(body.result);
        } catch (e) {
          reject(new Error(`Upstash parse error: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('Upstash request timeout')); });
    req.write(payload);
    req.end();
  });
}

// XADD — posts a ~100-byte notification. Returns the new stream entry ID.
async function xadd(machine, ticket, commit) {
  return upstashPost([
    'XADD', STREAM_KEY,
    'MAXLEN', '~', STREAM_MAXLEN,
    '*',
    'machine', machine,
    'ticket',  ticket  || '',
    'commit',  commit  || '',
  ]);
}

// XREAD — returns any new entries since lastId. Returns [] when nothing new.
async function xread(lastId) {
  const result = await upstashPost([
    'XREAD', 'COUNT', '20',
    'STREAMS', STREAM_KEY,
    lastId || '0-0',
  ]);

  if (!result) return [];
  // Wire format: [[streamName, [[id, [k,v,...]], ...]], ...]
  const entries = result[0]?.[1] ?? [];
  return entries.map(([id, fields]) => {
    const obj = { id };
    for (let i = 0; i < fields.length; i += 2) {
      obj[fields[i]] = fields[i + 1];
    }
    return obj;
  });
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function gitHead(dir) {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: dir, encoding: 'utf8', timeout: 5000,
    }).trim();
  } catch (_) { return ''; }
}

function gitPush(dir) {
  execSync('git push origin main', {
    cwd: dir, encoding: 'utf8', timeout: 60000, stdio: 'pipe',
  });
}

function gitPull(dir) {
  execSync('git pull --rebase origin main', {
    cwd: dir, encoding: 'utf8', timeout: 60000, stdio: 'pipe',
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

// Called by the runner after a session completes.
// Step 1: git push (KB files travel via Git, not Redis).
// Step 2: XADD to Upstash — doorbell only, no KB content.
async function notify(ticketKey) {
  if (!isEnabled() || !isDistributed()) return;

  const dir = kbCloneDir();
  let commit = '';

  try {
    gitPush(dir);
    commit = gitHead(dir);
  } catch (e) {
    // Push can fail if nothing changed or there are no new commits.
    // Still notify so other machines pull the latest state.
    commit = gitHead(dir);
    if (e.message.includes('Everything up-to-date') ||
        e.message.includes('nothing to commit')) {
      // Benign — skip XADD, other machines already have this state.
      return;
    }
    console.warn('[kb-sync] git push failed:', e.message.split('\n')[0]);
  }

  const machine = machineName();
  try {
    const id = await xadd(machine, ticketKey || '', commit);
    console.log(`[kb-sync] XADD → ${STREAM_KEY} id=${id} machine=${machine} ticket=${ticketKey} commit=${commit}`);
  } catch (e) {
    console.warn('[kb-sync] XADD failed:', e.message);
  }
}

// Called by the kbSyncWorker when a notification arrives from another machine.
// Does git pull and returns true on success.
function pullFromRemote(dir) {
  gitPull(dir);
}

module.exports = { isEnabled, isDistributed, machineName, kbCloneDir, xread, xadd, notify, pullFromRemote };
