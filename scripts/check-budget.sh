#!/usr/bin/env bash
# check-budget.sh — Monthly Claude token budget check using codeburn.
#
# Runs as a SessionStart hook (after load-env.sh). Does two things:
#   1. Saves today's daily spend to /tmp/.prx-session-start-spend so Step 11
#      can compute the per-session delta at the end of the session.
#   2. Checks current-month spend against PRX_MONTHLY_BUDGET and injects the
#      status into Claude's session context (and surfaces a warning when over
#      budget).
#
# Node.js is required for npx/codeburn. If not found, this script installs it
# automatically (Homebrew → nvm on macOS; apt/dnf → nvm on Linux).

# Load .env so PRX_MONTHLY_BUDGET is available when called by the hook runner
# (which does not inherit the env loaded by load-env.sh).
SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  set -o allexport
  # shellcheck disable=SC1090
  source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$')
  set +o allexport
fi

BUDGET="${PRX_MONTHLY_BUDGET:-20.00}"
BASELINE_FILE=/tmp/.prx-session-start-spend

# ── helpers ──────────────────────────────────────────────────────────────────

emit_json() {
  # $1 = additionalContext string  $2 = optional systemMessage string
  python3 - "$1" "${2:-}" <<'PYEOF'
import json, sys
ctx = sys.argv[1]
msg = sys.argv[2] if len(sys.argv) > 2 else ""
out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}
if msg:
    out["systemMessage"] = msg
print(json.dumps(out))
PYEOF
}

# ── locate npx (checks PATH + common install locations) ──────────────────────

locate_npx() {
  # 1. System PATH
  if command -v npx &>/dev/null 2>&1; then
    command -v npx; return 0
  fi

  # 2. Homebrew (macOS — Apple Silicon or Intel; brew may not be in PATH in hook context)
  local brew_paths=("/opt/homebrew/bin/npx" "/usr/local/bin/npx")
  for p in "${brew_paths[@]}"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done

  # 3. nvm — source it and re-check
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -f "$nvm_dir/nvm.sh" ]; then
    # shellcheck disable=SC1090
    source "$nvm_dir/nvm.sh" 2>/dev/null || true
    if command -v npx &>/dev/null 2>&1; then
      command -v npx; return 0
    fi
    # Find npx binary directly under nvm versions
    local nvm_npx
    nvm_npx=$(find "$nvm_dir/versions/node" -maxdepth 3 -name "npx" 2>/dev/null | sort -V | tail -1)
    if [ -n "$nvm_npx" ] && [ -x "$nvm_npx" ]; then
      echo "$nvm_npx"; return 0
    fi
  fi

  # 4. Other version managers (Volta, fnm)
  local other_paths=(
    "$HOME/.volta/bin/npx"
    "$HOME/.local/share/fnm/aliases/default/bin/npx"
  )
  for p in "${other_paths[@]}"; do
    if [ -x "$p" ]; then echo "$p"; return 0; fi
  done

  return 1
}

# ── install Node.js ───────────────────────────────────────────────────────────

install_via_brew() {
  local brew_bin
  brew_bin=$(command -v brew 2>/dev/null \
    || { [ -x "/opt/homebrew/bin/brew" ] && echo "/opt/homebrew/bin/brew"; } \
    || { [ -x "/usr/local/bin/brew" ] && echo "/usr/local/bin/brew"; } \
    || echo "")
  [ -z "$brew_bin" ] && return 1
  echo "⚙️  Installing Node.js via Homebrew..." >&2
  "$brew_bin" install node 1>&2
}

install_via_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -f "$nvm_dir/nvm.sh" ]; then
    echo "⚙️  Installing nvm..." >&2
    if command -v curl &>/dev/null; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash 1>&2
    elif command -v wget &>/dev/null; then
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash 1>&2
    else
      echo "❌  Cannot install nvm: neither curl nor wget found." >&2
      return 1
    fi
  fi
  # shellcheck disable=SC1090
  source "$nvm_dir/nvm.sh" 2>/dev/null || true
  echo "⚙️  Installing Node.js LTS via nvm..." >&2
  nvm install --lts 1>&2
  nvm use --lts 1>&2
}

install_via_apt() {
  command -v apt-get &>/dev/null || return 1
  command -v curl   &>/dev/null || return 1
  echo "⚙️  Installing Node.js via apt (NodeSource LTS)..." >&2
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - 1>&2
  sudo apt-get install -y nodejs 1>&2
}

