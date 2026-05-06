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
function ok     { param($m) Write-Host "  OK   $m" -ForegroundColor Green }
function warn   { param($m) Write-Host "  WARN $m" -ForegroundColor Yellow }
function err    { param($m) Write-Host "  ERR  $m" -ForegroundColor Red; $script:ERRORS++ }
function step   { param($m) Write-Host "`n-- $m" -ForegroundColor Cyan }
function info   { param($m) Write-Host "       $m" }
function impact { param($m) Write-Host "       Impact: $m" -ForegroundColor Yellow }

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
step "1/9  uvx  (Jira MCP server)  [required]"

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
            impact "Jira MCP server may not start until PATH is updated"
        }
    } catch {
        err "uvx installation failed: $_"
        impact "Jira MCP server disabled — ticket fetching and Jira integration will not work"
        info "Install manually: https://docs.astral.sh/uv/getting-started/installation/"
    }
}

# ── 2. Node.js (codeburn) ─────────────────────────────────────────────────────
step "2/9  Node.js  (budget tracking + Prevoyant Server)  [required]"

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
        impact "Token budget tracking and Prevoyant Server unavailable until Node.js is installed"
    }
}

# ── 3. pandoc (PDF generation) ────────────────────────────────────────────────
step "3/9  pandoc  (PDF reports)  [optional — Chrome headless or HTML fallback]"

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
        impact "Reports still generated — quality may be lower without pandoc"
        info "Install manually: winget install JohnMacFarlane.Pandoc"
        info "Or download from: https://pandoc.org/installing.html"
    }
}

# ── 4. qpdf (PDF encryption for WhatsApp delivery) ───────────────────────────
step "4/9  qpdf  (PDF encryption)  [optional — needed for PRX_WASENDER_PDF_PASSWORD]"

if (cmd_exists 'qpdf') {
    ok "qpdf already installed ($((qpdf --version 2>$null | Select-Object -First 1) -replace '.*qpdf version ','qpdf '))"
} else {
    info "Installing qpdf..."
    $QPDF_OK = $false

    if (-not $QPDF_OK -and (cmd_exists 'winget')) {
        info "--> winget"
        try {
            winget install --id qpdf.qpdf --silent --accept-package-agreements --accept-source-agreements 2>&1 |
                Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'qpdf') { $QPDF_OK = $true }
        } catch { info "winget attempt failed: $_" }
    }

    if (-not $QPDF_OK -and (cmd_exists 'choco')) {
        info "--> Chocolatey"
        try {
            choco install qpdf -y 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'qpdf') { $QPDF_OK = $true }
        } catch { info "Chocolatey attempt failed: $_" }
    }

    if (-not $QPDF_OK -and (cmd_exists 'scoop')) {
        info "--> Scoop"
        try {
            scoop install qpdf 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            refresh_path
            if (cmd_exists 'qpdf') { $QPDF_OK = $true }
        } catch { info "Scoop attempt failed: $_" }
    }

    if (cmd_exists 'qpdf') {
        ok "qpdf installed"
    } else {
        warn "qpdf not installed — PDF encryption for WhatsApp delivery will be skipped."
        impact "Reports will be sent unencrypted until qpdf is installed"
        info "Install manually: winget install qpdf.qpdf  (or choco install qpdf)"
        info "Or download from: https://github.com/qpdf/qpdf/releases"
    }
}

# ── 5. basic-memory (per-agent personal memory MCP) ──────────────────────────
step "5/9  basic-memory  (per-agent MCP)  [optional — set PRX_BASIC_MEMORY_ENABLED=Y in .env]"

if (cmd_exists 'uvx') {
    ok "basic-memory available via uvx — no separate install needed"
    info "Seven per-agent MCP projects auto-provisioned when PRX_BASIC_MEMORY_ENABLED=Y"
} else {
    warn "uvx not found — basic-memory requires uvx (step 1/9 must succeed first)"
    impact "Personal agent memory MCP will not start until uvx is installed"
}

# ── 6. .env ───────────────────────────────────────────────────────────────────
step "6/9  .env  (environment file)  [required]"

$EnvFile    = Join-Path $PROJECT_ROOT ".env"
$EnvExample = Join-Path $PROJECT_ROOT ".env.example"

