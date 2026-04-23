'use strict';

const { spawn }   = require('child_process');
const fs          = require('fs');
const os          = require('os');
const path        = require('path');
const config      = require('../config/env');
const tracker     = require('../dashboard/tracker');
const stages      = require('../dashboard/stages.json');

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

// Matches "Step 3 —", "Step R5 —", "Step E5b —", "Step 14 —" etc.
const STEP_RE = /(?:^|[*#\s])Step\s+((?:R|E)?\d+[a-z]?)\s*[—–]/m;

function detectStep(text) {
  const match = text.match(STEP_RE);
  return match ? match[1] : null;
}

// Loads instruction markdown files from server/dashboard/stage-instructions/<id>.md.
// To define instructions for a new stage, create a file named <stageId>.md in that directory.
// Files are only injected if the stage ID exists in stages.json for the current mode.
const STAGE_INSTRUCTIONS_DIR = path.join(__dirname, '../dashboard/stage-instructions');

function loadStageInstructions(list) {
  let files;
  try { files = fs.readdirSync(STAGE_INSTRUCTIONS_DIR); } catch (_) { return ''; }

  const stageIds = new Set(list.map(s => s.id));
  const blocks = files
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const id = f.slice(0, -3);
      if (!stageIds.has(id)) return null;
      const content = fs.readFileSync(path.join(STAGE_INSTRUCTIONS_DIR, f), 'utf8').trim();
      const stage = list.find(s => s.id === id);
      return `### Step ${id} — ${stage.label}\n\n${content}`;
    })
    .filter(Boolean);

  return blocks.length
    ? `\n\nAdditional step instructions (from stage-instructions/, supplement SKILL.md):\n\n${blocks.join('\n\n---\n\n')}`
    : '';
}

function stageSequenceHint(mode) {
  const list = mode === 'review'   ? stages.review
             : mode === 'estimate' ? stages.estimate
             : stages.dev;
  const seq = list.map(s => `Step ${s.id} — ${s.label}`).join(' → ');
  return `\n\nPrevoyant pipeline stages for this ${mode} session (announce each on its own line as ### Step N — {label}):\n${seq}`
    + loadStageInstructions(list);
}

function modePrompt(ticketKey, mode) {
  const base = mode === 'review'   ? `/prx:dev review ${ticketKey}`
             : mode === 'estimate' ? `/prx:dev estimate ${ticketKey}`
             : `/prx:dev ${ticketKey}`;
  return base + stageSequenceHint(mode);
}

function reportAlreadyExists(ticketKey, mode) {
  const reportsDir = process.env.CLAUDE_REPORT_DIR
    || path.join(os.homedir(), '.prevoyant', 'reports');
  const suffix = mode === 'review' ? 'review' : mode === 'estimate' ? 'estimate' : 'analysis';
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

function processLine(ticketKey, line) {
  let ev;
  try { ev = JSON.parse(line); } catch (_) {
    // Not JSON — log only if it looks like human-readable text (not a JSON fragment)
    const t = line.trim();
    if (t && !t.startsWith('{') && !t.startsWith('[') && !t.startsWith('"')) {
      tracker.appendOutput(ticketKey, t);
    }
    return;
  }

  if (ev.type === 'assistant') {
    for (const block of (ev.message || {}).content || []) {
      if (block.type === 'text' && block.text.trim()) {
        const text = block.text.trim();
        tracker.appendOutput(ticketKey, text);
        const stepId = detectStep(text);
        if (stepId) tracker.recordStepActive(ticketKey, stepId);
      }
    }
  } else if (ev.type === 'result') {
    const cost = ev.cost_usd != null ? ` — $${ev.cost_usd.toFixed(4)}` : '';
    tracker.appendOutput(ticketKey, `[Result] ${ev.subtype}${cost}`);
  }
  // Intentionally drop type: 'user' / 'system' — these are raw tool payloads, not readable output
}

// ticketKey → { proc, killed } — lets killProcess() find and terminate the child
const activeProcesses = new Map();

function killProcess(ticketKey) {
  const entry = activeProcesses.get(ticketKey);
  if (!entry) return false;
  entry.killed = true;
  entry.proc.kill('SIGTERM');
  setTimeout(() => { try { entry.proc.kill('SIGKILL'); } catch (_) {} }, 3000);
  return true;
}

function runClaudeAnalysis(ticketKey, mode = 'dev') {
  return new Promise((resolve, reject) => {
    console.log(`[runner] Spawning claude for ${ticketKey} (mode: ${mode})`);

    const mcpConfig = buildMcpConfig();
    const usingTempConfig = mcpConfig !== config.mcpConfigFile;

    // AUTO_MODE=Y — SKILL.md checks for exactly 'Y' in confirmation gates
    const childEnv = { ...process.env, AUTO_MODE: 'Y' };
    if (reportAlreadyExists(ticketKey, mode)) {
      childEnv.CLAUDE_REPORT_SUFFIX = datetimeSuffix();
      console.log(`[runner] Existing report for ${ticketKey} — suffix ${childEnv.CLAUDE_REPORT_SUFFIX}`);
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

    const state = { proc, killed: false };
    activeProcesses.set(ticketKey, state);

    // Line buffer — stdout arrives in 64 KB chunks; large JSON events span multiple chunks.
    // Accumulate bytes until we have a complete newline-terminated line before parsing.
    let lineBuf = '';
    proc.stdout.on('data', chunk => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop(); // last element is the incomplete tail (may be empty)
      for (const line of lines) processLine(ticketKey, line);
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[${ticketKey}] stderr: ${text}`);
        tracker.appendOutput(ticketKey, `[stderr] ${text}`);
      }
    });

    proc.on('close', code => {
      activeProcesses.delete(ticketKey);
      if (lineBuf.trim()) processLine(ticketKey, lineBuf); // flush any partial line
      if (usingTempConfig) try { fs.unlinkSync(mcpConfig); } catch (_) {}
      if (state.killed) reject(Object.assign(new Error('Process killed by user'), { killed: true }));
      else if (code === 0) resolve();
      else reject(new Error(`claude exited with code ${code}`));
    });

    proc.on('error', err => reject(new Error(`failed to spawn claude: ${err.message}`)));
  });
}

module.exports = { runClaudeAnalysis, killProcess };
