'use strict';

const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const http           = require('http');
const https          = require('https');
const { spawn }      = require('child_process');
const wa             = require('../notifications/whatsapp');

const MAX_EVENTS = 5000;
let events  = [];
let nextId  = 1;
let _dirty  = false;

// ── Storage ───────────────────────────────────────────────────────────────────

function serverDir() {
  return path.join(os.homedir(), '.prevoyant', 'server');
}

function logPath() {
  return path.join(serverDir(), 'activity-log.json');
}

function saveLog() {
  _dirty = false;
  try {
    fs.mkdirSync(serverDir(), { recursive: true });
    fs.writeFileSync(logPath(), JSON.stringify(events));
  } catch (_) { /* best-effort */ }
}

function loadLog() {
  // Migrate from legacy path if new path doesn't exist yet
  const legacy = path.join(os.homedir(), '.prevoyant', 'activity-log.json');
  const current = logPath();
  if (!fs.existsSync(current) && fs.existsSync(legacy)) {
    try {
      fs.mkdirSync(serverDir(), { recursive: true });
      fs.renameSync(legacy, current);
      console.log('[activity] Migrated activity-log.json → ~/.prevoyant/server/');
    } catch (_) { /* best-effort migration */ }
  }

  try {
    const raw = JSON.parse(fs.readFileSync(current, 'utf8'));
    if (Array.isArray(raw) && raw.length > 0) {
      events = raw.slice(-MAX_EVENTS);
      nextId = events[events.length - 1].id + 1;
      console.log(`[activity] Loaded ${events.length} event(s) from disk`);
    }
  } catch (_) { /* not found or corrupt — start fresh */ }
}

// ── Webhook ───────────────────────────────────────────────────────────────────

const WEBHOOK_EMOJI = {
  ticket_completed:  '✅', ticket_failed: '❌', ticket_interrupted: '⚠️',
  ticket_started: '▶️', ticket_queued: '📥', upgrade_completed: '🆙',
};

function fireWebhook(event) {
  const url = process.env.PRX_WEBHOOK_URL;
  if (!url) return;

  const allowed = (process.env.PRX_WEBHOOK_EVENTS || 'ticket_completed,ticket_failed,ticket_interrupted')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(event.type)) return;

  let urlObj;
  try { urlObj = new URL(url); } catch (_) { return; }

  const emoji = WEBHOOK_EMOJI[event.type] || '🔔';
  const ticket = event.ticketKey ? ` [${event.ticketKey}]` : '';
  const detail = event.details && event.details.reason ? ` — ${event.details.reason}` : '';
  const text   = `${emoji} *Prevoyant*${ticket}: ${event.type.replace(/_/g, ' ')}${detail}`;

  const payload = Buffer.from(JSON.stringify({ text, event }));
  const mod = urlObj.protocol === 'https:' ? https : http;

  const req = mod.request({
    hostname: urlObj.hostname,
    port:     urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
    path:     urlObj.pathname + urlObj.search,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': payload.length },
  }, res => { res.resume(); });

  req.on('error', () => {});
  req.setTimeout(10000, () => req.destroy());
  req.write(payload);
  req.end();
}

// ── WhatsApp dispatch ─────────────────────────────────────────────────────────

// Report events that should also send the PDF as a WhatsApp document.
const REPORT_EVENTS = new Set(['stage_dev_report', 'stage_review_report', 'stage_est_report']);

function reportsDir() {
  return process.env.CLAUDE_REPORT_DIR || path.join(os.homedir(), '.prevoyant', 'reports');
}

function findLatestReport(ticketKey) {
  const dir    = reportsDir();
  const prefix = ticketKey.toLowerCase();
  try {
    const files = fs.readdirSync(dir)
      .filter(f => {
        const l = f.toLowerCase();
        return (l.startsWith(prefix + '_') || l.startsWith(prefix + '-')) && l.endsWith('.pdf');
      })
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? files[0].name : null;
  } catch (_) { return null; }
}

// Encrypt a PDF with qpdf and return the temp output path.
// Caller must delete the temp file after use.
function encryptPdf(inputPath, password) {
  return new Promise((resolve, reject) => {
    const tmpOut = path.join(os.tmpdir(), `prx-enc-${Date.now()}.pdf`);
    const proc   = spawn('qpdf', ['--encrypt', password, password, '256', '--', inputPath, tmpOut]);
    proc.on('error', err => reject(new Error(`qpdf unavailable: ${err.message}`)));
    proc.on('close', code => code === 0 ? resolve(tmpOut) : reject(new Error(`qpdf exited ${code}`)));
  });
}

