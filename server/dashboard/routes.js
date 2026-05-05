'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { getStats, getTicket, reRunTicket, recordScheduled, deleteTicket, hasActive } = require('./tracker');
const { killJob, enqueue, scheduleJob, prioritizeJob, pauseQueue, resumeQueue, isPaused, getQueueDepth } = require('../queue/jobQueue');
const activityLog = require('./activityLog');
const { getPollStatus } = require('../runner/pollScheduler');
const serverEvents  = require('../serverEvents');
const watchStore    = require('../watchers/watchStore');
const watchManager  = require('../watchers/watchManager');

const VALID_MODES    = new Set(['dev', 'review', 'estimate']);
const WATCH_LOG_DIR  = path.join(os.homedir(), '.prevoyant', 'watch', 'logs');

const config = require('../config/env');

function isInSeenCache(ticketKey) {
  try {
    return fs.readFileSync(config.seenCacheFile, 'utf8')
      .split('\n')
      .some(l => l.trim() === ticketKey);
  } catch (_) {
    return false;
  }
}

function removeFromSeenCache(ticketKey) {
  try {
    const lines = fs.readFileSync(config.seenCacheFile, 'utf8').split('\n');
    fs.writeFileSync(
      config.seenCacheFile,
      lines.filter(l => l.trim() !== ticketKey).join('\n')
    );
  } catch (_) { /* file missing — nothing to remove */ }
}

const router = express.Router();

// Plugin metadata — read once at startup
let pluginVersion = '—';
let pluginDescription = 'Claude Code plugin for structured Jira-driven developer workflow.';
let pluginAuthor = 'dodogeny';
const GITHUB_URL = 'https://github.com/dodogeny/prevoyant-claude-plugin';
try {
  const meta = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../plugin/.claude-plugin/plugin.json'), 'utf8')
  );
  pluginVersion    = meta.version     || '—';
  pluginDescription = meta.description || pluginDescription;
  pluginAuthor     = (meta.author && meta.author.name) || pluginAuthor;
} catch (_) { /* non-fatal */ }

// ── Update status helper ──────────────────────────────────────────────────────

const UPDATE_STATUS_FILE = path.join(os.homedir(), '.prevoyant', 'server', 'update-status.json');

