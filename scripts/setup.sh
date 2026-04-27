#!/usr/bin/env bash
# setup.sh — Prevoyant one-shot prerequisite installer
#
# Supports: macOS · Linux · Windows (WSL) · Windows (Git Bash / MSYS2)
# Installs: uvx (Jira MCP), Node.js (budget tracking), pandoc (PDF reports)
# Also:     copies .env.example → .env, registers marketplace in settings.json
#
# Safe to re-run — skips anything already present.
# Run from any directory: bash /path/to/scripts/setup.sh
# Windows (native PowerShell): use scripts\setup.ps1 instead
# Windows (CMD / double-click): use scripts\setup.cmd

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OS_RAW="$(uname -s)"
ERRORS=0

# ── OS / environment detection ────────────────────────────────────────────────

IS_WSL=0
IS_WIN_BASH=0   # Git Bash / MSYS2 / Cygwin running on Windows

if grep -qi "microsoft\|wsl" /proc/version 2>/dev/null; then
  IS_WSL=1
fi

case "$OS_RAW" in
  MINGW*|MSYS*|CYGWIN*) IS_WIN_BASH=1 ;;
esac

if   [ "$IS_WIN_BASH" -eq 1 ]; then PLATFORM="Windows (Git Bash)"
elif [ "$IS_WSL" -eq 1 ];      then PLATFORM="Linux (WSL)"
elif [ "$OS_RAW" = "Darwin" ]; then PLATFORM="macOS"
else                                 PLATFORM="Linux"
fi

# ── colours ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()     { printf "${GREEN}  ✅  %s${NC}\n"       "$*"; }
warn()   { printf "${YELLOW}  ⚠️   %s${NC}\n"    "$*"; }
err()    { printf "${RED}  ❌  %s${NC}\n"       "$*"; ERRORS=$((ERRORS + 1)); }
step()   { printf "\n${BOLD}── %s${NC}\n"       "$*"; }
info()   { printf "       %s\n"                 "$*"; }
impact() { printf "       ${YELLOW}Impact: %s${NC}\n" "$*"; }

# ── helpers ───────────────────────────────────────────────────────────────────

brew_bin() {
  command -v brew 2>/dev/null && return 0
  [ -x /opt/homebrew/bin/brew ] && echo /opt/homebrew/bin/brew && return 0
  [ -x /usr/local/bin/brew ]    && echo /usr/local/bin/brew    && return 0
  return 1
}

locate_npx() {
  command -v npx     &>/dev/null 2>&1 && { command -v npx;     return 0; }
  command -v npx.cmd &>/dev/null 2>&1 && { command -v npx.cmd; return 0; }
  for p in /opt/homebrew/bin/npx /usr/local/bin/npx \
            "$HOME/.volta/bin/npx" "$HOME/.local/share/fnm/aliases/default/bin/npx"; do
    [ -x "$p" ] && { echo "$p"; return 0; }
  done
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ -f "$nvm_dir/nvm.sh" ]; then
    # shellcheck disable=SC1090
    source "$nvm_dir/nvm.sh" 2>/dev/null || true
    command -v npx &>/dev/null 2>&1 && { command -v npx; return 0; }
    local nvm_npx
    nvm_npx=$(find "$nvm_dir/versions/node" -maxdepth 3 -name npx 2>/dev/null | sort -V | tail -1)
    [ -n "$nvm_npx" ] && [ -x "$nvm_npx" ] && { echo "$nvm_npx"; return 0; }
  fi
  return 1
}

# Returns the first working Python 3 executable.
# On Windows Git Bash, python3 resolves to a Store stub that exits non-zero,
# so we verify each candidate actually runs before accepting it.
find_python() {
  for cmd in python3 python py; do
    if command -v "$cmd" &>/dev/null 2>&1; then
      if "$cmd" -c "import sys; assert sys.version_info >= (3,6)" 2>/dev/null; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

install_node_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -f "$nvm_dir/nvm.sh" ]; then
    info "Installing nvm..."
    if command -v curl &>/dev/null; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash 2>&1 | tail -3
    elif command -v wget &>/dev/null; then
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash 2>&1 | tail -3
    else
      return 1
    fi
  fi
  # shellcheck disable=SC1090
  source "$nvm_dir/nvm.sh" 2>/dev/null || return 1
  info "Installing Node.js LTS..."
  nvm install --lts 2>&1 | tail -3
  nvm use --lts 2>/dev/null || true
}