// Upload a local file to tmpfiles.org and return a direct download URL.
function uploadToTmpFiles(filePath) {
  return new Promise((resolve, reject) => {
    let fileData;
    try { fileData = fs.readFileSync(filePath); } catch (e) { return reject(e); }

    const filename = path.basename(filePath);
    const boundary = `----PRXBoundary${Date.now()}`;
    const head     = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileData, tail]);

    const req = https.request({
      hostname: 'tmpfiles.org',
      path:     '/api/v1/upload',
      method:   'POST',
      headers:  { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
    }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try {
          const d = JSON.parse(raw);
          if (d.status === 'success' && d.data?.url) {
            // Convert page URL → direct download URL
            resolve(d.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/'));
          } else {
            reject(new Error(`tmpfiles.org: ${raw.slice(0, 120)}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('tmpfiles.org timeout')); });
    req.write(body);
    req.end();
  });
}

async function fireWhatsApp(event) {
  if (!wa.shouldSend(event.type)) return;

  const text = wa.eventText(event.type, event.ticketKey, event.details);
  if (!text) return;

  wa.sendText(text).catch(() => {});

  if (!REPORT_EVENTS.has(event.type) || !event.ticketKey) return;

  const filename = findLatestReport(event.ticketKey);
  if (!filename) return;

  const srcPath   = path.join(reportsDir(), filename);
  const password  = (process.env.PRX_WASENDER_PDF_PASSWORD || '').trim();
  const publicUrl = (process.env.PRX_WASENDER_PUBLIC_URL  || '').replace(/\/$/, '');

  let sendPath   = srcPath;
  let tmpCreated = null;

  // Encrypt first if a password is configured.
  if (password) {
    try {
      sendPath   = await encryptPdf(srcPath, password);
      tmpCreated = sendPath;
    } catch (e) {
      console.warn('[whatsapp] PDF encryption failed (install qpdf):', e.message);
      // Fall through — send unencrypted rather than silently dropping the document.
    }
  }

  let docUrl = null;
  try {
    // When a password is set the encrypted temp file can't be served via the
    // public-URL endpoint (which reads from reportsDir), so always upload to
    // tmpfiles.org in that case. Without a password, use the public URL if set.
    if (!password && publicUrl) {
      docUrl = `${publicUrl}/dashboard/reports/serve/${encodeURIComponent(filename)}`;
    } else {
      docUrl = await uploadToTmpFiles(sendPath);
    }
  } catch (e) {
    console.warn('[whatsapp] PDF upload failed:', e.message);
  } finally {
    if (tmpCreated) try { fs.unlinkSync(tmpCreated); } catch (_) {}
  }

  if (docUrl) {
    const caption = `${event.ticketKey} — ${filename}${password ? ' 🔒' : ''}`;
    wa.sendDocument(docUrl, caption).catch(() => {});
  }
}

// ── Core ──────────────────────────────────────────────────────────────────────

function record(type, ticketKey = null, actor = 'system', details = {}) {
  const event = {
    id:        nextId++,
    ts:        new Date().toISOString(),
    type,
    ticketKey: ticketKey || null,
    actor,
    details,
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  _chartCache = null; // invalidate cached chart data on each new event
  // Deferred save: batches rapid back-to-back writes into a single disk flush
  if (!_dirty) {
    _dirty = true;
    setImmediate(saveLog);
  }
  fireWebhook(event);
  fireWhatsApp(event);
  return event;
}

// ── Queries ───────────────────────────────────────────────────────────────────

function getFiltered({ type, ticketKey, actor, from, to, page = 1, pageSize = 100 } = {}) {
  let r = events;
  if (type)      r = r.filter(e => e.type === type);
  if (ticketKey) r = r.filter(e => e.ticketKey && e.ticketKey.toUpperCase().includes(ticketKey.toUpperCase()));
  if (actor)     r = r.filter(e => e.actor === actor);
  if (from) {
    const fromMs = new Date(from).getTime();
    if (!isNaN(fromMs)) r = r.filter(e => new Date(e.ts).getTime() >= fromMs);
  }
  if (to) {
    const toMs = new Date(to).getTime();
    if (!isNaN(toMs)) r = r.filter(e => new Date(e.ts).getTime() <= toMs);
  }

  const total      = r.length;
  const desc       = [...r].reverse();
  const paged      = desc.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { events: paged, total, page, pageSize, totalPages };
}

function getStats() {
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  return {
    total:   events.length,
    last24h: events.filter(e => e.ts >= cutoff).length,
    byType:  events.reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {}),
  };
}

// ── Chart data ────────────────────────────────────────────────────────────────

let _chartCache    = null;
let _chartCachedAt = 0;
const CHART_TTL_MS = 60000; // recompute at most once per minute

function getChartData() {
  const now = Date.now();
  if (_chartCache && (now - _chartCachedAt) < CHART_TTL_MS) return _chartCache;
  _chartCache    = _buildChartData();
  _chartCachedAt = now;
  return _chartCache;
}

function _buildChartData() {
  const now  = Date.now();
  const nowD = new Date(now);

  // Hourly — last 24 h
  const hourStart = now - 24 * 3600000;
  const hourLabels = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(hourStart + i * 3600000);
    return d.getHours().toString().padStart(2, '0') + ':00';
  });
  const hourly = new Array(24).fill(0);
  for (const e of events) {
    const ms = new Date(e.ts).getTime();
    if (ms < hourStart) continue;
    const idx = Math.floor((ms - hourStart) / 3600000);
    if (idx >= 0 && idx < 24) hourly[idx]++;
  }

  // Daily — last 30 days
  const dayStart = now - 30 * 86400000;
  const dayLabels = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(dayStart + i * 86400000);
    return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
  });
  const daily = new Array(30).fill(0);
  for (const e of events) {
    const ms = new Date(e.ts).getTime();
    if (ms < dayStart) continue;
    const idx = Math.floor((ms - dayStart) / 86400000);
    if (idx >= 0 && idx < 30) daily[idx]++;
  }

  // Monthly — last 12 months (calendar-aligned)
  const monthLabels = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(nowD.getFullYear(), nowD.getMonth() - i, 1);
    monthLabels.push(d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
  }
  const monthly = new Array(12).fill(0);
  for (const e of events) {
    const d     = new Date(e.ts);
    const mDiff = (nowD.getFullYear() - d.getFullYear()) * 12 + (nowD.getMonth() - d.getMonth());
    const idx   = 11 - mDiff;
    if (idx >= 0 && idx < 12) monthly[idx]++;
  }

  // Tickets processed per day (last 30 days) — completed + failed
  const processed = new Array(30).fill(0);
  for (const e of events) {
    if (e.type !== 'ticket_completed' && e.type !== 'ticket_failed') continue;
    const ms = new Date(e.ts).getTime();
    if (ms < dayStart) continue;
    const idx = Math.floor((ms - dayStart) / 86400000);
    if (idx >= 0 && idx < 30) processed[idx]++;
  }

  // Token cost per day (last 30 days)
  const tokenCost = new Array(30).fill(0);
  for (const e of events) {
    if (e.type !== 'ticket_completed' || !e.details || e.details.costUsd == null) continue;
    const ms = new Date(e.ts).getTime();
    if (ms < dayStart) continue;
    const idx = Math.floor((ms - dayStart) / 86400000);
    if (idx >= 0 && idx < 30) {
      tokenCost[idx] = parseFloat((tokenCost[idx] + (e.details.costUsd || 0)).toFixed(6));
    }
  }

  return {
    hourly:    { labels: hourLabels,  data: hourly    },
    daily:     { labels: dayLabels,   data: daily     },
    monthly:   { labels: monthLabels, data: monthly   },
    processed: { labels: dayLabels,   data: processed },
    tokenCost: { labels: dayLabels,   data: tokenCost },
  };
}

function getAllTypes()  { return [...new Set(events.map(e => e.type))].sort(); }
function getAllActors() { return [...new Set(events.map(e => e.actor))].sort(); }

// ── Bootstrap ─────────────────────────────────────────────────────────────────
loadLog();
// Flush on process exit so nothing is lost on clean shutdown or signals
process.on('exit',    () => { if (_dirty) saveLog(); });
process.on('SIGINT',  () => { if (_dirty) saveLog(); process.exit(0); });
process.on('SIGTERM', () => { if (_dirty) saveLog(); process.exit(0); });

module.exports = { record, getFiltered, getStats, getChartData, getAllTypes, getAllActors, saveLog };
