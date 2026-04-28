'use strict';

const { runClaudeAnalysis, killProcess } = require('../runner/claudeRunner');
const tracker = require('../dashboard/tracker');

const MAX_CONCURRENT = 1;
const queue = [];
let running = 0;

// ticketKey → setTimeout handle for scheduled jobs
const scheduledTimers = new Map();
// ticketKey → setTimeout handle for retry delays
const retryTimers = new Map();
// ticketKey → attempt count (resets on success or manual re-run)
const retryCounts = new Map();

function retryConfig() {
  return {
    maxRetries:  parseInt(process.env.PRX_RETRY_MAX     || '0',  10),
    backoffSecs: parseInt(process.env.PRX_RETRY_BACKOFF || '30', 10),
  };
}

function enqueue(ticketKey, mode = 'dev', priority = 'normal') {
  const job = { ticketKey, mode, priority };
  if (priority === 'urgent') {
    queue.unshift(job);
  } else {
    queue.push(job);
  }
  console.log(`[queue] Enqueued ${ticketKey} mode=${mode} priority=${priority} (depth: ${queue.length})`);
  drain();
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const { ticketKey: ticket, mode, priority } = queue.shift();
    running++;
    tracker.recordStarted(ticket);
    console.log(`[queue] Starting ${ticket} mode=${mode} priority=${priority} (running: ${running}/${MAX_CONCURRENT})`);

    runClaudeAnalysis(ticket, mode)
      .then(() => {
        retryCounts.delete(ticket);
        tracker.recordCompleted(ticket, true);
        console.log(`[queue] ${ticket} complete`);
      })
      .catch(err => {
        if (err.killed) {
          retryCounts.delete(ticket);
          const reason = err.killReason || 'manual';
          tracker.recordInterrupted(ticket, reason);
          console.log(`[queue] ${ticket} stopped — reason: ${reason}`);
          return;
        }

        const { maxRetries, backoffSecs } = retryConfig();
        const attempt = (retryCounts.get(ticket) || 0) + 1;

        if (attempt <= maxRetries) {
          retryCounts.set(ticket, attempt);
          const delaySecs = backoffSecs * Math.pow(2, attempt - 1);
          const nextRetryAt = new Date(Date.now() + delaySecs * 1000);
          tracker.recordRetrying(ticket, attempt, maxRetries, nextRetryAt);
          console.log(`[queue] ${ticket} failed — retry ${attempt}/${maxRetries} in ${delaySecs}s`);
          const handle = setTimeout(() => {
            retryTimers.delete(ticket);
            tracker.reRunTicket(ticket, mode, 'retry', priority);
            enqueue(ticket, mode, priority);
          }, delaySecs * 1000);
          retryTimers.set(ticket, handle);
        } else {
          retryCounts.delete(ticket);
          tracker.recordCompleted(ticket, false);
          console.error(`[queue] ${ticket} failed (no retries left): ${err.message}`);
        }
      })
      .finally(() => {
        running--;
        drain();
      });
  }
}

function prioritizeJob(ticketKey) {
  const idx = queue.findIndex(j => j.ticketKey === ticketKey);
  if (idx <= 0) return false;
  const [job] = queue.splice(idx, 1);
  queue.unshift(job);
  console.log(`[queue] ${ticketKey} moved to front of queue`);
  return true;
}

function scheduleJob(ticketKey, mode = 'dev', scheduledAt) {
  const delay = scheduledAt - Date.now();
  if (delay <= 0) {
    tracker.reRunTicket(ticketKey, mode, 'scheduled');
    enqueue(ticketKey, mode);
    return;
  }
  console.log(`[queue] Scheduled ${ticketKey} mode=${mode} for ${scheduledAt.toISOString()} (in ${Math.round(delay / 1000)}s)`);
  const handle = setTimeout(() => {
    scheduledTimers.delete(ticketKey);
    console.log(`[queue] Scheduled time reached for ${ticketKey} — queuing`);
    tracker.reRunTicket(ticketKey, mode, 'scheduled');
    enqueue(ticketKey, mode);
  }, delay);
  scheduledTimers.set(ticketKey, handle);
}

function restoreScheduledJobs() {
  const pending = tracker.getScheduledTickets();
  if (pending.length === 0) return;
  console.log(`[queue] Restoring ${pending.length} scheduled job(s) from persisted sessions`);
  for (const t of pending) {
    scheduleJob(t.ticketKey, t.mode || 'dev', t.scheduledFor);
  }
}

function killJob(ticketKey) {
  if (scheduledTimers.has(ticketKey)) {
    clearTimeout(scheduledTimers.get(ticketKey));
    scheduledTimers.delete(ticketKey);
    tracker.recordInterrupted(ticketKey, 'manual');
    console.log(`[queue] ${ticketKey} scheduled job cancelled by user`);
    return true;
  }
  if (retryTimers.has(ticketKey)) {
    clearTimeout(retryTimers.get(ticketKey));
    retryTimers.delete(ticketKey);
    retryCounts.delete(ticketKey);
    tracker.recordInterrupted(ticketKey, 'manual');
    console.log(`[queue] ${ticketKey} retry cancelled by user`);
    return true;
  }
  const idx = queue.findIndex(j => j.ticketKey === ticketKey);
  if (idx !== -1) {
    queue.splice(idx, 1);
    tracker.recordInterrupted(ticketKey, 'manual');
    console.log(`[queue] ${ticketKey} removed from queue by user`);
    return true;
  }
  return killProcess(ticketKey);
}

module.exports = { enqueue, prioritizeJob, scheduleJob, restoreScheduledJobs, killJob };
