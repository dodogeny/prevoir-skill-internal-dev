'use strict';

const express = require('express');
const fs = require('fs');
const config = require('../config/env');
const jobQueue = require('../queue/jobQueue');
const tracker = require('../dashboard/tracker');
const activityLog = require('../dashboard/activityLog');

const router = express.Router();

const RELEVANT_STATUSES = new Set(['To Do', 'Open', 'Parked', 'Blocked']);

// In-memory dedup — file cache is the durable store shared with poll-jira.sh
const seenThisSession = new Set();

function isAlreadySeen(ticketKey) {
  if (seenThisSession.has(ticketKey)) return true;
  try {
    return fs.readFileSync(config.seenCacheFile, 'utf8')
      .split('\n')
      .some(l => l.trim() === ticketKey);
  } catch (_) {
    return false;
  }
}

function markSeen(ticketKey) {
  seenThisSession.add(ticketKey);
  try {
    fs.appendFileSync(config.seenCacheFile, ticketKey + '\n');
  } catch (_) { /* best-effort */ }
}

function isAssignedToMe(fields) {
  if (!config.jiraUsername) return true; // no filter configured — accept all
  const email = (fields.assignee || {}).emailAddress || '';
  return email === config.jiraUsername;
}

function isRelevantEvent(body) {
  const event = body.webhookEvent || '';
  const fields = (body.issue || {}).fields || {};

  if (event === 'jira:issue_assigned') {
    return isAssignedToMe(fields);
  }

  if (event === 'jira:issue_created') {
    const status = (fields.status || {}).name || '';
    return RELEVANT_STATUSES.has(status) && isAssignedToMe(fields);
  }

  if (event === 'jira:issue_updated') {
    const items = (body.changelog || {}).items || [];
    return items.some(
      item => item.field === 'status' && RELEVANT_STATUSES.has(item.toString)
    ) && isAssignedToMe(fields);
  }

  return false;
}

router.post('/', (req, res) => {
  // Jira sends the webhook secret as ?token= in the URL you register
  if (config.webhookSecret && req.query.token !== config.webhookSecret) {
    console.warn('[webhook] Rejected — invalid token');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body;
  const ticketKey = (body.issue || {}).key;

  if (!ticketKey) {
    return res.status(400).json({ error: 'missing issue key' });
  }

  if (!isRelevantEvent(body)) {
    console.log(`[webhook] ${ticketKey} — event not relevant, skipping`);
    activityLog.record('webhook_skipped', ticketKey, 'jira', { event: body.webhookEvent, reason: 'not relevant' });
    return res.json({ status: 'skipped', reason: 'not relevant' });
  }

  if (isAlreadySeen(ticketKey)) {
    console.log(`[webhook] ${ticketKey} — already processed, skipping`);
    activityLog.record('webhook_skipped', ticketKey, 'jira', { event: body.webhookEvent, reason: 'duplicate' });
    return res.json({ status: 'skipped', reason: 'duplicate' });
  }

  markSeen(ticketKey);
  activityLog.record('webhook_received', ticketKey, 'jira', { event: body.webhookEvent });
  tracker.recordQueued(ticketKey, 'webhook');
  console.log(`[webhook] ${ticketKey} — queued for analysis`);
  jobQueue.enqueue(ticketKey);

  res.json({ status: 'queued', ticket: ticketKey });
});

module.exports = router;