# Install Node.js on Windows (Git Bash) via Windows-native package managers
install_node_win() {
  local ok=0
  if command -v winget.exe &>/dev/null; then
    info "→ winget"
    winget.exe install --id OpenJS.NodeJS.LTS --silent \
      --accept-package-agreements --accept-source-agreements 2>&1 | tail -5 && ok=1
  fi
  if [ "$ok" -eq 0 ] && command -v choco.exe &>/dev/null; then
    info "→ Chocolatey"
    choco.exe install nodejs-lts -y 2>&1 | tail -5 && ok=1
  fi
  if [ "$ok" -eq 0 ] && command -v scoop &>/dev/null; then
    info "→ Scoop"
    scoop install nodejs-lts 2>&1 | tail -5 && ok=1
  fi
  [ "$ok" -eq 1 ]
}

install_pandoc_win() {
  local ok=0
  if command -v winget.exe &>/dev/null; then
    info "→ winget"
    winget.exe install --id JohnMacFarlane.Pandoc --silent \
      --accept-package-agreements --accept-source-agreements 2>&1 | tail -5 && ok=1
  fi
  if [ "$ok" -eq 0 ] && command -v choco.exe &>/dev/null; then
    info "→ Chocolatey"
    choco.exe install pandoc -y 2>&1 | tail -5 && ok=1
  fi
  if [ "$ok" -eq 0 ] && command -v scoop &>/dev/null; then
    info "→ Scoop"
    scoop install pandoc 2>&1 | tail -5 && ok=1
  fi
  [ "$ok" -eq 1 ]
}

install_python_win() {
  local ok=0
  if command -v winget.exe &>/dev/null; then
    info "→ winget"
    winget.exe install --id Python.Python.3 --silent \
      --accept-package-agreements --accept-source-agreements 2>&1 | tail -5 && ok=1
  fi
  if [ "$ok" -eq 0 ] && command -v choco.exe &>/dev/null; then
    info "→ Chocolatey"
    choco.exe install python -y 2>&1 | tail -5 && ok=1
  fi
  if [ "$ok" -eq 0 ] && command -v scoop &>/dev/null; then
    info "→ Scoop"
    scoop install python 2>&1 | tail -5 && ok=1
  fi
  [ "$ok" -eq 1 ]
}

# After a Windows package manager installs Python, PATH is not refreshed in the
# current Git Bash session. Probe known LOCALAPPDATA install locations directly.
find_python_win_after_install() {
  local appdata=""
  if command -v cygpath &>/dev/null && [ -n "${USERPROFILE:-}" ]; then
    appdata="$(cygpath -u "$USERPROFILE")/AppData/Local"
  else
    appdata="/c/Users/${USERNAME:-$USER}/AppData/Local"
  fi
  local py_exe
  py_exe="$(find "$appdata/Programs/Python" -maxdepth 2 -name python.exe 2>/dev/null \
            | sort -rV | head -1 || true)"
  if [ -n "$py_exe" ] && "$py_exe" -c "import sys; assert sys.version_info >= (3,6)" 2>/dev/null; then
    echo "$py_exe"
    return 0
  fi
  # Refresh shell hash table and retry find_python (covers choco / scoop paths)
  hash -r 2>/dev/null || true
  find_python
}

# Resolve the Windows user home directory from within WSL
wsl_win_home() {
  local win_path
  win_path="$(powershell.exe -NoProfile -c \
    '[Environment]::GetFolderPath("UserProfile")' 2>/dev/null | tr -d '\r\n')"
  [ -z "$win_path" ] && return 1
  wslpath "$win_path" 2>/dev/null || return 1
}

# ── header ────────────────────────────────────────────────────────────────────

printf "\n${BOLD}Prevoyant — Setup${NC}\n"
printf "Platform : %s\n" "$PLATFORM"
printf "Repo     : %s\n" "$PROJECT_ROOT"
printf "══════════════════════════════════════\n"

# ── 1. uvx (Jira MCP) ─────────────────────────────────────────────────────────

step "1/7  uvx  (Jira MCP server)  [required]"

if command -v uvx &>/dev/null; then
  ok "uvx already installed"
else
  info "Installing uv / uvx..."
  if command -v curl &>/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh 2>&1 | tail -5
  elif command -v wget &>/dev/null; then
    wget -qO- https://astral.sh/uv/install.sh | sh 2>&1 | tail -5
  else
    err "Cannot install uvx: curl and wget not found."
    impact "Jira MCP server disabled — ticket fetching and Jira integration will not work"
    info "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
  fi
  export PATH="$HOME/.local/bin:$PATH"
  if command -v uvx &>/dev/null; then
    ok "uvx installed"
    info "Add to your shell profile: export PATH=\"\$HOME/.local/bin:\$PATH\""
  else
    err "uvx installed but not found in PATH — restart shell or add \$HOME/.local/bin to PATH"
    impact "Jira MCP server may not start until PATH is updated"
  fi
