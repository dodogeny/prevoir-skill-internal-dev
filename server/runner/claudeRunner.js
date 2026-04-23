'use strict';

const { spawn }   = require('child_process');
const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const config      = require('../config/env');
const tracker     = require('../stats/tracker');

// Build a temp MCP config that uses mcp-atlassian with API-token auth.
// When JIRA_URL + JIRA_USERNAME + JIRA_API_TOKEN are present in the env block,
// mcp-atlassian uses basic auth instead of OAuth — no browser pop-up needed.
// Falls back to the static .mcp.json when credentials are not configured.
function buildMcpConfig() {
  const { jiraUrl, jiraUsername, jiraToken } = config;
  if (!jiraUrl || !jiraUsername || !jiraToken) return config.mcpConfigFile;

  const tmp = path.join(os.tmpdir(), `prevoyant-mcp-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    mcpServers: {
      jira: {
        command: 'uvx',
        args: ['mcp-atlassian'],
        env: {
          JIRA_URL:       jiraUrl,
          JIRA_USERNAME:  jiraUsername,
          JIRA_API_TOKEN: jiraToken,
        },
      },
    },
  }));
  return tmp;
}

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

function reportAlreadyExists(ticketKey, mode) {
  const reportsDir = process.env.CLAUDE_REPORT_DIR
    || path.join(os.homedir(), '.prevoyant', 'reports');
  const suffix = mode === 'review' ? 'review' : 'analysis';
  const candidate = path.join(reportsDir, `${ticketKey}-${suffix}.pdf`);
  try { fs.accessSync(candidate); return true; } catch (_) { return false; }
}

function datetimeSuffix() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
}

function runClaudeAnalysis(ticketKey, mode = 'dev') {
  return new Promise((resolve, reject) => {
    console.log(`[runner] Spawning claude for ${ticketKey} (mode: ${mode})`);

    const mcpConfig = buildMcpConfig();
    const usingTempConfig = mcpConfig !== config.mcpConfigFile;

    const childEnv = { ...process.env, AUTO_MODE: 'true' };
    if (reportAlreadyExists(ticketKey, mode)) {
      childEnv.CLAUDE_REPORT_SUFFIX = datetimeSuffix();
      console.log(`[runner] Existing report found for ${ticketKey} — will use suffix ${childEnv.CLAUDE_REPORT_SUFFIX}`);
    }

    const proc = spawn(
      'claude',
      [
        '--dangerously-skip-permissions',
        '--print', modePrompt(ticketKey, mode),
        '--mcp-config', mcpConfig,
        '--output-format', 'stream-json',
        '--verbose',
      ],
      {
        cwd: config.projectRoot,
        env: childEnv,
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
      if (usingTempConfig) try { fs.unlinkSync(mcpConfig); } catch (_) {}
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
