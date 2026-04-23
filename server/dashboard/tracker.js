'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const serverStartedAt = new Date();

// ticketKey → ticket entry
const tickets = new Map();

// ── Stage definitions ─────────────────────────────────────────────────────────
// Edit server/dashboard/stages.json to add, remove, or rename pipeline stages.
// IDs must match what Claude announces in output ("Step X —") to be tracked as active.

const _stages = require('./stages.json');
const DEV_STAGES      = _stages.dev;
const REVIEW_STAGES   = _stages.review;
const ESTIMATE_STAGES = _stages.estimate;

function makeStagePipeline(stageList) {
  return stageList.map(s => ({ id: s.id, label: s.label, status: 'pending', startedAt: null, completedAt: null }));
}

// ── Directory helpers ─────────────────────────────────────────────────────────

function reportsDir() {
  return process.env.CLAUDE_REPORT_DIR || path.join(os.homedir(), '.prevoyant', 'reports');
}

function sessionsDir() {
  return path.join(os.homedir(), '.prevoyant', 'sessions');
}

// ── Report file discovery ─────────────────────────────────────────────────────

function findReportFiles(ticketKey) {
  const dir = reportsDir();
  const prefix = ticketKey.toLowerCase();
  try {
    return fs.readdirSync(dir)
      .filter(f => {
        const lower = f.toLowerCase();
        return (lower.startsWith(prefix + '_') || lower.startsWith(prefix + '-')) &&
               (lower.endsWith('.pdf') || lower.endsWith('.html'));
      })
      .map(f => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

// ── Session persistence ───────────────────────────────────────────────────────

function serializeDates(entry) {
  return {
    ...entry,
    queuedAt:    entry.queuedAt    ? entry.queuedAt.toISOString()    : null,
    startedAt:   entry.startedAt   ? entry.startedAt.toISOString()   : null,
    completedAt: entry.completedAt ? entry.completedAt.toISOString() : null,
    stages: (entry.stages || []).map(s => ({
      ...s,
      startedAt:   s.startedAt   ? s.startedAt.toISOString()   : null,
      completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    })),
  };
}

function deserializeDates(raw) {
  return {
    ...raw,
    queuedAt:    raw.queuedAt    ? new Date(raw.queuedAt)    : new Date(),
    startedAt:   raw.startedAt   ? new Date(raw.startedAt)   : null,
    completedAt: raw.completedAt ? new Date(raw.completedAt) : null,
    outputLog:   raw.outputLog   || [],
    stages: (raw.stages || []).map(s => ({
      ...s,
      startedAt:   s.startedAt   ? new Date(s.startedAt)   : null,
      completedAt: s.completedAt ? new Date(s.completedAt) : null,
    })),
  };
}

function saveSession(ticketKey) {
  const entry = tickets.get(ticketKey);
  if (!entry) return;
  const dir = sessionsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${ticketKey}-session.json`),
      JSON.stringify(serializeDates(entry), null, 2)
    );
  } catch (_) { /* best-effort */ }
}

function loadSessions() {
  const dir = sessionsDir();
  try {
    let count = 0;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('-session.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        const entry = deserializeDates(raw);
        if (entry.status === 'running' || entry.status === 'queued') {
          entry.status = 'interrupted';
          entry.completedAt = new Date();
          tickets.set(raw.ticketKey, entry);
          saveSession(raw.ticketKey); // persist corrected state to disk
        } else {
          tickets.set(raw.ticketKey, entry);
        }
        count++;
      } catch (_) { /* corrupt session file — skip */ }
    }
    if (count > 0) console.log(`[tracker] Restored ${count} session(s) from disk`);
  } catch (_) { /* sessions dir doesn't exist yet — fine */ }
}

// ── Ticket lifecycle ──────────────────────────────────────────────────────────

function recordQueued(ticketKey, source = 'webhook') {
  if (!tickets.has(ticketKey)) {
    tickets.set(ticketKey, {
      ticketKey, source, queuedAt: new Date(),
      startedAt: null, completedAt: null,
      status: 'queued', mode: null, stages: null, outputLog: [],
    });
    saveSession(ticketKey);
  }
}

function reRunTicket(ticketKey, mode = 'dev', source = 'manual') {
  // Delete stale session file before writing the fresh one
  try { fs.unlinkSync(path.join(sessionsDir(), `${ticketKey}-session.json`)); } catch (_) {}
  tickets.set(ticketKey, {
    ticketKey, source, queuedAt: new Date(),
    startedAt: null, completedAt: null,
    status: 'queued', mode, stages: null, outputLog: [],
  });
  saveSession(ticketKey);
}

function recordStarted(ticketKey) {
  const entry = tickets.get(ticketKey) || { ticketKey, source: 'unknown', queuedAt: new Date(), outputLog: [] };
  const updated = { ...entry, startedAt: new Date(), status: 'running' };
  tickets.set(ticketKey, updated);
  saveSession(ticketKey);
}

function recordCompleted(ticketKey, success) {
  const entry = tickets.get(ticketKey) || { ticketKey, source: 'unknown', queuedAt: new Date(), outputLog: [] };
  const now = new Date();
  const stages = (entry.stages || []).map(s => {
    if (s.status === 'active')  return { ...s, status: success ? 'done' : 'failed', completedAt: now };
    if (s.status === 'pending') return { ...s, status: 'skipped' };
    return s;
  });
  const updated = { ...entry, completedAt: new Date(), status: success ? 'success' : 'failed', stages };
  tickets.set(ticketKey, updated);
  saveSession(ticketKey);
}

function recordInterrupted(ticketKey) {
  const entry = tickets.get(ticketKey);
  if (!entry) return;
  const now = new Date();
  const stages = (entry.stages || []).map(s => {
    if (s.status === 'active')  return { ...s, status: 'failed', completedAt: now };
    if (s.status === 'pending') return { ...s, status: 'skipped' };
    return s;
  });
  tickets.set(ticketKey, { ...entry, completedAt: now, status: 'interrupted', stages });
  saveSession(ticketKey);
}

// ── Stage tracking ────────────────────────────────────────────────────────────

const OUTPUT_CAP = 2000;

function recordStepActive(ticketKey, stepId) {
  const entry = tickets.get(ticketKey);
  if (!entry) return;

  const upper = String(stepId).toUpperCase();
  const isReview   = upper.startsWith('R');
  const isEstimate = upper.startsWith('E');
  let stages = entry.stages;
  if (!stages) {
    if (isReview)        { stages = makeStagePipeline(REVIEW_STAGES);   entry.mode = 'review'; }
    else if (isEstimate) { stages = makeStagePipeline(ESTIMATE_STAGES); entry.mode = 'estimate'; }
    else                 { stages = makeStagePipeline(DEV_STAGES);       entry.mode = 'dev'; }
  }

  const normalised = String(stepId).toUpperCase();
  const now = new Date();
  const targetIdx = stages.findIndex(s => s.id === normalised);
  entry.stages = stages.map((s, i) => {
    if (s.id === normalised)   return { ...s, status: 'active',  startedAt: now };
    if (s.status === 'active') return { ...s, status: 'done',    completedAt: now };
    // Any pending stage that comes before the new active stage was jumped over
    if (s.status === 'pending' && targetIdx > -1 && i < targetIdx)
      return { ...s, status: 'skipped' };
    return s;
  });
  tickets.set(ticketKey, entry);
  saveSession(ticketKey);
}

function appendOutput(ticketKey, text) {
  const entry = tickets.get(ticketKey);
  if (!entry) return;
  if (entry.outputLog.length >= OUTPUT_CAP) entry.outputLog.shift();
  entry.outputLog.push({ ts: new Date(), text });
  // Persist every 10 entries so output survives a server restart mid-run
  if (entry.outputLog.length % 10 === 0) saveSession(ticketKey);
}

// ── Disk scan (historical tickets) ───────────────────────────────────────────

const REPORT_FILE_RE = /^([A-Za-z]+-\d+)[_-].+\.(pdf|html)$/i;

function scanReportsDir() {
  const dir = reportsDir();
  const diskMap = new Map();

  try {
    for (const file of fs.readdirSync(dir)) {
      const m = file.match(REPORT_FILE_RE);
      if (!m) continue;

      const ticketKey = m[1].toUpperCase();
      const mode = file.toLowerCase().includes('review') ? 'review' : 'dev';
      const fullPath = path.join(dir, file);

      if (!diskMap.has(ticketKey)) {
        let mtime = new Date();
        try { mtime = fs.statSync(fullPath).mtime; } catch (_) { /* ok */ }
        diskMap.set(ticketKey, {
          ticketKey, source: 'disk', status: 'success', mode,
          queuedAt: mtime, startedAt: null, completedAt: mtime,
          stages: null, outputLog: [], reportFiles: [],
        });
      }
      diskMap.get(ticketKey).reportFiles.push(fullPath);
    }
  } catch (_) { /* reports dir may not exist yet */ }

  return diskMap;
}

// ── Stats accessors ───────────────────────────────────────────────────────────

function getStats() {
  // Disk-scanned tickets are the baseline; live in-memory entries take priority.
  const merged = scanReportsDir();
  for (const [key, entry] of tickets) {
    merged.set(key, { ...entry, reportFiles: findReportFiles(key), outputLog: undefined });
  }

  return {
    serverStartedAt,
    uptimeSeconds: Math.floor((Date.now() - serverStartedAt) / 1000),
    reportsDir: reportsDir(),
    tickets: Array.from(merged.values()).sort((a, b) => (b.queuedAt || 0) - (a.queuedAt || 0)),
  };
}

function getTicket(ticketKey) {
  const entry = tickets.get(ticketKey);
  if (entry) return { ...entry, reportFiles: findReportFiles(ticketKey) };

  // Fall back to disk-only synthetic entry
  const diskMap = scanReportsDir();
  return diskMap.get(ticketKey) || null;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
loadSessions();

module.exports = {
  recordQueued, reRunTicket, recordStarted, recordCompleted, recordInterrupted,
  recordStepActive, appendOutput,
  getStats, getTicket,
};