fi

# ── 2. Node.js (ccusage) ──────────────────────────────────────────────────────

step "2/7  Node.js  (budget tracking + Prevoyant Server)  [required]"

if locate_npx &>/dev/null; then
  ok "Node.js already installed ($(node --version 2>/dev/null || echo 'found'))"
else
  info "Node.js not found — installing..."
  NODE_OK=0

  if [ "$IS_WIN_BASH" -eq 1 ]; then
    install_node_win && NODE_OK=1
  elif [ "$OS_RAW" = "Darwin" ]; then
    BREW=$(brew_bin 2>/dev/null || echo "")
    if [ -n "$BREW" ]; then
      info "→ Homebrew"
      "$BREW" install node 2>&1 | tail -5 && NODE_OK=1
    fi
    if [ "$NODE_OK" -eq 0 ]; then
      info "→ nvm (Homebrew unavailable)"
      install_node_nvm && NODE_OK=1
    fi
  else
    # Linux (including WSL — installs Node.js inside the Linux environment)
    if command -v apt-get &>/dev/null && command -v curl &>/dev/null; then
      info "→ apt (NodeSource LTS)"
      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - 2>&1 | tail -2 \
        && sudo apt-get install -y nodejs 2>&1 | tail -3 && NODE_OK=1
    fi
    if [ "$NODE_OK" -eq 0 ]; then
      PM_CMD=$(command -v dnf 2>/dev/null || command -v yum 2>/dev/null || echo "")
      if [ -n "$PM_CMD" ] && command -v curl &>/dev/null; then
        info "→ $(basename "$PM_CMD") (NodeSource LTS)"
        curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash - 2>&1 | tail -2 \
          && sudo "$PM_CMD" install -y nodejs 2>&1 | tail -3 && NODE_OK=1
      fi
    fi
    if [ "$NODE_OK" -eq 0 ]; then
      info "→ nvm"
      install_node_nvm && NODE_OK=1
    fi
  fi

  if locate_npx &>/dev/null; then
    ok "Node.js installed ($(node --version 2>/dev/null || echo 'found'))"
  else
    err "Node.js installation failed. Install from https://nodejs.org then re-run setup."
    impact "Token budget tracking and Prevoyant Server unavailable until Node.js is installed"
  fi
fi

# ── 3. pandoc (PDF generation) ────────────────────────────────────────────────

step "3/7  pandoc  (PDF reports)  [optional — Chrome headless or HTML fallback]"

if command -v pandoc &>/dev/null; then
  ok "pandoc already installed ($(pandoc --version 2>/dev/null | head -1 || echo 'found'))"
else
  info "Installing pandoc..."
  PANDOC_OK=0

  if [ "$IS_WIN_BASH" -eq 1 ]; then
    install_pandoc_win && PANDOC_OK=1
  elif [ "$OS_RAW" = "Darwin" ]; then
    BREW=$(brew_bin 2>/dev/null || echo "")
    [ -n "$BREW" ] && "$BREW" install pandoc 2>&1 | tail -5 && PANDOC_OK=1
  elif command -v apt-get &>/dev/null; then
    sudo apt-get install -y pandoc 2>&1 | tail -3 && PANDOC_OK=1
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y pandoc 2>&1 | tail -3 && PANDOC_OK=1
  elif command -v yum &>/dev/null; then
    sudo yum install -y pandoc 2>&1 | tail -3 && PANDOC_OK=1
  fi

  if command -v pandoc &>/dev/null; then
    ok "pandoc installed"
  else
    warn "pandoc not installed — PDF reports will fall back to Chrome headless or HTML."
    impact "Reports still generated — quality may be lower without pandoc"
    if [ "$IS_WIN_BASH" -eq 1 ]; then
      info "Install manually: winget install JohnMacFarlane.Pandoc"
    elif [ "$OS_RAW" = "Darwin" ]; then
      info "Install manually: brew install pandoc"
    else
      info "Install manually: apt install pandoc  (Debian/Ubuntu)"
      info "                  dnf install pandoc  (Fedora/RHEL)"
    fi
    info "See: https://pandoc.org/installing.html"
  fi
