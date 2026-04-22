# setup.ps1 — Prevoyant one-shot prerequisite installer (Windows)
#
# Installs: uvx (Jira MCP), Node.js (budget tracking), pandoc (PDF reports)
# Also:     copies .env.example → .env, registers marketplace in settings.json
#
# Safe to re-run — skips anything already present.
# Run from the project root: .\scripts\setup.ps1
# If blocked by execution policy: Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned

#Requires -Version 5.1

$SCRIPT_DIR   = Split-Path -Parent $MyInvocation.MyCommand.Path
$PROJECT_ROOT = Split-Path -Parent $SCRIPT_DIR
$ERRORS = 0

# ── helpers ───────────────────────────────────────────────────────────────────
function ok   { param($m) Write-Host "  OK   $m" -ForegroundColor Green }
function warn { param($m) Write-Host "  WARN $m" -ForegroundColor Yellow }
function err  { param($m) Write-Host "  ERR  $m" -ForegroundColor Red; $script:ERRORS++ }
function step { param($m) Write-Host "`n-- $m" -ForegroundColor Cyan }
function info { param($m) Write-Host "       $m" }

function cmd_exists { param($c) return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

function refresh_path {
    $env:PATH = ($env:PATH + ";" +
        [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
        [System.Environment]::GetEnvironmentVariable("PATH", "User")) -replace ';;+', ';'
}

# ── header ────────────────────────────────────────────────────────────────────
Write-Host "`nPrevoyant -- Setup" -ForegroundColor White
Write-Host "Platform : Windows ($([System.Environment]::OSVersion.Version))"
Write-Host "Repo     : $PROJECT_ROOT"
Write-Host "======================================"

# ── 1. uvx (Jira MCP) ─────────────────────────────────────────────────────────
step "1/5  uvx  (Jira MCP server)"

if (cmd_exists 'uvx') {
    ok "uvx already installed"
} else {
    info "Installing uv / uvx via PowerShell installer..."
    try {
        $null = powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex" 2>&1
        refresh_path
        if (cmd_exists 'uvx') {
            ok "uvx installed ($((Get-Command uvx).Source))"
            info "Add to your profile: `$env:PATH += `";`$env:USERPROFILE\.local\bin`""
        } else {
            err "uvx installed but not found in PATH — restart PowerShell or open a new terminal"
        }
    } catch {
        err "uvx installation failed: $_"
        info "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
    }
}

# ── 2. Node.js (ccusage) ──────────────────────────────────────────────────────
step "2/5  Node.js  (ccusage budget tracking)"

if (cmd_exists 'node') {
    ok "Node.js already installed ($(node --version 2>$null))"
} else {
    info "Node.js not found — installing..."
    $NODE_OK = $false

    if (-not $NODE_OK -and (cmd_exists 'winget')) {
        info "--> winget"
        try {
            winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'node') { $NODE_OK = $true }
        } catch { info "winget attempt failed: $_" }
    }

    if (-not $NODE_OK -and (cmd_exists 'choco')) {
        info "--> Chocolatey"
        try {
            choco install nodejs-lts -y 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'node') { $NODE_OK = $true }
        } catch { info "Chocolatey attempt failed: $_" }
    }

    if (-not $NODE_OK -and (cmd_exists 'scoop')) {
        info "--> Scoop"
        try {
            scoop install nodejs-lts 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'node') { $NODE_OK = $true }
        } catch { info "Scoop attempt failed: $_" }
    }

    if (cmd_exists 'node') {
        ok "Node.js installed ($(node --version 2>$null))"
    } else {
        err "Node.js installation failed. Install from https://nodejs.org then re-run setup."
        info "Budget tracking will be skipped until Node.js is available."
    }
}

# ── 3. pandoc (PDF generation) ────────────────────────────────────────────────
step "3/5  pandoc  (PDF reports — optional, Chrome/HTML fallback available)"

