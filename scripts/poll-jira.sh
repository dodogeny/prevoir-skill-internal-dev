#!/bin/bash
# poll-jira.sh
# Polls Jira every hour for To Do/Open/Parked/Blocked tickets assigned to the current user
# and triggers the Prx dev skill analysis for any new ones found.
#
# macOS  — scheduled via launchd (StartInterval 3600)
#          See: scripts/com.prx.poll-jira.plist
# Linux  — scheduled via cron: 0 * * * * /path/to/poll-jira.sh
# Windows — run via WSL; scheduled via Task Scheduler calling:
#           wsl bash /path/to/poll-jira.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREDENTIALS_FILE="$SCRIPT_DIR/.jira-credentials"
CACHE_FILE="$SCRIPT_DIR/.jira-seen-tickets"
LOG_FILE="$SCRIPT_DIR/poll-jira.log"

JIRA_BASE="https://prevoirsolutions.atlassian.net"
JQL='assignee = currentUser() AND status in ("To Do","Open","Parked","Blocked") ORDER BY updated DESC'

# ── Cross-platform notification ───────────────────────────────────────────────

notify() {
  local title="$1"
  local message="$2"
  case "$(uname -s)" in
    Darwin)
      osascript -e "display notification \"$message\" with title \"$title\""
      ;;
    Linux)
      if command -v notify-send &>/dev/null; then
        notify-send "$title" "$message"
      fi
      ;;
    *)
      # Windows via WSL
      if command -v powershell.exe &>/dev/null; then
        powershell.exe -Command "
          Add-Type -AssemblyName System.Windows.Forms
          \$n = New-Object System.Windows.Forms.NotifyIcon
          \$n.Icon = [System.Drawing.SystemIcons]::Information
          \$n.BalloonTipTitle = '$title'
          \$n.BalloonTipText = '$message'
          \$n.Visible = \$true
          \$n.ShowBalloonTip(5000)
          Start-Sleep -Seconds 6
          \$n.Dispose()
        " 2>/dev/null
      fi
      ;;
  esac
}

# ── Load credentials ──────────────────────────────────────────────────────────

if [ ! -f "$CREDENTIALS_FILE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: Credentials file not found at $CREDENTIALS_FILE" >> "$LOG_FILE"
  notify "Prx Dev Skill" "Credentials file missing — poll-jira cannot run."
  exit 1
fi

# shellcheck source=.jira-credentials
source "$CREDENTIALS_FILE"

touch "$CACHE_FILE"

# ── Build Jira MCP config for the Claude invocation ───────────────────────────
# The Atlassian MCP is scoped to the insight project directory; poll-jira.sh
# runs from Scripts so we inject the config explicitly via --mcp-config.
MCP_CONFIG_FILE="$(mktemp /tmp/poll-jira-mcp-XXXXXX.json)"
python3 -c "
import json, sys
print(json.dumps({
  'mcpServers': {
    'jira': {
      'type': 'stdio',
      'command': 'npx',
      'args': ['-y', 'raalarcon-jira-mcp-server'],
      'env': {
        'JIRA_HOST': sys.argv[1],
        'JIRA_EMAIL': sys.argv[2],
        'JIRA_API_TOKEN': sys.argv[3]
      }
    }
  }
}))
" "$JIRA_BASE" "$JIRA_USER" "$JIRA_TOKEN" > "$MCP_CONFIG_FILE"

# ── Query Jira ────────────────────────────────────────────────────────────────

echo "$(date '+%Y-%m-%d %H:%M:%S') Polling Jira for To Do/Open/Parked/Blocked tickets..." >> "$LOG_FILE"

JSON_BODY=$(python3 -c "import json, sys; print(json.dumps({'jql': sys.argv[1], 'fields': ['key','summary','status'], 'maxResults': 50}))" "$JQL")

HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -u "$JIRA_USER:$JIRA_TOKEN" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -X POST \
  -d "$JSON_BODY" \
  "$JIRA_BASE/rest/api/3/search/jql")

HTTP_BODY=$(echo "$HTTP_RESPONSE" | sed '$d')
HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: Jira API returned HTTP $HTTP_CODE" >> "$LOG_FILE"
  echo "$HTTP_BODY" >> "$LOG_FILE"
  notify "Prx Dev Skill" "Jira API error (HTTP $HTTP_CODE) — check poll-jira.log"
  exit 1
fi

