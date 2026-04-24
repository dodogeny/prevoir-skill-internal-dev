'use strict';

const { spawn } = require('child_process');
const path = require('path');
const config = require('../config/env');
const activityLog = require('../dashboard/activityLog');

let lastRanAt    = null;
let nextRunAt    = null;
let intervalDays = 0;
let fallbackRanAt = null;  // set when a one-time startup scan runs with polling disabled

function runPollScript(label) {
  lastRanAt = new Date();
  const scriptPath = path.join(config.scriptsDir, 'poll-jira.sh');
  const trigger = label || 'scheduled';
  console.log(`[prevoyant-server/poll] Running poll-jira.sh${label ? ` (${label})` : ''}`);
  activityLog.record('poll_triggered', null, 'system', { trigger });

  const proc = spawn('/bin/bash', [scriptPath], {
    cwd: config.projectRoot,
    env: process.env,
    stdio: 'inherit',
  });

  proc.on('close', code => {
    console.log(`[prevoyant-server/poll] poll-jira.sh exited with code ${code}`);
  });

  proc.on('error', err => {
    console.error(`[prevoyant-server/poll] Failed to run poll-jira.sh: ${err.message}`);
  });
}

function schedulePollScript(days) {
  intervalDays = days;
  const intervalMs = days * 24 * 60 * 60 * 1000;

  // Run once immediately on startup so there is no initial blind spot
  runPollScript();
  nextRunAt = new Date(Date.now() + intervalMs);

  setInterval(() => {
    runPollScript();
    nextRunAt = new Date(Date.now() + intervalMs);
  }, intervalMs);

  console.log(`[prevoyant-server/poll] Polling every ${days} day(s)`);
}

// One-time startup scan used as fallback when scheduled polling is disabled.
// Ensures at least one Jira sweep happens even in pure-webhook mode, so
// tickets that arrived while the server was offline are not missed.
function runFallbackPoll() {
  fallbackRanAt = new Date();
  runPollScript('startup fallback');
}

function getPollStatus() {
  return { lastRanAt, nextRunAt, intervalDays, enabled: intervalDays > 0, fallbackRanAt };
}

module.exports = { schedulePollScript, runFallbackPoll, getPollStatus };
