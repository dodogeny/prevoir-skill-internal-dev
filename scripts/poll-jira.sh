#!/bin/bash
# poll-jira.sh
# Polls Jira every hour for To Do/Open/Parked/Blocked tickets assigned to the current user
# and triggers the Prevoir dev skill analysis for any new ones found.
#
# macOS  — scheduled via launchd (StartInterval 3600)
#          See: scripts/com.prevoir.poll-jira.plist
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
  notify "Prevoir Dev Skill" "Credentials file missing — poll-jira cannot run."
  exit 1
fi

# shellcheck source=.jira-credentials
source "$CREDENTIALS_FILE"

touch "$CACHE_FILE"

# ── Query Jira ────────────────────────────────────────────────────────────────

echo "$(date '+%Y-%m-%d %H:%M:%S') Polling Jira for To Do/Open/Parked/Blocked tickets..." >> "$LOG_FILE"

ENCODED_JQL=$(python3 -c "import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))" "$JQL")

HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -u "$JIRA_USER:$JIRA_TOKEN" \
  -H "Accept: application/json" \
  "$JIRA_BASE/rest/api/3/search?jql=${ENCODED_JQL}&fields=key,summary,status&maxResults=50")

HTTP_BODY=$(echo "$HTTP_RESPONSE" | head -n -1)
HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n 1)

if [ "$HTTP_CODE" != "200" ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S') ERROR: Jira API returned HTTP $HTTP_CODE" >> "$LOG_FILE"
  echo "$HTTP_BODY" >> "$LOG_FILE"
  notify "Prevoir Dev Skill" "Jira API error (HTTP $HTTP_CODE) — check poll-jira.log"
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

  notify "Prevoir Dev Skill" "Starting analysis for $TICKET…"

  # Run the dev skill in headless/analysis-only mode
  AUTO_MODE=true \
    claude --print "/prevoir:dev $TICKET" \
    >> "$LOG_FILE" 2>&1
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') Analysis complete for $TICKET (exit $EXIT_CODE)" >> "$LOG_FILE"
    notify "Prevoir Dev Skill" "Analysis complete for $TICKET. PDF saved to DevelopmentTasks folder."
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') Analysis failed for $TICKET (exit $EXIT_CODE)" >> "$LOG_FILE"
    notify "Prevoir Dev Skill" "Analysis failed for $TICKET (exit $EXIT_CODE) — check poll-jira.log"
  fi

done

echo "$(date '+%Y-%m-%d %H:%M:%S') Done. $NEW_COUNT new ticket(s) processed." >> "$LOG_FILE"
