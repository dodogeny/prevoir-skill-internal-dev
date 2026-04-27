'use strict';

// Prefix every console line with an ISO timestamp so prevoyant-server.log
// entries are traceable without relying on the shell's redirection timestamp.
(function patchConsole() {
  const ts = () => new Date().toISOString();
  for (const level of ['log', 'warn', 'error', 'info']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(`[${ts()}]`, ...args);
  }
})();

const express = require('express');
const path    = require('path');
const { Worker } = require('worker_threads');
const config = require('./config/env');
const jiraWebhook = require('./webhooks/jira');
const dashboardRoutes = require('./dashboard/routes');
const { schedulePollScript, runFallbackPoll } = require('./runner/pollScheduler');
const { restoreScheduledJobs } = require('./queue/jobQueue');
const activityLog   = require('./dashboard/activityLog');
const serverEvents  = require('./serverEvents');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'prevoyant-server', ts: new Date().toISOString() });
});

// Dashboard
app.use('/dashboard', dashboardRoutes);

// Legacy redirect — /stats → /dashboard
app.use('/stats', (req, res) => res.redirect(301, '/dashboard' + req.url));

// Jira pushes events here: POST /jira-events?token=WEBHOOK_SECRET
app.use('/jira-events', jiraWebhook);

// ── Health-monitor watchdog (worker thread) ───────────────────────────────────

let watchdogWorker  = null;
let diskWorker      = null;

function startWatchdog() {
  if (process.env.PRX_WATCHDOG_ENABLED !== 'Y') return;

  const workerData = {
    port:          config.port,
    intervalSecs:  parseInt(process.env.PRX_WATCHDOG_INTERVAL_SECS  || '60', 10),
    failThreshold: parseInt(process.env.PRX_WATCHDOG_FAIL_THRESHOLD || '3',  10),
    smtpHost: process.env.PRX_SMTP_HOST  || '',
    smtpPort: process.env.PRX_SMTP_PORT  || '587',
    smtpUser: process.env.PRX_SMTP_USER  || '',
    smtpPass: process.env.PRX_SMTP_PASS  || '',
    emailTo:  process.env.PRX_EMAIL_TO   || '',
  };

  watchdogWorker = new Worker(
    path.join(__dirname, 'workers', 'healthMonitor.js'),
    { workerData }
  );

  watchdogWorker.on('message', msg => {
    if (msg && msg.type === 'log') {
      // Watchdog log lines already printed inside the worker; suppress duplicates
    }
  });
  watchdogWorker.on('error', err =>
    console.error('[watchdog] Worker thread error:', err.message)
  );
  watchdogWorker.on('exit', code => {
    watchdogWorker = null;
    if (code !== 0) console.error(`[watchdog] Worker thread exited with code ${code}`);
  });

  console.log(`[prevoyant-server] Health watchdog active — check every ${workerData.intervalSecs}s, alert after ${workerData.failThreshold} failures`);
}

function startDiskMonitor() {
  if (process.env.PRX_DISK_MONITOR_ENABLED !== 'Y') return;

  const workerData = {
    intervalMins:        parseInt(process.env.PRX_DISK_MONITOR_INTERVAL_MINS  || '60',  10),
    cleanupIntervalDays: parseInt(process.env.PRX_DISK_CLEANUP_INTERVAL_DAYS  || '7',   10),
    maxSizeMB:           parseInt(process.env.PRX_PREVOYANT_MAX_SIZE_MB       || '500', 10),
    alertPct:            parseInt(process.env.PRX_DISK_CAPACITY_ALERT_PCT     || '80',  10),
    smtpHost: process.env.PRX_SMTP_HOST || '',
    smtpPort: process.env.PRX_SMTP_PORT || '587',
    smtpUser: process.env.PRX_SMTP_USER || '',
    smtpPass: process.env.PRX_SMTP_PASS || '',
    emailTo:  process.env.PRX_EMAIL_TO  || '',
  };

  diskWorker = new Worker(
    path.join(__dirname, 'workers', 'diskMonitor.js'),
    { workerData }
  );

  diskWorker.on('error', err =>
    console.error('[disk-monitor] Worker thread error:', err.message)
  );
  diskWorker.on('exit', code => {
    diskWorker = null;
    if (code !== 0) console.error(`[disk-monitor] Worker thread exited with code ${code}`);
  });

  console.log(`[prevoyant-server] Disk monitor active — check every ${workerData.intervalMins}m, alert at ${workerData.alertPct}% of ${workerData.maxSizeMB} MB quota`);
}

// Signal graceful stop to watchdog before this process exits so it doesn't
// fire a false DOWN alert for intentional restarts / stops.
function stopWatchdog() {
  if (watchdogWorker) {
    watchdogWorker.postMessage({ type: 'graceful-stop' });
  }
}

function stopDiskMonitor() {
  if (diskWorker) {
    diskWorker.postMessage({ type: 'graceful-stop' });
  }
}

process.on('SIGTERM', () => { stopWatchdog(); stopDiskMonitor(); setTimeout(() => process.exit(0), 600); });
process.on('SIGINT',  () => { stopWatchdog(); stopDiskMonitor(); setTimeout(() => process.exit(0), 600); });

// Reactively start/stop workers when settings are saved from the dashboard.
// This avoids requiring a full server restart for monitor enable/disable toggles.
serverEvents.on('settings-saved', () => {
  const diskEnabled     = process.env.PRX_DISK_MONITOR_ENABLED === 'Y';
  const watchdogEnabled = process.env.PRX_WATCHDOG_ENABLED     === 'Y';

  if (diskEnabled && !diskWorker)         startDiskMonitor();
  if (!diskEnabled && diskWorker)         stopDiskMonitor();
  if (watchdogEnabled && !watchdogWorker) startWatchdog();
  if (!watchdogEnabled && watchdogWorker) stopWatchdog();
});

// ── Server listen ─────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`[prevoyant-server] Listening on port ${config.port}`);
  console.log(`[prevoyant-server] Dashboard: http://localhost:${config.port}/dashboard`);
  activityLog.record('server_started', null, 'system', { port: config.port });

  restoreScheduledJobs();
  startWatchdog();
  startDiskMonitor();

  if (config.pollIntervalDays > 0) {
    schedulePollScript(config.pollIntervalDays);
  } else {
    console.log('[prevoyant-server] Scheduled polling disabled — running one-time startup scan as webhook fallback');
    runFallbackPoll();
  }
});