if (Test-Path $EnvFile) {
    Copy-Item $EnvFile "$EnvFile.bak" -Force
    ok ".env already exists — skipping (backed up to .env.bak)"
} else {
    if (Test-Path $EnvExample) {
        Copy-Item $EnvExample $EnvFile
        ok ".env created from .env.example"
        warn "Edit .env: set PRX_REPO_DIR, JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN"
    } else {
        err ".env.example not found — create .env manually (see README)"
        impact "Plugin cannot load credentials — Jira and email features disabled"
    }
}

# ── 7. Claude Code settings.json (marketplace registration) ───────────────────
step "7/9  Claude Code marketplace registration  [required]"

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
    impact "Prevoyant plugin will not load in Claude Code until the marketplace is registered"
    info "Add the marketplace manually (see README)"
}

# ── 8. .claude/settings.local.json (permissions) ─────────────────────────────
# SessionStart hooks (load-env + check-budget) live in the committed
# .claude/settings.json and work without this file.  This file only adds
# pre-approved permissions so common commands don't trigger prompts.
step "8/9  settings.local.json  (permission allowlist)  [optional]"

$LocalSettings = Join-Path $PROJECT_ROOT ".claude\settings.local.json"
$LocalDir = Split-Path -Parent $LocalSettings
if (-not (Test-Path $LocalDir)) { New-Item -ItemType Directory -Path $LocalDir -Force | Out-Null }

if (Test-Path $LocalSettings) {
    ok "settings.local.json already exists — skipping"
    info "To regenerate, delete it and re-run setup."
} else {
    try {
        $config = [PSCustomObject]@{
            permissions = [PSCustomObject]@{
                allow = @(
                    "Bash(npx --yes codeburn@latest *)",
                    "Bash(codeburn *)",
                    "Bash(bash scripts/check-budget.sh)",
                    "Bash(bash .claude/load-env.sh)"
                )
            }
        }
        $config | ConvertTo-Json -Depth 10 | Set-Content $LocalSettings -Encoding UTF8
        ok "settings.local.json created (permission allowlist)"
    } catch {
        warn "Could not create settings.local.json: $_ — hooks still work via settings.json; you may see extra permission prompts"
    }
}

# ── 9. Plugin install + enable ────────────────────────────────────────────────
step "9/9  plugin install + enable  [required]"

$PLUGIN_OK = $false
if (cmd_exists 'claude') {
    info "Checking plugin status..."
    $pluginList = & claude plugin list 2>$null
    if ($pluginList -match 'prevoyant@dodogeny') {
        ok "prevoyant@dodogeny already installed"
        & claude plugin enable prevoyant@dodogeny 2>$null | Out-Null
        $PLUGIN_OK = $true
    } else {
        info "Installing Prevoyant plugin..."
        try {
            & claude plugin marketplace update dodogeny 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
            & claude plugin install prevoyant@dodogeny 2>&1 | Select-Object -Last 5 | ForEach-Object { info $_ }
            & claude plugin enable  prevoyant@dodogeny 2>&1 | Select-Object -Last 3 | ForEach-Object { info $_ }
            $pluginList2 = & claude plugin list 2>$null
            if ($pluginList2 -match 'prevoyant@dodogeny') {
                ok "prevoyant@dodogeny installed and enabled"
                $PLUGIN_OK = $true
            } else {
                warn "Plugin install did not complete — run manually after setup:"
                info "  claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
                impact "Prevoyant /prevoyant:dev skill unavailable until the plugin is installed and enabled"
            }
        } catch {
            warn "Plugin install failed: $_ — run manually:"
            info "  claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
            impact "Prevoyant /prevoyant:dev skill unavailable until the plugin is installed and enabled"
        }
    }
} else {
    warn "claude CLI not found in PATH — plugin will not be auto-installed"
    impact "After Claude Code is installed, run:"
    info "  claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
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
if ($PLUGIN_OK) {
    Write-Host "  2. Open Claude Code and try: /prevoyant:dev PROJ-1234"
} else {
    Write-Host "  2. Run: claude plugin install prevoyant@dodogeny && claude plugin enable prevoyant@dodogeny"
    Write-Host "  3. Open Claude Code and try: /prevoyant:dev PROJ-1234"
}
Write-Host ""