fi

# ── 4. .env ───────────────────────────────────────────────────────────────────

step "4/7  .env  (environment file)  [required]"

ENV_FILE="$PROJECT_ROOT/.env"
ENV_EXAMPLE="$PROJECT_ROOT/.env.example"

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "${ENV_FILE}.bak"
  ok ".env already exists — skipping (backed up to .env.bak)"
else
  if [ -f "$ENV_EXAMPLE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    ok ".env created from .env.example"
    warn "Edit .env: set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
  else
    err ".env.example not found — create .env manually (see README)"
    impact "Plugin cannot load credentials — Jira and email features disabled"
  fi
fi

# ── 5. Claude Code settings.json (marketplace registration) ───────────────────

step "5/7  Claude Code marketplace registration  [required]"

# On WSL, Claude Code runs on Windows — write to the Windows user profile.
# On Git Bash, $HOME already maps to the Windows user folder.
# On macOS / Linux, $HOME is correct as-is.
SETTINGS_FILE="$HOME/.claude/settings.json"
REPO_PATH_FOR_JSON="$PROJECT_ROOT"

if [ "$IS_WSL" -eq 1 ]; then
  WIN_HOME="$(wsl_win_home 2>/dev/null || echo "")"
  if [ -n "$WIN_HOME" ] && [ -d "$(dirname "$WIN_HOME")" ]; then
    SETTINGS_FILE="$WIN_HOME/.claude/settings.json"
    REPO_PATH_FOR_JSON="$(wslpath -w "$PROJECT_ROOT" 2>/dev/null || echo "$PROJECT_ROOT")"
    info "WSL: targeting Windows settings at $SETTINGS_FILE"
  else
    warn "Could not resolve Windows user path — writing to Linux ~/.claude (may not match Claude Code on Windows)"
  fi
elif [ "$IS_WIN_BASH" -eq 1 ] && command -v cygpath &>/dev/null; then
  REPO_PATH_FOR_JSON="$(cygpath -w "$PROJECT_ROOT")"
fi

mkdir -p "$(dirname "$SETTINGS_FILE")"

PYTHON_CMD="$(find_python || true)"
if [ -z "$PYTHON_CMD" ]; then
  info "Python 3 not found — attempting to install..."
  if [ "$IS_WIN_BASH" -eq 1 ]; then
    if install_python_win; then
      PYTHON_CMD="$(find_python_win_after_install || true)"
      [ -n "$PYTHON_CMD" ] \
        && ok "Python installed ($("$PYTHON_CMD" --version 2>&1))" \
        || warn "Python installed but not yet in PATH — re-run setup or open a new terminal"
    else
      warn "Automatic Python install failed"
      info "Install manually: winget install Python.Python.3"
    fi
  elif [ "$OS_RAW" = "Darwin" ]; then
    BREW=$(brew_bin 2>/dev/null || echo "")
    if [ -n "$BREW" ]; then
      info "→ Homebrew"
      "$BREW" install python3 2>&1 | tail -5
    else
      warn "Homebrew not installed — cannot auto-install Python"
      info "Install: https://brew.sh  then run: brew install python3"
    fi
    PYTHON_CMD="$(find_python || true)"
  else
    if command -v apt-get &>/dev/null; then
      info "→ apt"
      sudo apt-get install -y python3 2>&1 | tail -3
    elif command -v dnf &>/dev/null; then
      info "→ dnf"
      sudo dnf install -y python3 2>&1 | tail -3
    elif command -v yum &>/dev/null; then
      info "→ yum"
      sudo yum install -y python3 2>&1 | tail -3
    fi
    PYTHON_CMD="$(find_python || true)"
  fi
fi
if [ -z "$PYTHON_CMD" ]; then
  err "Python 3 not found — add the marketplace manually (see README)"
  impact "Prevoyant plugin will not load in Claude Code until the marketplace is registered"
  PYTHON_CMD="python3"  # dummy so subsequent heredocs fail gracefully
fi

"$PYTHON_CMD" - "$REPO_PATH_FOR_JSON" "$SETTINGS_FILE" <<'PYEOF'
import json, sys, os

repo_path     = sys.argv[1]
settings_path = sys.argv[2]

settings = {}
if os.path.exists(settings_path):
    try:
        with open(settings_path) as f:
            settings = json.load(f)
    except (json.JSONDecodeError, IOError):
        pass  # unreadable — start fresh

markets  = settings.setdefault("extraKnownMarketplaces", {})
existing = (markets.get("dodogeny") or {})
if (existing.get("source") or {}).get("path") == repo_path:
    print("       already registered at correct path")
    sys.exit(0)

markets["dodogeny"] = {"source": {"source": "directory", "path": repo_path}}

with open(settings_path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")

print(f"       registered dodogeny → {repo_path}")
PYEOF

if [ $? -eq 0 ]; then
  ok "settings.json updated"
else
  err "Could not update settings.json — add the marketplace manually (see README)"
  impact "Prevoyant plugin will not load in Claude Code until the marketplace is registered"
fi

# ── 6. .claude/settings.local.json (permissions) ─────────────────────────────
# SessionStart hooks (load-env + check-budget) live in the committed
# .claude/settings.json and work without this file.  This file only adds
# pre-approved permissions so common commands don't trigger prompts.

step "6/7  settings.local.json  (permission allowlist)  [optional]"

LOCAL_SETTINGS="$PROJECT_ROOT/.claude/settings.local.json"
mkdir -p "$PROJECT_ROOT/.claude"

if [ -f "$LOCAL_SETTINGS" ]; then
  ok "settings.local.json already exists — skipping"
  info "To regenerate, delete it and re-run setup."
else
  "$PYTHON_CMD" - "$LOCAL_SETTINGS" <<'PYEOF'
import json, sys

path = sys.argv[1]

config = {
    "permissions": {
        "allow": [
            "Bash(npx --yes ccusage@latest *)",
            "Bash(bash scripts/check-budget.sh)",
            "Bash(bash .claude/load-env.sh)"
        ]
    }
}

with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")

print(f"       created {path}")
PYEOF

  if [ $? -eq 0 ]; then
    ok "settings.local.json created (permission allowlist)"
  else
    warn "Could not create settings.local.json — hooks still work via settings.json; you may see extra permission prompts"
  fi
fi

# ── 7. Plugin install + enable ────────────────────────────────────────────────

step "7/7  plugin install + enable  [required]"

PLUGIN_OK=0
if command -v claude &>/dev/null; then
  if claude plugin list 2>/dev/null | grep -q "prevoyant-claude-plugin@dodogeny"; then
    ok "prevoyant-claude-plugin@dodogeny already installed"
    claude plugin enable prevoyant-claude-plugin@dodogeny 2>/dev/null || true
    PLUGIN_OK=1
  else
    info "Installing Prevoyant plugin..."
    claude plugin marketplace update dodogeny 2>&1 | tail -3 || true
    claude plugin install prevoyant-claude-plugin@dodogeny 2>&1 | tail -5 || true
    claude plugin enable  prevoyant-claude-plugin@dodogeny 2>&1 | tail -3 || true
    if claude plugin list 2>/dev/null | grep -q "prevoyant-claude-plugin@dodogeny"; then
      ok "prevoyant-claude-plugin@dodogeny installed and enabled"
      PLUGIN_OK=1
    else
      warn "Plugin install did not complete — run manually after setup:"
      info "  claude plugin install prevoyant-claude-plugin@dodogeny && claude plugin enable prevoyant-claude-plugin@dodogeny"
      impact "Prevoyant /prevoyant-claude-plugin:dev skill unavailable until the plugin is installed and enabled"
    fi
  fi
else
  warn "claude CLI not found in PATH — plugin will not be auto-installed"
  impact "After Claude Code is installed, run:"
  info "  claude plugin install prevoyant-claude-plugin@dodogeny && claude plugin enable prevoyant-claude-plugin@dodogeny"
fi

# ── summary ───────────────────────────────────────────────────────────────────

printf "\n══════════════════════════════════════\n"
if [ "$ERRORS" -eq 0 ]; then
  printf "${GREEN}${BOLD}Setup complete!${NC}\n"
else
  printf "${YELLOW}${BOLD}Setup finished with %d issue(s) — see above.${NC}\n" "$ERRORS"
fi

printf "\n${BOLD}Next steps:${NC}\n"
printf "  1. Edit .env — set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN\n"
printf "     Get your Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens\n"
if [ "$PLUGIN_OK" -eq 1 ]; then
  printf "  2. Open Claude Code and try: /prevoyant-claude-plugin:dev PROJ-1234\n\n"
else
  printf "  2. Run: claude plugin install prevoyant-claude-plugin@dodogeny && claude plugin enable prevoyant-claude-plugin@dodogeny\n"
  printf "  3. Open Claude Code and try: /prevoyant-claude-plugin:dev PROJ-1234\n\n"
fi