function readUpdateStatus() {
  try { return JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8')); }
  catch (_) { return { available: false, latestVersion: null, currentVersion: null, checkedAt: null }; }
}

// ── Disk status helper ────────────────────────────────────────────────────────

const DISK_STATUS_FILE = path.join(os.homedir(), '.prevoyant', 'server', 'disk-status.json');
const DISK_LOG_FILE    = path.join(os.homedir(), '.prevoyant', 'server', 'disk-log.json');

function readDiskStatus() {
  try {
    return JSON.parse(fs.readFileSync(DISK_STATUS_FILE, 'utf8'));
  } catch (_) {
    return { pendingCleanup: false, prevoyantMB: 0, diskUsedPct: 0, updatedAt: null, lastCleanupAt: null };
  }
}

function readDiskLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(DISK_LOG_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ── Watch log stats ───────────────────────────────────────────────────────────

function getWatchLogStats() {
  let totalBytes = 0, fileCount = 0, ticketCount = 0, oldestMs = Infinity;
  try {
    const ticketDirs = fs.readdirSync(WATCH_LOG_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    ticketCount = ticketDirs.length;
    for (const td of ticketDirs) {
      const dir = path.join(WATCH_LOG_DIR, td.name);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.log')) continue;
          try {
            const s = fs.statSync(path.join(dir, f));
            totalBytes += s.size;
            fileCount++;
            if (s.mtimeMs < oldestMs) oldestMs = s.mtimeMs;
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  return {
    totalBytes,
    fileCount,
    ticketCount,
    oldestDate: oldestMs < Infinity ? new Date(oldestMs) : null,
    keepDays:   parseInt(process.env.PRX_WATCH_LOG_KEEP_DAYS        || '30', 10),
    keepPer:    parseInt(process.env.PRX_WATCH_LOG_KEEP_PER_TICKET  || '10', 10),
  };
}

// ── Claude budget helper ──────────────────────────────────────────────────────
// Cost is calculated from local token counts via codeburn (labelled "codeburn calc'd").

let _budgetCache    = null;
let _budgetCachedAt = 0;
const BUDGET_CACHE_MS = 120 * 1000;

// Fetch monthly spend from local codeburn (no network, reads JSONL files).
function fetchCodeburnMonthly() {
  const { execFile } = require('child_process');
  const now        = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const today      = now.toISOString().slice(0, 10);

  return new Promise(resolve => {
    execFile(
      'npx', ['--yes', 'codeburn@latest', 'report', '--from', monthStart, '--to', today, '--format', 'json'],
      { timeout: 30000, env: process.env },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch (_) { resolve(null); }
      }
    );
  });
}

function getBudgetStatus() {
  if (_budgetCache && (Date.now() - _budgetCachedAt) < BUDGET_CACHE_MS) {
    return Promise.resolve(_budgetCache);
  }

  const budget    = parseFloat(process.env.PRX_MONTHLY_BUDGET || '0') || null;
  const thisMonth = new Date().toISOString().slice(0, 7);

  return fetchCodeburnMonthly().then(cbData => {
    const available = cbData != null;
    if (!available) {
      const fallback = { available: false, spent: null, budget, remaining: null, pct: null, month: thisMonth, source: 'unavailable', tokens: null };
      _budgetCache    = fallback;
      _budgetCachedAt = Date.now();
      return fallback;
    }

    const spent     = parseFloat(cbData?.overview?.cost ?? 0);
    const source    = 'codeburn-calculated';
    const remaining = budget != null ? Math.max(0, budget - spent) : null;
    const pct       = budget ? Math.min(100, Math.round((spent / budget) * 100)) : null;
    const month     = thisMonth;

    // Token summary from codeburn (always local)
    const models = cbData?.models || [];
    const tokens = {
      input:         models.reduce((s, m) => s + (m.inputTokens  || 0), 0),
      output:        models.reduce((s, m) => s + (m.outputTokens || 0), 0),
      cacheCreation: models.reduce((s, m) => s + (m.cacheCreationTokens || 0), 0),
      cacheRead:     models.reduce((s, m) => s + (m.cacheReadTokens     || 0), 0),
      total:         models.reduce((s, m) => s + (m.totalTokens  || 0), 0),
      calculated:    spent,
      models:        models.map(m => ({
        name: m.model || m.modelName, cost: parseFloat(m.cost ?? 0),
        input: m.inputTokens || 0, output: m.outputTokens || 0,
        cacheRead: m.cacheReadTokens || 0, cacheCreate: m.cacheCreationTokens || 0,
      })),
    };

    const result = { available: true, spent, budget, remaining, pct, month, source, tokens };
    _budgetCache    = result;
    _budgetCachedAt = Date.now();
    return result;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTokensK(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

function formatUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmt(date) {
  if (!date) return '—';
  return date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
}

function dur(start, end) {
  if (!start) return '—';
  const ms = (end || new Date()) - start;
  const mins = Math.floor(ms / 60000), secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function fmtRelative(date) {
  if (!date) return null;
  const diffMs = date - Date.now();
  const abs    = Math.abs(diffMs);
  const past   = diffMs < 0;
  const mins   = Math.floor(abs / 60000);
  const hours  = Math.floor(abs / 3600000);
  const days   = Math.floor(abs / 86400000);
  let label;
  if (abs < 60000)         label = `${Math.floor(abs / 1000)}s`;
  else if (hours < 1)      label = `${mins}m`;
  else if (days < 1)       label = `${hours}h ${Math.floor((abs % 3600000) / 60000)}m`;
  else                     label = `${days}d ${Math.floor((abs % 86400000) / 3600000)}h`;
  return past ? `${label} ago` : `in ${label}`;
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

const BASE_CSS = `
  :root {
    --bg:           #f4f6fb;
    --surface:      #ffffff;
    --surface-2:    #f8fafc;
    --border:       #e4e9f0;
    --border-light: #f1f5f9;

    --text:   #0f172a;
    --text-2: #4a5568;
    --text-3: #94a3b8;

    --accent:       #6366f1;
    --accent-dim:   #eef2ff;
    --accent-hover: #4f46e5;

    --green:   #059669; --green-dim:  #d1fae5;
    --red:     #dc2626; --red-dim:    #fee2e2;
    --amber:   #d97706; --amber-dim:  #fef3c7;
    --blue:    #2563eb; --blue-dim:   #dbeafe;
    --purple:  #7c3aed; --purple-dim: #ede9fe;
    --orange:  #ea580c; --orange-dim: #fff7ed;

    --header-bg: #0f172a;
    --r-sm: 6px; --r-md: 10px; --r-lg: 14px;
    --shadow:    0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
    --shadow-md: 0 4px 12px rgba(15,23,42,.07), 0 1px 3px rgba(15,23,42,.04);
    --shadow-lg: 0 20px 48px rgba(15,23,42,.12), 0 4px 12px rgba(15,23,42,.06);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13.5px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Header ─────────────────────────────────────────────────── */
  header {
    background: var(--header-bg);
    color: #fff;
    padding: .85rem 1.75rem;
    display: flex;
    align-items: center;
    gap: .9rem;
    border-bottom: 1px solid rgba(255,255,255,.05);
    position: sticky;
    top: 0;
    z-index: 100;
  }

  header h1 {
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -.025em;
    display: flex;
    align-items: center;
    gap: .55rem;
    white-space: nowrap;
  }
  .sun-logo {
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: rgba(255,255,255,.35);
    transition: color .5s ease, filter .5s ease;
  }
  .sun-logo.processing {
    color: #fbbf24;
    filter: drop-shadow(0 0 5px rgba(251,191,36,.55));
  }
  .sun-logo.processing svg {
    animation: sun-spin 6s linear infinite;
  }
  @keyframes sun-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .version-badge {
    background: rgba(255,255,255,.07);
    border: 1px solid rgba(255,255,255,.12);
    color: #64748b;
    font-size: .66rem;
    padding: 2px 8px;
    border-radius: 20px;
    font-weight: 500;
    letter-spacing: .02em;
    white-space: nowrap;
  }

  .meta { font-size: .77rem; color: #475569; flex: 1; }
  .meta span { margin-right: 1rem; }

  .refresh-note {
    display: inline-flex; align-items: center; gap: .4rem;
    background: rgba(245,158,11,.07);
    border: 1px solid rgba(245,158,11,.18);
    border-radius: var(--r-sm);
    padding: .28rem .6rem;
    font-size: .71rem; color: #f59e0b; white-space: nowrap;
  }
  .refresh-select {
    background: transparent; border: none; color: #f59e0b;
    font-size: .71rem; font-family: inherit; cursor: pointer;
    padding: 0; outline: none; appearance: none; -webkit-appearance: none;
  }
  .refresh-select option { background: var(--header-bg); color: #fff; }

  /* ── Nav links ───────────────────────────────────────────────── */
  .settings-link {
    display: inline-flex; align-items: center; gap: .38rem;
    color: #64748b; text-decoration: none;
    font-size: .77rem; font-weight: 500;
    padding: .3rem .65rem;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    transition: background .15s, color .15s, border-color .15s;
    white-space: nowrap;
  }
  .settings-link:hover {
    background: rgba(255,255,255,.07); color: #cbd5e1;
    border-color: rgba(255,255,255,.1);
  }

  .header-btn {
    display: inline-flex; align-items: center; gap: .38rem;
    color: #64748b; background: none;
    font-size: .77rem; font-weight: 500;
    padding: .3rem .65rem;
    border-radius: var(--r-sm);
    border: 1px solid rgba(255,255,255,.1);
    cursor: pointer;
    transition: background .15s, color .15s;
    white-space: nowrap; font-family: inherit;
  }
  .header-btn:hover { background: rgba(255,255,255,.07); color: #cbd5e1; }
  .header-btn.icon-only { padding: .3rem .5rem; }
  .header-btn-active { background: rgba(245,158,11,.1); color: #fbbf24; border-color: rgba(245,158,11,.28); }
  .header-btn-active:hover { background: rgba(245,158,11,.16); color: #fcd34d; }

  /* ── Badges ──────────────────────────────────────────────────── */
  .badge {
    padding: 2px 10px; border-radius: 20px;
    font-size: .7rem; font-weight: 600; letter-spacing: .01em;
  }
  .badge-queued      { background: #f1f5f9;           color: #64748b; }
  .badge-running     { background: var(--blue-dim);   color: var(--blue); }
  .badge-success     { background: var(--green-dim);  color: var(--green); }
  .badge-failed      { background: var(--red-dim);    color: var(--red); }
  .badge-interrupted { background: var(--orange-dim); color: var(--orange); }
  .badge-scheduled   { background: var(--purple-dim); color: var(--purple); }
  .badge-retrying    { background: var(--amber-dim);  color: var(--amber); }

  .mode-badge { padding: 2px 8px; border-radius: 20px; font-size: .69rem; font-weight: 600; }
  .mode-dev      { background: var(--blue-dim);   color: var(--blue); }
  .mode-review   { background: var(--purple-dim); color: var(--purple); }
  .mode-estimate { background: var(--amber-dim);  color: var(--amber); }

  /* ── Interrupt banners ───────────────────────────────────────── */
  .interrupt-banner {
    display: flex; align-items: flex-start; gap: .9rem;
    padding: .95rem 1.2rem; border-radius: var(--r-md); border: 1px solid; margin-bottom: 1rem;
  }
  .interrupt-banner-budget_exceeded,
  .interrupt-banner-low_balance { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
  .interrupt-banner-manual      { background: var(--orange-dim); border-color: #fed7aa; color: #9a3412; }
  .interrupt-banner-server_restart { background: #f0f9ff; border-color: #bae6fd; color: #0c4a6e; }
  .interrupt-banner strong { display: block; font-weight: 600; margin-bottom: .2rem; font-size: .88rem; }
  .interrupt-banner p { margin: 0; font-size: .82rem; line-height: 1.55; }

  /* ── Utilities ───────────────────────────────────────────────── */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin .9s linear infinite; transform-origin: center; display: block; }

  .footer {
    text-align: center; padding: 1.5rem;
    font-size: .69rem; color: var(--text-3);
    border-top: 1px solid var(--border-light);
    margin-top: 2rem;
  }
`;

// ── Shared script (sun-logo processing indicator) ─────────────────────────────

const BASE_SCRIPT = `
  <script>
    (function () {
      const logo = document.getElementById('sun-logo');
      if (!logo) return;
      function checkBusy() {
        fetch('/dashboard/busy', { cache: 'no-store' })
          .then(r => r.json())
          .then(d => logo.classList.toggle('processing', !!d.busy))
          .catch(() => {});
      }
      checkBusy();
      setInterval(checkBusy, 4000);
    })();
  <\/script>
`;

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICONS = {
  queued:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  running: (n = 18) => `<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#0d6efd" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  success: (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#198754" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  failed:       (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  interrupted:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  skipped:      (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  scheduled:    (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#7e22ce" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="16" r="2"/></svg>`,
  retrying:     (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#c2410c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.49"/></svg>`,
};

function sessionIconBadge(status) {
  const labels = { queued: 'Queued', running: 'Running', success: 'Done', failed: 'Failed', interrupted: 'Interrupted', scheduled: 'Scheduled', retrying: 'Retrying' };
  return `<span title="${labels[status] || status}" style="display:inline-flex;align-items:center;gap:6px">
    ${(ICONS[status] || ICONS.queued)(18)}<span class="badge badge-${status}">${labels[status] || status}</span>
  </span>`;
}

// Lightweight server-side Markdown → HTML for the output log.
// Handles fenced code blocks, headers, bold/italic, inline code, tables,
// blockquotes, HR, and unordered/ordered lists. Keeps it dependency-free.
function renderMarkdown(raw) {
  let s = raw;

  // Fenced code blocks (``` ... ```) — must come before inline-code pass
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Escape remaining HTML (outside pre blocks) — replace per-segment
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/g);
  s = parts.map((p, i) => i % 2 === 1 ? p :
    p.replace(/&(?!amp;|lt;|gt;|quot;)/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  ).join('');

  // Horizontal rule
  s = s.replace(/^[-*]{3,}\s*$/gm, '<hr>');

  // ATX headings
  s = s.replace(/^#{4,6}\s+(.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^#{3}\s+(.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^#{2}\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^#{1}\s+(.+)$/gm, '<h2>$1</h2>');

  // Tables (simple: | col | col |)
  s = s.replace(/((?:^\|.+\|\s*\n?)+)/gm, tableBlock => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    const isSep = r => /^\|[-| :]+\|$/.test(r.trim());
    let html = '<table>';
    let headerDone = false;
    for (const row of rows) {
      if (isSep(row)) { headerDone = true; continue; }
      const cells = row.replace(/^\||\|$/g,'').split('|').map(c => c.trim());
      const tag = !headerDone ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      if (!headerDone) headerDone = true;
    }
    return html + '</table>';
  });

  // Blockquotes
  s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  s = s.replace(/((?:^[-*+]\s+.+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*+]\s+/,'')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  s = s.replace(/((?:^\d+\.\s+.+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/,'')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Inline: bold, italic, inline code
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs — wrap consecutive non-block lines in <p>
  s = s.replace(/^(?!<[a-z]|$)(.+)$/gm, (_, line) => `<p>${line}</p>`);

  return s;
}

function modeBadge(mode) {
  if (mode === 'dev')      return '<span class="mode-badge mode-dev">Dev</span>';
  if (mode === 'review')   return '<span class="mode-badge mode-review">Review</span>';
  if (mode === 'estimate') return '<span class="mode-badge mode-estimate">Estimate</span>';
  return '<span style="color:#ccc;font-size:0.82rem">—</span>';
}

function interruptReasonMessage(reason) {
  switch (reason) {
    case 'budget_exceeded':
      return 'Monthly budget limit reached — the job was stopped automatically to prevent overspend. Increase <code>PRX_MONTHLY_BUDGET</code> in your <code>.env</code> or wait for the next billing cycle.';
    case 'low_balance':
      return 'Anthropic account balance too low — the API returned a billing error mid-run. Top up your account balance or check your subscription to continue.';
    case 'server_restart':
      return 'Server was restarted while this job was running. Re-run the ticket to resume.';
    case 'timeout': {
      const mins = process.env.PRX_JOB_TIMEOUT_MINS || '?';
      return `Job exceeded the ${mins}-minute timeout limit (PRX_JOB_TIMEOUT_MINS). Increase the limit in Settings or optimise the job.`;
    }
    case 'manual':
    default:
      return 'Stopped manually by the user.';
  }
}

function renderSparkline(data, width = 140, height = 36) {
  const nonZero = data.filter(v => v > 0);
  if (nonZero.length < 2) return '<span style="font-size:.72rem;color:#d1d5db">no data</span>';
  const max = Math.max(...data);
  const pts = data.map((v, i) => {
    const x = ((i / (data.length - 1)) * width).toFixed(1);
    const y = (height - (v / max) * (height - 4) - 2).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const last = data[data.length - 1];
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <polyline points="${pts}" fill="none" stroke="#0d6efd" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${width}" y="${height}" text-anchor="end" font-size="9" fill="#9ca3af">$${last.toFixed(2)}</text>
  </svg>`;
}

function interruptBannerIcon(reason) {
  const urgent = reason === 'budget_exceeded' || reason === 'low_balance';
  const color = urgent ? '#dc2626' : reason === 'server_restart' ? '#0369a1' : '#ea580c';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px">${urgent ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}</svg>`;
}

// ── Token usage cell ──────────────────────────────────────────────────────────

function fmtTokens(n) {
  if (n == null) return '0';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function tokenCell(usage) {
  if (!usage) return '<span style="color:#ccc">—</span>';
  const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, costUsd, actualCostUsd } = usage;

  // Build cost line — prefer codeburn actual cost, fall back to stream-json estimate
  let costHtml = '';
  if (actualCostUsd != null) {
    costHtml = `<div style="display:flex;align-items:center;gap:5px">` +
      `<span style="font-size:.85rem;font-weight:700;color:#1a1a2e">$${actualCostUsd.toFixed(4)}</span>` +
      `<span style="font-size:.66rem;font-weight:600;padding:1px 5px;border-radius:4px;background:#dbeafe;color:#1d4ed8">codeburn</span>` +
      `</div>`;
    if (costUsd != null) {
      costHtml += `<div style="font-size:.72rem;color:#9ca3af">est. $${costUsd.toFixed(4)}</div>`;
    }
  } else if (costUsd != null) {
    costHtml = `<div style="font-size:.85rem;font-weight:700;color:#1a1a2e">$${costUsd.toFixed(4)}</div>`;
  }

  const cacheNote = cacheReadTokens > 0 ? ` · ${fmtTokens(cacheReadTokens)} cached` : '';
  const tooltipParts = [
    `Input: ${inputTokens.toLocaleString()}`,
    `Output: ${outputTokens.toLocaleString()}`,
    cacheReadTokens > 0 ? `Cache read: ${cacheReadTokens.toLocaleString()}` : '',
    actualCostUsd != null ? `codeburn cost: $${actualCostUsd.toFixed(6)}` : '',
    costUsd       != null ? `Stream est.: $${costUsd.toFixed(6)}`         : '',
  ].filter(Boolean).join(' · ');

  const tokensHtml = (inputTokens || outputTokens)
    ? `<div style="font-size:.74rem;color:#6b7280;white-space:nowrap">${fmtTokens(inputTokens)} in · ${fmtTokens(outputTokens)} out${cacheNote}</div>`
    : '';

  return `<div title="${tooltipParts}">${costHtml}${tokensHtml}</div>`;
}

// ── Report cell ───────────────────────────────────────────────────────────────

function reportCell(reportFiles) {
  if (!reportFiles || !reportFiles.length) return '<span style="color:#ccc">—</span>';
  return reportFiles.map(f => {
    const ext = path.extname(f).toUpperCase().replace('.', '');
    const base = path.basename(f);
    const enc = encodeURIComponent(f);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
      <span style="font-family:monospace;font-size:0.78rem;color:#555;word-break:break-all">${base}</span>
      <a href="/dashboard/download?path=${enc}" class="dl-btn" title="Download ${base}">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        ${ext}
      </a>
    </div>`;
  }).join('');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function renderDashboard(stats, budget) {
  const counts = stats.tickets.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const b = budget || {};
  const budgetPctColor = !b.available ? '#9ca3af'
    : b.pct == null     ? '#6b7280'
    : b.pct >= 90       ? '#dc2626'
    : b.pct >= 70       ? '#ea580c'
    : '#16a34a';
  const budgetBg = !b.available ? '#f3f4f6'
    : b.pct == null     ? '#f3f4f6'
    : b.pct >= 90       ? '#fee2e2'
    : b.pct >= 70       ? '#fff7ed'
    : '#dcfce7';
  const monthLabel = b.month
    ? new Date(b.month + '-01').toLocaleString('en-GB', { month: 'long', year: 'numeric' })
    : new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const rows = stats.tickets.map(t => {
    const isRunning   = t.status === 'running' || t.status === 'queued';
    const isScheduled = t.status === 'scheduled';
    const isRetrying  = t.status === 'retrying';
    const isBlocked   = isRunning || isScheduled || isRetrying;
    const isUrgent    = t.priority === 'urgent';
    const currentMode = t.mode || 'dev';

    const playBtn = `
      <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/run"
            style="display:inline-flex;align-items:center;gap:6px" onsubmit="return confirmRun(this)">
        <select name="mode" class="mode-select" title="Mode">
          <option value="dev"${currentMode === 'dev' ? ' selected' : ''}>Dev</option>
          <option value="review"${currentMode === 'review' ? ' selected' : ''}>Review</option>
          <option value="estimate"${currentMode === 'estimate' ? ' selected' : ''}>Estimate</option>
        </select>
        <button type="submit" class="play-btn" title="Run this ticket" ${isBlocked ? 'disabled' : ''}>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
               fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </form>`;

    let statusExtra = '';
    if (isScheduled && t.scheduledFor)
      statusExtra = `<div style="font-size:.72rem;color:#7e22ce;margin-top:3px" title="Fires ${fmtRelative(t.scheduledFor)}">${fmt(t.scheduledFor)}</div>`;
    if (isRetrying && t.nextRetryAt)
      statusExtra = `<div style="font-size:.72rem;color:#c2410c;margin-top:3px">Attempt ${t.retryAttempt}/${t.maxRetries} · ${fmtRelative(t.nextRetryAt)}</div>`;

    const stopConfirmMsg = isScheduled ? `Cancel the scheduled run for ${t.ticketKey}?`
      : isRetrying ? `Cancel the retry for ${t.ticketKey}?` : 'Stop this job?';

    const prioritiseBtnHtml = t.status === 'queued' ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/prioritize"
              style="display:inline" title="Move to front of queue">
          <button type="submit" class="pri-btn" title="Prioritise — move to front of queue">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>
            </svg>
          </button>
        </form>` : '';

    const priorityBadge = isUrgent
      ? `<span class="priority-badge">↑ Urgent</span>`
      : '';

    return `
    <tr class="${isRunning ? 'row-running' : isScheduled ? 'row-scheduled' : isRetrying ? 'row-retrying' : ''}">
      <td><a href="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}" class="ticket-link">${t.ticketKey}</a>${priorityBadge}</td>
      <td>${modeBadge(t.mode)}</td>
      <td><span class="source-tag ${t.source === 'disk' ? 'source-disk' : ''}">${t.source}</span></td>
      <td>${sessionIconBadge(t.status)}${statusExtra}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.queuedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.completedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${dur(t.startedAt, t.completedAt)}</td>
      <td>${tokenCell(t.tokenUsage)}</td>
      <td>${reportCell(t.reportFiles)}</td>
      <td style="display:flex;align-items:center;gap:6px">
        ${playBtn}
        ${prioritiseBtnHtml}
        ${isBlocked ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/stop"
              style="display:inline" onsubmit="return confirm('${stopConfirmMsg}')">
          <button type="submit" class="stop-btn" title="${stopConfirmMsg}">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                 fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          </button>
        </form>` : ''}
        ${!isRunning ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/delete"
              style="display:inline" onsubmit="return confirm('Delete ${t.ticketKey}?\\n\\nAll information about this ticket — session history, logs, and status — will be permanently lost. This cannot be undone.')">
          <button type="submit" class="del-btn" title="Delete this ticket">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </form>` : ''}
      </td>
    </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="10" style="text-align:center;color:#bbb;padding:2.5rem;font-size:0.9rem">No tickets yet — waiting for Jira events.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prevoyant Server — Dashboard</title>
  <style>
    ${BASE_CSS}
    /* ── Info strip ────────────────────────────────────────────── */
    .info-strip {
      display: flex; align-items: stretch;
      padding: 0 1.75rem;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .info-item {
      display: flex; align-items: center; gap: .6rem;
      padding: .75rem 1.4rem;
      border-right: 1px solid var(--border-light);
      flex-shrink: 0;
    }
    .info-item:first-child { padding-left: 0; }
    .info-item:last-child  { border-right: none; }
    .info-icon { color: #cbd5e1; flex-shrink: 0; }
    .info-text { display: flex; flex-direction: column; gap: 1px; }
    .info-lbl { font-size: .62rem; color: var(--text-3); text-transform: uppercase; letter-spacing: .09em; font-weight: 700; }
    .info-val { font-size: .8rem; color: var(--text); font-weight: 600; white-space: nowrap; }
    .info-val.muted { color: var(--text-3); font-weight: 500; }
    .info-val.ok    { color: var(--green); }
    .info-val.warn  { color: var(--amber); }

    /* ── Stat cards ─────────────────────────────────────────────── */
    .cards { display: flex; gap: .85rem; padding: 1.4rem 1.75rem 0; flex-wrap: wrap; }
    .card {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1rem 1.4rem; flex: 1; min-width: 88px;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
      position: relative; overflow: hidden;
    }
    .card::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
      background: var(--border-light); border-radius: var(--r-lg) var(--r-lg) 0 0;
    }
    .card.success::before { background: var(--green); }
    .card.failed::before  { background: var(--red); }
    .card.running::before { background: var(--accent); }
    .card .num { font-size: 1.85rem; font-weight: 700; line-height: 1; letter-spacing: -.03em; }
    .card .lbl { font-size: .67rem; color: var(--text-3); margin-top: 5px; text-transform: uppercase; letter-spacing: .07em; font-weight: 600; }
    .card.success .num { color: var(--green); }
    .card.failed  .num { color: var(--red); }
    .card.running .num { color: var(--accent); }

    /* ── Section / table ─────────────────────────────────────────── */
    .section { margin: 1.4rem 1.75rem 2rem; }
    .section h2 {
      font-size: .68rem; color: var(--text-3);
      text-transform: uppercase; letter-spacing: .09em; font-weight: 700;
      margin-bottom: .7rem;
    }
    table {
      width: 100%; border-collapse: collapse;
      background: var(--surface); border-radius: var(--r-lg); overflow: hidden;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
    }
    th {
      background: var(--surface-2); text-align: left;
      padding: .55rem 1rem; font-size: .67rem;
      text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); font-weight: 700;
      border-bottom: 1px solid var(--border);
    }
    td { padding: .7rem 1rem; border-top: 1px solid var(--border-light); vertical-align: middle; }
    tr:hover td { background: #fafbff; }
    tr.row-running   td { background: #f5f7ff; }
    tr.row-scheduled td { background: #faf7ff; }
    tr.row-retrying  td { background: #fffaf5; }

    /* ── Ticket link + tags ──────────────────────────────────────── */
    .ticket-link {
      font-weight: 700; font-size: .92rem; color: var(--text);
      text-decoration: none;
      border-bottom: 2px solid rgba(99,102,241,.25);
      transition: border-color .15s, color .15s;
    }
    .ticket-link:hover { border-bottom-color: var(--accent); color: var(--accent); }
    .source-tag  { font-size: .71rem; color: var(--text-3); background: var(--surface-2); padding: 2px 7px; border-radius: var(--r-sm); border: 1px solid var(--border-light); }
    .source-disk { background: var(--amber-dim); color: #854d0e; border-color: #fde68a; }

    /* ── Action buttons ──────────────────────────────────────────── */
    .dl-btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px; background: var(--text); color: #fff;
      border-radius: var(--r-sm); font-size: .7rem;
      text-decoration: none; font-weight: 500; transition: background .15s;
    }
    .dl-btn:hover { background: #1e293b; }
    .mode-select {
      font-size: .71rem; padding: 3px 5px;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface); color: var(--text-2); cursor: pointer;
    }
    .play-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--green); color: #fff; border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s;
    }
    .play-btn:hover:not([disabled]) { background: #047857; }
    .play-btn[disabled] { background: var(--border); color: var(--text-3); cursor: not-allowed; }
    .stop-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--red); color: #fff; border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s;
    }
    .stop-btn:hover { background: #b91c1c; }
    .del-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--surface-2); color: var(--text-3); border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s, color .15s;
    }
    .del-btn:hover { background: var(--red-dim); color: var(--red); }
    .pri-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--amber-dim); color: var(--amber); border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s;
    }
    .pri-btn:hover { background: #fde68a; }
    .priority-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: .66rem; font-weight: 700;
      color: var(--amber); background: var(--amber-dim);
      border: 1px solid #fde68a; border-radius: 4px;
      padding: 1px 5px; margin-left: 4px; vertical-align: middle;
    }

    /* ── Toast ───────────────────────────────────────────────────── */
    .upd-toast {
      position: fixed; bottom: 1.5rem; right: 1.5rem;
      background: #1e293b; color: #fff;
      padding: .6rem 1.1rem; border-radius: var(--r-md); font-size: .8rem; font-weight: 500;
      box-shadow: var(--shadow-lg); z-index: 1100; display: none;
      align-items: center; gap: .5rem; max-width: 340px;
    }
    .upd-toast.show { display: flex; }
    .upd-toast.ok   { background: #065f46; }
    .upd-toast.fail { background: #7f1d1d; }
    .upd-toast.info { background: #1e40af; }

    /* ── Modals ───────────────────────────────────────────────────── */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(15,23,42,.5);
      display: none; align-items: center; justify-content: center;
      z-index: 900; padding: 1rem; backdrop-filter: blur(2px);
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.6rem 1.8rem; width: 100%; max-width: 430px;
      box-shadow: var(--shadow-lg); animation: modalIn .18s ease;
      border: 1px solid var(--border);
    }
    @keyframes modalIn { from { opacity:0; transform:scale(.97) translateY(8px); } to { opacity:1; transform:none; } }
    .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.3rem; }
    .modal-title  { font-size: .97rem; font-weight: 700; color: var(--text); }
    .modal-close  {
      background: none; border: none; cursor: pointer; color: var(--text-3);
      padding: .25rem; border-radius: var(--r-sm);
      display: flex; align-items: center; transition: color .15s, background .15s;
    }
    .modal-close:hover { color: var(--text); background: var(--surface-2); }
    .modal-field  { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
    .modal-label  { font-size: .78rem; font-weight: 600; color: var(--text-2); }
    .modal-input  {
      padding: .5rem .78rem; border: 1px solid var(--border);
      border-radius: var(--r-md); font-size: .88rem;
      color: var(--text); font-family: inherit; transition: border-color .15s, box-shadow .15s;
      background: var(--surface);
    }
    .modal-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
    .modal-select {
      padding: .5rem .78rem; border: 1px solid var(--border);
      border-radius: var(--r-md); font-size: .88rem;
      color: var(--text); font-family: inherit; background: var(--surface); cursor: pointer;
    }
    .modal-actions { display: flex; gap: .6rem; margin-top: 1.4rem; justify-content: flex-end; }
    .modal-btn-primary {
      padding: .5rem 1.25rem; background: var(--accent); color: #fff; border: none;
      border-radius: var(--r-md); font-size: .85rem; font-weight: 600;
      cursor: pointer; transition: background .15s; font-family: inherit;
    }
    .modal-btn-primary:hover { background: var(--accent-hover); }
    .modal-btn-cancel {
      padding: .5rem 1rem; background: none;
      border: 1px solid var(--border); color: var(--text-2);
      border-radius: var(--r-md); font-size: .85rem; cursor: pointer;
      transition: border-color .15s, color .15s; font-family: inherit;
    }
    .modal-btn-cancel:hover { border-color: #94a3b8; color: var(--text); }
    .info-desc { font-size: .86rem; color: var(--text-2); line-height: 1.65; margin-bottom: 1rem; }
    .info-row   { display:flex; align-items:center; gap:.6rem; font-size:.82rem; color:#374151;
                  padding:.45rem 0; border-top:1px solid #f3f4f6; }
    .info-row svg { flex-shrink:0; color:#9ca3af; }
    .info-row a  { color:#0d6efd; text-decoration:none; font-weight:500; }
    .info-row a:hover { text-decoration:underline; }
    .info-modes { display:flex; gap:.5rem; flex-wrap:wrap; margin:.8rem 0 .4rem; }
    .info-mode-pill { font-size:.76rem; font-weight:600; padding:3px 10px; border-radius:20px; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta"></div>
    <button type="button" class="header-btn" onclick="openModal('add-ticket-modal')">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add Ticket
    </button>
    <button type="button" class="header-btn" onclick="openModal('bulk-add-modal')" title="Queue multiple tickets at once">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      Bulk Add
    </button>
    <button type="button" id="pause-btn" class="header-btn${isPaused() ? ' header-btn-active' : ''}" onclick="toggleQueuePause()" title="${isPaused() ? 'Resume queue' : 'Pause queue — stop new jobs from starting'}">
      ${isPaused()
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause Queue`}
    </button>
    <button type="button" class="header-btn icon-only" id="check-update-btn" title="Check for updates" onclick="checkForUpdates()">
      <svg id="check-update-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>
    </button>
    <button type="button" class="header-btn icon-only" title="About Prevoyant" onclick="openModal('info-modal')">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    </button>
    <a href="/dashboard/activity" class="settings-link" title="Activity Log">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Activity
    </a>
    <a href="/dashboard/watch" class="settings-link" title="Ticket Watcher">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    ${readDiskStatus().pendingCleanup
      ? `<a href="/dashboard/disk" class="settings-link" title="Disk Monitor — cleanup pending" style="color:#ea580c">`
      : `<a href="/dashboard/disk" class="settings-link" title="Disk Monitor">`}
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
      Disk${readDiskStatus().pendingCleanup ? ' ⚑' : ''}
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
    <div class="refresh-note">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      Refresh every
      <select class="refresh-select" id="refresh-select" onchange="setRefreshInterval(this.value)">
        <option value="5">5s</option>
        <option value="30" selected>30s</option>
        <option value="60">1 min</option>
        <option value="180">3 min</option>
        <option value="300">5 min</option>
        <option value="600">10 min</option>
      </select>
    </div>
  </header>

  ${(() => {
    const upd = readUpdateStatus();
    if (!upd.available) return '';
    return `
  <div id="update-banner" style="background:#fffbeb;border-bottom:1px solid #fcd34d;padding:.6rem 1.4rem;display:flex;align-items:center;gap:.8rem;font-size:.875rem;">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <span style="color:#92400e;flex:1">
      <strong>Update available</strong> &mdash; v${upd.latestVersion} is ready (you have v${upd.currentVersion}).
      <a href="https://github.com/dodogeny/prevoyant-claude-plugin/releases" target="_blank" rel="noopener" style="color:#b45309;margin-left:.4rem">View changes</a>
    </span>
    <button onclick="upgradePlugin()" id="upgrade-btn" style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:.35rem .9rem;font-size:.82rem;font-weight:600;cursor:pointer;font-family:inherit">
      Upgrade now
    </button>
    <button onclick="document.getElementById('update-banner').remove()" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:1rem;padding:0 .2rem" title="Dismiss">&#x2715;</button>
  </div>
  <script>
    function upgradePlugin() {
      const btn = document.getElementById('upgrade-btn');
      btn.disabled = true;
      btn.textContent = 'Upgrading…';
      fetch('/dashboard/upgrade', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            btn.textContent = 'Done — restarting…';
            setTimeout(() => location.reload(), 4000);
          } else {
            btn.textContent = 'Failed';
            btn.style.background = '#dc2626';
            alert('Upgrade failed:\\n' + (d.error || 'Unknown error'));
          }
        })
        .catch(e => {
          btn.textContent = 'Failed';
          btn.style.background = '#dc2626';
          alert('Upgrade error: ' + e.message);
        });
    }
  </script>`;
  })()}

  ${(() => {
    const ps = getPollStatus();
    let pollingVal, pollingClass, startupVal, startupClass;
    if (ps.enabled) {
      const next = ps.nextRunAt ? fmtRelative(ps.nextRunAt) : '—';
      const last = ps.lastRanAt ? fmtRelative(ps.lastRanAt) : 'never';
      pollingVal = `<span title="Last ran: ${last}">Every ${ps.intervalDays}d &middot; next ${next}</span>`;
      pollingClass = 'ok';
    } else {
      pollingVal = 'Disabled';
      pollingClass = 'muted';
    }
    if (ps.enabled && ps.nextRunAt) {
      startupVal = fmtRelative(ps.nextRunAt);
      startupClass = 'ok';
    } else if (!ps.enabled && ps.fallbackRanAt) {
      startupVal = 'No scheduled scan';
      startupClass = 'muted';
    } else {
      startupVal = '—';
      startupClass = 'muted';
    }
    return `
  <div class="info-strip">
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div class="info-text">
        <span class="info-lbl">Uptime</span>
        <span class="info-val">${formatUptime(stats.uptimeSeconds)}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <div class="info-text">
        <span class="info-lbl">Started</span>
        <span class="info-val">${fmt(stats.serverStartedAt)}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <div class="info-text">
        <span class="info-lbl">Reports</span>
        <span class="info-val" title="${stats.reportsDir}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${stats.reportsDir}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <div class="info-text">
        <span class="info-lbl">Polling</span>
        <span class="info-val ${pollingClass}">${pollingVal}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <div class="info-text">
        <span class="info-lbl">Next Scan</span>
        <span class="info-val ${startupClass}">${startupVal}</span>
      </div>
    </div>
    <div class="info-item" title="${b.available ? `${monthLabel} · $${(b.spent||0).toFixed(4)} · source: ${b.source}` : 'Budget data unavailable'}">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <div class="info-text">
        <span class="info-lbl">Budget ${b.month ? '(' + b.month + ')' : ''}</span>
        ${b.available
          ? (b.budget
              ? `<span class="info-val" style="color:${budgetPctColor}">$${(b.remaining||0).toFixed(2)} left</span>
                 <span style="font-size:.7rem;color:#b0b7c3">$${(b.spent||0).toFixed(2)} / $${b.budget.toFixed(2)} &middot; ⚪ calc</span>`
              : `<span class="info-val">$${(b.spent||0).toFixed(2)} spent</span>
                 <span style="font-size:.7rem;color:#b0b7c3">⚪ codeburn calc'd</span>`)
          : `<span class="info-val muted">unavailable</span>`}
      </div>
    </div>
  </div>`;
  })()}

  ${isPaused() ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:.6rem 1rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.6rem;font-size:.83rem;color:#92400e">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    <strong>Queue paused</strong> — no new jobs will start until you resume. Running jobs are unaffected.
    <button onclick="toggleQueuePause()" style="margin-left:auto;padding:.25rem .75rem;background:#d97706;color:#fff;border:none;border-radius:5px;font-size:.78rem;cursor:pointer;font-family:inherit">Resume Queue</button>
  </div>` : ''}
  <div class="cards">
    <div class="card"><div class="num">${stats.tickets.length}</div><div class="lbl">Total</div></div>
    <div class="card running"><div class="num">${counts.running || 0}</div><div class="lbl">Running</div></div>
    <div class="card success"><div class="num">${counts.success || 0}</div><div class="lbl">Succeeded</div></div>
    <div class="card failed"><div class="num">${counts.failed || 0}</div><div class="lbl">Failed</div></div>
    <div class="card"><div class="num">${counts.queued || 0}</div><div class="lbl">Queued</div></div>
    <div class="card" style="min-width:170px;flex:1.2" title="Daily cost from completed jobs — last 30 days">
      <div class="lbl" style="margin-bottom:.35rem">Cost trend — 30d</div>
      ${renderSparkline(activityLog.getChartData().tokenCost.data)}
    </div>
    ${b.available ? `
    <div class="card" style="min-width:240px;flex:2;background:${budgetBg};border:1px solid ${budgetPctColor}22">
      <!-- header row: label + source badge + pct -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.45rem">
        <div>
          <div style="display:flex;align-items:center;gap:.4rem">
            <div class="lbl" style="color:${budgetPctColor};opacity:.8">Claude Budget &mdash; ${monthLabel}</div>
            <span style="font-size:.62rem;font-weight:700;padding:1px 5px;border-radius:4px;background:#f3f4f6;color:#6b7280;white-space:nowrap" title="Calculated from token counts × pricing — may differ from actual billing">codeburn calc'd</span>
          </div>
          <div style="font-size:1.55rem;font-weight:700;color:${budgetPctColor};line-height:1.1;margin-top:3px">
            ${b.budget
              ? `$${(b.remaining||0).toFixed(2)} <span style="font-size:.9rem;font-weight:500;color:${budgetPctColor};opacity:.7">remaining</span>`
              : `$${(b.spent||0).toFixed(2)} <span style="font-size:.9rem;font-weight:500;opacity:.7">spent</span>`}
          </div>
        </div>
        ${b.pct != null ? `<div style="font-size:1.6rem;font-weight:800;color:${budgetPctColor};opacity:.85">${b.pct}%</div>` : ''}
      </div>
      <!-- progress bar -->
      ${b.budget ? `
      <div style="height:6px;border-radius:3px;background:#00000015;overflow:hidden;margin-bottom:.3rem">
        <div style="height:100%;width:${b.pct}%;background:${budgetPctColor};border-radius:3px;transition:width .4s"></div>
      </div>
      <div style="font-size:.72rem;color:${budgetPctColor};opacity:.75;margin-bottom:.45rem">$${(b.spent||0).toFixed(2)} spent of $${b.budget.toFixed(2)} budget</div>` : `
      <div style="font-size:.72rem;color:${budgetPctColor};opacity:.75;margin-bottom:.45rem">Set PRX_MONTHLY_BUDGET in Settings to track remaining</div>`}
      <!-- token breakdown from codeburn -->
      ${b.tokens ? `
      <div style="border-top:1px solid ${budgetPctColor}18;padding-top:.4rem;display:flex;flex-wrap:wrap;gap:.3rem .7rem">
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Input tokens">${fmtTokensK(b.tokens.input)} in</span>
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Cache read tokens">${fmtTokensK(b.tokens.cacheRead)} cached</span>
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Cache creation tokens">${fmtTokensK(b.tokens.cacheCreation)} cache-write</span>
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Output tokens">${fmtTokensK(b.tokens.output)} out</span>
      </div>` : ''}
    </div>` : ''}
  </div>

  <div class="section">
    <h2>Processed Tickets <span style="font-weight:400;color:#aaa;font-size:0.72rem;text-transform:none;letter-spacing:0">(includes reports found in ${stats.reportsDir})</span></h2>
    <table>
      <thead>
        <tr>
          <th>Ticket</th><th>Type</th><th>Source</th><th>Session</th>
          <th>Queued at</th><th>Completed at</th><th>Duration</th><th>Tokens</th><th>Report</th><th>Run</th>
        </tr>
      </thead>
      <tbody>${stats.tickets.length ? rows : emptyRow}</tbody>
    </table>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion} &mdash; Dashboard &mdash; ${new Date().toLocaleString('en-GB')}</div>

  <!-- Add Ticket Modal -->
  <div class="modal-overlay" id="add-ticket-modal" onclick="overlayClick(event,'add-ticket-modal')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Add Ticket to Queue</span>
        <button class="modal-close" onclick="closeModal('add-ticket-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-ticket-key">Jira Ticket Key</label>
        <input type="text" id="modal-ticket-key" class="modal-input" placeholder="e.g. IV-1234"
               autocomplete="off" spellcheck="false" style="text-transform:uppercase"
               onkeydown="if(event.key==='Enter')submitAddTicket()">
        <span id="modal-key-err" style="font-size:.76rem;color:#dc2626;display:none">Please enter a ticket key.</span>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-ticket-mode">Mode</label>
        <select id="modal-ticket-mode" class="modal-select">
          <option value="dev">Dev</option>
          <option value="review">Review</option>
          <option value="estimate">Estimate</option>
        </select>
      </div>
      <div class="modal-field" style="flex-direction:row;align-items:center;gap:.6rem">
        <input type="checkbox" id="modal-priority" style="width:15px;height:15px;accent-color:#c2410c;cursor:pointer">
        <label for="modal-priority" class="modal-label" style="cursor:pointer;margin:0">
          Urgent priority <span style="font-size:.72rem;font-weight:400;color:#9ca3af">— moves to front of queue</span>
        </label>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-scheduled-at">Schedule for <span style="font-size:.72rem;font-weight:400;color:#9ca3af">(optional — leave blank to run now)</span></label>
        <input type="datetime-local" id="modal-scheduled-at" class="modal-input" style="color-scheme:light">
        <span id="modal-sched-err" style="font-size:.76rem;color:#dc2626;display:none">Scheduled time must be in the future.</span>
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('add-ticket-modal')">Cancel</button>
        <button type="button" class="modal-btn-primary" onclick="submitAddTicket()">Add to Queue</button>
      </div>
    </div>
  </div>

  <!-- Bulk Add Modal -->
  <div class="modal-overlay" id="bulk-add-modal" onclick="overlayClick(event,'bulk-add-modal')">
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <span class="modal-title">Bulk Add Tickets</span>
        <button class="modal-close" onclick="closeModal('bulk-add-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="bulk-keys">Ticket Keys <span style="font-size:.72rem;font-weight:400;color:#9ca3af">— comma or newline separated, max 20</span></label>
        <textarea id="bulk-keys" class="modal-input" rows="5" placeholder="IV-1234, IV-1235&#10;IV-1236" style="resize:vertical;font-family:monospace"></textarea>
        <span id="bulk-key-err" style="font-size:.76rem;color:#dc2626;display:none"></span>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="bulk-mode">Mode</label>
        <select id="bulk-mode" class="modal-select">
          <option value="dev">Dev</option>
          <option value="review">Review</option>
          <option value="estimate">Estimate</option>
        </select>
      </div>
      <div id="bulk-result" style="font-size:.82rem;color:#166534;background:#dcfce7;border-radius:6px;padding:.5rem .75rem;display:none"></div>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('bulk-add-modal')">Cancel</button>
        <button type="button" class="modal-btn-primary" onclick="submitBulkAdd()">Queue All</button>
      </div>
    </div>
  </div>

  <!-- Info Modal -->
  <div class="modal-overlay" id="info-modal" onclick="overlayClick(event,'info-modal')">
    <div class="modal" style="max-width:460px">
      <div class="modal-header">
        <span class="modal-title">Prevoyant</span>
        <button class="modal-close" onclick="closeModal('info-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p class="info-desc">${pluginDescription}</p>
      <div class="info-modes">
        <span class="info-mode-pill mode-dev">Dev</span>
        <span class="info-mode-pill mode-review">Review</span>
        <span class="info-mode-pill mode-estimate">Estimate</span>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Version <strong>v${pluginVersion}</strong>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
        <a href="${GITHUB_URL}" target="_blank" rel="noopener">${GITHUB_URL}</a>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Author: <strong>${pluginAuthor}</strong>
      </div>
      <div class="modal-actions" style="margin-top:1rem">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('info-modal')">Close</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="update-check-modal" onclick="overlayClick(event,'update-check-modal')">
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <span class="modal-title">Update Available</span>
        <button class="modal-close" onclick="closeModal('update-check-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p id="update-check-msg" style="font-size:.88rem;color:#4b5563;line-height:1.6;margin-bottom:1.2rem"></p>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('update-check-modal')">Later</button>
        <button type="button" id="update-modal-upgrade-btn" onclick="upgradeFromModal()"
          style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:.4rem 1rem;font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit">
          Upgrade Now
        </button>
      </div>
    </div>
  </div>

  <div id="upd-toast" class="upd-toast">
    <span id="upd-toast-msg"></span>
  </div>

  <script>
    function confirmRun(form) {
      const key  = form.action.split('/ticket/')[1].split('/run')[0];
      const mode = form.querySelector('select[name=mode]').value;
      return confirm('Run ' + decodeURIComponent(key) + ' in ' + mode + ' mode?');
    }

    // ── Auto-refresh ──────────────────────────────────────────────────────────
    const REFRESH_KEY = 'prv_dashboard_refresh';
    let refreshTimer = null;

    function setRefreshInterval(seconds) {
      const s = parseInt(seconds, 10);
      localStorage.setItem(REFRESH_KEY, s);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => location.reload(), s * 1000);
    }

    (function initRefresh() {
      const saved = parseInt(localStorage.getItem(REFRESH_KEY) || '30', 10);
      const sel = document.getElementById('refresh-select');
      // Apply saved preference to the dropdown (find closest option)
      if (sel) {
        const opt = [...sel.options].find(o => parseInt(o.value) === saved);
        if (opt) sel.value = opt.value;
      }
      setRefreshInterval(saved);
    })();
    function openModal(id) {
      document.getElementById(id).classList.add('open');
      if (id === 'add-ticket-modal') {
        setTimeout(() => document.getElementById('modal-ticket-key').focus(), 50);
      }
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
      if (id === 'add-ticket-modal') {
        document.getElementById('modal-ticket-key').value = '';
        document.getElementById('modal-scheduled-at').value = '';
        document.getElementById('modal-priority').checked = false;
        document.getElementById('modal-key-err').style.display = 'none';
        document.getElementById('modal-sched-err').style.display = 'none';
      }
    }
    function overlayClick(e, id) {
      if (e.target === document.getElementById(id)) closeModal(id);
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        ['add-ticket-modal','info-modal','update-check-modal'].forEach(id => {
          if (document.getElementById(id).classList.contains('open')) closeModal(id);
        });
      }
    });
    function showUpdToast(msg, type, duration) {
      const t = document.getElementById('upd-toast');
      document.getElementById('upd-toast-msg').textContent = msg;
      t.className = 'upd-toast show' + (type ? ' ' + type : '');
      clearTimeout(t._tid);
      if (duration !== 0) t._tid = setTimeout(() => t.classList.remove('show'), duration || 3000);
    }
    function checkForUpdates() {
      const btn  = document.getElementById('check-update-btn');
      const icon = document.getElementById('check-update-icon');
      btn.disabled = true;
      icon.classList.add('spin');
      fetch('/dashboard/check-update', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          btn.disabled = false;
          icon.classList.remove('spin');
          if (!d.ok) { showUpdToast('Check failed: ' + (d.error || 'Unknown error'), 'fail'); return; }
          if (d.available) {
            document.getElementById('update-check-msg').textContent =
              'v' + d.latestVersion + ' is available (you have v' + d.currentVersion + '). Would you like to upgrade now?';
            openModal('update-check-modal');
          } else {
            showUpdToast('Already up to date — v' + d.currentVersion, 'ok');
          }
        })
        .catch(e => {
          btn.disabled = false;
          icon.classList.remove('spin');
          showUpdToast('Check failed: ' + e.message, 'fail');
        });
    }
    function upgradeFromModal() {
      const upgradeBtn = document.getElementById('update-modal-upgrade-btn');
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = 'Upgrading…';
      closeModal('update-check-modal');
      showUpdToast('Upgrading — please wait…', 'info', 0);
      fetch('/dashboard/upgrade', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            showUpdToast('Upgraded — restarting in 4s…', 'ok', 0);
            setTimeout(() => location.reload(), 4000);
          } else {
            showUpdToast('Upgrade failed: ' + (d.error || 'Unknown error'), 'fail');
          }
        })
        .catch(e => showUpdToast('Upgrade error: ' + e.message, 'fail'));
    }
    function submitAddTicket() {
      const keyEl   = document.getElementById('modal-ticket-key');
      const key     = keyEl.value.trim().toUpperCase();
      const keyErr  = document.getElementById('modal-key-err');
      if (!key) { keyErr.style.display = ''; keyEl.focus(); return; }
      keyErr.style.display = 'none';

      const schedEl  = document.getElementById('modal-scheduled-at');
      const schedVal = schedEl.value;
      const schedErr = document.getElementById('modal-sched-err');
      if (schedVal) {
        const schedDate = new Date(schedVal);
        if (isNaN(schedDate) || schedDate <= new Date()) {
          schedErr.style.display = ''; schedEl.focus(); return;
        }
      }
      schedErr.style.display = 'none';

      const mode     = document.getElementById('modal-ticket-mode').value;
      const priority = document.getElementById('modal-priority').checked ? 'urgent' : 'normal';
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/dashboard/queue';
      const fields = [['ticketKey', key], ['mode', mode], ['priority', priority]];
      if (schedVal) fields.push(['scheduledAt', schedVal]);
      fields.forEach(([n, v]) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = n; i.value = v;
        form.appendChild(i);
      });
      document.body.appendChild(form);
      form.submit();
    }

    async function toggleQueuePause() {
      const btn = document.getElementById('pause-btn');
      const paused = btn && btn.classList.contains('header-btn-active');
      try {
        const res = await fetch('/dashboard/queue/' + (paused ? 'resume' : 'pause'), { method: 'POST' });
        if (res.ok) location.reload();
      } catch (_) {}
    }

    async function submitBulkAdd() {
      const raw  = document.getElementById('bulk-keys').value;
      const mode = document.getElementById('bulk-mode').value;
      const err  = document.getElementById('bulk-key-err');
      const result = document.getElementById('bulk-result');
      err.style.display = 'none';
      result.style.display = 'none';

      const keys = [...new Set(raw.split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(k => /^[A-Z]+-\d+$/.test(k)))];
      if (keys.length === 0) { err.textContent = 'No valid ticket keys found (expected format: PROJ-123).'; err.style.display = ''; return; }
      if (keys.length > 20) { err.textContent = 'Maximum 20 tickets per bulk run.'; err.style.display = ''; return; }

      try {
        const res  = await fetch('/dashboard/tickets/bulk-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'keys=' + encodeURIComponent(keys.join(',')) + '&mode=' + encodeURIComponent(mode),
        });
        const data = await res.json();
        result.textContent = data.queued + ' ticket(s) queued' + (data.skipped ? ', ' + data.skipped + ' skipped (already running/queued).' : '.');
        result.style.display = '';
        setTimeout(() => location.reload(), 1500);
      } catch (_) { err.textContent = 'Failed to queue tickets.'; err.style.display = ''; }
    }
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Activity page ─────────────────────────────────────────────────────────────

const EVENT_DISPLAY = {
  server_started:     { label: 'Server Started',     bg: '#dbeafe', color: '#1d4ed8' },
  webhook_received:   { label: 'Webhook Received',   bg: '#e0f2fe', color: '#0369a1' },
  webhook_skipped:    { label: 'Webhook Skipped',    bg: '#f3f4f6', color: '#6b7280' },
  poll_triggered:     { label: 'Poll Triggered',     bg: '#f3e8ff', color: '#7e22ce' },
  ticket_queued:      { label: 'Queued',             bg: '#f3f4f6', color: '#6b7280' },
  ticket_rerun:       { label: 'Re-run',             bg: '#e0f2fe', color: '#0369a1' },
  ticket_scheduled:   { label: 'Scheduled',          bg: '#f3e8ff', color: '#7e22ce' },
  ticket_started:     { label: 'Started',            bg: '#dbeafe', color: '#1d4ed8' },
  ticket_completed:   { label: 'Completed',          bg: '#dcfce7', color: '#166534' },
  ticket_failed:      { label: 'Failed',             bg: '#fee2e2', color: '#991b1b' },
  ticket_interrupted: { label: 'Interrupted',        bg: '#fff7ed', color: '#9a3412' },
  ticket_retrying:    { label: 'Retrying',           bg: '#fff7ed', color: '#c2410c' },
  ticket_deleted:     { label: 'Deleted',            bg: '#fee2e2', color: '#991b1b' },
  ticket_prioritized: { label: 'Prioritized',        bg: '#e0f2fe', color: '#0369a1' },
  stage_active:       { label: 'Stage Active',       bg: '#eff6ff', color: '#1d4ed8' },
  settings_saved:     { label: 'Settings Saved',     bg: '#f3f4f6', color: '#374151' },
  kb_exported:        { label: 'KB Exported',        bg: '#dcfce7', color: '#166534' },
  kb_imported:        { label: 'KB Imported',        bg: '#dcfce7', color: '#166534' },
  disk_cleanup:       { label: 'Disk Cleanup',       bg: '#fef3c7', color: '#92400e' },
};

const ACTOR_STYLE = {
  system:  { bg: '#f3f4f6', color: '#6b7280' },
  user:    { bg: '#dbeafe', color: '#1d4ed8' },
  jira:    { bg: '#fef3c7', color: '#92400e' },
  webhook: { bg: '#fef3c7', color: '#92400e' },
  manual:  { bg: '#dcfce7', color: '#166534' },
};

function renderActivity(results, chartData, allTypes, allActors, actStats, filters) {
  const { events: evts, total, page, pageSize, totalPages } = results;
  const f = filters || {};

  function eventBadge(type) {
    const m = EVENT_DISPLAY[type] || { label: type, bg: '#f3f4f6', color: '#6b7280' };
    return `<span style="padding:2px 8px;border-radius:8px;font-size:.73rem;font-weight:600;white-space:nowrap;background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  function actorBadge(actor) {
    const m = ACTOR_STYLE[actor] || { bg: '#f3f4f6', color: '#6b7280' };
    return `<span style="padding:2px 8px;border-radius:8px;font-size:.73rem;font-weight:600;background:${m.bg};color:${m.color}">${esc(actor)}</span>`;
  }

  function fmtDetails(details) {
    if (!details || Object.keys(details).length === 0) return '<span style="color:#d1d5db">—</span>';
    return Object.entries(details)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => {
        const sv = String(v);
        const display = sv.length > 48 ? sv.slice(0, 48) + '…' : sv;
        return `<span style="font-size:.73rem;color:#9ca3af">${esc(k)}=</span><span style="font-size:.73rem;font-weight:600;color:#374151">${esc(display)}</span>`;
      }).join('  ');
  }

  const rows = evts.map(e => {
    const dt = new Date(e.ts);
    const dateStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ticketCell = e.ticketKey
      ? `<a href="/dashboard/ticket/${encodeURIComponent(e.ticketKey)}" style="font-weight:700;font-size:.88rem;color:#1a1a2e;text-decoration:none;border-bottom:2px solid #0d6efd44;transition:border-color .15s" onmouseover="this.style.borderBottomColor='#0d6efd'" onmouseout="this.style.borderBottomColor='#0d6efd44'">${esc(e.ticketKey)}</a>`
      : '<span style="color:#d1d5db">—</span>';
    return `<tr>
      <td>
        <div style="font-size:.78rem;font-weight:600;color:#374151;white-space:nowrap">${timeStr}</div>
        <div style="font-size:.7rem;color:#9ca3af">${dateStr}</div>
      </td>
      <td>${eventBadge(e.type)}</td>
      <td>${ticketCell}</td>
      <td>${actorBadge(e.actor)}</td>
      <td style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmtDetails(e.details)}</td>
    </tr>`;
  }).join('');

  // Always show every defined event type even before it has been observed
  const allKnownTypes = [...new Set([...Object.keys(EVENT_DISPLAY), ...allTypes])].sort();
  const typeOptions = ['', ...allKnownTypes].map(t =>
    `<option value="${esc(t)}"${(f.type || '') === t ? ' selected' : ''}>${t ? ((EVENT_DISPLAY[t] || {}).label || t) : 'All types'}</option>`
  ).join('');

  const actorOptions = ['', ...allActors].map(a =>
    `<option value="${esc(a)}"${(f.actor || '') === a ? ' selected' : ''}>${a || 'All actors'}</option>`
  ).join('');

  function pageUrl(p) {
    const params = new URLSearchParams();
    if (f.type)      params.set('type', f.type);
    if (f.ticketKey) params.set('ticketKey', f.ticketKey);
    if (f.actor)     params.set('actor', f.actor);
    if (f.from)      params.set('from', f.from);
    if (f.to)        params.set('to', f.to);
    if (p > 1)       params.set('page', p);
    const qs = params.toString();
    return '/dashboard/activity' + (qs ? '?' + qs : '');
  }

  const prevPage = page > 1 ? page - 1 : null;
  const nextPage = page < totalPages ? page + 1 : null;
  const paginationHtml = totalPages > 1 ? `
    <div class="act-pager">
      ${prevPage ? `<a href="${pageUrl(prevPage)}" class="pg-btn">‹ Prev</a>` : `<span class="pg-btn pg-off">‹ Prev</span>`}
      <span class="pg-info">Page ${page} of ${totalPages}</span>
      ${nextPage ? `<a href="${pageUrl(nextPage)}" class="pg-btn">Next ›</a>` : `<span class="pg-btn pg-off">Next ›</span>`}
    </div>` : '';

  const hasFilters = f.type || f.ticketKey || f.actor || f.from || f.to;

  const topType = Object.entries(actStats.byType).sort((a, b) => b[1] - a[1])[0];
  const topTypeLabel = topType ? ((EVENT_DISPLAY[topType[0]] || {}).label || topType[0]) : '—';

  const showFrom = evts.length ? (page - 1) * pageSize + 1 : 0;
  const showTo   = (page - 1) * pageSize + evts.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Activity Log — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .page { max-width: 1400px; margin: 0 auto; padding: 1.5rem 1.75rem 4rem; }
    .breadcrumb { font-size: .78rem; color: #64748b; }
    .breadcrumb a { color: #64748b; text-decoration: none; }
    .breadcrumb a:hover { color: #e2e8f0; }
    .act-stats { display: flex; gap: .85rem; flex-wrap: wrap; margin-bottom: 1.4rem; }
    .act-stat {
      background: var(--surface); border-radius: var(--r-lg);
      padding: .85rem 1.3rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
      display: flex; flex-direction: column; gap: 3px; min-width: 130px;
    }
    .act-stat-lbl { font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--text-3); }
    .act-stat-val { font-size: 1.5rem; font-weight: 700; color: var(--text); line-height: 1.1; letter-spacing: -.02em; }
    .act-stat-val.small { font-size: .92rem; padding-top: 3px; letter-spacing: 0; }
    .charts-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: .85rem; margin-bottom: 1.4rem; }
    @media(max-width:900px) { .charts-grid { grid-template-columns: 1fr 1fr; } }
    @media(max-width:560px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-card {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.1rem 1.2rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
    }
    .chart-title {
      font-size: .67rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: var(--text-3);
      margin-bottom: .9rem;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .4rem;
    }
    .period-btns { display: flex; gap: 3px; }
    .period-btn {
      font-size: .66rem; font-weight: 600; padding: 2px 8px;
      border: 1px solid var(--border); border-radius: 5px;
      cursor: pointer; background: var(--surface-2); color: var(--text-3);
      transition: all .12s; font-family: inherit;
    }
    .period-btn.active { background: var(--text); color: #fff; border-color: var(--text); }
    .filter-bar {
      background: var(--surface); border-radius: var(--r-lg);
      padding: .9rem 1.1rem; margin-bottom: .7rem;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
    }
    .filter-row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: flex-end; }
    .filter-field { display: flex; flex-direction: column; gap: .28rem; }
    .filter-lbl { font-size: .68rem; font-weight: 600; color: var(--text-2); }
    .filter-sel, .filter-inp {
      padding: .36rem .6rem; border: 1px solid var(--border);
      border-radius: var(--r-sm); font-size: .82rem;
      color: var(--text); font-family: inherit; height: 30px;
      background: var(--surface); transition: border-color .15s;
    }
    .filter-sel:focus, .filter-inp:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
    .filter-btn {
      padding: .36rem 1rem; background: var(--text); color: #fff; border: none;
      border-radius: var(--r-sm); font-size: .82rem; font-weight: 600;
      cursor: pointer; height: 30px; font-family: inherit; transition: background .15s;
    }
    .filter-btn:hover { background: #1e293b; }
    .filter-clear {
      font-size: .75rem; color: var(--accent); text-decoration: none; font-weight: 600;
      height: 30px; display: inline-flex; align-items: center;
    }
    .filter-clear:hover { color: var(--accent-hover); }
    .results-meta { font-size: .74rem; color: var(--text-3); margin-bottom: .4rem; }
    table {
      width: 100%; border-collapse: collapse;
      background: var(--surface); border-radius: var(--r-lg); overflow: hidden;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
    }
    th {
      background: var(--surface-2); text-align: left;
      padding: .52rem 1rem; font-size: .66rem;
      text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); font-weight: 700;
      border-bottom: 1px solid var(--border);
    }
    td { padding: .65rem 1rem; border-top: 1px solid var(--border-light); vertical-align: middle; }
    tr:hover td { background: #fafbff; }
    .act-pager { display: flex; align-items: center; gap: .75rem; padding: .85rem 0; }
    .pg-btn {
      padding: .35rem .85rem; background: var(--surface);
      border: 1px solid var(--border); border-radius: var(--r-sm);
      font-size: .8rem; font-weight: 600; text-decoration: none;
      color: var(--text-2); transition: background .12s;
    }
    .pg-btn:hover:not(.pg-off) { background: var(--surface-2); }
    .pg-off { color: var(--border); pointer-events: none; }
    .pg-info { font-size: .76rem; color: var(--text-3); }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Activity Log</span>
    </div>
  </header>

  <div class="page">

    <!-- Stats strip -->
    <div class="act-stats">
      <div class="act-stat">
        <span class="act-stat-lbl">Total Events</span>
        <span class="act-stat-val">${actStats.total.toLocaleString()}</span>
      </div>
      <div class="act-stat">
        <span class="act-stat-lbl">Last 24 h</span>
        <span class="act-stat-val">${actStats.last24h.toLocaleString()}</span>
      </div>
      ${topType ? `<div class="act-stat">
        <span class="act-stat-lbl">Most Common</span>
        <span class="act-stat-val small">${esc(topTypeLabel)}</span>
      </div>` : ''}
      <div class="act-stat">
        <span class="act-stat-lbl">Event Types</span>
        <span class="act-stat-val">${allTypes.length}</span>
      </div>
    </div>

    <!-- Charts -->
    <div class="charts-grid">
      <div class="chart-card">
        <div class="chart-title">
          Activity Over Time
          <div class="period-btns">
            <button class="period-btn active" onclick="setPeriod('hourly',this)">Hourly</button>
            <button class="period-btn"        onclick="setPeriod('daily',this)">Daily</button>
            <button class="period-btn"        onclick="setPeriod('monthly',this)">Monthly</button>
          </div>
        </div>
        <div style="position:relative;height:170px"><canvas id="chart-activity"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">
          Tickets Processed
          <span style="font-size:.62rem;color:#b0b7c3;font-weight:400;text-transform:none;letter-spacing:0">30 days</span>
        </div>
        <div style="position:relative;height:170px"><canvas id="chart-tickets"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">
          Token Cost (USD)
          <span style="font-size:.62rem;color:#b0b7c3;font-weight:400;text-transform:none;letter-spacing:0">30 days</span>
        </div>
        <div style="position:relative;height:170px"><canvas id="chart-cost"></canvas></div>
      </div>
    </div>

    <!-- Filters -->
    <div class="filter-bar">
      <form method="GET" action="/dashboard/activity">
        <div class="filter-row">
          <div class="filter-field">
            <label class="filter-lbl">Event Type</label>
            <select name="type" class="filter-sel">${typeOptions}</select>
          </div>
          <div class="filter-field">
            <label class="filter-lbl">Ticket Key</label>
            <input type="text" name="ticketKey" value="${esc(f.ticketKey || '')}" placeholder="e.g. IV-123" class="filter-inp" style="width:120px">
          </div>
          <div class="filter-field">
            <label class="filter-lbl">Actor</label>
            <select name="actor" class="filter-sel">${actorOptions}</select>
          </div>
          <div class="filter-field">
            <label class="filter-lbl">From</label>
            <input type="datetime-local" name="from" value="${esc(f.from || '')}" class="filter-inp" style="color-scheme:light">
          </div>
          <div class="filter-field">
            <label class="filter-lbl">To</label>
            <input type="datetime-local" name="to" value="${esc(f.to || '')}" class="filter-inp" style="color-scheme:light">
          </div>
          <button type="submit" class="filter-btn">Apply</button>
          ${hasFilters ? `<a href="/dashboard/activity" class="filter-clear">Clear</a>` : ''}
        </div>
      </form>
    </div>

    <div class="results-meta">Showing ${showFrom}–${showTo} of ${total.toLocaleString()} event${total !== 1 ? 's' : ''}</div>

    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Event</th>
          <th>Ticket</th>
          <th>Actor</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5" style="text-align:center;color:#bbb;padding:2.5rem;font-size:.88rem">No events found${hasFilters ? ' — try clearing the filters' : ''}.</td></tr>`}
      </tbody>
    </table>

    ${paginationHtml}
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion}</div>

  <script>
    const CD = ${JSON.stringify(chartData)};
    let actChart = null;

    const BAR_STYLE = { backgroundColor: 'rgba(99,102,241,0.72)', borderColor: '#6366f1', borderWidth: 1, borderRadius: 3 };
    const CHART_OPT = (yFmt) => ({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index' } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 40, autoSkip: true, maxTicksLimit: 12 } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0, ...(yFmt ? { callback: yFmt } : {}) } },
      },
    });

    function mkBar(id, labels, data, style) {
      const ctx = document.getElementById(id);
      if (!ctx) return null;
      return new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Count', data, ...BAR_STYLE, ...(style||{}) }] }, options: CHART_OPT() });
    }

    function mkLine(id, labels, data, opts) {
      const ctx = document.getElementById(id);
      if (!ctx) return null;
      return new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [{ label: opts.label || '', data, borderColor: opts.color, backgroundColor: opts.fill,
                                     borderWidth: 2, pointRadius: 2, fill: true, tension: 0.35 }] },
        options: CHART_OPT(opts.yFmt),
      });
    }

    function setPeriod(p, btn) {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (actChart) { actChart.data.labels = CD[p].labels; actChart.data.datasets[0].data = CD[p].data; actChart.update(); }
    }

    (function () {
      actChart = mkBar('chart-activity', CD.hourly.labels, CD.hourly.data);
      mkBar('chart-tickets', CD.processed.labels, CD.processed.data,
        { backgroundColor: 'rgba(22,163,74,0.68)', borderColor: '#16a34a' });
      mkLine('chart-cost', CD.tokenCost.labels, CD.tokenCost.data, {
        label: 'USD', color: '#6366f1', fill: 'rgba(99,102,241,0.09)',
        yFmt: v => '$' + v.toFixed(4),
      });
    })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── .env helpers ─────────────────────────────────────────────────────────────

const ENV_PATH = path.resolve(__dirname, '../../.env');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readEnvValues() {
  const v = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) v[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return v;
}

function writeEnvValues(updates) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch (_) {}
  const applied = new Set();
  const updated = content.split('\n').map(line => {
    const active = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (active && active[1] in updates) {
      applied.add(active[1]);
      return `${active[1]}=${updates[active[1]]}`;
    }
    const commented = line.match(/^#\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (commented && commented[1] in updates && !applied.has(commented[1]) && updates[commented[1]] !== '') {
      applied.add(commented[1]);
      return `${commented[1]}=${updates[commented[1]]}`;
    }
    return line;
  });
  const extra = Object.entries(updates)
    .filter(([k, v]) => !applied.has(k) && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, updated.join('\n') + (extra.length ? '\n' + extra.join('\n') : ''), 'utf8');

  // Keep process.env in sync so in-process reads see the new values immediately.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

// ── KB helpers ────────────────────────────────────────────────────────────────

function kbDir() {
  return process.env.PRX_KNOWLEDGE_DIR || path.join(os.homedir(), '.prevoyant', 'knowledge-base');
}

function countFilesRecursive(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try { n += fs.statSync(full).isDirectory() ? countFilesRecursive(full) : 1; } catch (_) {}
    }
  } catch (_) {}
  return n;
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length; } catch (_) { return 0; }
}

function kbStats() {
  const kb        = kbDir();
  const sessions  = path.join(os.homedir(), '.prevoyant', 'sessions');
  const reports   = process.env.CLAUDE_REPORT_DIR || path.join(os.homedir(), '.prevoyant', 'reports');
  const serverDir = path.join(os.homedir(), '.prevoyant', 'server');
  const watchLogs = path.join(os.homedir(), '.prevoyant', 'watch', 'logs');
  const memoryDir = path.join(os.homedir(), '.prevoyant', 'memory');
  return {
    kbDir:      kb,
    kbExists:   fs.existsSync(kb),
    kbFiles:    countFilesRecursive(kb),
    sessions,
    sessionFiles: countFiles(sessions),
    reports,
    reportFiles:  countFiles(reports),
    serverDir,
    serverFiles:   countFiles(serverDir),
    watchLogs,
    watchLogFiles: countFilesRecursive(watchLogs),
    memoryDir,
    memoryFiles:   countFilesRecursive(memoryDir),
  };
}

// ── Disk Monitor page ─────────────────────────────────────────────────────────

function renderDisk(status, diskLog, flash) {
  const wlStats = getWatchLogStats();
  const pendingCleanup  = status.pendingCleanup || false;
  const prevoyantMB     = status.prevoyantMB  || 0;
  const diskUsedPct     = status.diskUsedPct  || 0;
  const diskFree        = status.diskFree     || 0;
  const diskTotal       = status.diskTotal    || 0;
  const lastCleanupAt   = status.lastCleanupAt  ? new Date(status.lastCleanupAt) : null;
  const updatedAt       = status.updatedAt      ? new Date(status.updatedAt)     : null;
  const maxSizeMB         = status.maxSizeMB           || 500;
  const alertPct          = status.alertPct             || 80;
  const alertThresholdMB  = status.alertThresholdMB     || (maxSizeMB * alertPct / 100);
  const cleanupInterval   = status.cleanupIntervalDays  || 7;
  const monitorEnabled  = process.env.PRX_DISK_MONITOR_ENABLED === 'Y';
  const kbProtected     = kbDir();

  // Build chart data from log (last 48 entries for hourly or last 30 for daily)
  const recent = diskLog.slice(-48);
  const chartLabels = recent.map(e => {
    const d = new Date(e.ts);
    return d.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  });
  const chartPrevoyant = recent.map(e => e.prevoyantMB || 0);
  const chartDiskPct   = recent.map(e => e.diskUsedPct || 0);

  const quotaUsedPct = maxSizeMB > 0 ? Math.min(Math.round((prevoyantMB / maxSizeMB) * 100), 100) : 0;
  const quotaColor   = prevoyantMB >= alertThresholdMB ? '#dc2626' : quotaUsedPct >= alertPct * 0.85 ? '#ea580c' : '#6366f1';
  const quotaBg      = prevoyantMB >= alertThresholdMB ? '#fee2e2' : quotaUsedPct >= alertPct * 0.85 ? '#fff7ed' : '#ede9fe';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Disk Monitor — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .breadcrumb { font-size: .78rem; color: #64748b; }
    .breadcrumb a { color: #64748b; text-decoration: none; }
    .breadcrumb a:hover { color: #e2e8f0; }
    .page-body { max-width: 1000px; margin: 1.75rem auto; padding: 0 1.75rem; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); gap: .85rem; margin-bottom: 1.4rem; }
    .stat-card {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.1rem 1.3rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
    }
    .stat-lbl { font-size: .62rem; text-transform: uppercase; letter-spacing: .09em; color: var(--text-3); font-weight: 700; margin-bottom: .4rem; }
    .stat-val { font-size: 1.6rem; font-weight: 700; line-height: 1; color: var(--text); letter-spacing: -.025em; }
    .stat-sub { font-size: .73rem; color: var(--text-3); margin-top: .3rem; }
    .section  {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.4rem 1.6rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light); margin-bottom: 1.4rem;
    }
    .section h2 { font-size: .97rem; font-weight: 700; color: var(--text); margin-bottom: 1rem; }
    .progress-bar { height: 10px; border-radius: 20px; background: var(--surface-2); overflow: hidden; margin: .4rem 0; border: 1px solid var(--border-light); }
    .progress-fill { height: 100%; border-radius: 20px; transition: width .4s; }
    .banner {
      display: flex; align-items: flex-start; gap: .7rem;
      padding: .9rem 1.1rem; border-radius: var(--r-md);
      margin-bottom: 1.2rem; font-size: .84rem;
    }
    .banner-warn { background: var(--amber-dim); border: 1px solid #fde68a; color: #92400e; }
    .banner-info { background: var(--blue-dim);  border: 1px solid #bfdbfe; color: #1e3a8a; }
    .banner-ok   { background: var(--green-dim); border: 1px solid #a7f3d0; color: #065f46; }
    .cleanup-form { margin-top: 1rem; }
    .btn-approve {
      background: var(--orange); color: #fff; border: none;
      border-radius: var(--r-sm); padding: .5rem 1.2rem;
      font-size: .83rem; font-weight: 600; cursor: pointer; font-family: inherit; transition: background .15s;
    }
    .btn-approve:hover { background: #c2410c; }
    .btn-dismiss {
      background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border);
      border-radius: var(--r-sm); padding: .5rem 1rem;
      font-size: .83rem; font-weight: 500; cursor: pointer; margin-left: .6rem; font-family: inherit; transition: background .15s;
    }
    .btn-dismiss:hover { background: var(--border); }
    .detail-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: .5rem 0; border-bottom: 1px solid var(--border-light); font-size: .83rem;
    }
    .detail-row:last-child { border-bottom: none; }
    .detail-key { color: var(--text-2); }
    .detail-val { font-weight: 600; color: var(--text); }
    canvas { max-height: 220px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Disk Monitor</span>
    </div>
    <a href="/dashboard/settings#disk-monitor" class="settings-link" style="margin-left:auto">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>

  <div class="page-body">
    ${!monitorEnabled ? `
    <div class="banner banner-info">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>Disk Monitor is <strong>disabled</strong>. Enable it in <a href="/dashboard/settings" style="color:#1e40af">Settings → Disk Monitor</a> to start tracking disk usage automatically.</span>
    </div>` : ''}

    ${pendingCleanup ? `
    <div class="banner banner-warn">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <div style="flex:1">
        <strong>Scheduled cleanup is due</strong> — house-cleaning will remove old session files and trim server logs under <code style="background:#fed7aa;padding:1px 4px;border-radius:3px">~/.prevoyant/</code>.
        Last cleanup: ${lastCleanupAt ? lastCleanupAt.toLocaleString('en-GB') : 'never'}.
        Cleanup interval: every ${cleanupInterval} day(s).
        <div class="cleanup-form">
          <form method="POST" action="/dashboard/disk/approve-cleanup" onsubmit="return confirm('Run house-cleaning now?\\n\\n• Old session files (>30 days) will be deleted\\n• Server logs will be trimmed\\n• Watch poll logs will be pruned\\n\\nThis cannot be undone.')">
            <button type="submit" class="btn-approve">Approve Cleanup</button>
            <button type="button" class="btn-dismiss" onclick="dismissCleanup()">Dismiss for now</button>
          </form>
        </div>
      </div>
    </div>` : `
    <div class="banner banner-ok">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span>No cleanup pending. ${lastCleanupAt ? 'Last cleanup: ' + lastCleanupAt.toLocaleString('en-GB') + '.' : 'No cleanup has been run yet.'} ${cleanupInterval > 0 ? `Next check in ~${cleanupInterval} day(s).` : 'Auto-cleanup is disabled.'}</span>
    </div>`}

    <!-- Stat cards -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-lbl">.prevoyant Size</div>
        <div class="stat-val" style="color:${quotaColor}">${prevoyantMB.toFixed(1)} <span style="font-size:1rem;font-weight:500;color:#9ca3af">MB</span></div>
        <div class="stat-sub">Quota: ${maxSizeMB} MB (${quotaUsedPct}% used)</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Alert Threshold</div>
        <div class="stat-val" style="color:${quotaColor};font-size:1.3rem">${alertThresholdMB.toFixed(0)} MB</div>
        <div class="stat-sub">${alertPct}% of ${maxSizeMB} MB quota</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Free Disk Space</div>
        <div class="stat-val" style="font-size:1.3rem">${fmtBytes(diskFree)}</div>
        <div class="stat-sub">Disk used: ${diskUsedPct}% of ${fmtBytes(diskTotal)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Last Updated</div>
        <div class="stat-val" style="font-size:1rem;font-weight:600">${updatedAt ? updatedAt.toLocaleTimeString('en-GB') : '—'}</div>
        <div class="stat-sub">${updatedAt ? updatedAt.toLocaleDateString('en-GB') : 'No data yet'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Watch Logs</div>
        <div class="stat-val" style="font-size:1.3rem">${fmtBytes(wlStats.totalBytes)}</div>
        <div class="stat-sub">${wlStats.fileCount} file${wlStats.fileCount !== 1 ? 's' : ''} · ${wlStats.ticketCount} ticket${wlStats.ticketCount !== 1 ? 's' : ''}</div>
      </div>
    </div>

    <!-- Quota bar -->
    <div class="section">
      <h2>.prevoyant Quota</h2>
      <div style="display:flex;justify-content:space-between;font-size:.8rem;color:#6b7280;margin-bottom:.3rem">
        <span>${prevoyantMB.toFixed(1)} MB used of ${maxSizeMB} MB quota</span>
        <span style="font-weight:700;color:${quotaColor}">${quotaUsedPct}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${quotaUsedPct}%;background:${quotaColor}"></div>
      </div>
      <div style="font-size:.75rem;color:#9ca3af;margin-top:.3rem">Alert fires when <code style="background:#f3f4f6;padding:1px 4px;border-radius:3px">~/.prevoyant/</code> reaches ${alertThresholdMB.toFixed(0)} MB (${alertPct}% of ${maxSizeMB} MB quota)</div>
    </div>

    <!-- Chart -->
    ${diskLog.length > 1 ? `
    <div class="section">
      <h2>Usage Over Time</h2>
      <canvas id="diskChart"></canvas>
    </div>` : `
    <div class="section">
      <div style="text-align:center;color:#9ca3af;padding:2rem;font-size:.9rem">No history yet — data will appear after the first monitor tick.</div>
    </div>`}

    <!-- Detail table -->
    <div class="section">
      <h2>Details</h2>
      <div class="detail-row">
        <span class="detail-key">Monitor status</span>
        <span class="detail-val">${monitorEnabled ? '<span style="color:#16a34a">Enabled</span>' : '<span style="color:#9ca3af">Disabled</span>'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Check interval</span>
        <span class="detail-val">${process.env.PRX_DISK_MONITOR_INTERVAL_MINS || 60} minutes</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Size quota</span>
        <span class="detail-val">${maxSizeMB} MB</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Alert threshold</span>
        <span class="detail-val">${alertThresholdMB.toFixed(0)} MB (${alertPct}% of quota)</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Cleanup interval</span>
        <span class="detail-val">${cleanupInterval > 0 ? `Every ${cleanupInterval} days` : 'Disabled'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Last cleanup</span>
        <span class="detail-val">${lastCleanupAt ? lastCleanupAt.toLocaleString('en-GB') : 'Never'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">History entries</span>
        <span class="detail-val">${diskLog.length}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Watch log files</span>
        <span class="detail-val">${wlStats.fileCount} files · ${fmtBytes(wlStats.totalBytes)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Watch log retention</span>
        <span class="detail-val">Last ${wlStats.keepPer} per ticket · max ${wlStats.keepDays} days</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Oldest watch log</span>
        <span class="detail-val">${wlStats.oldestDate ? wlStats.oldestDate.toLocaleString('en-GB') : '—'}</span>
      </div>
    </div>

    <!-- Cleanup controls -->
    <div class="section">
      <h2>House-cleaning</h2>

      ${flash === 'cleaned' ? `
      <div class="banner banner-ok" style="margin-bottom:1rem">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>Cleanup completed successfully.</span>
      </div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.2rem">
        <!-- Will clean -->
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:.9rem 1rem">
          <div style="font-size:.75rem;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.07em;margin-bottom:.6rem">Will clean</div>
          <ul style="list-style:none;font-size:.83rem;color:#15803d;line-height:1.7">
            <li>✓ Session directories older than 30 days<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/sessions/</span></li>
            <li>✓ Trim disk history log to last 200 entries<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/server/disk-log.json</span></li>
            <li>✓ Trim activity log to last 2 000 entries<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/server/activity-log.json</span></li>
            <li>✓ Watch poll logs older than ${wlStats.keepDays} days &amp; beyond last ${wlStats.keepPer} per ticket<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/watch/logs/</span></li>
          </ul>
        </div>
        <!-- Protected -->
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:.9rem 1rem">
          <div style="font-size:.75rem;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:.07em;margin-bottom:.6rem">Never touched</div>
          <ul style="list-style:none;font-size:.83rem;color:#b91c1c;line-height:1.7">
            <li>✗ Knowledge base files<br><span style="font-size:.75rem;color:#f87171;opacity:.9;word-break:break-all">${kbProtected}</span></li>
            <li>✗ Reports</li>
            <li>✗ .env configuration</li>
            <li>✗ Sessions younger than 30 days</li>
          </ul>
        </div>
      </div>

      <form method="POST" action="/dashboard/disk/approve-cleanup"
            onsubmit="return confirm('Run immediate house-cleaning?\\n\\n✓ Deletes session directories older than 30 days\\n✓ Trims disk history and activity logs\\n✓ Trims watch poll logs (>${wlStats.keepDays}d or beyond last ${wlStats.keepPer} per ticket)\\n\\n✗ Will NOT touch knowledge base, reports, or .env\\n\\nThis cannot be undone.')">
        <button type="submit" class="btn-approve">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:5px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Run Cleanup Now
        </button>
        <span style="font-size:.78rem;color:#9ca3af;margin-left:.8rem">Safe to run at any time — KB files are never affected.</span>
      </form>
    </div>
  </div>

  <div class="footer">Prevoyant Server &mdash; Disk Monitor</div>

  <script>
    ${diskLog.length > 1 ? `
    const ctx = document.getElementById('diskChart').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(chartLabels)},
        datasets: [
          {
            label: '.prevoyant (MB)',
            data: ${JSON.stringify(chartPrevoyant)},
            borderColor: '#6366f1', backgroundColor: '#6366f133',
            tension: 0.3, fill: true, yAxisID: 'yMB',
          },
          {
            label: 'Disk Used (%)',
            data: ${JSON.stringify(chartDiskPct)},
            borderColor: '#f59e0b', backgroundColor: 'transparent',
            tension: 0.3, fill: false, yAxisID: 'yPct', borderDash: [4,3],
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top' } },
        scales: {
          x:    { ticks: { maxTicksLimit: 8, font: { size: 11 } } },
          yMB:  { type: 'linear', position: 'left',  title: { display: true, text: 'MB' }, beginAtZero: true },
          yPct: { type: 'linear', position: 'right', title: { display: true, text: '%' }, beginAtZero: true, max: 100, grid: { drawOnChartArea: false } },
        },
      },
    });` : ''}

    function dismissCleanup() {
      fetch('/dashboard/disk/dismiss-cleanup', { method: 'POST' })
        .then(() => location.reload());
    }
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Watch page ────────────────────────────────────────────────────────────────

function relativeTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) {
    const abs = Math.abs(diff);
    if (abs < 3600000) return `in ${Math.round(abs / 60000)}m`;
    if (abs < 86400000) return `in ${Math.round(abs / 3600000)}h`;
    return `in ${Math.round(abs / 86400000)}d`;
  }
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

// ── Watch log list & viewer pages ─────────────────────────────────────────────

function watchLogCss() {
  return `
    .wl-wrap { max-width:960px; margin:2rem auto; padding:0 1.5rem 4rem; }
    .wl-header { display:flex; align-items:baseline; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .wl-title { font-size:1.15rem; font-weight:700; color:#1a1a2e; }
    .breadcrumb { font-size:.82rem; color:#94a3b8; }
    .breadcrumb a { color:#64748b; text-decoration:none; }
    .breadcrumb a:hover { color:#374151; }
    .wl-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px;
               box-shadow:0 1px 3px #0001; overflow:hidden; }
    .wl-card-head { display:flex; align-items:center; justify-content:space-between;
                    padding:.85rem 1.25rem; border-bottom:1px solid #f1f5f9; }
    .wl-card-label { font-weight:600; font-size:.88rem; color:#374151; }
    .wl-empty { text-align:center; color:#9ca3af; padding:2.5rem 1rem; font-size:.875rem; }
    table.wl-table { width:100%; border-collapse:collapse; font-size:.84rem; }
    table.wl-table th { background:#f8fafc; color:#64748b; font-weight:600; font-size:.75rem;
                        text-transform:uppercase; letter-spacing:.04em; padding:.6rem 1rem;
                        text-align:left; border-bottom:1px solid #e2e8f0; }
    table.wl-table td { padding:.65rem 1rem; border-bottom:1px solid #f1f5f9; vertical-align:middle; }
    table.wl-table tr:last-child td { border-bottom:none; }
    table.wl-table tr:hover td { background:#f8fafc; }
    .wl-badge-live { display:inline-block; padding:1px 7px; border-radius:8px;
                     background:#fef3c7; color:#92400e; font-size:.7rem; font-weight:700;
                     text-transform:uppercase; letter-spacing:.05em; margin-left:.4rem; }
    .wl-badge-ok   { display:inline-block; padding:1px 7px; border-radius:8px;
                     background:#dcfce7; color:#166534; font-size:.7rem; font-weight:600; }
    .wl-badge-err  { display:inline-block; padding:1px 7px; border-radius:8px;
                     background:#fee2e2; color:#991b1b; font-size:.7rem; font-weight:600; }
    .wl-btn { border:none; border-radius:5px; padding:.3rem .65rem; font-size:.78rem;
              font-weight:500; cursor:pointer; background:#eff6ff; color:#1d4ed8; }
    .wl-btn:hover { background:#dbeafe; }
    .wl-btn-a { text-decoration:none; display:inline-block;
                border:none; border-radius:5px; padding:.3rem .65rem; font-size:.78rem;
                font-weight:500; background:#eff6ff; color:#1d4ed8; }
    .wl-btn-a:hover { background:#dbeafe; }
    .wl-btn-danger { border:none; border-radius:5px; padding:.35rem .8rem; font-size:.78rem;
                     font-weight:500; cursor:pointer; background:#fef2f2; color:#dc2626; }
    .wl-btn-danger:hover { background:#fee2e2; }
    .wl-size { color:#9ca3af; font-size:.78rem; }
    /* log viewer */
    .wl-log-wrap { background:#0f172a; border-radius:0 0 10px 10px;
                   padding:1.25rem 1.5rem; overflow:auto; max-height:72vh; }
    .wl-log-pre { color:#e2e8f0; font-family:'Menlo','Monaco','Consolas',monospace;
                  font-size:.78rem; line-height:1.6; white-space:pre-wrap; word-break:break-word;
                  margin:0; }
    .wl-live-bar { background:#fefce8; border:1px solid #fcd34d; border-radius:6px;
                   padding:.5rem 1rem; margin-bottom:.75rem; font-size:.82rem; color:#92400e;
                   display:flex; align-items:center; gap:.5rem; }
    @keyframes wl-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .wl-live-dot { width:8px; height:8px; border-radius:50%; background:#f59e0b;
                   animation:wl-pulse 1.2s ease-in-out infinite; }`;
}

function parseLogFilename(filename) {
  // 2026-05-03_14-30-00_poll-3.log → { date, pollNum }
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_poll-(\d+)\.log$/);
  if (!m) return { date: filename, pollNum: null };
  const iso = `${m[1]}T${m[2].replace(/-/g, ':')}Z`;
  return { date: new Date(iso).toLocaleString(), pollNum: parseInt(m[3], 10) };
}

function logFileStatus(filename, lastLogFile, pollingNow) {
  if (filename === lastLogFile && pollingNow) return 'live';
  // peek at last line of file to detect error footer
  const fPath = null; // resolved by caller
  return 'ok';
}

function renderWatchLogs(key, files, ticket, flash) {
  const isLive    = ticket?.pollingNow;
  const lastLog   = ticket?.lastLogFile || '';
  const flashHtml = flash === 'cleared'
    ? `<div style="background:#dcfce7;color:#166534;border:1px solid #bbf7d0;border-radius:6px;padding:.6rem 1rem;margin-bottom:1rem;font-size:.85rem">All logs for ${esc(key)} deleted.</div>`
    : '';

  const rows = files.length === 0
    ? `<tr><td colspan="4" class="wl-empty">No log files yet for ${esc(key)}.</td></tr>`
    : files.map(f => {
        const { date, pollNum } = parseLogFilename(f);
        const isFileLive = (f === lastLog && isLive);
        const liveBadge  = isFileLive ? `<span class="wl-badge-live">Live</span>` : '';
        let size = '';
        try {
          const bytes = fs.statSync(path.join(WATCH_LOG_DIR, key, f)).size;
          size = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
        } catch (_) {}
        return `<tr>
          <td>${esc(date)}${liveBadge}</td>
          <td class="wl-size">${pollNum != null ? `Poll #${pollNum}` : '—'}</td>
          <td class="wl-size">${esc(size)}</td>
          <td><a class="wl-btn-a" href="/dashboard/watch/${esc(key)}/logs/${esc(f)}">View</a></td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Logs: ${esc(key)} — Prevoyant Server</title>
  <style>${BASE_CSS}${watchLogCss()}</style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${esc(pluginVersion)}</span>
    <span class="meta"></span>
    <a href="/dashboard/watch" class="settings-link" style="color:#fff">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>
  <div class="wl-wrap">
    <div class="wl-header">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › <a href="/dashboard/watch">Watch</a> › ${esc(key)}</span>
    </div>
    <div class="wl-header">
      <span class="wl-title">Poll Logs — ${esc(key)}</span>
      <span style="font-size:.82rem;color:#64748b">${files.length} run${files.length !== 1 ? 's' : ''}</span>
    </div>
    ${flashHtml}
    <div class="wl-card">
      <div class="wl-card-head">
        <span class="wl-card-label">Run History</span>
        <div style="display:flex;align-items:center;gap:.75rem">
          ${isLive ? `<span style="font-size:.8rem;color:#92400e;font-weight:600">● Poll in progress</span>` : ''}
          ${files.length > 0 && !isLive ? `
          <form method="POST" action="/dashboard/watch/${esc(key)}/logs/clear" style="margin:0"
                onsubmit="return confirm('Delete all ${files.length} log file${files.length !== 1 ? 's' : ''} for ${esc(key)}?\\n\\nThis cannot be undone.')">
            <button type="submit" class="wl-btn-danger">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Clear all logs
            </button>
          </form>` : ''}
        </div>
      </div>
      <table class="wl-table">
        <thead><tr><th>Date / Time</th><th>Poll #</th><th>Size</th><th>Log</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <footer class="footer">Prevoyant Server v${esc(pluginVersion)}</footer>
  ${BASE_SCRIPT}
</body>
</html>`;
}

function renderWatchLogView(key, filename, content, ticket) {
  const { date, pollNum } = parseLogFilename(filename);
  const isLive = ticket?.pollingNow && ticket?.lastLogFile === filename;
  const liveBar = isLive
    ? `<div class="wl-live-bar"><span class="wl-live-dot"></span>This poll is still running — page auto-refreshes every 3 s</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Log: ${esc(key)} #${pollNum ?? '?'} — Prevoyant Server</title>
  <style>${BASE_CSS}${watchLogCss()}</style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${esc(pluginVersion)}</span>
    <span class="meta"></span>
    <a href="/dashboard/watch" class="settings-link" style="color:#fff">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>
  <div class="wl-wrap">
    <div class="wl-header">
      <span class="breadcrumb">
        <a href="/dashboard">Dashboard</a> ›
        <a href="/dashboard/watch">Watch</a> ›
        <a href="/dashboard/watch/${esc(key)}/logs">${esc(key)}</a> ›
        ${pollNum != null ? `Poll #${pollNum}` : esc(filename)}
      </span>
    </div>
    <div class="wl-header">
      <span class="wl-title">${esc(key)} — Poll #${pollNum ?? '?'}</span>
      <span style="font-size:.82rem;color:#64748b">${esc(date)}</span>
    </div>
    ${liveBar}
    <div class="wl-card">
      <div class="wl-card-head">
        <span class="wl-card-label">${esc(filename)}</span>
        <a class="wl-btn-a" href="/dashboard/watch/${esc(key)}/logs">← All runs</a>
      </div>
      <div class="wl-log-wrap" id="log-container">
        <pre class="wl-log-pre" id="log-content">${esc(content)}</pre>
      </div>
    </div>
  </div>
  <footer class="footer">Prevoyant Server v${esc(pluginVersion)}</footer>
  ${isLive ? `<script>
  (function() {
    var key = ${JSON.stringify(key)}, file = ${JSON.stringify(filename)};
    var pre = document.getElementById('log-content');
    var container = document.getElementById('log-container');
    var atBottom = true;
    container.addEventListener('scroll', function() {
      atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
    });
    function refresh() {
      fetch('/dashboard/watch/' + key + '/log/tail?file=' + encodeURIComponent(file))
        .then(function(r){ return r.json(); })
        .then(function(d) {
          pre.textContent = d.content || '';
          if (atBottom) container.scrollTop = container.scrollHeight;
          if (d.done) { clearInterval(iv); document.querySelector('.wl-live-bar').style.display='none'; }
        }).catch(function(){});
    }
    var iv = setInterval(refresh, 3000);
    // Scroll to bottom initially
    container.scrollTop = container.scrollHeight;
  })();
  </script>` : ''}
  ${BASE_SCRIPT}
</body>
</html>`;
}

function renderWatch(flash) {
  const tickets   = watchStore.list();
  const watching  = tickets.filter(t => t.status === 'watching').length;
  const enabled   = process.env.PRX_WATCH_ENABLED === 'Y';
  const jiraBase  = (process.env.JIRA_URL || '').replace(/\/$/, '');

  const flashHtml = flash === 'added'    ? `<div class="w-flash w-flash-ok">Ticket added — first poll running now.</div>`
                  : flash === 'stopped'  ? `<div class="w-flash w-flash-ok">Ticket watch stopped.</div>`
                  : flash === 'resumed'  ? `<div class="w-flash w-flash-ok">Ticket resumed — polling now.</div>`
                  : flash === 'polled'   ? `<div class="w-flash w-flash-ok">Poll triggered — digest will be emailed shortly.</div>`
                  : flash === 'removed'  ? `<div class="w-flash w-flash-ok">Ticket removed from watch list.</div>`
                  : flash === 'exists'   ? `<div class="w-flash w-flash-err">That ticket is already being watched.</div>`
                  : flash === 'nokey'    ? `<div class="w-flash w-flash-err">Please enter a ticket key.</div>`
                  : '';

  const INTERVAL_LABELS = { '1h': 'Every hour', '1d': 'Every day', '2d': 'Every 2 days', '5d': 'Every 5 days' };
  const STATUS_BADGE = {
    watching:  `<span class="w-badge w-watching">Watching</span>`,
    stopped:   `<span class="w-badge w-stopped">Stopped</span>`,
    completed: `<span class="w-badge w-completed">Completed</span>`,
  };

  const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

  const rows = tickets.length === 0
    ? `<tr><td colspan="8" class="w-empty">No tickets being watched yet. Add one above.</td></tr>`
    : tickets.map(t => {
        const ticketLabel = jiraBase
          ? `<a href="${esc(jiraBase)}/browse/${esc(t.key)}" target="_blank" rel="noopener" class="w-ticket-link">${esc(t.key)}</a>`
          : `<code>${esc(t.key)}</code>`;
        const watchingEye = t.status === 'watching'
          ? `<span class="w-eye-anim" title="Actively watching">${EYE_SVG}</span>`
          : '';
        const digestPreview = t.lastDigest
          ? `<span class="w-digest-preview" title="${esc(t.lastDigest)}">${esc(t.lastDigest.slice(0, 80))}${t.lastDigest.length > 80 ? '…' : ''}</span>`
          : `<span class="w-muted">—</span>`;
        const errorHtml = t.lastError
          ? `<div class="w-error-row" title="${esc(t.lastError)}">⚠ ${esc(t.lastError.slice(0, 80))}</div>`
          : '';
        const logsBtn = `<a href="/dashboard/watch/${esc(t.key)}/logs" class="w-btn w-btn-logs" style="margin-left:.3rem;text-decoration:none" title="View poll logs">Logs</a>`;
        let actions = '';
        if (t.status === 'watching') {
          actions = `<form method="POST" action="/dashboard/watch/${esc(t.key)}/poll" style="display:inline">
               <button class="w-btn w-btn-poll" title="Trigger an immediate poll and email digest now">Poll now</button>
             </form>
             <form method="POST" action="/dashboard/watch/${esc(t.key)}/stop" style="display:inline;margin-left:.3rem">
               <button class="w-btn w-btn-stop" title="Stop watching this ticket">Stop</button>
             </form>
             <form method="POST" action="/dashboard/watch/${esc(t.key)}/remove" style="display:inline;margin-left:.3rem">
               <button class="w-btn w-btn-remove" title="Remove from list" onclick="return confirm('Remove ${esc(t.key)} from the watch list?')">Remove</button>
             </form>${logsBtn}`;
        } else {
          actions = `<form method="POST" action="/dashboard/watch/${esc(t.key)}/resume" style="display:inline">
               <button class="w-btn w-btn-resume" title="Resume watching this ticket">Resume</button>
             </form>
             <form method="POST" action="/dashboard/watch/${esc(t.key)}/remove" style="display:inline;margin-left:.3rem">
               <button class="w-btn w-btn-remove" title="Remove from list" onclick="return confirm('Remove ${esc(t.key)} from the watch list?')">Remove</button>
             </form>${logsBtn}`;
        }
        return `<tr data-key="${esc(t.key)}">
          <td style="white-space:nowrap">${ticketLabel}${watchingEye}</td>
          <td>${STATUS_BADGE[t.status] || esc(t.status)}</td>
          <td>${esc(INTERVAL_LABELS[t.interval] || t.interval)}</td>
          <td class="w-num">${t.pollCount}${t.maxPolls > 0 ? ` / ${t.maxPolls}` : ''}</td>
          <td class="w-time">${relativeTime(t.lastPollAt)}</td>
          <td class="w-time">${t.status === 'watching' ? relativeTime(t.nextPollAt) : '—'}</td>
          <td>${digestPreview}${errorHtml}</td>
          <td class="w-actions">${actions}</td>
        </tr>`;
      }).join('');

  const defaultInterval = process.env.PRX_WATCH_POLL_INTERVAL || '1d';
  const defaultMaxPolls = process.env.PRX_WATCH_MAX_POLLS     || '0';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ticket Watcher — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .w-wrap { max-width:1100px; margin:2rem auto; padding:0 1.5rem 4rem; }
    .w-header { display:flex; align-items:baseline; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .w-title { font-size:1.25rem; font-weight:700; color:#1a1a2e; }
    .w-subtitle { font-size:.82rem; color:#64748b; }
    .w-flash { padding:.7rem 1rem; border-radius:6px; margin-bottom:1.2rem; font-size:.875rem; }
    .w-flash-ok  { background:#dcfce7; color:#166534; border:1px solid #bbf7d0; }
    .w-flash-err { background:#fee2e2; color:#991b1b; border:1px solid #fecaca; }
    .w-warn { background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:.75rem 1rem;
              color:#92400e; font-size:.84rem; margin-bottom:1.2rem; }
    .w-add-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:1.25rem 1.5rem;
                  margin-bottom:2rem; box-shadow:0 1px 3px #0001; }
    .w-add-title { font-weight:600; font-size:.9rem; color:#1a1a2e; margin-bottom:1rem; }
    .w-form-row { display:flex; gap:.75rem; align-items:flex-end; flex-wrap:wrap; }
    .w-field { display:flex; flex-direction:column; gap:.3rem; }
    .w-label { font-size:.78rem; font-weight:500; color:#374151; }
    .w-input, .w-select { border:1px solid #d1d5db; border-radius:6px; padding:.45rem .7rem;
                          font-size:.875rem; background:#fff; color:#1a1a2e; }
    .w-input:focus, .w-select:focus { outline:2px solid #0d6efd44; border-color:#0d6efd; }
    .w-input { width:160px; }
    .w-submit { background:#0d6efd; color:#fff; border:none; border-radius:6px; padding:.5rem 1.1rem;
                font-size:.875rem; font-weight:500; cursor:pointer; white-space:nowrap; }
    .w-submit:hover { background:#0b5ed7; }
    .w-hint { font-size:.72rem; color:#94a3b8; }
    .w-table-wrap {
      background: var(--surface); border: 1px solid var(--border-light);
      border-radius: var(--r-lg); box-shadow: var(--shadow); overflow: hidden;
    }
    .w-table-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: .85rem 1.25rem; border-bottom: 1px solid var(--border-light);
      gap: 1rem; flex-wrap: wrap;
    }
    .w-table-label { font-weight: 700; font-size: .86rem; color: var(--text); }
    .w-count { font-size: .76rem; color: var(--text-3); }
    table.w-table { width: 100%; border-collapse: collapse; font-size: .83rem; }
    table.w-table th {
      background: var(--surface-2); color: var(--text-3); font-weight: 700; font-size: .68rem;
      text-transform: uppercase; letter-spacing: .07em; padding: .55rem 1rem;
      text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap;
    }
    table.w-table td { padding: .72rem 1rem; border-bottom: 1px solid var(--border-light); vertical-align: top; }
    table.w-table tr:last-child td { border-bottom: none; }
    table.w-table tr:hover td { background: #fafbff; }
    .w-badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: .7rem; font-weight: 600; }
    .w-watching  { background: var(--blue-dim);   color: var(--blue); }
    .w-stopped   { background: var(--surface-2);  color: var(--text-3); border: 1px solid var(--border-light); }
    .w-completed { background: var(--green-dim);  color: var(--green); }
    .w-num  { text-align: center; color: var(--text-2); font-variant-numeric: tabular-nums; }
    .w-time { color: var(--text-3); white-space: nowrap; font-size: .78rem; }
    .w-actions { white-space: nowrap; }
    .w-btn {
      border: none; border-radius: var(--r-sm); padding: .28rem .65rem;
      font-size: .76rem; font-weight: 600; cursor: pointer; font-family: inherit; transition: background .12s;
    }
    .w-btn-poll   { background: var(--blue-dim);   color: var(--blue); }
    .w-btn-poll:hover   { background: #bfdbfe; }
    .w-btn-stop   { background: var(--red-dim);    color: var(--red); }
    .w-btn-stop:hover   { background: #fecaca; }
    .w-btn-resume { background: var(--green-dim);  color: var(--green); }
    .w-btn-resume:hover { background: #a7f3d0; }
    .w-btn-remove { background: var(--surface-2);  color: var(--text-3); border: 1px solid var(--border-light); }
    .w-btn-remove:hover { background: var(--border); }
    .w-btn-logs   { background: var(--purple-dim); color: var(--purple); }
    .w-btn-logs:hover   { background: #ddd6fe; }
    @keyframes w-blink { 0%, 80%, 100% { transform: scaleY(1); } 90% { transform: scaleY(0.08); } }
    .w-eye-anim {
      display: inline-flex; align-items: center; margin-left: .4rem;
      color: var(--accent); vertical-align: middle;
    }
    .w-eye-anim svg { animation: w-blink 3.5s ease-in-out infinite; transform-origin: center; }
    .w-empty { text-align: center; color: var(--text-3); padding: 2.5rem 1rem; font-size: .86rem; }
    .w-muted { color: var(--text-3); }
    .w-ticket-link { color: var(--accent); font-weight: 600; text-decoration: none; }
    .w-ticket-link:hover { color: var(--accent-hover); text-decoration: underline; }
    .w-digest-preview { color: var(--text-2); font-size: .79rem; line-height: 1.45; }
    .w-error-row { color: var(--red); font-size: .73rem; margin-top: .3rem; }
    .breadcrumb { font-size: .78rem; color: #64748b; }
    .breadcrumb a { color: #64748b; text-decoration: none; }
    .breadcrumb a:hover { color: #e2e8f0; }
    /* Live progress panel */
    .w-progress {
      background: #0b1120; border: 1px solid #1e3a5f; border-radius: var(--r-lg);
      padding: 1rem 1.25rem; margin-bottom: 2rem;
    }
    .w-progress-head {
      font-weight: 600; font-size: .86rem; color: #7dd3fc; margin-bottom: .75rem;
      display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
    }
    .w-progress-head a { color: #38bdf8; font-size: .77rem; font-weight: 400; margin-left: auto; text-decoration: none; }
    .w-progress-head a:hover { text-decoration: underline; }
    @keyframes w-spin { to { transform: rotate(360deg); } }
    .w-spinner {
      width: 12px; height: 12px; border: 2px solid #1e3a5f; border-top-color: #38bdf8;
      border-radius: 50%; animation: w-spin .7s linear infinite; flex-shrink: 0;
    }
    .w-log-pre {
      color: #e2e8f0; font-family: ui-monospace, 'Menlo', 'Monaco', monospace;
      font-size: .74rem; line-height: 1.58; white-space: pre-wrap; word-break: break-word;
      margin: 0; max-height: 260px; overflow-y: auto; padding: .5rem .75rem;
      background: #020617; border-radius: var(--r-sm);
    }
    .w-progress-none { color: #475569; font-size: .79rem; font-style: italic; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${esc(pluginVersion)}</span>
    <span class="meta"></span>
    <a href="/dashboard/activity" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Activity
    </a>
    <a href="/dashboard/watch" class="settings-link" style="color:#fff">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>

  <div class="w-wrap">
    <div class="w-header">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Ticket Watcher</span>
    </div>
    <div class="w-header">
      <span class="w-title">Ticket Watcher</span>
      <span class="w-subtitle">${watching} ticket${watching !== 1 ? 's' : ''} currently being watched</span>
    </div>

    ${flashHtml}

    ${!enabled ? `<div class="w-warn">
      <strong>Ticket Watcher is disabled.</strong>
      Enable it under <a href="/dashboard/settings#ticket-watcher" style="color:#92400e;font-weight:600">Settings → Ticket Watcher</a>
      and set <code>PRX_WATCH_ENABLED=Y</code>.
    </div>` : ''}

    <!-- Live progress panel (shown only when a ticket is actively polling) -->
    <div id="w-progress-panel" style="display:none" class="w-progress">
      <div class="w-progress-head">
        <span class="w-spinner"></span>
        <span id="w-progress-key" style="color:#f0f9ff">Polling…</span>
        <span style="color:#7dd3fc;font-size:.78rem;font-weight:400" id="w-progress-subtitle"></span>
        <a id="w-progress-loglink" href="#" target="_blank">Open full log ↗</a>
      </div>
      <pre class="w-log-pre" id="w-log-pre"><span class="w-progress-none">Waiting for output…</span></pre>
    </div>

    <!-- Add ticket form -->
    <div class="w-add-card">
      <div class="w-add-title">Watch a Jira Ticket</div>
      <form method="POST" action="/dashboard/watch/add">
        <div class="w-form-row">
          <div class="w-field">
            <label class="w-label" for="wf-key">Ticket Key</label>
            <input id="wf-key" name="key" class="w-input" placeholder="e.g. IV-1234" required
                   pattern="[A-Z][A-Z0-9]+-[0-9]+" title="e.g. PROJ-123" autocomplete="off"
                   style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">
          </div>
          <div class="w-field">
            <label class="w-label" for="wf-interval">Poll Interval</label>
            <select id="wf-interval" name="interval" class="w-select">
              <option value="1h"${defaultInterval === '1h' ? ' selected' : ''}>Every hour</option>
              <option value="1d"${defaultInterval === '1d' || !defaultInterval ? ' selected' : ''}>Every day</option>
              <option value="2d"${defaultInterval === '2d' ? ' selected' : ''}>Every 2 days</option>
              <option value="5d"${defaultInterval === '5d' ? ' selected' : ''}>Every 5 days</option>
            </select>
          </div>
          <div class="w-field">
            <label class="w-label" for="wf-max">Max Polls</label>
            <input id="wf-max" name="maxPolls" type="number" min="0" class="w-input"
                   value="${esc(defaultMaxPolls)}" placeholder="0" style="width:90px">
            <span class="w-hint">0 = unlimited</span>
          </div>
          <button type="submit" class="w-submit">Start Watching</button>
        </div>
      </form>
    </div>

    <!-- Watched tickets table -->
    <div class="w-table-wrap">
      <div class="w-table-head">
        <span class="w-table-label">Watched Tickets</span>
        <span class="w-count">${tickets.length} total</span>
      </div>
      <table class="w-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Status</th>
            <th>Interval</th>
            <th style="text-align:center">Polls</th>
            <th>Last Polled</th>
            <th>Next Poll</th>
            <th>Last Digest</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>

  <footer class="footer">
    Prevoyant Server v${esc(pluginVersion)} &mdash; Ticket Watcher
  </footer>

  <script>
  (function() {
    var POLL_MS    = 3000;
    var panel      = document.getElementById('w-progress-panel');
    var keyEl      = document.getElementById('w-progress-key');
    var subtitleEl = document.getElementById('w-progress-subtitle');
    var logPre     = document.getElementById('w-log-pre');
    var logLink    = document.getElementById('w-progress-loglink');
    var tbody      = document.querySelector('table.w-table tbody');
    var activeKey  = null;
    var atBottom   = true;

    logPre.addEventListener('scroll', function() {
      atBottom = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 40;
    });

    function fmtTime(iso) {
      if (!iso) return '—';
      try {
        var d = new Date(iso), now = new Date();
        var diff = Math.floor((now - d) / 1000);
        if (diff < 5)  return 'just now';
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch(e) { return ''; }
    }

    function escHtml(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function fetchLogTail(key, logFile) {
      if (!logFile) return;
      fetch('/dashboard/watch/' + key + '/log/tail?file=' + encodeURIComponent(logFile))
        .then(function(r){ return r.json(); })
        .then(function(d) {
          logPre.textContent = d.content || '(empty)';
          if (atBottom) { logPre.scrollTop = logPre.scrollHeight; }
        }).catch(function(){});
    }

    function refresh() {
      fetch('/dashboard/watch/json').then(function(r){ return r.json(); }).then(function(tickets) {
        var inflight = tickets.filter(function(t){ return t.pollingNow; });

        if (inflight.length > 0) {
          var t = inflight[0];
          panel.style.display = '';
          keyEl.textContent   = t.key + ' — Polling in progress';
          subtitleEl.textContent = inflight.length > 1 ? '(+' + (inflight.length - 1) + ' more in queue)' : '';
          if (t.lastLogFile) {
            logLink.href = '/dashboard/watch/' + t.key + '/logs/' + encodeURIComponent(t.lastLogFile);
            logLink.style.display = '';
          } else {
            logLink.style.display = 'none';
          }
          activeKey = t.key;
          fetchLogTail(t.key, t.lastLogFile);
        } else {
          panel.style.display = 'none';
          activeKey = null;
        }

        var STATUS_HTML = {
          watching:  '<span class="w-badge w-watching">Watching</span>',
          stopped:   '<span class="w-badge w-stopped">Stopped</span>',
          completed: '<span class="w-badge w-completed">Completed</span>',
        };
        var EYE = '<span class="w-eye-anim" title="Actively watching"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>';

        tickets.forEach(function(t) {
          var row = tbody.querySelector('tr[data-key="' + t.key + '"]');
          if (!row) return;
          row.cells[1].innerHTML = STATUS_HTML[t.status] || escHtml(t.status);
          row.cells[3].textContent = t.pollCount + (t.maxPolls > 0 ? ' / ' + t.maxPolls : '');
          row.cells[4].textContent = t.lastPollAt ? fmtTime(t.lastPollAt) : '—';
          row.cells[5].textContent = t.status === 'watching' && t.nextPollAt ? fmtTime(t.nextPollAt) : '—';
          var eyeSpan = row.cells[0].querySelector('.w-eye-anim');
          if (t.status === 'watching' && !eyeSpan) row.cells[0].insertAdjacentHTML('beforeend', EYE);
          if (t.status !== 'watching' && eyeSpan) eyeSpan.remove();
        });
      }).catch(function(){});
    }

    setInterval(refresh, POLL_MS);
  })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Settings page ─────────────────────────────────────────────────────────────

function fld(key, label, type, val, placeholder, hint, opts) {
  const id = `f_${key}`;
  let input;
  if (type === 'select') {
    const options = opts.map(o =>
      `<option value="${esc(o.v)}"${val === o.v ? ' selected' : ''}>${esc(o.l)}</option>`
    ).join('');
    input = `<select id="${id}" name="${key}" class="s-input">${options}</select>`;
  } else if (type === 'password') {
    input = `<div class="pw-wrap">
      <input type="password" id="${id}" name="${key}" value="${esc(val)}" placeholder="${esc(placeholder || '')}" class="s-input" autocomplete="off">
      <button type="button" class="pw-eye" onclick="togglePw('${id}')" tabindex="-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>`;
  } else {
    input = `<input type="${type}" id="${id}" name="${key}" value="${esc(val)}" placeholder="${esc(placeholder || '')}" class="s-input">`;
  }
  return `<div class="s-field">
    <label for="${id}" class="s-label">${esc(label)} <code class="s-key">${key}</code></label>
    ${input}
    ${hint ? `<div class="s-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

function sectionHasValues(keys, vals) {
  return keys.some(k => vals[k] && vals[k] !== '');
}

const NOTIFY_EVENTS = [
  // Jira
  { key: 'jira_assigned',         label: 'Ticket assigned to me',                  group: 'Jira' },
  { key: 'jira_created',          label: 'Relevant ticket created',                group: 'Jira' },
  { key: 'jira_status_changed',   label: 'Ticket status changed to relevant state', group: 'Jira' },
  // Job lifecycle
  { key: 'ticket_scheduled',      label: 'Ticket scheduled for future run',         group: 'Job Lifecycle' },
  { key: 'ticket_queued',         label: 'Ticket added to queue',                   group: 'Job Lifecycle' },
  { key: 'ticket_started',        label: 'Processing started',                      group: 'Job Lifecycle' },
  { key: 'ticket_completed',      label: 'Completed successfully',                  group: 'Job Lifecycle' },
  { key: 'ticket_failed',         label: 'Processing failed',                       group: 'Job Lifecycle' },
  { key: 'ticket_interrupted',    label: 'Job stopped / interrupted',               group: 'Job Lifecycle' },
  { key: 'poll_ran',              label: 'Jira poll scan ran',                      group: 'Job Lifecycle' },
  // Dev pipeline
  { key: 'stage_dev_root_cause',  label: 'Root cause analysis (Step 7)',            group: 'Pipeline — Dev' },
  { key: 'stage_dev_fix',         label: 'Fix proposed (Step 8)',                   group: 'Pipeline — Dev' },
  { key: 'stage_dev_impact',      label: 'Impact analysis (Step 9)',                group: 'Pipeline — Dev' },
  { key: 'stage_dev_report',      label: 'Report generated (Step 12)',              group: 'Pipeline — Dev' },
  // Review pipeline
  { key: 'stage_review_panel',    label: 'Engineering panel complete (R5)',         group: 'Pipeline — Review' },
  { key: 'stage_review_report',   label: 'Review report generated (R8)',            group: 'Pipeline — Review' },
  // Estimate pipeline
  { key: 'stage_est_final',       label: 'Final estimate ready (E5)',               group: 'Pipeline — Estimate' },
  { key: 'stage_est_report',      label: 'Estimate report generated (E5b)',         group: 'Pipeline — Estimate' },
];

function renderSettings(vals, flash) {
  const v = k => vals[k] || '';

  const kbKeys     = ['PRX_KB_MODE','PRX_SOURCE_REPO_URL','PRX_KNOWLEDGE_DIR','PRX_KB_REPO','PRX_KB_LOCAL_CLONE','PRX_KB_KEY','PRX_REALTIME_KB_SYNC','PRX_UPSTASH_REDIS_URL','PRX_UPSTASH_REDIS_TOKEN','PRX_KB_SYNC_MACHINE','PRX_KB_SYNC_POLL_SECS','PRX_KB_SYNC_TRIGGER','PRX_KB_SYNC_DEBOUNCE_SECS'];
  const memKeys    = ['PRX_MEMORY_INDEX_ENABLED','PRX_MEMORY_LIMIT','PRX_REDIS_ENABLED','PRX_REDIS_URL','PRX_REDIS_PASSWORD','PRX_REDIS_PREFIX','PRX_REDIS_TTL_DAYS'];
  const emailKeys  = ['PRX_EMAIL_TO','PRX_SMTP_HOST','PRX_SMTP_PORT','PRX_SMTP_USER','PRX_SMTP_PASS'];
  const bryanKeys  = ['PRX_INCLUDE_SM_IN_SESSIONS_ENABLED','PRX_SKILL_UPGRADE_MIN_SESSIONS','PRX_SKILL_COMPACTION_INTERVAL','PRX_MONTHLY_BUDGET'];
  const autoKeys   = ['AUTO_MODE','FORCE_FULL_RUN','PRX_REPORT_VERBOSITY','PRX_JIRA_PROJECT','PRX_ATTACHMENT_MAX_MB'];
  const reportKeys = ['CLAUDE_REPORT_DIR'];
  const notifyKeys  = ['PRX_NOTIFY_ENABLED','PRX_NOTIFY_LEVEL','PRX_NOTIFY_MUTE_DAYS','PRX_NOTIFY_MUTE_UNTIL','PRX_NOTIFY_EVENTS'];
  const waKeys      = ['PRX_WASENDER_ENABLED','PRX_WASENDER_API_KEY','PRX_WASENDER_TO','PRX_WASENDER_PUBLIC_URL','PRX_WASENDER_EVENTS','PRX_WASENDER_PDF_PASSWORD'];
  const kb = kbStats();

  // Notification-specific values
  const nEnabled   = v('PRX_NOTIFY_ENABLED');
  const nLevel     = v('PRX_NOTIFY_LEVEL') || 'full';
  const nMuteDays  = v('PRX_NOTIFY_MUTE_DAYS') || '0';
  const nMuteUntil = v('PRX_NOTIFY_MUTE_UNTIL');
  const nEvents    = v('PRX_NOTIFY_EVENTS') || NOTIFY_EVENTS.map(e => e.key).join(',');
  const emailTo    = v('PRX_EMAIL_TO');
  const nOpen      = nEnabled === 'Y' || sectionHasValues(notifyKeys, vals);

  // WhatsApp / WaSender values
  const waEnabled  = v('PRX_WASENDER_ENABLED');
  const waEvents   = v('PRX_WASENDER_EVENTS') || NOTIFY_EVENTS.map(e => e.key).join(',');
  const waOpen     = waEnabled === 'Y' || sectionHasValues(waKeys, vals);
  const waChecked  = new Set(waEvents.split(',').map(s => s.trim()).filter(Boolean));

  const checkedEvents = new Set(nEvents.split(',').map(s => s.trim()).filter(Boolean));

  // Group events for rendering
  const eventGroups = {};
  for (const e of NOTIFY_EVENTS) {
    if (!eventGroups[e.group]) eventGroups[e.group] = [];
    eventGroups[e.group].push(e);
  }
  const eventCheckboxes = Object.entries(eventGroups).map(([groupName, events]) => {
    const boxes = events.map(e =>
      `<label class="n-evt-lbl" id="n-evt-lbl-${e.key}">
        <input type="checkbox" class="n-evt-cb" value="${e.key}" ${checkedEvents.has(e.key) ? 'checked' : ''} onchange="syncNotifyEvents()">
        ${esc(e.label)}
      </label>`
    ).join('');
    const groupHint = groupName === 'Jira'
      ? `<span style="font-size:.68rem;color:#b0b7c3;font-weight:400;text-transform:none;letter-spacing:0"> — uses JIRA_USERNAME to match assignee</span>`
      : '';
    return `<div class="n-group">
      <div class="n-group-lbl">${esc(groupName)}${groupHint}</div>
      <div class="n-events-grid">${boxes}</div>
    </div>`;
  }).join('');

  const waEventCheckboxes = Object.entries(eventGroups).map(([groupName, evts]) => {
    const boxes = evts.map(e =>
      `<label class="n-evt-lbl">
        <input type="checkbox" class="wa-evt-cb" value="${e.key}" ${waChecked.has(e.key) ? 'checked' : ''} onchange="syncWaEvents()">
        ${esc(e.label)}
      </label>`
    ).join('');
    return `<div class="n-group">
      <div class="n-group-lbl">${esc(groupName)}</div>
      <div class="n-events-grid">${boxes}</div>
    </div>`;
  }).join('');

  let muteUntilHtml = '';
  if (nMuteUntil) {
    const d = new Date(nMuteUntil);
    if (!isNaN(d)) {
      const isPast = d <= new Date();
      muteUntilHtml = `<div class="n-mute-info ${isPast ? 'n-mute-expired' : 'n-mute-active'}">
        ${isPast ? 'Previous mute expired' : 'Muted until'}: <strong>${d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</strong>
      </div>`;
    }
  }

  const levelDescriptions = {
    full:    '<strong>Full</strong> — one email per event as it happens.',
    compact: '<strong>Compact</strong> — all events batched into a single daily digest email.',
    urgent:  '<strong>Urgent</strong> — failures, errors, and decision prompts only. Event selection is ignored.',
    mute:    '<strong>Mute</strong> — all notifications are suppressed.',
  };

  const flashHtml = flash === 'saved'
    ? `<div class="s-flash s-flash-ok">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Settings saved successfully.
      </div>`
    : flash === 'error'
    ? `<div class="s-flash s-flash-err">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Failed to save settings — check server logs.
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Settings — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .breadcrumb { font-size:0.8rem; color:#a0a8c0; }
    .breadcrumb a { color:#a0a8c0; text-decoration:none; }
    .breadcrumb a:hover { color:#fff; }
    .settings-wrap { max-width: 800px; margin: 1.75rem auto; padding: 0 1.75rem 4rem; }
    .s-flash {
      display: flex; align-items: center; gap: .6rem;
      padding: .72rem 1rem; border-radius: var(--r-md);
      font-size: .83rem; font-weight: 500; margin-bottom: 1.4rem;
    }
    .s-flash-ok  { background: var(--green-dim); color: #065f46; border: 1px solid #a7f3d0; }
    .s-flash-err { background: var(--red-dim);   color: #7f1d1d; border: 1px solid #fca5a5; }
    .s-section {
      background: var(--surface); border-radius: var(--r-lg);
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
      margin-bottom: 1rem; overflow: hidden;
    }
    .s-section summary {
      list-style: none; display: flex; align-items: center; gap: .6rem;
      padding: .85rem 1.25rem; font-size: .78rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .07em; color: var(--text-2);
      cursor: pointer; user-select: none;
      border-bottom: 1px solid transparent; transition: background .12s;
    }
    .s-section summary:hover { background: var(--surface-2); }
    details[open] > summary { border-bottom-color: var(--border-light); }
    .s-section summary::-webkit-details-marker { display: none; }
    .s-section summary .s-chevron { margin-left: auto; color: var(--border); transition: transform .2s; }
    details[open] summary .s-chevron { transform: rotate(90deg); color: var(--text-3); }
    .s-section summary .s-req {
      font-size: .65rem; background: var(--red-dim); color: #7f1d1d;
      padding: 1px 6px; border-radius: 4px; font-weight: 600; text-transform: none; letter-spacing: 0;
    }
    .s-section summary .s-opt {
      font-size: .65rem; background: var(--surface-2); color: var(--text-3);
      padding: 1px 6px; border-radius: 4px; font-weight: 600; text-transform: none; letter-spacing: 0;
      border: 1px solid var(--border-light);
    }
    .s-body { padding: 1.25rem; display: grid; grid-template-columns: 1fr 1fr; gap: .9rem 1.2rem; }
    .s-body.full-width { grid-template-columns: 1fr; }
    .s-field { display: flex; flex-direction: column; gap: .3rem; }
    .s-field.span2 { grid-column: span 2; }
    .s-label { font-size: .77rem; font-weight: 600; color: var(--text-2); display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
    .s-key {
      font-family: ui-monospace, 'SF Mono', monospace; font-size: .7rem;
      background: var(--surface-2); color: var(--text-3);
      padding: 1px 5px; border-radius: 4px; font-weight: 400;
      border: 1px solid var(--border-light);
    }
    .s-input {
      width: 100%; padding: .45rem .68rem;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      font-size: .84rem; color: var(--text); background: var(--surface);
      transition: border-color .15s, box-shadow .15s; font-family: inherit;
    }
    .s-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
    .s-hint { font-size: .72rem; color: var(--text-3); line-height: 1.55; }
    .pw-wrap { position: relative; }
    .pw-wrap .s-input { padding-right: 2.4rem; }
    .pw-eye {
      position: absolute; right: .5rem; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; color: var(--text-3);
      padding: .2rem; display: flex; align-items: center; transition: color .15s;
    }
    .pw-eye:hover { color: var(--text-2); }
    .s-actions { display: flex; gap: .75rem; align-items: center; margin-top: 1.8rem; flex-wrap: wrap; }
    .btn-save {
      padding: .52rem 1.4rem; background: var(--accent); color: #fff; border: none;
      border-radius: var(--r-md); font-size: .86rem; font-weight: 600;
      cursor: pointer; transition: background .15s; font-family: inherit;
    }
    .btn-save:hover { background: var(--accent-hover); }
    .btn-restart {
      padding: .52rem 1.4rem; background: var(--blue); color: #fff; border: none;
      border-radius: var(--r-md); font-size: .86rem; font-weight: 600;
      cursor: pointer; transition: background .15s; font-family: inherit;
    }
    .btn-restart:hover { background: #1d4ed8; }
    .btn-cancel { font-size: .83rem; color: var(--text-3); text-decoration: none; padding: .52rem .8rem; transition: color .15s; }
    .btn-cancel:hover { color: var(--text-2); }
    @media(max-width:560px){ .s-body { grid-template-columns:1fr; } .s-field.span2 { grid-column:span 1; } }
    .n-warn {
      display: flex; align-items: flex-start; gap: .55rem;
      background: var(--amber-dim); border: 1px solid #fde68a;
      border-radius: var(--r-md); padding: .65rem .9rem;
      font-size: .81rem; color: #92400e; margin-bottom: .4rem;
    }
    .n-warn svg { flex-shrink: 0; margin-top: 1px; color: var(--amber); }
    .n-events-groups { display: flex; flex-direction: column; gap: 1rem; padding: .5rem 0 .2rem; }
    .n-group-lbl {
      font-size: .65rem; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
      color: var(--text-3); margin-bottom: .45rem;
      display: flex; align-items: center; gap: .5rem;
    }
    .n-group-lbl::after { content: ''; flex: 1; height: 1px; background: var(--border-light); }
    .n-events-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem .9rem; }
    .n-evt-lbl {
      display: flex; align-items: center; gap: .5rem;
      font-size: .81rem; color: var(--text-2); cursor: pointer; user-select: none;
    }
    .n-evt-lbl input[type=checkbox] { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent); flex-shrink: 0; }
    .n-evt-lbl.disabled { color: var(--text-3); cursor: not-allowed; }
    .n-evt-lbl.disabled input { cursor: not-allowed; }
    .n-sel-all-row { display: flex; align-items: center; gap: .75rem; margin-bottom: .2rem; }
    .n-sel-btn {
      background: none; border: none; color: var(--accent); font-size: .74rem; font-weight: 600;
      cursor: pointer; padding: 0; font-family: inherit; text-decoration: underline;
    }
    .n-sel-btn:hover { color: var(--accent-hover); }
    .n-level-desc {
      font-size: .77rem; color: var(--text-2); background: var(--surface-2);
      border: 1px solid var(--border-light); border-radius: var(--r-sm);
      padding: .55rem .8rem; line-height: 1.58;
    }
    .n-level-desc strong { color: var(--text); }
    .n-mute-info { font-size: .77rem; padding: .45rem .75rem; border-radius: var(--r-sm); margin-top: .35rem; }
    .n-mute-active  { background: var(--purple-dim); color: #5b21b6; border: 1px solid #ddd6fe; }
    .n-mute-expired { background: var(--surface-2);  color: var(--text-3); border: 1px solid var(--border-light); }
    @media(max-width:560px){ .n-events-grid { grid-template-columns:1fr; } }
    .bk-stat-row { display:flex; flex-wrap:wrap; gap:.6rem 1.4rem; margin-bottom:1rem; }
    .bk-stat { display:flex; flex-direction:column; gap:2px; }
    .bk-stat-lbl { font-size:.68rem; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#9ca3af; }
    .bk-stat-val { font-size:.88rem; font-weight:600; color:#1a1a2e; }
    .bk-stat-val.muted { color:#b0b7c3; font-weight:400; }
    .bk-path { font-family:monospace; font-size:.76rem; color:#6b7280; background:#f9fafb;
               border:1px solid #e5e7eb; border-radius:6px; padding:.3rem .6rem;
               word-break:break-all; margin-bottom:.85rem; }
    .bk-include-row { display:flex; flex-wrap:wrap; gap:.5rem 1.2rem; margin-bottom:1rem; }
    .bk-inc-lbl { display:flex; align-items:center; gap:.45rem; font-size:.83rem; color:#374151; cursor:pointer; }
    .bk-inc-lbl input { width:15px; height:15px; accent-color:#6366f1; cursor:pointer; }
    .btn-export { display:inline-flex; align-items:center; gap:.5rem; padding:.55rem 1.3rem;
                  background:#6366f1; color:#fff; border:none; border-radius:8px; font-size:.88rem;
                  font-weight:600; cursor:pointer; transition:background .15s; font-family:inherit; }
    .btn-export:hover { background:#4f46e5; }
    .btn-export:disabled { background:#a5b4fc; cursor:not-allowed; }
    .bk-divider { border:none; border-top:1px solid #f0f1f5; margin:1.2rem 0; }
    .bk-import-row { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
    .bk-file-input { font-size:.83rem; color:#374151; }
    .btn-import { display:inline-flex; align-items:center; gap:.5rem; padding:.5rem 1.1rem;
                  background:#1a1a2e; color:#fff; border:none; border-radius:8px; font-size:.85rem;
                  font-weight:600; cursor:pointer; transition:background .15s; font-family:inherit; white-space:nowrap; }
    .btn-import:hover { background:#2d3a5e; }
    .btn-import:disabled { background:#9ca3af; cursor:not-allowed; }
    .bk-import-status { display:none; margin-top:.65rem; padding:.5rem .8rem; border-radius:7px;
                        font-size:.82rem; font-weight:500; border:1px solid transparent; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Settings</span>
    </div>
  </header>

  <div class="settings-wrap">
    ${flashHtml}

    <form method="POST" action="/dashboard/settings">
      <input type="hidden" name="_restart" id="_restart" value="0">

      <!-- Repository -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Repository
          <span class="s-req">Required</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          ${fld('PRX_REPO_DIR','Repo Directory','text',v('PRX_REPO_DIR'),'/absolute/path/to/your/repo','Absolute path to local codebase clone. Skill creates branches and searches files here.')}
        </div>
      </details>

      <!-- Jira -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Jira
          <span class="s-req">Required</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('JIRA_URL','Jira URL','text',v('JIRA_URL'),'https://yourcompany.atlassian.net','')}
          ${fld('JIRA_USERNAME','Username','text',v('JIRA_USERNAME'),'firstname.lastname@yourcompany.com','')}
          <div class="s-field span2">
            ${fld('JIRA_API_TOKEN','API Token','password',v('JIRA_API_TOKEN'),'your-jira-api-token','Generate at id.atlassian.com/manage-profile/security/api-tokens')}
          </div>
        </div>
      </details>

      <!-- Webhook & Polling -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Webhook &amp; Polling
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('WEBHOOK_PORT','Port','number',v('WEBHOOK_PORT'),'3000','HTTP port this server listens on for incoming Jira webhook events. Default: 3000.')}
          ${fld('WEBHOOK_POLL_INTERVAL_DAYS','Poll Interval (days)','number',v('WEBHOOK_POLL_INTERVAL_DAYS'),'0','How often to run poll-jira.sh as a fallback when no Jira webhook is configured. 0 = disabled (use webhook instead). Fractional values accepted: 0.5 = every 12 h, 0.042 ≈ every hour.')}
          <div class="s-field span2">
            ${fld('WEBHOOK_SECRET','Webhook Secret','password',v('WEBHOOK_SECRET'),'your-strong-secret','Secret token appended to the Jira webhook URL (?token=…). Leave empty to skip validation.')}
          </div>
        </div>
      </details>

      <!-- Knowledge Base -->
      <details class="s-section"${sectionHasValues(kbKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Knowledge Base
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_KB_MODE','Mode','select',v('PRX_KB_MODE') || 'local','','',
            [{v:'local',l:'local (default)'},{v:'distributed',l:'distributed (shared git repo)'}])}
          ${fld('PRX_SOURCE_REPO_URL','Source Repo URL','text',v('PRX_SOURCE_REPO_URL'),'https://github.com/myorg/myrepo','Used to cross-check KB file:line refs against the live branch. Omit to skip.')}
          ${fld('PRX_KNOWLEDGE_DIR','KB Directory (local mode)','text',v('PRX_KNOWLEDGE_DIR'),'$HOME/.prevoyant/knowledge-base','Override default KB path. Local mode only.')}
          ${fld('PRX_KB_REPO','KB Repo URL (distributed)','text',v('PRX_KB_REPO'),'git@github.com:yourorg/team-kb.git','Private git repo for shared KB. Required in distributed mode.')}
          ${fld('PRX_KB_LOCAL_CLONE','KB Local Clone (distributed)','text',v('PRX_KB_LOCAL_CLONE'),'$HOME/.prevoyant/kb','Local clone path. Distributed mode only.')}
          <div class="s-field span2">
            ${fld('PRX_KB_KEY','Encryption Key (distributed)','password',v('PRX_KB_KEY'),'your-strong-passphrase','AES-256-CBC passphrase for encrypting KB files. Optional. Never commit this value.')}
          </div>
          <div class="s-field span2" style="border-top:1px solid #e5e7eb;padding-top:1rem;margin-top:.5rem">
            <span class="s-label" style="font-weight:600">Real-time KB Sync <span style="font-size:10px;font-weight:400;color:#6b7280;margin-left:.4rem">Redis doorbell · Git mail carrier · <a href="https://upstash.com/" target="_blank" rel="noopener" style="color:#6b7280">upstash.com</a></span></span>
            <span class="s-hint">Push/pull KB changes across machines the moment a session finishes. Redis carries only a ~100-byte notification (machine, ticket, commit). Git carries the actual KB files. Requires distributed mode.</span>
          </div>
          ${fld('PRX_REALTIME_KB_SYNC','Enable Real-time Sync','select',v('PRX_REALTIME_KB_SYNC') || 'N','','Requires PRX_KB_MODE=distributed and Upstash credentials below.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_UPSTASH_REDIS_URL','Upstash REST URL','text',v('PRX_UPSTASH_REDIS_URL'),'https://your-endpoint.upstash.io','REST endpoint from console.upstash.com → Database → REST API. Free tier is sufficient.')}
          <div class="s-field">
            ${fld('PRX_UPSTASH_REDIS_TOKEN','Upstash REST Token','password',v('PRX_UPSTASH_REDIS_TOKEN'),'your-token-here','REST token from console.upstash.com. Never commit this value.')}
          </div>
          ${fld('PRX_KB_SYNC_MACHINE','Machine Name','text',v('PRX_KB_SYNC_MACHINE'),require('os').hostname(),'Override hostname used in sync notifications. Useful in Docker or cloud VMs where hostname is unstable.')}
          ${fld('PRX_KB_SYNC_POLL_SECS','Poll Interval (seconds)','text',v('PRX_KB_SYNC_POLL_SECS'),'10','How often each machine checks Redis for new KB updates. Default: 10.')}
          ${fld('PRX_KB_SYNC_TRIGGER','Outbound trigger','select',v('PRX_KB_SYNC_TRIGGER') || 'session','','What triggers an outbound KB notification on this machine.',
            [{v:'session',l:'session — SKILL.md signals after git push (recommended)'},{v:'filesystem',l:'filesystem — watch KB dir for manual edits'},{v:'both',l:'both — session + filesystem'}])}
          ${fld('PRX_KB_SYNC_DEBOUNCE_SECS','Filesystem debounce (seconds)','text',v('PRX_KB_SYNC_DEBOUNCE_SECS'),'3','Seconds to wait after the last file change before committing. filesystem / both triggers only.')}
        </div>
      </details>

      <!-- Backup & Export -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Backup &amp; Export
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">

          <div class="s-field">
            <span class="s-label">Knowledge Base</span>
            <div class="bk-path">${esc(kb.kbDir)}</div>
            <div class="bk-stat-row">
              <div class="bk-stat">
                <span class="bk-stat-lbl">KB files</span>
                <span class="bk-stat-val ${kb.kbFiles === 0 ? 'muted' : ''}">${kb.kbFiles === 0 ? 'none' : kb.kbFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Sessions</span>
                <span class="bk-stat-val ${kb.sessionFiles === 0 ? 'muted' : ''}">${kb.sessionFiles === 0 ? 'none' : kb.sessionFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Reports</span>
                <span class="bk-stat-val ${kb.reportFiles === 0 ? 'muted' : ''}">${kb.reportFiles === 0 ? 'none' : kb.reportFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Server state</span>
                <span class="bk-stat-val ${kb.serverFiles === 0 ? 'muted' : ''}">${kb.serverFiles === 0 ? 'none' : kb.serverFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Watch logs</span>
                <span class="bk-stat-val ${kb.watchLogFiles === 0 ? 'muted' : ''}">${kb.watchLogFiles === 0 ? 'none' : kb.watchLogFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Memory</span>
                <span class="bk-stat-val ${kb.memoryFiles === 0 ? 'muted' : ''}">${kb.memoryFiles === 0 ? 'none' : kb.memoryFiles}</span>
              </div>
            </div>
            <div class="s-hint" style="margin-bottom:.7rem">
              Download a <code>.tar.gz</code> archive of all selected items. Extract with
              <code>tar -xzf prevoyant-backup-*.tar.gz</code>.
            </div>

            <div class="bk-include-row">
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-kb" checked ${!kb.kbExists ? 'disabled' : ''}>
                Knowledge Base &amp; Agent Memory ${!kb.kbExists ? '<span style="color:#9ca3af">(not found)</span>' : ''}
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-sessions" ${kb.sessionFiles === 0 ? '' : 'checked'}>
                Session files (${kb.sessionFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-reports" ${kb.reportFiles === 0 ? '' : 'checked'}>
                Reports (${kb.reportFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-server" ${kb.serverFiles === 0 ? '' : 'checked'}>
                Server state — activity log &amp; watched tickets (${kb.serverFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-watchlogs" ${kb.watchLogFiles === 0 ? '' : 'checked'}>
                Watch logs (${kb.watchLogFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-memory" ${kb.memoryFiles === 0 ? '' : 'checked'}>
                Agent memory index (${kb.memoryFiles})
              </label>
            </div>

            <button type="button" class="btn-export" onclick="downloadKbBackup()" ${!kb.kbExists && kb.sessionFiles === 0 && kb.reportFiles === 0 && kb.serverFiles === 0 ? 'disabled' : ''}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download Backup (.tar.gz)
            </button>
          </div>

          <hr class="bk-divider">

          <div class="s-field">
            <span class="s-label">Import Backup</span>
            <div class="s-hint" style="margin-bottom:.6rem">
              Restore from a <code>.tar.gz</code> backup. Existing files are <strong>never overwritten</strong> —
              only new files not already present on disk are added.
            </div>
            <div class="bk-import-row">
              <input type="file" id="bk-import-file" class="bk-file-input" accept=".tar.gz,.gz"
                     onchange="document.getElementById('btn-import').disabled = !this.files.length">
              <button type="button" id="btn-import" class="btn-import" disabled onclick="importKbBackup()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/><polyline points="17 8 12 3 7 8"/></svg>
                Import
              </button>
            </div>
            <div id="bk-import-status" class="bk-import-status"></div>
          </div>

        </div>
      </details>

      <!-- Report Output -->
      <details class="s-section"${sectionHasValues(reportKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Report Output
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          ${fld('CLAUDE_REPORT_DIR','Reports Directory','text',v('CLAUDE_REPORT_DIR'),'$HOME/.prevoyant/reports','Folder where PDF/HTML reports are saved. Created automatically if missing.')}
        </div>
      </details>

      <!-- Agent Memory -->
      <details class="s-section"${sectionHasValues(memKeys, vals) ? ' open' : ''} id="agent-memory">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Agent Memory
          <span class="s-opt">Optional</span>
          <span id="mem-status-badge" style="margin-left:.4rem;font-size:.7rem;padding:.1rem .45rem;border-radius:999px;background:#e5e7eb;color:#374151"></span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Indexes agent learnings, surprises, and running context notes from each session's
              memory file. On each new ticket only the most relevant entries are injected
              (scored by Jira component + label match) — replacing ~700 lines of raw session
              excerpts with a compact ~20-line table (<strong>~96% token reduction</strong>
              on the agent memory section). Supports two backends:
              <br><br>
              <strong>JSON</strong> (local) — single-machine, zero setup, zero dependencies.<br>
              <strong>Redis</strong> (team-shared) — all developers share one memory store
              across machines and parallel sessions. Requires a Redis instance.
            </div>
          </div>

          <div class="s-field span2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:.2rem 0 .8rem"></div>

          <div class="s-field span2" style="font-weight:600;font-size:.8rem;color:#6366f1;margin-bottom:-.3rem">JSON backend (local fallback)</div>
          ${fld('PRX_MEMORY_INDEX_ENABLED','Enable JSON memory','select',v('PRX_MEMORY_INDEX_ENABLED')||'Y','','Local JSON index at ~/.prevoyant/memory/index.json. Used when Redis is disabled or unreachable.',
            [{v:'Y',l:'Y — enabled (default)'},{v:'N',l:'N — disabled'}])}
          ${fld('PRX_MEMORY_LIMIT','Max learnings per prompt','number',v('PRX_MEMORY_LIMIT'),'15','Max indexed entries injected per session prompt. Lower = fewer tokens. Default: 15.')}

          <div class="s-field span2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:.5rem 0 .8rem"></div>

          <div class="s-field span2" style="font-weight:600;font-size:.8rem;color:#6366f1;margin-bottom:-.3rem">Redis backend (team-shared, primary)</div>
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Team-shared store — all developers see the same indexed learnings across machines and parallel sessions.
              Takes priority over JSON when connected; JSON stays warm as a hot-standby.
              <br><br>
              <strong>Using the same Upstash instance as KB sync?</strong><br>
              The REST token in <code>PRX_UPSTASH_REDIS_TOKEN</code> is <em>not</em> the Redis password.
              To get the native Redis connection string:
              <ol style="margin:.4rem 0 0 1.1rem;padding:0;line-height:1.8">
                <li>Open your <strong>Upstash Console</strong> → select your database</li>
                <li>Click <strong>Connect</strong> → select the <strong>ioredis</strong> tab</li>
                <li>Copy the <code>rediss://</code> URL — it contains the correct password</li>
                <li>Paste it into <strong>Redis URL</strong> below and leave <strong>Redis password</strong> blank</li>
              </ol>
              <br>Key spaces don't clash — memory uses prefix <code>prx:mem:</code>, KB sync uses its own stream key.
            </div>
          </div>
          ${fld('PRX_REDIS_ENABLED','Enable Redis memory','select',v('PRX_REDIS_ENABLED')||'N','','Team-shared memory via Redis. Takes priority over JSON when connected.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_REDIS_URL','Redis URL','text',v('PRX_REDIS_URL'),'rediss://default:<password>@<host>:6379','Connection URL. Use rediss:// for TLS (required for Upstash). Embed credentials directly in the URL.')}
          ${fld('PRX_REDIS_PASSWORD','Redis password','password',v('PRX_REDIS_PASSWORD'),'','Leave blank when credentials are already embedded in the URL above (recommended for Upstash).')}
          ${fld('PRX_REDIS_PREFIX','Key prefix','text',v('PRX_REDIS_PREFIX'),'prx:mem:','Namespace prefix for all Redis keys. Change if sharing a Redis instance with other apps.')}
          ${fld('PRX_REDIS_TTL_DAYS','Memory TTL (days)','number',v('PRX_REDIS_TTL_DAYS'),'0','Days before indexed entries expire. 0 = never expire (recommended).')}

          <div class="s-field span2">
            <button type="button" onclick="testRedisConnection()"
              style="padding:.4rem 1rem;background:#1a1a2e;color:#fff;border:none;border-radius:6px;font-size:.78rem;cursor:pointer;font-family:inherit">
              Test Redis connection
            </button>
            <span id="redis-test-result" style="margin-left:.75rem;font-size:.78rem;color:#6b7280"></span>
          </div>
        </div>
      </details>

      <script>
        async function testRedisConnection() {
          const el = document.getElementById('redis-test-result');
          el.textContent = 'Testing…';
          try {
            const r = await fetch('/dashboard/api/memory-status');
            const d = await r.json();
            if (d.backend === 'redis' && d.connected) {
              el.textContent = '✓ Redis connected — ' + d.total + ' learnings indexed';
              el.style.color = '#16a34a';
            } else if (d.backend === 'redis' && !d.connected) {
              el.textContent = '✗ Redis unreachable — check URL and server';
              el.style.color = '#dc2626';
            } else {
              el.textContent = 'Redis disabled — using ' + (d.backend || 'none');
              el.style.color = '#9ca3af';
            }
          } catch (_) {
            el.textContent = 'Request failed';
            el.style.color = '#dc2626';
          }
        }
        // Auto-load status badge on page open
        (async () => {
          try {
            const r = await fetch('/dashboard/api/memory-status');
            const d = await r.json();
            const badge = document.getElementById('mem-status-badge');
            if (!badge) return;
            if (d.backend === 'redis' && d.connected) {
              badge.textContent = 'Redis ✓';
              badge.style.background = '#dcfce7'; badge.style.color = '#16a34a';
            } else if (d.backend === 'json' && d.connected) {
              badge.textContent = 'JSON ✓';
              badge.style.background = '#eff6ff'; badge.style.color = '#2563eb';
            } else {
              badge.textContent = 'disabled';
            }
          } catch (_) {}
        })();
      </script>

      <!-- Automation -->
      <details class="s-section"${sectionHasValues(autoKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Automation
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('AUTO_MODE','Auto Mode','select',v('AUTO_MODE') || 'N','','Bypass all interactive gates. Fix is applied automatically to the feature branch.',
            [{v:'N',l:'N — interactive (default)'},{v:'Y',l:'Y — headless / automated'}])}
          ${fld('FORCE_FULL_RUN','Force Full Run','select',v('FORCE_FULL_RUN') || 'N','','Force every step to run in full even on repeat tickets.',
            [{v:'N',l:'N — default'},{v:'Y',l:'Y — force fresh analysis'}])}
          ${fld('PRX_REPORT_VERBOSITY','Report Verbosity','select',v('PRX_REPORT_VERBOSITY') || 'full','','Controls panel dialogue in terminal. PDF always contains full content.',
            [{v:'full',l:'full (default)'},{v:'compact',l:'compact'},{v:'minimal',l:'minimal'}])}
          ${fld('PRX_JIRA_PROJECT','Jira Project','text',v('PRX_JIRA_PROJECT'),'IV','Scope polling to a single project key. Omit to poll all assigned projects.')}
          ${fld('PRX_ATTACHMENT_MAX_MB','Attachment Max MB','number',v('PRX_ATTACHMENT_MAX_MB'),'0','Max size for non-image attachments. 0 = no limit.')}
          ${fld('PRX_RETRY_MAX','Auto-retry on failure','number',v('PRX_RETRY_MAX'),'0','Number of automatic retries after a job fails. 0 = disabled.')}
          ${fld('PRX_RETRY_BACKOFF','Retry backoff (seconds)','number',v('PRX_RETRY_BACKOFF'),'30','Initial wait before first retry. Doubles on each subsequent attempt (exponential backoff).')}
        </div>
      </details>

      <!-- Email Delivery -->
      <details class="s-section"${sectionHasValues(emailKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          Email Delivery
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_EMAIL_TO','Recipient','text',v('PRX_EMAIL_TO'),'recipient@example.com','Set this to enable email delivery after each report.')}
          ${fld('PRX_SMTP_HOST','SMTP Host','text',v('PRX_SMTP_HOST'),'smtp.gmail.com','smtp.gmail.com or smtp.office365.com')}
          ${fld('PRX_SMTP_PORT','SMTP Port','number',v('PRX_SMTP_PORT'),'587','587 (STARTTLS) or 465 (SSL).')}
          ${fld('PRX_SMTP_USER','SMTP Username','text',v('PRX_SMTP_USER'),'you@gmail.com','')}
          <div class="s-field span2">
            ${fld('PRX_SMTP_PASS','SMTP Password','password',v('PRX_SMTP_PASS'),'app-password','Gmail: generate an App Password when 2-Step Verification is enabled.')}
          </div>
        </div>
      </details>

      <!-- Notifications -->
      <details class="s-section"${nOpen ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          Notifications
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">

          <span id="n-email-set-indicator" data-set="${emailTo ? '1' : '0'}" style="display:none"></span>

          <div class="s-field">
            <label for="f_PRX_NOTIFY_ENABLED" class="s-label">Enable email notifications <code class="s-key">PRX_NOTIFY_ENABLED</code></label>
            <select id="f_PRX_NOTIFY_ENABLED" name="PRX_NOTIFY_ENABLED" class="s-input" style="max-width:280px" onchange="onNotifyToggle(this.value)">
              <option value="N"${nEnabled !== 'Y' ? ' selected' : ''}>N — disabled</option>
              <option value="Y"${nEnabled === 'Y' ? ' selected' : ''}>Y — enabled</option>
            </select>
            <div class="s-hint">Requires PRX_EMAIL_TO and SMTP credentials to be configured in Email Delivery above.</div>
          </div>

          <div id="n-email-warn" class="n-warn" style="display:${nEnabled === 'Y' && !emailTo ? '' : 'none'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span><strong>PRX_EMAIL_TO is not set.</strong> Set a recipient email in the Email Delivery section above before enabling notifications.</span>
          </div>

          <div id="n-config" style="display:${nEnabled === 'Y' ? '' : 'none'}">

            <div class="s-field" style="margin-top:.6rem">
              <label for="f_PRX_NOTIFY_LEVEL" class="s-label">Notification level <code class="s-key">PRX_NOTIFY_LEVEL</code></label>
              <select id="f_PRX_NOTIFY_LEVEL" name="PRX_NOTIFY_LEVEL" class="s-input" style="max-width:340px" onchange="onNotifyLevelChange(this.value)">
                <option value="full"${nLevel === 'full' ? ' selected' : ''}>Full — one email per event</option>
                <option value="compact"${nLevel === 'compact' ? ' selected' : ''}>Compact — daily digest, all events in one mail</option>
                <option value="urgent"${nLevel === 'urgent' ? ' selected' : ''}>Urgent — failures, errors and decision prompts only</option>
                <option value="mute"${nLevel === 'mute' ? ' selected' : ''}>Mute — suppress all notifications</option>
              </select>
              <div id="n-level-desc" class="n-level-desc" style="margin-top:.45rem;max-width:500px">
                ${levelDescriptions[nLevel] || ''}
              </div>
            </div>

            <div id="n-mute-wrap" style="display:${nLevel === 'mute' ? '' : 'none'};margin-top:.6rem">
              <div class="s-field" style="max-width:260px">
                <label for="f_PRX_NOTIFY_MUTE_DAYS" class="s-label">Mute for (days) <code class="s-key">PRX_NOTIFY_MUTE_DAYS</code></label>
                <input type="number" id="f_PRX_NOTIFY_MUTE_DAYS" name="PRX_NOTIFY_MUTE_DAYS" value="${esc(nMuteDays)}" min="0" max="365" placeholder="0" class="s-input">
                <div class="s-hint">0 = mute permanently. 1–365 = mute for N days from time of save.</div>
              </div>
              ${muteUntilHtml}
            </div>

            <div id="n-events-wrap" style="display:${nLevel !== 'mute' && nLevel !== 'urgent' ? '' : 'none'};margin-top:.6rem">
              <input type="hidden" id="n-events-hidden" name="PRX_NOTIFY_EVENTS" value="${esc(nEvents)}">
              <div class="s-field">
                <div class="n-sel-all-row">
                  <span class="s-label" style="margin:0">Events to notify <code class="s-key">PRX_NOTIFY_EVENTS</code></span>
                  <button type="button" class="n-sel-btn" onclick="selectAllEvents(true)">Select all</button>
                  <button type="button" class="n-sel-btn" onclick="selectAllEvents(false)">Deselect all</button>
                </div>
                <div class="s-hint" style="margin-bottom:.5rem">Tick each event that should trigger an email. Jira assignment events match against your JIRA_USERNAME.</div>
                <div class="n-events-groups">${eventCheckboxes}</div>
              </div>
            </div>

          </div>
        </div>
      </details>

      <!-- WhatsApp / WaSender -->
      <details class="s-section"${waOpen ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          WhatsApp Notifications
          <span class="s-opt">Optional — via WaSenderAPI</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">

          <div class="s-field">
            <label for="f_PRX_WASENDER_ENABLED" class="s-label">Enable WhatsApp notifications <code class="s-key">PRX_WASENDER_ENABLED</code></label>
            <select id="f_PRX_WASENDER_ENABLED" name="PRX_WASENDER_ENABLED" class="s-input" style="max-width:280px" onchange="document.getElementById('wa-config').style.display=this.value==='Y'?'':'none'">
              <option value="N"${waEnabled !== 'Y' ? ' selected' : ''}>N — disabled</option>
              <option value="Y"${waEnabled === 'Y' ? ' selected' : ''}>Y — enabled</option>
            </select>
            <div class="s-hint">Sends concise WhatsApp alerts for selected events. PDF reports are also delivered as documents when a public URL is configured. Requires a <a href="https://wasenderapi.com" target="_blank" rel="noopener">WaSenderAPI</a> account (free 3-day trial).</div>
          </div>

          <div id="wa-config" style="display:${waEnabled === 'Y' ? '' : 'none'}">

            <div class="s-grid s-grid-2" style="margin-top:.6rem">
              ${fld('PRX_WASENDER_API_KEY','Session API Key','password',v('PRX_WASENDER_API_KEY'),'','Session-specific key from your WaSenderAPI dashboard (Settings → Sessions → API Key).')}
              ${fld('PRX_WASENDER_TO','Recipient phone number','text',v('PRX_WASENDER_TO'),'+1234567890','Include country code, e.g. +23052xxxxxxx. This is the WhatsApp number that receives all notifications.')}
            </div>

            <div class="s-grid s-grid-2" style="margin-top:.6rem">
              <div class="s-field">
                <label for="f_PRX_WASENDER_PUBLIC_URL" class="s-label">Public server URL <code class="s-key">PRX_WASENDER_PUBLIC_URL</code></label>
                <input type="text" id="f_PRX_WASENDER_PUBLIC_URL" name="PRX_WASENDER_PUBLIC_URL" value="${esc(v('PRX_WASENDER_PUBLIC_URL'))}" placeholder="https://yourserver.com" class="s-input">
                <div class="s-hint">Optional. WaSenderAPI fetches the PDF from this URL. Leave blank — reports are auto-uploaded to <strong>tmpfiles.org</strong> (free, 14-day links, no account needed). When a PDF password is set, tmpfiles.org is always used regardless of this field.</div>
              </div>
              ${fld('PRX_WASENDER_PDF_PASSWORD','PDF report password','password',v('PRX_WASENDER_PDF_PASSWORD'),'','Optional. Encrypts PDF reports with this password before sending. Requires <code>qpdf</code> — install with <code>brew install qpdf</code> (Mac) or <code>apt install qpdf</code> (Linux). Leave blank to send unencrypted.')}
            </div>

            <div style="margin-top:.8rem">
              <input type="hidden" id="wa-events-hidden" name="PRX_WASENDER_EVENTS" value="${esc(waEvents)}">
              <div class="s-field">
                <div class="n-sel-all-row">
                  <span class="s-label" style="margin:0">Events to notify <code class="s-key">PRX_WASENDER_EVENTS</code></span>
                  <button type="button" class="n-sel-btn" onclick="selectAllWaEvents(true)">Select all</button>
                  <button type="button" class="n-sel-btn" onclick="selectAllWaEvents(false)">Deselect all</button>
                </div>
                <div class="s-hint" style="margin-bottom:.5rem">Messages are brief one-liners with emoji. Report events also send the PDF as a WhatsApp document (requires Public server URL above).</div>
                <div class="n-events-groups">${waEventCheckboxes}</div>
              </div>
            </div>

          </div>
        </div>
      </details>

      <!-- Bryan -->
      <details class="s-section"${sectionHasValues(bryanKeys, vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Bryan — Scrum Master
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_INCLUDE_SM_IN_SESSIONS_ENABLED','Enable Bryan','select',v('PRX_INCLUDE_SM_IN_SESSIONS_ENABLED') || 'N','','Bryan observes sessions and proposes SKILL.md improvements.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_MONTHLY_BUDGET','Monthly Budget (USD)','number',v('PRX_MONTHLY_BUDGET'),'20.00','Claude subscription budget. Bryan flags at >80% and ≥100%.')}
          ${fld('PRX_SKILL_UPGRADE_MIN_SESSIONS','Min Sessions Before Push','number',v('PRX_SKILL_UPGRADE_MIN_SESSIONS'),'3','Sessions with an approved change before Bryan pushes to main.')}
          ${fld('PRX_SKILL_COMPACTION_INTERVAL','Compaction Interval','number',v('PRX_SKILL_COMPACTION_INTERVAL'),'10','Sessions between full SKILL.md compaction passes.')}
        </div>
      </details>

      <!-- Health Monitor (Watchdog) -->
      <details class="s-section"${sectionHasValues(['PRX_WATCHDOG_ENABLED','PRX_WATCHDOG_INTERVAL_SECS','PRX_WATCHDOG_FAIL_THRESHOLD'], vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Health Monitor
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          <div class="s-field">
            <div style="display:flex;align-items:flex-start;gap:.55rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.65rem .9rem;font-size:.82rem;color:#1e40af;margin-bottom:.6rem">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Runs as an in-process thread — detects HTTP unresponsiveness, event-loop hangs, and controlled shutdowns.
              Planned stops via <code style="background:#dbeafe;padding:1px 4px;border-radius:3px">stop.sh</code> or
              dashboard restart send a graceful-stop signal so no false alert is fired.
              A hard OS kill (<code style="background:#dbeafe;padding:1px 4px;border-radius:3px">SIGKILL</code> / OOM) cannot be caught by any in-process solution.
              Requires SMTP credentials in the <strong>Email Delivery</strong> section above and <strong>PRX_EMAIL_TO</strong> to be set.
              Changes take effect after <em>Save &amp; Restart</em>.</span>
            </div>
          </div>
          <div class="s-body" style="padding:0;box-shadow:none;background:transparent">
            ${fld('PRX_WATCHDOG_ENABLED','Enable health monitor','select',v('PRX_WATCHDOG_ENABLED') || 'N','','Starts a background thread that polls /health and emails you if the server stops responding.',
              [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
            ${fld('PRX_WATCHDOG_INTERVAL_SECS','Check interval (seconds)','number',v('PRX_WATCHDOG_INTERVAL_SECS'),'60','How often to ping /health. Default: 60. Lower values catch outages faster but add noise.')}
            ${fld('PRX_WATCHDOG_FAIL_THRESHOLD','Failure threshold','number',v('PRX_WATCHDOG_FAIL_THRESHOLD'),'3','Consecutive failed checks before sending the DOWN alert. Default: 3. Avoids single-blip false alarms.')}
          </div>
        </div>
      </details>

      <!-- Disk Monitor -->
      <details id="disk-monitor" class="s-section"${sectionHasValues(['PRX_DISK_MONITOR_ENABLED','PRX_DISK_MONITOR_INTERVAL_MINS','PRX_DISK_CLEANUP_INTERVAL_DAYS','PRX_PREVOYANT_MAX_SIZE_MB','PRX_DISK_CAPACITY_ALERT_PCT'], vals) ? ' open' : ''}>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Disk Monitor
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          <div class="s-field">
            <div style="display:flex;align-items:flex-start;gap:.55rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.65rem .9rem;font-size:.82rem;color:#1e40af;margin-bottom:.6rem">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Runs as an in-process background thread. Tracks the total size of <code style="background:#dbeafe;padding:1px 4px;border-radius:3px">~/.prevoyant/</code> against a configurable size quota.
              Sends an email alert when the folder size exceeds that quota.
              When the cleanup interval elapses, a notification appears on the <a href="/dashboard/disk" style="color:#1e40af">Disk Monitor page</a> — you must click <em>Approve Cleanup</em> before any files are deleted.
              Cleanup removes session files older than 30 days and trims server logs.
              Changes take effect after <em>Save &amp; Restart</em>.</span>
            </div>
          </div>
          <div class="s-body" style="padding:0;box-shadow:none;background:transparent">
            ${fld('PRX_DISK_MONITOR_ENABLED','Enable disk monitor','select',v('PRX_DISK_MONITOR_ENABLED') || 'N','','Starts a background thread that tracks disk usage and alerts when capacity is low.',
              [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
            ${fld('PRX_DISK_MONITOR_INTERVAL_MINS','Check interval (minutes)','number',v('PRX_DISK_MONITOR_INTERVAL_MINS'),'60','How often to measure disk usage. Default: 60 (hourly).')}
            ${fld('PRX_PREVOYANT_MAX_SIZE_MB','Size quota for ~/.prevoyant/ (MB)','number',v('PRX_PREVOYANT_MAX_SIZE_MB'),'500','Maximum allowed size of the ~/.prevoyant/ folder. The alert threshold is a percentage of this value. Default: 500 MB.')}
            ${fld('PRX_DISK_CAPACITY_ALERT_PCT','Alert threshold (% of quota)','number',v('PRX_DISK_CAPACITY_ALERT_PCT'),'80','Send an email alert when ~/.prevoyant/ reaches this percentage of the size quota. E.g. 80% of 500 MB = alert at 400 MB. Default: 80.')}
            ${fld('PRX_DISK_CLEANUP_INTERVAL_DAYS','Cleanup interval (days)','number',v('PRX_DISK_CLEANUP_INTERVAL_DAYS'),'7','How many days between scheduled house-cleaning prompts. Set 0 to disable auto-cleanup prompts. Default: 7.')}
          </div>
        </div>
      </details>

      <!-- Ticket Watcher -->
      <details class="s-section"${v('PRX_WATCH_ENABLED') === 'Y' ? ' open' : ''} id="ticket-watcher">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Ticket Watcher
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body" style="padding:0;box-shadow:none;background:transparent">
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Watches specified Jira tickets on a recurring schedule. On each poll it reads all comments and attachments,
              calls Claude to produce a progress digest, and emails it to you.
              Watched tickets survive server restarts. Manage them at
              <a href="/dashboard/watch" style="color:#1e40af">Dashboard › Watch</a>.
            </div>
          </div>
          ${fld('PRX_WATCH_ENABLED','Enable ticket watcher','select',v('PRX_WATCH_ENABLED') || 'N','','Starts the background watcher worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_WATCH_POLL_INTERVAL','Default poll interval','select',v('PRX_WATCH_POLL_INTERVAL') || '1d','','Default interval pre-selected when adding a ticket on the Watch page.',
            [{v:'1h',l:'Every hour'},{v:'1d',l:'Every day (default)'},{v:'2d',l:'Every 2 days'},{v:'5d',l:'Every 5 days'}])}
          ${fld('PRX_WATCH_MAX_POLLS','Default max polls','number',v('PRX_WATCH_MAX_POLLS'),'0','Default maximum number of polls per ticket. 0 = unlimited. Pre-filled on the Watch page.')}
          ${fld('PRX_WATCH_LOG_KEEP_DAYS','Log retention (days)','number',v('PRX_WATCH_LOG_KEEP_DAYS') || '30','30','Delete poll log files older than this many days during house-cleaning. Default: 30.')}
          ${fld('PRX_WATCH_LOG_KEEP_PER_TICKET','Max logs per ticket','number',v('PRX_WATCH_LOG_KEEP_PER_TICKET') || '10','10','Keep at most this many log files per ticket (oldest removed first). Default: 10.')}
        </div>
      </details>

      <div class="s-actions">
        <button type="submit" class="btn-save">Save</button>
        <button type="button" class="btn-restart" onclick="saveAndRestart()">Save &amp; Restart Server</button>
        <a href="/dashboard" class="btn-cancel">Cancel</a>
      </div>
    </form>
  </div>

  <script>
    function togglePw(id) {
      const el = document.getElementById(id);
      el.type = el.type === 'password' ? 'text' : 'password';
    }
    function saveAndRestart() {
      document.getElementById('_restart').value = '1';
      document.querySelector('form').submit();
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    const N_LEVEL_DESC = {
      full:    '<strong>Full</strong> — one email per event as it happens.',
      compact: '<strong>Compact</strong> — all events batched into a single daily digest email.',
      urgent:  '<strong>Urgent</strong> — failures, errors, and decision prompts only. Event selection is ignored.',
      mute:    '<strong>Mute</strong> — all notifications are suppressed.',
    };

    function onNotifyToggle(val) {
      const emailSet = document.getElementById('n-email-set-indicator').dataset.set === '1';
      document.getElementById('n-config').style.display      = val === 'Y' ? '' : 'none';
      document.getElementById('n-email-warn').style.display  = (val === 'Y' && !emailSet) ? '' : 'none';
    }

    function onNotifyLevelChange(val) {
      document.getElementById('n-mute-wrap').style.display    = val === 'mute'                       ? '' : 'none';
      document.getElementById('n-events-wrap').style.display  = (val !== 'mute' && val !== 'urgent') ? '' : 'none';
      const descEl = document.getElementById('n-level-desc');
      if (descEl) descEl.innerHTML = N_LEVEL_DESC[val] || '';
    }

    function syncNotifyEvents() {
      const vals = [...document.querySelectorAll('.n-evt-cb')]
        .filter(cb => cb.checked).map(cb => cb.value);
      document.getElementById('n-events-hidden').value = vals.join(',');
    }
    function downloadKbBackup() {
      const sessions  = document.getElementById('bk-inc-sessions').checked  ? '1' : '0';
      const reports   = document.getElementById('bk-inc-reports').checked   ? '1' : '0';
      const server    = document.getElementById('bk-inc-server').checked    ? '1' : '0';
      const watchlogs = document.getElementById('bk-inc-watchlogs').checked ? '1' : '0';
      const memory    = document.getElementById('bk-inc-memory').checked    ? '1' : '0';
      window.location.href = '/dashboard/kb/export?sessions=' + sessions +
        '&reports=' + reports + '&server=' + server +
        '&watchlogs=' + watchlogs + '&memory=' + memory;
    }

    function importKbBackup() {
      const fileInput = document.getElementById('bk-import-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { showImportStatus('error', 'Please select a .tar.gz file.'); return; }

      const btn = document.getElementById('btn-import');
      btn.disabled = true;
      showImportStatus('loading', 'Uploading and importing…');

      fetch('/dashboard/kb/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
        .then(r => r.json())
        .then(data => {
          btn.disabled = false;
          if (data.error) { showImportStatus('error', data.error); return; }
          let msg;
          if (data.added > 0 && data.skipped)
            msg = data.added + ' new file(s) imported. Some existing files were kept unchanged.';
          else if (data.added > 0)
            msg = data.added + ' new file(s) imported successfully.';
          else if (data.skipped)
            msg = 'No new files imported — all files already exist on disk.';
          else
            msg = 'Import complete.';
          showImportStatus('ok', msg);
          fileInput.value = '';
        })
        .catch(err => {
          btn.disabled = false;
          showImportStatus('error', 'Import failed: ' + err.message);
        });
    }

    function showImportStatus(type, msg) {
      const el = document.getElementById('bk-import-status');
      const styles = {
        ok:      { bg: '#dcfce7', border: '#bbf7d0', color: '#166534' },
        error:   { bg: '#fee2e2', border: '#fecaca', color: '#991b1b' },
        loading: { bg: '#f9fafb', border: '#e5e7eb', color: '#374151' },
      };
      const s = styles[type] || styles.loading;
      Object.assign(el.style, { display: '', background: s.bg, borderColor: s.border, color: s.color });
      el.textContent = msg;
    }

    function selectAllEvents(select) {
      document.querySelectorAll('.n-evt-cb').forEach(cb => cb.checked = select);
      syncNotifyEvents();
    }
    function syncWaEvents() {
      const vals = [...document.querySelectorAll('.wa-evt-cb:checked')].map(cb => cb.value);
      document.getElementById('wa-events-hidden').value = vals.join(',');
    }
    function selectAllWaEvents(select) {
      document.querySelectorAll('.wa-evt-cb').forEach(cb => cb.checked = select);
      syncWaEvents();
    }
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Restart page ──────────────────────────────────────────────────────────────

function renderRestartPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Restarting — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    @keyframes spin { to { transform: rotate(360deg); } }
    body { display:flex; flex-direction:column; min-height:100vh; }
    .restart-box { flex:1; display:flex; flex-direction:column; align-items:center;
                   justify-content:center; gap:1.4rem; padding:2rem; text-align:center; }
    .spinner { width:46px; height:46px; border:4px solid #e2e8f0;
               border-top-color:#0d6efd; border-radius:50%; animation:spin .8s linear infinite; }
    .restart-title { font-size:1.3rem; font-weight:700; color:#1a1a2e; }
    .restart-sub   { font-size:.9rem; color:#64748b; }
    .restart-status { font-size:.8rem; color:#94a3b8; font-family:monospace; }
    #timeout-msg { display:none; }
    #timeout-msg a { color:#0d6efd; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
  </header>
  <div class="restart-box">
    <div class="spinner" id="spinner"></div>
    <div class="restart-title">Server is restarting…</div>
    <div class="restart-sub">Settings saved. Waiting for the server to come back online.</div>
    <div class="restart-status" id="status-msg">Waiting…</div>
    <div id="timeout-msg" style="font-size:.85rem;color:#dc2626">
      Restart is taking longer than expected. <a href="/dashboard">Try refreshing</a> or check the server log.
    </div>
  </div>
  <script>
    const MAX_WAIT = 30000, POLL_MS = 2000;
    const start = Date.now();
    let attempts = 0;
    function poll() {
      attempts++;
      const elapsed = Math.round((Date.now() - start) / 1000);
      document.getElementById('status-msg').textContent = 'Attempt ' + attempts + ' — ' + elapsed + 's elapsed…';
      if (Date.now() - start > MAX_WAIT) {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('timeout-msg').style.display = '';
        return;
      }
      fetch('/health', { cache: 'no-store' })
        .then(r => { if (r.ok) window.location.replace('/dashboard'); else setTimeout(poll, POLL_MS); })
        .catch(() => setTimeout(poll, POLL_MS));
    }
    setTimeout(poll, 2500);
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Ticket detail page ────────────────────────────────────────────────────────

function stagePipelineHtml(stages) {
  if (!stages || !stages.length) {
    return `<p style="color:#aaa;font-size:0.9rem;padding:.5rem 0">No stage data yet — stages appear as Claude processes the ticket.</p>`;
  }

  const cards = stages.map((s, i) => {
    const isLast = i === stages.length - 1;
    let icon, cls;
    switch (s.status) {
      case 'active':  icon = ICONS.running(20);  cls = 'stage-active';  break;
      case 'done':    icon = ICONS.success(20);  cls = 'stage-done';    break;
      case 'failed':  icon = ICONS.failed(20);   cls = 'stage-failed';  break;
      case 'skipped': icon = ICONS.skipped(20);  cls = 'stage-skipped'; break;
      default:        icon = ICONS.queued(20);   cls = 'stage-pending'; break;
    }
    const d = s.startedAt ? dur(s.startedAt, s.completedAt || (s.status === 'active' ? null : undefined)) : '';
    return `<div class="pipeline-item">
      <div class="stage-card ${cls}">
        <div class="stage-icon">${icon}</div>
        <div class="stage-name">Step ${s.id}</div>
        <div class="stage-label">${s.label}</div>
        ${s.status === 'skipped' ? '<div class="stage-skipped-badge">Skipped</div>' : ''}
        ${d ? `<div class="stage-dur">${d}</div>` : ''}
      </div>
      ${!isLast ? '<div class="pipeline-arrow">›</div>' : ''}
    </div>`;
  }).join('');

  return `<div class="pipeline-scroll"><div class="pipeline-row">${cards}</div></div>`;
}

function renderDetail(ticket, warn, warnMode) {
  const stages = ticket.stages || [];
  const outputLines = ticket.outputLog || [];
  const reportFiles = ticket.reportFiles || [];
  const currentStage = stages.find(s => s.status === 'active');
  const doneCount = stages.filter(s => s.status === 'done' || s.status === 'failed').length;
  const pdfFiles = reportFiles.filter(f => f.toLowerCase().endsWith('.pdf'));

  // Output section: session log if available, else embedded PDF, else empty state
  let outputSection;
  if (outputLines.length > 0) {
    const logHtml = outputLines.map(l => {
      const ts = new Date(l.ts).toLocaleTimeString('en-GB');
      const isStderr = l.text.startsWith('[stderr]');
      const isResult = l.text.startsWith('[Result]');
      let bodyHtml;
      if (isStderr) {
        const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        bodyHtml = `<span class="log-stderr">${t}</span>`;
      } else if (isResult) {
        const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        bodyHtml = `<span class="log-result">${t}</span>`;
      } else {
        bodyHtml = renderMarkdown(l.text);
      }
      return `<div class="log-entry"><div class="log-ts">${ts}</div><div class="log-body">${bodyHtml}</div></div>`;
    }).join('');
    outputSection = `
      <button class="output-toggle" onclick="toggleOutput()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span id="toggle-label">View Output</span> (<span id="output-count">${outputLines.length}</span> entries)
      </button>
      <div id="output-box" class="output-box">${logHtml}</div>`;
  } else if (pdfFiles.length > 0) {
    const enc = encodeURIComponent(pdfFiles[0]);
    outputSection = `
      <p style="font-size:0.82rem;color:#888;margin-bottom:.75rem">No live session captured. Showing saved report:</p>
      <iframe src="/dashboard/view?path=${enc}" style="width:100%;height:620px;border:none;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.12)"></iframe>`;
  } else {
    outputSection = `<p style="color:#bbb;font-size:0.85rem">No session output and no report found for this ticket.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prevoyant — ${ticket.ticketKey}</title>
  <style>
    ${BASE_CSS}
    .page { max-width:1400px; margin:0 auto; padding:1.5rem 2rem 3rem; }
    .topbar { display:flex; align-items:flex-start; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .back-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 14px; background:#fff;
                border:1px solid #dde; border-radius:8px; font-size:0.82rem; color:#444; text-decoration:none;
                font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.06); transition:background .15s; white-space:nowrap; }
    .back-btn:hover { background:#f0f1f5; }
    .ticket-title { font-size:1.5rem; font-weight:700; letter-spacing:-0.02em; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
    .ticket-meta  { font-size:0.82rem; color:#888; display:flex; gap:1.5rem; flex-wrap:wrap; margin-top:.4rem; }
    .panel { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); margin-bottom:1.25rem; }
    .panel-header { padding:.85rem 1.25rem; border-bottom:1px solid #f0f1f5; display:flex; align-items:center; gap:.75rem; }
    .panel-header h2 { font-size:0.82rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:#666; flex:1; }
    .panel-body { padding:1.25rem; }
    .pipeline-scroll { overflow-x:auto; padding-bottom:.5rem; }
    .pipeline-row { display:flex; align-items:center; min-width:max-content; }
    .pipeline-item { display:flex; align-items:center; }
    .stage-card { width:108px; padding:.7rem .5rem; border-radius:10px; border:2px solid transparent;
                  display:flex; flex-direction:column; align-items:center; gap:4px; }
    .stage-icon { display:flex; align-items:center; justify-content:center; }
    .stage-name  { font-size:0.7rem; font-weight:700; color:#666; }
    .stage-label { font-size:0.72rem; color:#888; text-align:center; line-height:1.3; }
    .stage-dur   { font-size:0.68rem; color:#aaa; margin-top:2px; }
    .stage-pending { background:#f9fafb; border-color:#e5e7eb; }
    .stage-active  { background:#eff6ff; border-color:#93c5fd; box-shadow:0 0 0 3px #dbeafe; }
    .stage-done    { background:#f0fdf4; border-color:#86efac; }
    .stage-failed  { background:#fef2f2; border-color:#fca5a5; }
    .stage-skipped { background:#f9fafb; border-color:#e5e7eb; opacity:0.55; }
    .stage-skipped-badge { font-size:0.6rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em;
                           color:#9ca3af; background:#e5e7eb; border-radius:4px; padding:1px 5px; margin-top:2px; }
    .pipeline-arrow { font-size:1.2rem; color:#d1d5db; padding:0 4px; }
    .progress-wrap { background:#f0f1f5; border-radius:99px; height:6px; overflow:hidden; margin-top:1rem; }
    .progress-bar  { height:100%; border-radius:99px; background:linear-gradient(90deg,#0d6efd,#198754); transition:width .4s; }
    .output-toggle { display:inline-flex; align-items:center; gap:6px; padding:7px 16px; background:#1a1a2e;
                     color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; }
    .output-toggle:hover { background:#2d3a5e; }
    .output-box { display:none; margin-top:1rem; background:#0f1117; border-radius:10px; padding:1.2rem 1.4rem;
                  max-height:620px; overflow-y:auto; }
    .output-box.open { display:block; }
    .log-entry  { padding:6px 0; border-bottom:1px solid #1e2130; }
    .log-entry:last-child { border-bottom:none; }
    .log-ts     { font-family:monospace; font-size:0.7rem; color:#4b5563; margin-bottom:3px; }
    .log-body   { color:#d1d5db; font-size:0.82rem; line-height:1.65; }
    .log-body h1,.log-body h2,.log-body h3 { color:#93c5fd; margin:10px 0 4px; font-size:0.9rem; border-bottom:1px solid #1e3a5f; padding-bottom:3px; }
    .log-body h4,.log-body h5 { color:#7dd3fc; margin:8px 0 2px; font-size:0.83rem; }
    .log-body pre  { background:#1a1f2e; border:1px solid #2d3a5e; border-radius:6px; padding:10px 12px;
                     overflow-x:auto; margin:8px 0; }
    .log-body code { background:#1a1f2e; padding:1px 5px; border-radius:3px; font-family:monospace;
                     font-size:0.78rem; color:#a5f3fc; }
    .log-body pre code { background:none; padding:0; color:#e2e8f0; font-size:0.77rem; white-space:pre; }
    .log-body strong { color:#fbbf24; }
    .log-body em     { color:#c4b5fd; }
    .log-body table  { border-collapse:collapse; margin:8px 0; font-size:0.78rem; width:100%; }
    .log-body th     { background:#1e2d40; color:#93c5fd; padding:5px 10px; border:1px solid #2d3a5e; }
    .log-body td     { padding:4px 10px; border:1px solid #1e2130; }
    .log-body hr     { border:none; border-top:1px solid #2d3a5e; margin:10px 0; }
    .log-body blockquote { border-left:3px solid #3b82f6; padding-left:10px; color:#94a3b8; margin:6px 0; }
    .log-body ul,.log-body ol { padding-left:1.4rem; margin:4px 0; }
    .log-body li    { margin:2px 0; }
    .log-stderr { color:#f87171; font-family:monospace; font-size:0.77rem; }
    .log-result { color:#4ade80; font-family:monospace; font-size:0.77rem; font-weight:600; }
    .dl-btn { display:inline-flex; align-items:center; gap:4px; padding:5px 12px; background:#1a1a2e;
              color:#fff; border-radius:8px; font-size:0.8rem; text-decoration:none; font-weight:500; transition:background .15s; }
    .dl-btn:hover { background:#2d3a5e; }
    .warn-banner { background:#fffbeb; border:1.5px solid #f59e0b; border-radius:10px;
                   padding:1rem 1.25rem; margin-bottom:1.25rem; }
    .warn-banner h3 { font-size:0.88rem; font-weight:700; color:#92400e; margin-bottom:.5rem;
                      display:flex; align-items:center; gap:.4rem; }
    .warn-banner p  { font-size:0.82rem; color:#78350f; margin-bottom:.5rem; line-height:1.5; }
    .warn-banner code { background:#fef3c7; padding:2px 6px; border-radius:4px; font-family:monospace;
                        font-size:0.8rem; color:#92400e; word-break:break-all; }
    .warn-banner ol { font-size:0.82rem; color:#78350f; padding-left:1.3rem; line-height:1.8; }
    .warn-banner .warn-actions { display:flex; align-items:center; gap:.75rem; margin-top:.9rem; flex-wrap:wrap; }
    .force-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 18px; background:#d97706;
                 color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:600;
                 cursor:pointer; transition:background .15s; }
    .force-btn:hover { background:#b45309; }
    .run-panel { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
    .run-panel label { font-size:0.82rem; color:#555; font-weight:500; }
    .mode-btn-group { display:flex; gap:.4rem; }
    .mode-btn { padding:6px 18px; border:2px solid #d1d5db; border-radius:8px; background:#fff;
                font-size:0.82rem; font-weight:600; cursor:pointer; transition:all .15s; color:#555; }
    .mode-btn.selected { border-color:#0d6efd; background:#eff6ff; color:#1d4ed8; }
    .mode-btn:hover:not(.selected) { border-color:#9ca3af; background:#f9fafb; }
    .run-submit { display:inline-flex; align-items:center; gap:6px; padding:8px 20px; background:#16a34a;
                  color:#fff; border:none; border-radius:8px; font-size:0.85rem; font-weight:600;
                  cursor:pointer; transition:background .15s; }
    .run-submit:hover { background:#15803d; }
    .run-submit:disabled { background:#d1d5db; color:#9ca3af; cursor:not-allowed; }
    .stop-submit { display:inline-flex; align-items:center; gap:6px; padding:8px 20px; background:#dc2626;
                   color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; transition:background .15s; }
    .stop-submit:hover { background:#b91c1c; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta" style="flex:1"></div>
  </header>

  <div class="page">
    <div class="topbar">
      <a href="/dashboard" class="back-btn">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Dashboard
      </a>
      <div>
        <div class="ticket-title">
          <span id="status-icon">${(ICONS[ticket.status] || ICONS.queued)(22)}</span>
          ${ticket.ticketKey}
          <span id="status-badge" class="badge badge-${ticket.status}" style="font-size:0.85rem">${ticket.status}</span>
          ${modeBadge(ticket.mode)}
        </div>
        <div class="ticket-meta">
          <span>Source: <strong>${ticket.source}</strong></span>
          <span>Queued: <strong>${fmt(ticket.queuedAt)}</strong></span>
          ${ticket.startedAt    ? `<span>Started: <strong>${fmt(ticket.startedAt)}</strong></span>`    : ''}
          ${ticket.completedAt  ? `<span>Finished: <strong>${fmt(ticket.completedAt)}</strong></span>` : ''}
          <span>Duration: <strong id="duration-val">${dur(ticket.startedAt, ticket.completedAt)}</strong></span>
        </div>
      </div>
    </div>

    <div id="interrupt-banner"
         class="interrupt-banner interrupt-banner-${ticket.interruptReason || 'manual'}"
         ${ticket.status !== 'interrupted' ? 'style="display:none"' : ''}>
      ${interruptBannerIcon(ticket.interruptReason)}
      <div>
        <strong>Job Interrupted</strong>
        <p class="interrupt-reason-text">${interruptReasonMessage(ticket.interruptReason)}</p>
      </div>
    </div>

    ${warn === 'seen' ? (() => {
      const safeKey = ticket.ticketKey.replace(/[^A-Za-z0-9_-]/g, '');
      const chosenMode = warnMode || ticket.mode || 'dev';
      const seenFile   = config.seenCacheFile;
      return `
    <div class="warn-banner">
      <h3>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        Ticket is in the seen-tickets cache
      </h3>
      <p><strong>${safeKey}</strong> is recorded in <code>${seenFile}</code>.
        The polling script skips tickets already in this file, so re-running from the dashboard
        will still work — but if you also want <code>poll-jira.sh</code> to pick it up again automatically,
        you need to remove it from the cache first.</p>
      <ol>
        <li>Remove just this ticket:<br>
            <code>sed -i '' '/^${safeKey}$/d' "${seenFile}"</code></li>
        <li>Or clear the entire cache (all tickets will be re-evaluated on next poll):<br>
            <code>truncate -s 0 "${seenFile}"</code></li>
      </ol>
      <div class="warn-actions">
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/run">
          <input type="hidden" name="mode"  value="${chosenMode}">
          <input type="hidden" name="force" value="1">
          <button type="submit" class="force-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                 fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Force Run &amp; remove from cache
          </button>
        </form>
        <span style="font-size:0.78rem;color:#92400e">
          This removes <strong>${safeKey}</strong> from the seen-tickets file and starts the job now.
        </span>
      </div>
    </div>`;
    })() : ''}

    <!-- Pipeline -->
    <div class="panel">
      <div class="panel-header">
        <h2>Pipeline</h2>
        <span id="pipeline-meta" style="font-size:0.78rem;color:#888;display:flex;align-items:center;gap:.75rem">
          ${stages.length ? `<span id="stage-count">${doneCount} / ${stages.length} stages</span>` : ''}
          ${currentStage ? `<span id="current-stage" style="color:#0d6efd">Currently: Step ${currentStage.id} — ${currentStage.label}</span>` : ''}
        </span>
      </div>
      <div class="panel-body">
        <div id="pipeline-content">${stagePipelineHtml(stages)}</div>
        ${stages.length ? `<div class="progress-wrap"><div id="progress-bar" class="progress-bar" style="width:${Math.round(doneCount / stages.length * 100)}%"></div></div>` : ''}
      </div>
    </div>

    <!-- Reports -->
    ${reportFiles.length ? `
    <div class="panel">
      <div class="panel-header"><h2>Reports</h2></div>
      <div class="panel-body" style="display:flex;gap:1rem;flex-wrap:wrap">
        ${reportFiles.map(f => {
          const ext = path.extname(f).toUpperCase().replace('.', '');
          const base = path.basename(f);
          const enc = encodeURIComponent(f);
          return `<a href="/dashboard/download?path=${enc}" class="dl-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download ${ext} — ${base}
          </a>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Re-run -->
    <div class="panel">
      <div class="panel-header"><h2>Run</h2></div>
      <div class="panel-body">
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/run"
              class="run-panel" onsubmit="return confirmDetailRun(this)">
          <label>Mode:</label>
          <div class="mode-btn-group" id="mode-group">
            ${['dev','review','estimate'].map(m => `
              <button type="button" class="mode-btn${(ticket.mode || 'dev') === m ? ' selected' : ''}"
                      onclick="selectMode('${m}')">${m.charAt(0).toUpperCase() + m.slice(1)}</button>`).join('')}
          </div>
          <input type="hidden" name="mode" id="mode-input" value="${ticket.mode || 'dev'}">
          <button type="submit" class="run-submit" ${ticket.status === 'running' || ticket.status === 'queued' ? 'disabled' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                 fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            ${ticket.status === 'running' ? 'Running…' : ticket.status === 'queued' ? 'Queued…' : 'Run'}
          </button>
          ${ticket.status === 'running' || ticket.status === 'queued' ? `
          <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/stop"
                style="display:inline" onsubmit="return confirm('Stop this job?')">
            <button type="submit" class="stop-submit">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                   fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop Job
            </button>
          </form>` : ''}
        </form>
      </div>
    </div>

    <!-- Claude session output / PDF fallback -->
    <div class="panel">
      <div class="panel-header">
        <h2>View Output</h2>
        <a href="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/log.txt"
           download="${ticket.ticketKey}-output.txt"
           style="display:inline-flex;align-items:center;gap:.35rem;font-size:.76rem;color:#6b7280;text-decoration:none;padding:.2rem .6rem;border:1px solid #e5e7eb;border-radius:5px;white-space:nowrap"
           title="Download full output log as .txt">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download log
        </a>
      </div>
      <div class="panel-body">
        <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem">
          <input type="text" id="output-search" placeholder="Search output…" oninput="filterOutput(this.value)"
                 style="flex:1;padding:.35rem .75rem;border:1px solid #e5e7eb;border-radius:6px;font-size:.82rem;font-family:inherit;outline:none">
          <span id="output-match-count" style="font-size:.75rem;color:#9ca3af;white-space:nowrap;min-width:6rem;text-align:right"></span>
        </div>
        ${outputSection}
      </div>
    </div>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion}</div>

  <script>
    function toggleOutput() {
      const box = document.getElementById('output-box');
      const lbl = document.getElementById('toggle-label');
      const open = box.classList.toggle('open');
      lbl.textContent = open ? 'Hide Output' : 'View Output';
      if (open) box.scrollTop = box.scrollHeight;
    }
    function filterOutput(q) {
      const entries = document.querySelectorAll('#output-box .log-entry');
      const term = q.trim().toLowerCase();
      let matches = 0;
      entries.forEach(el => {
        const show = !term || el.textContent.toLowerCase().includes(term);
        el.style.display = show ? '' : 'none';
        if (show && term) matches++;
      });
      const cnt = document.getElementById('output-match-count');
      if (cnt) cnt.textContent = term ? matches + ' match' + (matches === 1 ? '' : 'es') : '';
    }
    function selectMode(mode) {
      document.getElementById('mode-input').value = mode;
      document.querySelectorAll('#mode-group .mode-btn').forEach(b => {
        b.classList.toggle('selected', b.textContent.trim().toLowerCase() === mode);
      });
    }
    function confirmDetailRun(form) {
      const mode = document.getElementById('mode-input').value;
      return confirm('Run ${ticket.ticketKey} in ' + mode + ' mode?');
    }

    // Live polling — updates dynamic parts without a full page reload
    (function () {
      const ACTIVE = ['running', 'queued'];
      const ticketKey = ${JSON.stringify(ticket.ticketKey)};
      let knownOutputCount = ${outputLines.length};

      if (!ACTIVE.includes(${JSON.stringify(ticket.status)})) return;

      const timer = setInterval(async () => {
        let data;
        try {
          const res = await fetch('/dashboard/ticket/' + encodeURIComponent(ticketKey) + '/partial?since=' + knownOutputCount);
          if (!res.ok) return;
          data = await res.json();
        } catch (_) { return; }

        // Pipeline
        const pc = document.getElementById('pipeline-content');
        if (pc) pc.innerHTML = data.pipelineHtml;

        const pb = document.getElementById('progress-bar');
        if (pb) pb.style.width = data.progressPct + '%';

        const sc = document.getElementById('stage-count');
        if (sc) sc.textContent = data.doneCount + ' / ' + data.totalStages + ' stages';

        const cs = document.getElementById('current-stage');
        if (data.currentStageLabel) {
          if (cs) { cs.textContent = 'Currently: ' + data.currentStageLabel; cs.style.display = ''; }
        } else if (cs) { cs.style.display = 'none'; }

        // Duration
        const dv = document.getElementById('duration-val');
        if (dv && data.duration) dv.textContent = data.duration;

        // Output — append only new entries to preserve scroll and open state
        if (data.newLogEntries && data.newLogEntries.length) {
          const box = document.getElementById('output-box');
          if (box) {
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
            box.insertAdjacentHTML('beforeend', data.newLogEntries.join(''));
            if (atBottom) box.scrollTop = box.scrollHeight;
          }
          knownOutputCount += data.newLogEntries.length;
          const oc = document.getElementById('output-count');
          if (oc) oc.textContent = knownOutputCount;
        }

        // Status badge + icon
        if (data.status) {
          const badge = document.getElementById('status-badge');
          if (badge) {
            badge.className = 'badge badge-' + data.status;
            const labels = { queued: 'queued', running: 'running', success: 'success', failed: 'failed', interrupted: 'interrupted' };
            badge.textContent = labels[data.status] || data.status;
          }
          const icon = document.getElementById('status-icon');
          if (icon && data.statusIconHtml) icon.innerHTML = data.statusIconHtml;
        }

        // Interrupt banner — show with reason when job is stopped mid-run
        if (data.status === 'interrupted') {
          const REASON_MSGS = {
            budget_exceeded: 'Monthly budget limit reached — the job was stopped automatically to prevent overspend. Increase PRX_MONTHLY_BUDGET in your .env or wait for the next billing cycle.',
            low_balance: 'Anthropic account balance too low — the API returned a billing error mid-run. Top up your account balance or check your subscription to continue.',
            server_restart: 'Server was restarted while this job was running. Re-run the ticket to resume.',
            manual: 'Stopped manually by the user.',
          };
          const banner = document.getElementById('interrupt-banner');
          if (banner) {
            const reason = data.interruptReason || 'manual';
            banner.className = 'interrupt-banner interrupt-banner-' + reason;
            const txt = banner.querySelector('.interrupt-reason-text');
            if (txt) txt.textContent = REASON_MSGS[reason] || reason;
            banner.style.display = '';
          }
        }

        // Stop polling once job is no longer active
        if (!ACTIVE.includes(data.status)) clearInterval(timer);
      }, 5000);
    })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const budget = await getBudgetStatus();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboard(getStats(), budget));
});

router.get('/json', (_req, res) => res.json(getStats()));

// Lightweight processing indicator — polled every 4 s by the sun-logo script.
// O(1) Map scan; does not touch disk, rebuild merged sets, or sort.
router.get('/busy', (_req, res) => res.json({ busy: hasActive() }));

// Activity log
router.get('/activity', (req, res) => {
  const { type, ticketKey, actor, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const results = activityLog.getFiltered({ type, ticketKey, actor, from, to, page, pageSize: 100 });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderActivity(
    results,
    activityLog.getChartData(),
    activityLog.getAllTypes(),
    activityLog.getAllActors(),
    activityLog.getStats(),
    { type, ticketKey, actor, from, to },
  ));
});

router.get('/activity/json', (_req, res) => {
  res.json({ stats: activityLog.getStats(), chartData: activityLog.getChartData() });
});

// Disk monitor
router.get('/disk', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDisk(readDiskStatus(), readDiskLog(), req.query.cleaned === '1' ? 'cleaned' : null));
});

router.get('/disk/json', (_req, res) => {
  res.json({ status: readDiskStatus(), log: readDiskLog().slice(-100) });
});

router.post('/disk/approve-cleanup', (_req, res) => {
  const PREVOYANT_DIR = path.join(os.homedir(), '.prevoyant');
  const sessionsDir   = path.join(PREVOYANT_DIR, 'sessions');
  const serverDir     = path.join(PREVOYANT_DIR, 'server');
  // Knowledge base is never included in cleanup targets — resolve its path
  // so we can double-check that no candidate path ever falls inside it.
  const protectedKbDir = path.resolve(kbDir());
  const KEEP_DAYS      = 30;
  const cutoff         = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let deletedSessions  = 0;
  let trimmedLogs      = 0;

  function isSafeToDelete(fullPath) {
    const resolved = path.resolve(fullPath);
    // Never delete anything inside the knowledge base directory
    return !resolved.startsWith(protectedKbDir + path.sep) && resolved !== protectedKbDir;
  }

  // Remove session directories older than KEEP_DAYS days
  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(sessionsDir, e.name);
      if (!isSafeToDelete(full)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          deletedSessions++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Trim disk-log.json to last 200 entries
  try {
    const logPath = path.join(serverDir, 'disk-log.json');
    let log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (Array.isArray(log) && log.length > 200) {
      fs.writeFileSync(logPath, JSON.stringify(log.slice(-200)));
      trimmedLogs++;
    }
  } catch (_) {}

  // Trim activity-log.json to last 2000 entries
  try {
    const actPath = path.join(serverDir, 'activity-log.json');
    let log = JSON.parse(fs.readFileSync(actPath, 'utf8'));
    if (Array.isArray(log) && log.length > 2000) {
      fs.writeFileSync(actPath, JSON.stringify(log.slice(-2000)));
      trimmedLogs++;
    }
  } catch (_) {}

  // Trim watch poll logs — delete by age AND enforce per-ticket cap
  const WATCH_KEEP_DAYS = parseInt(process.env.PRX_WATCH_LOG_KEEP_DAYS       || '30', 10);
  const WATCH_KEEP_PER  = parseInt(process.env.PRX_WATCH_LOG_KEEP_PER_TICKET || '10', 10);
  const watchCutoff     = Date.now() - WATCH_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let deletedWatchLogs  = 0;
  try {
    const ticketDirs = fs.readdirSync(WATCH_LOG_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const td of ticketDirs) {
      const dir = path.join(WATCH_LOG_DIR, td.name);
      // Delete files older than cutoff
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort(); }
      catch (_) { continue; }
      for (const f of files) {
        const fp = path.join(dir, f);
        try {
          if (fs.statSync(fp).mtimeMs < watchCutoff) {
            fs.unlinkSync(fp);
            deletedWatchLogs++;
          }
        } catch (_) {}
      }
      // Enforce per-ticket cap on what remains
      try {
        const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort();
        if (remaining.length > WATCH_KEEP_PER) {
          for (const f of remaining.slice(0, remaining.length - WATCH_KEEP_PER)) {
            try { fs.unlinkSync(path.join(dir, f)); deletedWatchLogs++; } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Update status file
  try {
    const existing = readDiskStatus();
    fs.writeFileSync(
      DISK_STATUS_FILE,
      JSON.stringify({ ...existing, pendingCleanup: false, lastCleanupAt: new Date().toISOString() }, null, 2)
    );
  } catch (_) {}

  activityLog.record('disk_cleanup', null, 'user', { deletedSessions, trimmedLogs, deletedWatchLogs });
  res.redirect(303, '/dashboard/disk?cleaned=1');
});

router.post('/disk/dismiss-cleanup', (_req, res) => {
  try {
    const existing = readDiskStatus();
    fs.writeFileSync(
      DISK_STATUS_FILE,
      JSON.stringify({ ...existing, pendingCleanup: false }, null, 2)
    );
  } catch (_) {}
  res.json({ ok: true });
});

router.get('/ticket/:key', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).send('Ticket not found.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDetail(ticket, req.query.warn, req.query.mode));
});

// Partial update endpoint — returns only what the live-poll JS needs
router.get('/ticket/:key/partial', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).json({ error: 'not found' });

  const stages = ticket.stages || [];
  const outputLines = ticket.outputLog || [];
  const doneCount = stages.filter(s => s.status === 'done' || s.status === 'failed').length;
  const currentStage = stages.find(s => s.status === 'active');
  const since = parseInt(req.query.since || '0', 10);

  const newLogEntries = outputLines.slice(since).map(l => {
    const ts = new Date(l.ts).toLocaleTimeString('en-GB');
    const isStderr = l.text.startsWith('[stderr]');
    const isResult = l.text.startsWith('[Result]');
    let bodyHtml;
    if (isStderr) {
      const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      bodyHtml = `<span class="log-stderr">${t}</span>`;
    } else if (isResult) {
      const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      bodyHtml = `<span class="log-result">${t}</span>`;
    } else {
      bodyHtml = renderMarkdown(l.text);
    }
    return `<div class="log-entry"><div class="log-ts">${ts}</div><div class="log-body">${bodyHtml}</div></div>`;
  });

  res.json({
    status: ticket.status,
    interruptReason: ticket.interruptReason || null,
    statusIconHtml: (ICONS[ticket.status] || ICONS.queued)(22),
    pipelineHtml: stagePipelineHtml(stages),
    progressPct: stages.length ? Math.round(doneCount / stages.length * 100) : 0,
    doneCount,
    totalStages: stages.length,
    currentStageLabel: currentStage ? `Step ${currentStage.id} — ${currentStage.label}` : null,
    duration: dur(ticket.startedAt, ticket.completedAt),
    newLogEntries,
    totalOutputCount: outputLines.length,
  });
});

// Secure inline view (for PDF iframe embedding)
router.get('/view', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).send('Missing path.');
  const { reportsDir } = getStats();
  const resolved = path.resolve(rawPath);
  const base = path.resolve(reportsDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(403).send('Access denied.');
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found.');
  const ct = resolved.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html';
  res.setHeader('Content-Type', ct);
  fs.createReadStream(resolved).pipe(res);
});

// Run / re-run a ticket
router.post('/ticket/:key/run', express.urlencoded({ extended: false }), (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  const mode  = (req.body.mode  || 'dev').toLowerCase();
  const force = req.body.force === '1';

  if (!VALID_MODES.has(mode)) return res.status(400).send('Invalid mode.');

  const existing = getTicket(ticketKey);
  if (existing && (existing.status === 'running' || existing.status === 'queued')) {
    return res.status(409).send('Job already in progress.');
  }

  if (!force && isInSeenCache(ticketKey)) {
    const enc = encodeURIComponent(ticketKey);
    return res.redirect(303, `/dashboard/ticket/${enc}?warn=seen&mode=${encodeURIComponent(mode)}`);
  }

  if (force) removeFromSeenCache(ticketKey);

  reRunTicket(ticketKey, mode, 'manual');
  enqueue(ticketKey, mode);
  res.redirect(303, `/dashboard/ticket/${encodeURIComponent(ticketKey)}`);
});

// Stop a running or queued job
router.post('/ticket/:key/stop', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  killJob(ticketKey);
  res.redirect(303, `/dashboard/ticket/${encodeURIComponent(ticketKey)}`);
});

router.post('/ticket/:key/prioritize', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  prioritizeJob(ticketKey);
  activityLog.record('ticket_prioritized', ticketKey, 'user', {});
  res.redirect(303, '/dashboard');
});

router.post('/ticket/:key/delete', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  const ticket = getTicket(ticketKey);
  if (ticket && (ticket.status === 'running' || ticket.status === 'queued')) {
    return res.status(400).send('Cannot delete a running or queued ticket. Stop it first.');
  }
  if (ticket && ticket.status === 'scheduled') {
    killJob(ticketKey); // cancels the timer; records interrupted — deleteTicket below overwrites that
  }
  deleteTicket(ticketKey);
  res.redirect(303, '/dashboard');
});

// KB backup export
router.get('/kb/export', (req, res) => {
  const includeSessions  = req.query.sessions  === '1';
  const includeReports   = req.query.reports   === '1';
  const includeServer    = req.query.server    === '1';
  const includeWatchLogs = req.query.watchlogs === '1';
  const includeMemory    = req.query.memory    === '1';

  const kb = kbStats();
  const dirs = [];
  if (kb.kbExists)                                      dirs.push(kb.kbDir);
  if (includeSessions  && kb.sessionFiles  > 0)         dirs.push(kb.sessions);
  if (includeReports   && kb.reportFiles   > 0)         dirs.push(kb.reports);
  if (includeServer    && kb.serverFiles   > 0)         dirs.push(kb.serverDir);
  if (includeWatchLogs && kb.watchLogFiles > 0)         dirs.push(kb.watchLogs);
  if (includeMemory    && kb.memoryFiles   > 0)         dirs.push(kb.memoryDir);

  const validDirs = dirs.filter(d => fs.existsSync(d));
  if (validDirs.length === 0) return res.status(404).send('No files found to export.');

  const stamp   = new Date().toISOString().slice(0, 10);
  const tmpFile = path.join(os.tmpdir(), `prevoyant-backup-${Date.now()}.tar.gz`);

  execFile('tar', ['-czf', tmpFile, ...validDirs], (err) => {
    if (err) {
      console.error('[kb/export] tar failed:', err.message);
      return res.status(500).send('Failed to create backup archive: ' + err.message);
    }
    activityLog.record('kb_exported', null, 'user', {
      includeSessions, includeReports, includeServer, includeWatchLogs, includeMemory,
    });
    res.download(tmpFile, `prevoyant-backup-${stamp}.tar.gz`, () => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });
});

// KB backup import — restore from .tar.gz without overwriting existing files
router.post('/kb/import', express.raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'No file data received.' });
  }

  const tmpFile = path.join(os.tmpdir(), `prevoyant-import-${Date.now()}.tar.gz`);

  try {
    fs.writeFileSync(tmpFile, req.body);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write temp file: ' + e.message });
  }

  const prevoyantDir = path.join(os.homedir(), '.prevoyant');
  const before = countFilesRecursive(prevoyantDir);

  // -k / --keep-old-files: skip any file that already exists on disk
  // tar exits with code 1 when files are skipped — that is expected and not a failure
  execFile('tar', ['-xzf', tmpFile, '-k'], (err) => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}

    if (err && err.code !== 1) {
      console.error('[kb/import] tar failed (code %d): %s', err.code, err.message);
      return res.status(500).json({ error: 'Extraction failed: ' + err.message });
    }

    const after   = countFilesRecursive(prevoyantDir);
    const added   = Math.max(0, after - before);
    const skipped = !!(err && err.code === 1);

    console.log(`[kb/import] done — added=${added} skipped=${skipped}`);
    activityLog.record('kb_imported', null, 'user', { added, skipped });
    res.json({ ok: true, added, skipped });
  });
});

// Secure download
router.get('/download', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).send('Missing path.');
  const { reportsDir } = getStats();
  const resolved = path.resolve(rawPath);
  const base = path.resolve(reportsDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(403).send('Access denied.');
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found.');
  res.download(resolved);
});

// Queue pause / resume
router.post('/queue/pause',  (_req, res) => { pauseQueue();  res.json({ paused: true  }); });
router.post('/queue/resume', (_req, res) => { resumeQueue(); res.json({ paused: false }); });
router.get('/queue/status',  (_req, res) => res.json({ paused: isPaused(), depth: getQueueDepth() }));

// Bulk queue tickets
router.post('/tickets/bulk-run', express.urlencoded({ extended: false }), (req, res) => {
  const raw  = (req.body.keys || '').trim();
  const mode = (req.body.mode  || 'dev').toLowerCase();
  if (!VALID_MODES.has(mode)) return res.status(400).json({ error: 'Invalid mode.' });

  const keys = [...new Set(
    raw.split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(k => /^[A-Z]+-\d+$/.test(k))
  )];
  if (keys.length === 0) return res.status(400).json({ error: 'No valid ticket keys.' });
  if (keys.length > 20)  return res.status(400).json({ error: 'Maximum 20 tickets per bulk run.' });

  let queued = 0;
  for (const key of keys) {
    const existing = getTicket(key);
    if (existing && (existing.status === 'running' || existing.status === 'queued')) continue;
    reRunTicket(key, mode, 'manual');
    enqueue(key, mode);
    queued++;
  }
  res.json({ queued, skipped: keys.length - queued, keys });
});

// Output log download
router.get('/ticket/:key/log.txt', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).send('Not found.');
  const lines = (ticket.outputLog || []).map(l =>
    `[${new Date(l.ts).toISOString()}] ${l.text}`
  );
  const safe = req.params.key.replace(/[^A-Za-z0-9_-]/g, '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-output.txt"`);
  res.send(lines.join('\n'));
});

// Manually queue a ticket (from the Add Ticket modal on the dashboard)
router.post('/queue', express.urlencoded({ extended: false }), (req, res) => {
  const ticketKey = (req.body.ticketKey || '').toUpperCase().trim();
  const mode = (req.body.mode || 'dev').toLowerCase();
  if (!ticketKey || !VALID_MODES.has(mode)) return res.redirect(303, '/dashboard');

  const priority = (req.body.priority || 'normal') === 'urgent' ? 'urgent' : 'normal';

  const existing = getTicket(ticketKey);
  if (existing && (existing.status === 'running' || existing.status === 'queued' || existing.status === 'scheduled')) {
    return res.redirect(303, '/dashboard');
  }

  const rawScheduled = (req.body.scheduledAt || '').trim();
  if (rawScheduled) {
    const scheduledFor = new Date(rawScheduled);
    if (!isNaN(scheduledFor) && scheduledFor > new Date()) {
      recordScheduled(ticketKey, mode, scheduledFor, 'manual');
      scheduleJob(ticketKey, mode, scheduledFor);
      return res.redirect(303, '/dashboard');
    }
  }

  reRunTicket(ticketKey, mode, 'manual', priority);
  enqueue(ticketKey, mode, priority);
  res.redirect(303, '/dashboard');
});

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSettings(readEnvValues(), _req.query.saved === '1' ? 'saved' : null));
});

// Memory status API — polled by the settings page JS to show live badge + connection test
router.get('/api/memory-status', async (_req, res) => {
  try {
    const mem    = require('../memory/memoryAdapter');
    const result = await mem.stats();
    res.json(result);
  } catch (err) {
    res.json({ enabled: false, backend: 'none', connected: false, total: 0, error: err.message });
  }
});

router.post('/settings', express.urlencoded({ extended: false }), (req, res) => {
  const FIELDS = [
    'PRX_REPO_DIR',
    'JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN',
    'WEBHOOK_PORT', 'WEBHOOK_SECRET', 'WEBHOOK_POLL_INTERVAL_DAYS',
    'PRX_KB_MODE', 'PRX_SOURCE_REPO_URL', 'PRX_KNOWLEDGE_DIR',
    'PRX_KB_REPO', 'PRX_KB_LOCAL_CLONE', 'PRX_KB_KEY',
    'PRX_REALTIME_KB_SYNC', 'PRX_UPSTASH_REDIS_URL', 'PRX_UPSTASH_REDIS_TOKEN',
    'PRX_KB_SYNC_MACHINE', 'PRX_KB_SYNC_POLL_SECS', 'PRX_KB_SYNC_TRIGGER', 'PRX_KB_SYNC_DEBOUNCE_SECS',
    'CLAUDE_REPORT_DIR',
    'AUTO_MODE', 'FORCE_FULL_RUN', 'PRX_REPORT_VERBOSITY',
    'PRX_JIRA_PROJECT', 'PRX_ATTACHMENT_MAX_MB',
    'PRX_RETRY_MAX', 'PRX_RETRY_BACKOFF',
    'PRX_EMAIL_TO', 'PRX_SMTP_HOST', 'PRX_SMTP_PORT', 'PRX_SMTP_USER', 'PRX_SMTP_PASS',
    'PRX_NOTIFY_ENABLED', 'PRX_NOTIFY_LEVEL', 'PRX_NOTIFY_MUTE_DAYS', 'PRX_NOTIFY_EVENTS',
    'PRX_INCLUDE_SM_IN_SESSIONS_ENABLED', 'PRX_SKILL_UPGRADE_MIN_SESSIONS',
    'PRX_SKILL_COMPACTION_INTERVAL', 'PRX_MONTHLY_BUDGET',
    'PRX_MEMORY_INDEX_ENABLED', 'PRX_MEMORY_LIMIT',
    'PRX_REDIS_ENABLED', 'PRX_REDIS_URL', 'PRX_REDIS_PASSWORD', 'PRX_REDIS_PREFIX', 'PRX_REDIS_TTL_DAYS',
    'PRX_WATCHDOG_ENABLED', 'PRX_WATCHDOG_INTERVAL_SECS', 'PRX_WATCHDOG_FAIL_THRESHOLD',
    'PRX_DISK_MONITOR_ENABLED', 'PRX_DISK_MONITOR_INTERVAL_MINS', 'PRX_PREVOYANT_MAX_SIZE_MB', 'PRX_DISK_CAPACITY_ALERT_PCT', 'PRX_DISK_CLEANUP_INTERVAL_DAYS',
    'PRX_WATCH_ENABLED', 'PRX_WATCH_POLL_INTERVAL', 'PRX_WATCH_MAX_POLLS',
    'PRX_WATCH_LOG_KEEP_DAYS', 'PRX_WATCH_LOG_KEEP_PER_TICKET',
    'PRX_WASENDER_ENABLED', 'PRX_WASENDER_API_KEY', 'PRX_WASENDER_TO',
    'PRX_WASENDER_PUBLIC_URL', 'PRX_WASENDER_EVENTS', 'PRX_WASENDER_PDF_PASSWORD',
  ];

  try {
    const updates = {};
    for (const key of FIELDS) {
      if (key in req.body) updates[key] = String(req.body[key] || '').trim();
    }

    // Compute PRX_NOTIFY_MUTE_UNTIL from PRX_NOTIFY_MUTE_DAYS when saving with mute level
    const notifyLevel = updates['PRX_NOTIFY_LEVEL'] || '';
    const muteDays    = parseInt(updates['PRX_NOTIFY_MUTE_DAYS'] || '0', 10);
    if (notifyLevel === 'mute' && muteDays > 0) {
      const until = new Date(Date.now() + muteDays * 86400 * 1000);
      updates['PRX_NOTIFY_MUTE_UNTIL'] = until.toISOString();
    } else if (notifyLevel !== 'mute') {
      updates['PRX_NOTIFY_MUTE_UNTIL'] = '';
    }

    writeEnvValues(updates);
    // Bust budget cache so new admin key / budget takes effect immediately
    _budgetCache    = null;
    _budgetCachedAt = 0;
    activityLog.record('settings_saved', null, 'user', {
      fields: Object.keys(updates).filter(k => updates[k] !== '').join(','),
    });
    // Notify index.js to reactively start/stop workers (disk monitor, watchdog)
    // without requiring a full server restart.
    serverEvents.emit('settings-saved', updates);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderSettings(readEnvValues(), 'error'));
  }

  if (req.body._restart === '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderRestartPage());
    // Detached script: stop current server then start fresh (picks up new .env)
    setImmediate(() => {
      const scripts = path.join(__dirname, '../scripts');
      const child = spawn('bash', ['-c',
        `sleep 1 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    });
  } else {
    res.redirect(303, '/dashboard/settings?saved=1');
  }
});

// Standalone restart (no save) — useful for manual recovery
router.post('/restart', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderRestartPage());
  setImmediate(() => {
    const scripts = path.join(__dirname, '../scripts');
    const child = spawn('bash', ['-c',
      `sleep 1 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  });
});

// Manual update check — fetches latest version from GitHub and updates status file
router.post('/check-update', (_req, res) => {
  const https = require('https');
  const pluginJsonPath = path.resolve(__dirname, '../../plugin/.claude-plugin/plugin.json');
  let currentVersion = '0.0.0';
  try { currentVersion = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')).version || '0.0.0'; } catch (_) {}

  const REMOTE_URL = 'https://raw.githubusercontent.com/dodogeny/prevoyant-claude-plugin/main/plugin/.claude-plugin/plugin.json';

  function semverNewer(remote, current) {
    const parse = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const [rMaj, rMin, rPat] = parse(remote);
    const [cMaj, cMin, cPat] = parse(current);
    if (rMaj !== cMaj) return rMaj > cMaj;
    if (rMin !== cMin) return rMin > cMin;
    return rPat > cPat;
  }

  const req2 = https.get(REMOTE_URL, { timeout: 15000 }, r => {
    if (r.statusCode !== 200) {
      r.resume();
      return res.json({ ok: false, error: `HTTP ${r.statusCode}` });
    }
    let data = '';
    r.on('data', chunk => { data += chunk; });
    r.on('end', () => {
      try {
        const latestVersion = JSON.parse(data).version || null;
        const available = latestVersion ? semverNewer(latestVersion, currentVersion) : false;
        const statusFile = UPDATE_STATUS_FILE;
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (_) {}
        const updated = { ...existing, available, latestVersion, currentVersion, checkedAt: new Date().toISOString() };
        try {
          fs.mkdirSync(path.dirname(statusFile), { recursive: true });
          fs.writeFileSync(statusFile, JSON.stringify(updated, null, 2));
        } catch (_) {}
        res.json({ ok: true, available, latestVersion, currentVersion });
      } catch (e) {
        res.json({ ok: false, error: `Bad JSON: ${e.message}` });
      }
    });
  });
  req2.on('error', e => res.json({ ok: false, error: e.message }));
  req2.on('timeout', () => { req2.destroy(); res.json({ ok: false, error: 'Request timed out' }); });
});

// Upgrade — pulls latest from git then restarts the server
router.post('/upgrade', (_req, res) => {
  const repoRoot = path.resolve(__dirname, '../..');
  const { execFile: ef } = require('child_process');

  ef('git', ['-C', repoRoot, 'pull', '--ff-only'], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message || '').trim();
      activityLog.record('upgrade_failed', null, 'system', { error: msg });
      return res.json({ ok: false, error: msg });
    }

    activityLog.record('upgrade_completed', null, 'system', { output: stdout.trim() });
    res.json({ ok: true, output: stdout.trim() });

    // Restart server after a brief delay so the JSON response reaches the client
    setImmediate(() => {
      const scripts = path.join(__dirname, '../scripts');
      let child;
      if (process.platform === 'win32') {
        child = spawn('powershell', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Start-Sleep 2; & "${scripts}\\stop.ps1"; Start-Sleep 2; & "${scripts}\\start.ps1"`
        ], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('bash', ['-c',
          `sleep 2 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
        ], { detached: true, stdio: 'ignore' });
      }
      child.unref();
    });
  });
});

// ── Ticket Watcher ────────────────────────────────────────────────────────────

router.get('/watch', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderWatch(req.query.flash || null));
});

router.get('/watch/json', (_req, res) => {
  res.json(watchStore.list());
});

router.post('/watch/add', express.urlencoded({ extended: false }), (req, res) => {
  const key      = ((req.body.key || '').toUpperCase().trim()).replace(/[^A-Z0-9_-]/g, '');
  const interval = ['1h','1d','2d','5d'].includes(req.body.interval) ? req.body.interval : '1d';
  const maxPolls = parseInt(req.body.maxPolls) || 0;

  if (!key) return res.redirect(303, '/dashboard/watch?flash=nokey');

  const existing = watchStore.get(key);
  if (existing && existing.status === 'watching') {
    return res.redirect(303, '/dashboard/watch?flash=exists');
  }

  watchStore.addTicket(key, interval, maxPolls);
  watchManager.addTicket(key, interval, maxPolls);
  activityLog.record('watch_added', key, 'user', { interval, maxPolls });
  res.redirect(303, '/dashboard/watch?flash=added');
});

router.post('/watch/:key/stop', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchStore.stopTicket(key);
  watchManager.stopTicket(key);
  activityLog.record('watch_stopped', key, 'user', {});
  res.redirect(303, '/dashboard/watch?flash=stopped');
});

router.post('/watch/:key/resume', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchStore.resumeTicket(key);
  watchManager.resumeTicket(key);
  activityLog.record('watch_resumed', key, 'user', {});
  res.redirect(303, '/dashboard/watch?flash=resumed');
});

router.post('/watch/:key/poll', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchManager.pollNow(key);
  res.redirect(303, '/dashboard/watch?flash=polled');
});

router.post('/watch/:key/remove', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchStore.stopTicket(key);
  watchManager.stopTicket(key);
  watchStore.removeTicket(key);
  activityLog.record('watch_removed', key, 'user', {});
  res.redirect(303, '/dashboard/watch?flash=removed');
});

// ── Watch log routes ──────────────────────────────────────────────────────────

// Tail the current (or specified) log file — JSON, used by the live panel
router.get('/watch/:key/log/tail', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const ticket = watchStore.get(key);
  const file   = path.basename((req.query.file || ticket?.lastLogFile || '').toString());
  if (!file || !file.endsWith('.log')) return res.json({ content: '', done: true });
  const logPath = path.join(WATCH_LOG_DIR, key, file);
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    res.json({ content, done: !(ticket?.pollingNow && ticket?.lastLogFile === file) });
  } catch (_) {
    res.json({ content: '', done: true });
  }
});

// List all log files for a ticket
router.get('/watch/:key/logs', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const logDir = path.join(WATCH_LOG_DIR, key);
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse();
  } catch (_) {}
  res.send(renderWatchLogs(key, files, watchStore.get(key), req.query.flash || null));
});

// Delete all log files for a ticket (removes the entire ticket log directory)
router.post('/watch/:key/logs/clear', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const ticket = watchStore.get(key);
  if (ticket?.pollingNow) return res.redirect(303, `/dashboard/watch/${key}/logs`);
  const logDir = path.join(WATCH_LOG_DIR, key);
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (_) {}
  res.redirect(303, `/dashboard/watch/${key}/logs?flash=cleared`);
});

// View a specific log file
router.get('/watch/:key/logs/:file', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const file   = path.basename(req.params.file || '');
  if (!file.endsWith('.log')) return res.status(400).send('Invalid log file');
  const logPath = path.join(WATCH_LOG_DIR, key, file);
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    res.send(renderWatchLogView(key, file, content, watchStore.get(key)));
  } catch (_) {
    res.status(404).send('Log file not found');
  }
});

// ── Report file serving (for WhatsApp document delivery) ─────────────────────
// WaSenderAPI fetches the document from a URL — this endpoint serves PDFs from
// CLAUDE_REPORT_DIR so WaSenderAPI can retrieve them. Requires PRX_WASENDER_PUBLIC_URL
// to be set to a publicly reachable base URL (e.g. https://yourserver.com).

router.get('/reports/serve/:filename', (req, res) => {
  const filename = path.basename(req.params.filename || '');
  if (!filename.match(/^[A-Za-z0-9_\-]+\.pdf$/i)) return res.status(400).send('Invalid filename');
  const dir      = process.env.CLAUDE_REPORT_DIR || path.join(os.homedir(), '.prevoyant', 'reports');
  const filePath = path.join(dir, filename);
  if (!filePath.startsWith(dir + path.sep)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('Report not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
