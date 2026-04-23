'use strict';

const { runClaudeAnalysis, killProcess } = require('../runner/claudeRunner');
const tracker = require('../dashboard/tracker');

const MAX_CONCURRENT = 1; // run one analysis at a time to avoid resource exhaustion
const queue = [];
let running = 0;

function enqueue(ticketKey, mode = 'dev') {
  queue.push({ ticketKey, mode });
  console.log(`[queue] Enqueued ${ticketKey} mode=${mode} (depth: ${queue.length})`);
  drain();
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const { ticketKey: ticket, mode } = queue.shift();
    running++;
    tracker.recordStarted(ticket);
    console.log(`[queue] Starting ${ticket} mode=${mode} (running: ${running}/${MAX_CONCURRENT})`);

    runClaudeAnalysis(ticket, mode)
      .then(() => {
        tracker.recordCompleted(ticket, true);
        console.log(`[queue] ${ticket} complete`);
      })
      .catch(err => {
        if (err.killed) {
          tracker.recordInterrupted(ticket);
          console.log(`[queue] ${ticket} stopped by user`);
        } else {
          tracker.recordCompleted(ticket, false);
          console.error(`[queue] ${ticket} failed: ${err.message}`);
        }
      })
      .finally(() => {
        running--;
        drain();
      });
  }
}

function killJob(ticketKey) {
  // If still waiting in queue, remove it immediately
  const idx = queue.findIndex(j => j.ticketKey === ticketKey);
  if (idx !== -1) {
    queue.splice(idx, 1);
    tracker.recordInterrupted(ticketKey);
    console.log(`[queue] ${ticketKey} removed from queue by user`);
    return true;
  }
  // If actively running, send kill signal — recordInterrupted called via .catch()
  return killProcess(ticketKey);
}

module.exports = { enqueue, killJob };