TICKETS=$(echo "$HTTP_BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
issues = data.get('issues', [])
if not issues:
    print('__NONE__')
else:
    for issue in issues:
        print(issue['key'])
" 2>/dev/null)

if [ "$TICKETS" = "__NONE__" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') No assigned tickets found." >> "$LOG_FILE"
  exit 0
fi

# ── Process new tickets ───────────────────────────────────────────────────────

NEW_COUNT=0

for TICKET in $TICKETS; do
  if grep -qx "$TICKET" "$CACHE_FILE"; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') Skipping $TICKET (already processed)" >> "$LOG_FILE"
    continue
  fi

  echo "$(date '+%Y-%m-%d %H:%M:%S') New ticket detected: $TICKET — starting analysis" >> "$LOG_FILE"
  echo "$TICKET" >> "$CACHE_FILE"
  NEW_COUNT=$((NEW_COUNT + 1))

  notify "Prx Dev Skill" "Starting analysis for $TICKET…"

  # Run the dev skill in headless/analysis-only mode.
  # --dangerously-skip-permissions: allows non-interactive Bash tool calls
  #   (pandoc / Chrome PDF generation in Step 11) without permission prompts.
  # --mcp-config: injects the Jira MCP since it is only scoped to the insight
  #   project directory and is not available when running from Scripts/.
  # --output-format stream-json: streams output as JSON lines so each token
  #   is written to the log immediately, avoiding the silent-exit issue where
  #   --print (text mode) produces zero output on headless early exit.
  echo "$(date '+%Y-%m-%d %H:%M:%S') ── Claude output start ──────────────────────" >> "$LOG_FILE"
  AUTO_MODE=true \
    claude --dangerously-skip-permissions \
           --print "/prx:dev $TICKET" \
           --mcp-config "$MCP_CONFIG_FILE" \
           --output-format stream-json \
           --verbose \
    2>&1 | python3 -u -c "
import sys, json, datetime

def ts():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')

for raw in sys.stdin:
    raw = raw.rstrip()
    if not raw:
        continue
    try:
        ev = json.loads(raw)
    except Exception:
        # Non-JSON line (e.g. stderr text) — log as-is
        print(f'{ts()} {raw}', flush=True)
        continue

    t = ev.get('type', '')
    sub = ev.get('subtype', '')

    if t == 'assistant':
        # Extract text content from assistant message
        for block in ev.get('message', {}).get('content', []):
            if isinstance(block, dict):
                if block.get('type') == 'text':
                    for line in block['text'].splitlines():
                        if line.strip():
                            print(f'{ts()} [Claude] {line}', flush=True)
                elif block.get('type') == 'tool_use':
                    name = block.get('name', '?')
                    inp = block.get('input', {})
                    # Show a compact one-line summary of the tool call
                    summary = ', '.join(f'{k}={repr(v)[:60]}' for k, v in list(inp.items())[:3])
                    print(f'{ts()} [Tool] {name}({summary})', flush=True)
    elif t == 'tool_result':
        pass  # skip verbose tool results
    elif t == 'result':
        sub_type = ev.get('subtype', '')
        cost = ev.get('cost_usd')
        turns = ev.get('num_turns')
        parts = [f'subtype={sub_type}']
        if turns is not None:
            parts.append(f'turns={turns}')
        if cost is not None:
            parts.append(f'cost=\${cost:.4f}')
        print(f'{ts()} [Result] {\" \".join(parts)}', flush=True)
    elif t == 'system' and sub in ('init',):
        model = ev.get('session', {}).get('model', ev.get('model', ''))
        if model:
            print(f'{ts()} [System] model={model}', flush=True)
    # Skip: hook_started, hook_response, system/other — pure noise
" >> "$LOG_FILE"
  EXIT_CODE=${PIPESTATUS[0]}
  echo "$(date '+%Y-%m-%d %H:%M:%S') ── Claude output end ────────────────────────" >> "$LOG_FILE"

  if [ $EXIT_CODE -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') Analysis complete for $TICKET (exit $EXIT_CODE)" >> "$LOG_FILE"
    notify "Prx Dev Skill" "Analysis complete for $TICKET. PDF saved to DevelopmentTasks folder."
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') Analysis failed for $TICKET (exit $EXIT_CODE)" >> "$LOG_FILE"
    notify "Prx Dev Skill" "Analysis failed for $TICKET (exit $EXIT_CODE) — check poll-jira.log"
  fi

done

echo "$(date '+%Y-%m-%d %H:%M:%S') Done. $NEW_COUNT new ticket(s) processed." >> "$LOG_FILE"

rm -f "$MCP_CONFIG_FILE"
