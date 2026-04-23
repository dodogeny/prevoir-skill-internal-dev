'use strict';

const { spawn } = require('child_process');
const config = require('../config/env');
const tracker = require('../stats/tracker');

// Matches "Step 3 —", "Step R5 —", "Step 14 —" at the start of a line or after markdown markers.
// The em-dash / en-dash is the canonical separator used in SKILL.md step headers.
const STEP_RE = /(?:^|[*#\s])Step\s+(R?\d+)\s*[—–]/m;

function detectStep(text) {
  const match = text.match(STEP_RE);
  return match ? match[1] : null;
}

function modePrompt(ticketKey, mode) {
  if (mode === 'review')   return `/prx:dev review ${ticketKey}`;
  if (mode === 'estimate') return `/prx:dev estimate ${ticketKey}`;
  return `/prx:dev ${ticketKey}`;
}

function runClaudeAnalysis(ticketKey, mode = 'dev') {
  return new Promise((resolve, reject) => {
    console.log(`[runner] Spawning claude for ${ticketKey} (mode: ${mode})`);

    const proc = spawn(
      'claude',
      [
        '--dangerously-skip-permissions',
        '--print', modePrompt(ticketKey, mode),
        '--mcp-config', config.mcpConfigFile,
        '--output-format', 'stream-json',
        '--verbose',
      ],
      {
        cwd: config.projectRoot,
        env: { ...process.env, AUTO_MODE: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    proc.stdout.on('data', chunk => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        try {
          const ev = JSON.parse(line);

          if (ev.type === 'assistant') {
            for (const block of (ev.message || {}).content || []) {
              if (block.type === 'text' && block.text.trim()) {
                const text = block.text.trim();
                console.log(`[${ticketKey}] ${text}`);
                tracker.appendOutput(ticketKey, text);

                const stepId = detectStep(text);
                if (stepId) tracker.recordStepActive(ticketKey, stepId);
              }
            }
          } else if (ev.type === 'result') {
            const cost = ev.cost_usd != null ? ` cost=$${ev.cost_usd.toFixed(4)}` : '';
            const summary = `[Result] ${ev.subtype}${cost}`;
            console.log(`[${ticketKey}] ${summary}`);
            tracker.appendOutput(ticketKey, summary);
          }
        } catch (_) {
          const raw = line.trim();
          if (raw) {
            console.log(`[${ticketKey}] ${raw}`);
            tracker.appendOutput(ticketKey, raw);
          }
        }
      }
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[${ticketKey}] stderr: ${text}`);
        tracker.appendOutput(ticketKey, `[stderr] ${text}`);
      }
    });

    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude exited with code ${code}`));
      }
    });

    proc.on('error', err => {
      reject(new Error(`failed to spawn claude: ${err.message}`));
    });
  });
}

module.exports = { runClaudeAnalysis };