install_via_dnf() {
  command -v dnf  &>/dev/null || command -v yum &>/dev/null || return 1
  command -v curl &>/dev/null || return 1
  local pm; pm=$(command -v dnf 2>/dev/null || command -v yum)
  echo "⚙️  Installing Node.js via $pm (NodeSource LTS)..." >&2
  curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - 1>&2
  sudo "$pm" install -y nodejs 1>&2
}

# ── ensure npx is available, installing Node.js if necessary ─────────────────

ensure_npx() {
  local npx_bin
  if npx_bin=$(locate_npx 2>/dev/null); then
    echo "$npx_bin"; return 0
  fi

  echo "⚙️  Node.js not found — installing automatically (required for codeburn budget tracking)..." >&2

  local os
  os="$(uname -s)"

  if [[ "$os" == "Darwin" ]]; then
    install_via_brew || install_via_nvm
  else
    # Linux: prefer system package manager (system-wide, survives reboots)
    # but fall back to nvm (no sudo needed)
    install_via_apt || install_via_dnf || install_via_nvm
  fi

  # Re-locate after installation attempt
  if npx_bin=$(locate_npx 2>/dev/null); then
    echo "✅  Node.js installed successfully." >&2
    echo "$npx_bin"; return 0
  fi

  echo "❌  Node.js installation failed. Install manually: https://nodejs.org" >&2
  return 1
}

# ── main ──────────────────────────────────────────────────────────────────────

NPX_BIN=$(ensure_npx) || {
  emit_json \
    "Budget check skipped: Node.js could not be installed automatically. Visit https://nodejs.org to install, then restart Claude Code." \
    "⚠️  codeburn requires Node.js — install from https://nodejs.org to enable budget tracking."
  exit 0
}

TODAY_DATE=$(date +%Y-%m-%d)
MONTH_START=$(date +%Y-%m-01)

# Capture today's baseline for Step 11 session-delta calculation
"$NPX_BIN" --yes codeburn@latest report --from "$TODAY_DATE" --to "$TODAY_DATE" --format json > "$BASELINE_FILE" 2>/dev/null \
  || rm -f "$BASELINE_FILE"

# Get current-month spend
MONTHLY_JSON=$("$NPX_BIN" --yes codeburn@latest report --from "$MONTH_START" --to "$TODAY_DATE" --format json 2>/dev/null) || MONTHLY_JSON=""

if [ -z "$MONTHLY_JSON" ]; then
  emit_json "Budget check skipped: codeburn returned no data."
  exit 0
fi

# Compute status and emit JSON for Claude Code's hook system
python3 - "$BUDGET" "$BASELINE_FILE" <<PYEOF
import json, sys, datetime, os

budget = float(sys.argv[1])
baseline_file = sys.argv[2]

monthly_raw = """$MONTHLY_JSON"""

today = datetime.date.today()
next_month = (today.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
days_remaining = (next_month - today).days

# Parse monthly spend — codeburn JSON: { overview: { cost: N }, ... }
spent = 0.0
try:
    data = json.loads(monthly_raw)
    spent = float(data.get('overview', {}).get('cost', 0))
except Exception:
    pass

# Parse today's baseline spend (pre-session) — same JSON structure
baseline_today = 0.0
if os.path.exists(baseline_file):
    try:
        daily_data = json.loads(open(baseline_file).read())
        baseline_today = float(daily_data.get('overview', {}).get('cost', 0))
    except Exception:
        pass

pct = spent / budget * 100 if budget > 0 else 0

if pct >= 100:
    icon = "❌"
    label = "EXCEEDED"
elif pct >= 80:
    icon = "⚠️ "
    label = "WARNING"
else:
    icon = "✅"
    label = "on track"

status_line = (
    f"{icon} Monthly budget {label}: \${spent:.2f} of \${budget:.2f} "
    f"({pct:.0f}% used, {days_remaining}d left in month)"
)

context = (
    f"codeburn budget status at session start — {status_line}. "
    f"Today's spend before this session: \${baseline_today:.4f}. "
    f"Budget resets on the 1st of each month."
)

out = {
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": context
    }
}
# Surface a system message only when budget is at risk so it's impossible to miss
if pct >= 80:
    out["systemMessage"] = status_line

print(json.dumps(out))
PYEOF
