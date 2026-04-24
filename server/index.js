'use strict';

const express = require('express');
const path    = require('path');
const { Worker } = require('worker_threads');
const config = require('./config/env');
const jiraWebhook = require('./webhooks/jira');
const dashboardRoutes = require('./dashboard/routes');
const { schedulePollScript, runFallbackPoll } = require('./runner/pollScheduler');
const { restoreScheduledJobs } = require('./queue/jobQueue');
const activityLog = require('./dashboard/activityLog');

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

let watchdogWorker = null;

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

// Signal graceful stop to watchdog before this process exits so it doesn't
// fire a false DOWN alert for intentional restarts / stops.
function stopWatchdog() {
  if (watchdogWorker) {
    watchdogWorker.postMessage({ type: 'graceful-stop' });
  }
}

process.on('SIGTERM', () => { stopWatchdog(); setTimeout(() => process.exit(0), 600); });
process.on('SIGINT',  () => { stopWatchdog(); setTimeout(() => process.exit(0), 600); });

// ── Server listen ─────────────────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`[prevoyant-server] Listening on port ${config.port}`);
  console.log(`[prevoyant-server] Dashboard: http://localhost:${config.port}/dashboard`);
  activityLog.record('server_started', null, 'system', { port: config.port });

  restoreScheduledJobs();
  startWatchdog();

  if (config.pollIntervalDays > 0) {
    schedulePollScript(config.pollIntervalDays);
  } else {
    console.log('[prevoyant-server] Scheduled polling disabled — running one-time startup scan as webhook fallback');
    runFallbackPoll();
  }
});