if (cmd_exists 'pandoc') {
    ok "pandoc already installed ($(pandoc --version 2>$null | Select-Object -First 1))"
} else {
    info "Installing pandoc..."
    $PANDOC_OK = $false

    if (-not $PANDOC_OK -and (cmd_exists 'winget')) {
        info "--> winget"
        try {
            winget install --id JohnMacFarlane.Pandoc --silent --accept-package-agreements --accept-source-agreements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'pandoc') { $PANDOC_OK = $true }
        } catch { info "winget attempt failed: $_" }
    }

    if (-not $PANDOC_OK -and (cmd_exists 'choco')) {
        info "--> Chocolatey"
        try {
            choco install pandoc -y 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'pandoc') { $PANDOC_OK = $true }
        } catch { info "Chocolatey attempt failed: $_" }
    }

    if (-not $PANDOC_OK -and (cmd_exists 'scoop')) {
        info "--> Scoop"
        try {
            scoop install pandoc 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'pandoc') { $PANDOC_OK = $true }
        } catch { info "Scoop attempt failed: $_" }
    }

    if (cmd_exists 'pandoc') {
        ok "pandoc installed"
    } else {
        warn "pandoc not installed — PDF reports will fall back to Chrome headless or HTML."
        info "Install manually: winget install JohnMacFarlane.Pandoc"
        info "Or download from: https://pandoc.org/installing.html"
    }
}

# ── 4. .env ───────────────────────────────────────────────────────────────────
step "4/5  .env  (environment file)"

$EnvFile    = Join-Path $PROJECT_ROOT ".env"
$EnvExample = Join-Path $PROJECT_ROOT ".env.example"

if (Test-Path $EnvFile) {
    ok ".env already exists — skipping"
} else {
    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
        ok ".env created from .env.example"
        warn "Edit .env: set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
    } else {
        err ".env.example not found — create .env manually (see README)"
    }
}

# ── 5. Claude Code settings.json (marketplace registration) ───────────────────
step "5/5  Claude Code marketplace registration"

$SettingsFile = Join-Path $env:USERPROFILE ".claude\settings.json"
$SettingsDir  = Split-Path -Parent $SettingsFile
if (-not (Test-Path $SettingsDir)) {
    New-Item -ItemType Directory -Path $SettingsDir -Force | Out-Null
}

try {
    $settings = [PSCustomObject]@{}
    if (Test-Path $SettingsFile) {
        try { $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json } catch {}
    }

    # Ensure extraKnownMarketplaces exists
    if (-not $settings.PSObject.Properties['extraKnownMarketplaces']) {
        $settings | Add-Member -NotePropertyName 'extraKnownMarketplaces' -NotePropertyValue ([PSCustomObject]@{}) -Force
    }
    $markets = $settings.extraKnownMarketplaces

    $existingProp = $markets.PSObject.Properties['dodogeny']
    if ($existingProp -and $existingProp.Value.source.path -eq $PROJECT_ROOT) {
        info "already registered at correct path"
    } else {
        $entry = [PSCustomObject]@{
            source = [PSCustomObject]@{ source = 'directory'; path = $PROJECT_ROOT }
        }
        $markets | Add-Member -NotePropertyName 'dodogeny' -NotePropertyValue $entry -Force
        $settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
        info "registered dodogeny -> $PROJECT_ROOT"
    }
    ok "~/.claude/settings.json updated"
} catch {
    err "Could not update settings.json: $_"
    info "Add the marketplace manually (see README)"
}

# ── summary ───────────────────────────────────────────────────────────────────
Write-Host "`n======================================"
if ($ERRORS -eq 0) {
    Write-Host "Setup complete!" -ForegroundColor Green
} else {
    Write-Host "Setup finished with $ERRORS issue(s) — see above." -ForegroundColor Yellow
}

Write-Host "`nNext steps:"
Write-Host "  1. Edit .env — set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
Write-Host "     Get your Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens"
Write-Host "  2. Run: claude plugin install prx@dodogeny && claude plugin enable prx@dodogeny"
Write-Host "  3. Open Claude Code and try: /prx:dev PROJ-1234"
Write-Host ""
