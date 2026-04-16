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

# JIRA_BASE is loaded from .jira-credentials (JIRA_URL) — see credentials file
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

# ── Load configuration ────────────────────────────────────────────────────────
# Primary source: .env in the project root (one directory above scripts/).
# Optional override: .jira-credentials in the same directory as this script
#   (kept for backward compatibility — not required when .env is present).

ENV_FILE="$(dirname "$SCRIPT_DIR")/.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck source=../.env
  set -a; source "$ENV_FILE"; set +a
fi

if [ -f "$CREDENTIALS_FILE" ]; then
  # shellcheck source=.jira-credentials
  source "$CREDENTIALS_FILE"
fi

# Normalise variable names: .jira-credentials uses JIRA_USER / JIRA_TOKEN;
# .env uses JIRA_USERNAME / JIRA_API_TOKEN. Accept either.
JIRA_USER="${JIRA_USER:-${JIRA_USERNAME:-}}"
JIRA_TOKEN="${JIRA_TOKEN:-${JIRA_API_TOKEN:-}}"

# JIRA_URL / JIRA_BASE — accepted from either source
JIRA_BASE="${JIRA_URL:-}"

if [ -z "$JIRA_BASE" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: JIRA_URL is not set. Add it to .env: JIRA_URL=https://yourcompany.atlassian.net" >> "$LOG_FILE"
  notify "Dev Skill" "JIRA_URL not set — add it to .env and retry."
  exit 1
fi

if [ -z "$JIRA_USER" ] || [ -z "$JIRA_TOKEN" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: JIRA_USERNAME and JIRA_API_TOKEN must be set in .env" >> "$LOG_FILE"
  notify "Dev Skill" "Jira credentials missing — add JIRA_USERNAME and JIRA_API_TOKEN to .env."
  exit 1
fi

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

JSON_BODY=$(python3 -c "import json, sys; print(json.dumps({'jql': sys.argv[1], 'fields': ['key','summary','status','priority','description'], 'maxResults': 50}))" "$JQL")

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
  notify "Dev Skill" "Jira API error (HTTP $HTTP_CODE) — check poll-jira.log"
  exit 1
fi

# Write full ticket data (summary, priority, description) to a temp file so the
# per-ticket loop can read it without a second API call.
TICKET_DATA_FILE="$(mktemp /tmp/poll-jira-data-XXXXXX.json)"

TICKETS=$(TICKET_DATA_FILE="$TICKET_DATA_FILE" python3 -c "
import json, sys, os

def adf_text(node, limit=600):
    '''Extract plain text from Atlassian Document Format (ADF), capped at limit chars.'''
    if not node or not isinstance(node, dict):
        return ''
    if node.get('type') == 'text':
        return node.get('text', '')
    parts = []
    for child in node.get('content', []):
        t = adf_text(child)
        if t.strip():
            parts.append(t.strip())
    return ' '.join(parts)[:limit]

data = json.load(sys.stdin)
issues = data.get('issues', [])
ticket_info = {}
if not issues:
    print('__NONE__')
else:
    for issue in issues:
        key = issue['key']
        fields = issue.get('fields', {})
        summary  = fields.get('summary', '(no summary)')
        priority = (fields.get('priority') or {}).get('name', 'Medium')
        status   = (fields.get('status')   or {}).get('name', '')
        desc_node = fields.get('description') or {}
        desc = adf_text(desc_node).strip() or '(no description provided)'
        ticket_info[key] = {'summary': summary, 'priority': priority, 'status': status, 'description': desc}
        print(key)
    with open(os.environ['TICKET_DATA_FILE'], 'w') as f:
        json.dump(ticket_info, f)
" 2>/dev/null <<< "$HTTP_BODY")

if [ "$TICKETS" = "__NONE__" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') No assigned tickets found." >> "$LOG_FILE"
  exit 0
fi

# ── Email notification for new ticket assignment ──────────────────────────────
# Sends a summary email for a newly assigned ticket.
# Silently skipped when PRX_EMAIL_TO is not set.

send_ticket_email() {
  local ticket_key="$1"

  [ -z "${PRX_EMAIL_TO:-}" ] && return 0   # email not configured — skip silently

  python3 -c "
import json, os, sys, smtplib
from email.message import EmailMessage

ticket_key  = sys.argv[1]
data_file   = sys.argv[2]
jira_base   = sys.argv[3]

email_to   = os.environ.get('PRX_EMAIL_TO',   '').strip()
smtp_host  = os.environ.get('PRX_SMTP_HOST',  '').strip()
smtp_user  = os.environ.get('PRX_SMTP_USER',  '').strip()
smtp_pass  = os.environ.get('PRX_SMTP_PASS',  '').strip()
smtp_port  = int(os.environ.get('PRX_SMTP_PORT', '587'))

if not all([email_to, smtp_host, smtp_user, smtp_pass]):
    print('EMAIL_SKIP: SMTP not fully configured — skipping ticket notification.')
    sys.exit(0)

try:
    with open(data_file) as f:
        ticket_info = json.load(f)
except Exception as e:
    print(f'EMAIL_SKIP: Could not read ticket data ({e})')
    sys.exit(0)

info     = ticket_info.get(ticket_key, {})
summary  = info.get('summary',  '(no summary)')
priority = info.get('priority', 'Medium')
status   = info.get('status',   '')
desc     = info.get('description', '(no description provided)')

# Map Jira priority names to urgency labels for the subject line
urgency_map = {
    'blocker':  'URGENT', 'critical': 'URGENT',
    'high':     'HIGH',   'major':    'HIGH',
    'medium':   'MEDIUM', 'normal':   'MEDIUM',
    'low':      'LOW',    'minor':    'LOW',   'trivial': 'LOW',
}
urgency = urgency_map.get(priority.lower(), priority.upper())

subject = f'[New Ticket — {urgency}] {ticket_key}: {summary}'

body = f'''New Jira ticket assigned to you: {ticket_key}

Priority : {priority} ({urgency})
Status   : {status}
Summary  : {summary}
Link     : {jira_base}/browse/{ticket_key}

Description:
{desc}
{'...' if len(desc) == 600 else ''}

---
Automated notification from Dev Skill (poll-jira.sh)
'''

msg = EmailMessage()
msg['Subject'] = subject
msg['From']    = smtp_user
msg['To']      = email_to
msg.set_content(body)

try:
    with smtplib.SMTP(smtp_host, smtp_port) as server:
        server.ehlo(); server.starttls(); server.ehlo()
        server.login(smtp_user, smtp_pass)
        server.send_message(msg)
    print(f'EMAIL_SENT: ticket notification for {ticket_key} sent to {email_to}')
except smtplib.SMTPAuthenticationError:
    print(f'EMAIL_ERROR: SMTP authentication failed for {smtp_user}', file=sys.stderr)
except Exception as e:
    print(f'EMAIL_ERROR: {e}', file=sys.stderr)
" "$ticket_key" "$TICKET_DATA_FILE" "$JIRA_BASE" >> "$LOG_FILE" 2>&1
}

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

  notify "Dev Skill" "Starting analysis for $TICKET…"
  send_ticket_email "$TICKET"

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
    notify "Dev Skill" "Analysis complete for $TICKET. PDF saved to DevelopmentTasks folder."
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') Analysis failed for $TICKET (exit $EXIT_CODE)" >> "$LOG_FILE"
    notify "Dev Skill" "Analysis failed for $TICKET (exit $EXIT_CODE) — check poll-jira.log"
  fi

done

echo "$(date '+%Y-%m-%d %H:%M:%S') Done. $NEW_COUNT new ticket(s) processed." >> "$LOG_FILE"

rm -f "$MCP_CONFIG_FILE" "$TICKET_DATA_FILE"
