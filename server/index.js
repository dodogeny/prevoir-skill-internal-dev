'use strict';

const express = require('express');
const config = require('./config/env');
const jiraWebhook = require('./webhooks/jira');
const dashboardRoutes = require('./dashboard/routes');
const { schedulePollScript } = require('./runner/pollScheduler');

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

app.listen(config.port, () => {
  console.log(`[prevoyant-server] Listening on port ${config.port}`);
  console.log(`[prevoyant-server] Dashboard: http://localhost:${config.port}/dashboard`);

  if (config.pollIntervalDays > 0) {
    schedulePollScript(config.pollIntervalDays);
  } else {
    console.log('[prevoyant-server] Scheduled polling disabled — set WEBHOOK_POLL_INTERVAL_DAYS to enable');
  }
});
