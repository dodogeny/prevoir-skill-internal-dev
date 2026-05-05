# Prevoyant - Claude Code Plugin `v1.2.8`

**Prevoyant** is a [Claude Code](https://claude.ai/code) plugin — an AI agent team that runs a structured, end-to-end developer workflow for Jira tickets. Three modes:

- **Dev Mode** — hand Claude a ticket key and it walks through the full cycle: ticket ingestion → root cause analysis → proposed fix → PDF report (12 steps).
- **PR Review Mode** — hand Claude a ticket key with the word `review` and Prevoyant's Engineering Panel reviews the code changes on the associated feature branch, producing a structured PDF findings report.
- **Estimate Mode** — hand Claude a ticket key with the word `estimate` and Prevoyant's Engineering Panel runs Planning Poker. Each engineer scores the ticket across three dimensions (complexity, risk, repetition) drawing on their acquired system knowledge and the shared KB, then votes simultaneously. Structured debate continues until the team reaches unanimous consensus.

---

## Overview

Invoke the skill with a Jira ticket key and Claude runs a structured multi-step workflow — no manual searching, no copy-pasting ticket details, no guessing where to start.

### Dev Mode — `/prevoyant:dev PROJ-1234`

1. **KB query** — pull the team's knowledge base; surface prior knowledge on the ticket's components
2. **Ingest ticket** — fetch Jira fields, description, attachments, and all linked tickets
3. **Analyse & contextualise** — produce a problem statement, acceptance criteria, and an optional draw.io flow diagram
4. **Read comments** — extract prior investigation findings, decisions, and constraints
5. **Create branch** — determine the correct base branch (fix version → affected version → development) and check out `Feature/{TICKET_KEY}_{Title}`
6. **Locate affected code** — grep-first/read-second approach; build a file map with confidence gate
7. **Replicate the issue** — numbered reproduction steps with prerequisites, expected vs actual, service restart guidance
8. **Root cause analysis** — Engineering Panel (Morgan chairs; Alex, Sam, Jordan investigate; Henk provides domain authority and client-value assessment; Riley assesses test coverage) for bugs; Direct Analysis for enhancements; scored verdict + Root Cause Statement + Henk's business-necessity check-in
9. **Propose the fix** — code changes anchored to the Root Cause Statement; Morgan fix review; optional apply to branch
10. **Impact analysis** — usage reference search, layer-by-layer impact table, regression risks, retest checklist
11. **Change summary** — files touched, commit message, PR description template ready to paste
12. **Session stats** — elapsed time, actual token usage and cost via codeburn (falls back to estimation if Node.js unavailable)
13. **PDF report** — full-detail report saved to `CLAUDE_REPORT_DIR`; emailed if `PRX_EMAIL_TO` is set
14. **Update KB** — write session record; push to shared repo if distributed
15. **Bryan's retrospective** — Scrum Master audits token spend, flags process friction, proposes one SKILL.md improvement; unanimous team vote; pushes to main after `PRX_SKILL_UPGRADE_MIN_SESSIONS` sessions

### PR Review Mode — `/prevoyant:dev review PROJ-1234`

1. **KB query** — pull the team's knowledge base; surface prior knowledge on the ticket's components
2. **Read ticket** — fetch Jira fields and description
3. **Understand problem** — full analysis including all linked tickets and attachments
4. **Read comments** — extract prior investigation and decisions
5. **Fetch code changes** — locate the feature branch; run `git diff` to retrieve the full changeset
6. **Engineering Panel review** — same team as Dev Mode, now operating as reviewers: Alex (code quality), Sam (logic + acceptance criteria), Jordan (20-pattern defensive checklist), Henk (business rule alignment and client-value impact), Riley (test coverage); Morgan scores and delivers a binding verdict
7. **Consolidated findings** — Critical/Major/Minor issues with `file:line` and fix recommendations; Positives; Conditions for Approval
8. **Session stats** — elapsed time, actual token usage and cost via codeburn (falls back to estimation if Node.js unavailable)
9. **PDF review report** — saved as `{TICKET_KEY}-review.pdf` in `CLAUDE_REPORT_DIR`
10. **Update KB** — record review verdict, confirmed rules, pattern bumps; push if distributed
11. **Bryan's retrospective** — same as Dev Mode; token audit uses review session stats

**Review verdict:** ✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT

### Estimate Mode — `/prevoyant:dev estimate PROJ-1234`

Story points measure **effort** — not hours. Each vote scores three dimensions: **Complexity** (how hard), **Risk** (how uncertain), **Repetition** (how familiar). Scale: 1 · 2 · 3 · 5 · 8 · 13 · 20 · ? (spike needed).

Each engineer draws on their **acquired system knowledge** and the shared KB (`core-mental-map/`, `patterns.md`, `gotchas.md`, past ticket estimates, lessons learned) before committing to a vote — ensuring estimates are grounded in what the team actually knows about the codebase, not gut feel.

1. **KB & system knowledge load** — pull KB; each engineer reads architecture, gotchas, data-flows, past estimates on similar components, and lessons learned before voting
2. **Ingest ticket** — fetch Jira fields, acceptance criteria, linked sub-tasks; surface existing story points as reference only (team does not anchor on it)
3. **Scope & dimension analysis** — Engineering Panel jointly maps work areas and rates Complexity / Risk / Repetition with KB evidence before any individual votes are cast
4. **Planning Poker Round 1** — all panel members vote simultaneously; each scores all three dimensions through their domain lens (Morgan: architecture; Alex: backend; Sam: business logic; Jordan: infrastructure; Henk: business rules and client workflows; Riley: testing) citing specific KB entries
5. **Debate & consensus** — if votes differ, structured rounds anchored to specific dimensions: highest voter explains which dimension is underweighted and why (citing system knowledge); lowest responds with counter-evidence; others react; re-vote
6. **Morgan's final call** — if no consensus after 3 rounds, Morgan makes a binding decision citing the deciding KB evidence; dissenting view recorded
7. **Final estimate** — agreed story points, dimension summary, confidence level (High/Medium/Low), key assumptions, what would change the estimate
8. **KB update** — records estimate with dimension breakdown and any `[ESTIMATE-PATTERN]` complexity insights for future sessions
9. **Bryan's retrospective** — audits whether estimates were grounded in KB evidence; proposes SKILL.md improvements (opt-in)

**Confidence levels:** High = unanimous Round 1 · Medium = Round 2 · Low = Round 3+ or Morgan call

---

## Quick Start

### 1. Install the plugin

**macOS / Linux:**
```bash
git clone https://github.com/dodogeny/prevoyant-claude-plugin.git \
  ~/.claude/plugins/marketplaces/dodogeny
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/dodogeny/prevoyant-claude-plugin.git "$env:USERPROFILE\.claude\plugins\marketplaces\dodogeny"
```

Add to `~/.claude/settings.json` (or skip this — the setup script in Step 2 does it automatically):

**macOS / Linux:**
```json
{
  "extraKnownMarketplaces": {
    "dodogeny": {
      "source": { "source": "directory", "path": "/Users/<username>/.claude/plugins/marketplaces/dodogeny" }
    }
  }
}
```

**Windows:**
```json
{
  "extraKnownMarketplaces": {
    "dodogeny": {
      "source": { "source": "directory", "path": "C:\\Users\\<username>\\.claude\\plugins\\marketplaces\\dodogeny" }
    }
  }
}
```

**Alternatively**, skip the manual clone and point directly to GitHub:
```json
{
  "extraKnownMarketplaces": {
    "dodogeny": {
      "source": { "source": "github", "repo": "dodogeny/prevoyant-claude-plugin" }
    }
  }
}
```

Then install and enable:
```bash
claude plugin marketplace update dodogeny
claude plugin install prevoyant@dodogeny
claude plugin enable prevoyant@dodogeny
claude plugin list   # should show prevoyant@dodogeny with ✔ enabled
```

---

### 2. Install prerequisites

Run the one-shot setup script — it auto-detects your OS and installs `uvx` (Jira MCP), `Node.js` (budget tracking), and `pandoc` (PDF reports), copies `.env.example` → `.env`, and registers the marketplace in `~/.claude/settings.json`. Safe to re-run.

| Environment | Command |
|-------------|---------|
| macOS | `bash scripts/setup.sh` |
| Linux | `bash scripts/setup.sh` |
| Windows — WSL | `bash scripts/setup.sh` |
| Windows — Git Bash | `bash scripts/setup.sh` |
| Windows — PowerShell | `.\scripts\setup.ps1` |
| Windows — CMD / double-click | `scripts\setup.cmd` |

> **How it works:** `.mcp.json` (committed, no credentials) tells Claude Code to run `uvx mcp-atlassian`. On first use `uvx` downloads the package into an isolated cache — no `pip install`, no virtual environment, no version conflicts. Credentials flow in from `.env` automatically.

---

### 3. Fill in `.env`

The setup script copied `.env.example` → `.env` for you. Open `.env` and set the three required values:

```bash
# Path to your local repository clone
PRX_REPO_DIR=/absolute/path/to/your/repo

# Jira credentials — get your API token at:
# https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_URL=https://yourcompany.atlassian.net
JIRA_USERNAME=your.name@yourcompany.com
JIRA_API_TOKEN=your-api-token-here
```

> **Why no `.mcp.json` editing?** `.mcp.json` is already committed to the repo with no credentials. `mcp-atlassian` reads `JIRA_URL`, `JIRA_USERNAME`, and `JIRA_API_TOKEN` from the environment. Claude Code loads `.env` before starting MCP servers, so the credentials flow through automatically.

**Verify** — open a Claude Code session in the project directory and ask:
```
search for Jira issue PROJ-1
```
If the MCP is configured correctly, Claude returns the issue details.

---

### 4. Run it

**Dev Mode:**
```
/prevoyant:dev PROJ-1234
```

**PR Review Mode:**
```
/prevoyant:dev review PROJ-1234
```

**Estimate Mode:**
```
/prevoyant:dev estimate PROJ-1234
```

> `/dev` is the shorthand (no namespace prefix). Use `/prevoyant:dev` if another installed plugin also has a `dev` skill.

---

## Configuration Reference

Copy `.env.example` to `.env` — Claude Code loads it automatically from the project root. All variables are optional unless marked required.

### Required

| Variable | Description |
|----------|-------------|
| `PRX_REPO_DIR` | Absolute path to your local repository clone, e.g. `/home/alice/projects/myrepo`. The skill creates branches here and searches this directory for code. |
| `JIRA_URL` | Your Atlassian base URL, e.g. `https://yourcompany.atlassian.net` |
| `JIRA_USERNAME` | Your Atlassian account email |
| `JIRA_API_TOKEN` | Jira API token — generate at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) |

> `JIRA_URL`, `JIRA_USERNAME`, and `JIRA_API_TOKEN` are read by the Atlassian MCP server directly from the environment. `.mcp.json` (already committed, no credentials) just specifies the command — no editing needed.

### Knowledge Base

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_KB_MODE` | `local` | `local` — KB on this machine only. `distributed` — KB in a shared private git repo. |
| `PRX_KNOWLEDGE_DIR` | `$HOME/.prevoyant/knowledge-base` | Override the local KB path (local mode only). |
| `PRX_KB_REPO` | — | URL of your team's private KB git repository (distributed mode — required). |
| `PRX_KB_LOCAL_CLONE` | `$HOME/.prevoyant/kb` | Local clone path for the KB repo (distributed mode). |
| `PRX_KB_KEY` | — | AES-256-CBC passphrase for encrypting KB files at rest (distributed mode, optional). |

### Source Repository Cross-Check (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_SOURCE_REPO_URL` | — | Hosted URL of your codebase (e.g. `https://github.com/myorg/myrepo`). When set, the skill cross-checks KB `file:line` references against the live main branch. Omit to skip. |

### Report Output

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_REPORT_DIR` | `$HOME/.prevoyant/reports` | Folder where PDF/HTML reports are saved. Created automatically if it does not exist. |

### Email Delivery (optional)

Set `PRX_EMAIL_TO` to enable. Leave it unset to disable email entirely.

| Variable | Required | Description |
|----------|----------|-------------|
| `PRX_EMAIL_TO` | — | Recipient address |
| `PRX_SMTP_HOST` | If email set | SMTP hostname — `smtp.gmail.com` / `smtp.office365.com` |
| `PRX_SMTP_PORT` | — | SMTP port — default `587` (STARTTLS), use `465` for SSL |
| `PRX_SMTP_USER` | If email set | SMTP login username |
| `PRX_SMTP_PASS` | If email set | SMTP password or app password |

> **Gmail:** Use an [App Password](https://myaccount.google.com/apppasswords) when 2-Step Verification is enabled.

### Bryan — Scrum Master (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_INCLUDE_SM_IN_SESSIONS_ENABLED` | `N` | Set to `Y` to activate Bryan's retrospective (Step 14 / R10). Disabled by default. |
| `PRX_SKILL_UPGRADE_MIN_SESSIONS` | `3` | Sessions with an approved change before Bryan pushes to the plugin repo's main branch. Set to `1` to push after every approved session. |
| `PRX_SKILL_COMPACTION_INTERVAL` | `10` | Sessions between full SKILL.md compaction passes. On compaction sessions Bryan deep-reviews the entire file to eliminate redundancy and compress verbose prose; requires all five team members to approve. |
| `PRX_MONTHLY_BUDGET` | `20.00` | Monthly Claude subscription budget in USD. Actual spend is measured via [codeburn](https://github.com/getagentseal/codeburn), which reads Claude Code's local JSONL logs — no network call, no auth. Checked at every session start; Bryan uses the real figure in Step 14. Flags ⚠️ at >80% and ❌ at ≥100%. Budget resets on the 1st of each month. |

### Automation (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_MODE` | `N` | Set to `Y` to run the full workflow without any interactive prompts, confirmation gates, or permission asks. The fix is proposed and automatically applied to the newly created feature branch. |
| `FORCE_FULL_RUN` | `N` | Set to `Y` to force every step to execute in full even when the ticket has been analysed in a prior session. Useful when replaying a ticket for a completely fresh analysis. |

### Output Verbosity (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_REPORT_VERBOSITY` | `full` | Controls how much panel dialogue appears in the terminal. `full` — all panel dialogue, debate rounds, check-ins. `compact` — structured blocks intact; narrative condensed to bullets. `minimal` — structured blocks only; no panel narrative. The PDF report always contains full content regardless of this setting. |

### Jira Project Scope (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_JIRA_PROJECT` | — | Jira project key to scope ticket polling (e.g. `IV`). When set, `poll-jira.sh` restricts the JQL to that project only. Omit to poll all projects assigned to `currentUser()`. |

### Attachment Size Limit (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_ATTACHMENT_MAX_MB` | `0` (no limit) | Maximum size in MB for non-image attachments (logs, dumps, XML, etc.). Set to `0` or leave unset for no limit. Images and screenshots are always read regardless of this setting. |

### Webhook Server — Ambient Agent (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_PORT` | `3000` | Port the Express server listens on. |
| `WEBHOOK_SECRET` | — | Token appended to the webhook URL registered in Jira: `http://your-server:3000/jira-events?token=YOUR_SECRET`. Leave empty to skip token validation (only safe on a private network). |
| `WEBHOOK_POLL_INTERVAL_DAYS` | `0` (disabled) | Run `poll-jira.sh` every N days as a scheduled fallback. Set to `0` or leave unset to disable. Fractional values work: `0.5` = every 12 hours. |

### Notifications (optional)

Set `PRX_NOTIFY_ENABLED=Y` to enable. Requires `PRX_EMAIL_TO` to be set.

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_NOTIFY_ENABLED` | `N` | Set to `Y` to enable email notifications for ticket lifecycle events. |
| `PRX_NOTIFY_LEVEL` | `compact` | `full` — one email per event. `compact` — one summary email per job. `urgent` — issues and decision prompts only. `mute` — suppressed. |
| `PRX_NOTIFY_MUTE_DAYS` | `0` | Temporarily mute all notifications for N days. |
| `PRX_NOTIFY_MUTE_UNTIL` | — | Internal — set by the mute command. Do not edit manually. |
| `PRX_NOTIFY_EVENTS` | all events | Comma-separated list of events to notify on: `jira_assigned`, `ticket_scheduled`, `ticket_queued`, `ticket_started`, `ticket_completed`, `ticket_failed`, `ticket_interrupted`, `poll_ran`. |

### Health Monitor — Watchdog (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_WATCHDOG_ENABLED` | `N` | Set to `Y` to enable the in-process watchdog. Polls `GET /health` and sends an urgent email alert when the server stops responding; sends a recovery email when it comes back. Requires `PRX_EMAIL_TO`. |
| `PRX_WATCHDOG_INTERVAL_SECS` | `60` | Seconds between health checks. |
| `PRX_WATCHDOG_FAIL_THRESHOLD` | `3` | Consecutive failures before sending a DOWN alert. |

### Disk Monitor (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_DISK_MONITOR_ENABLED` | `N` | Set to `Y` to enable disk space tracking for `~/.prevoyant/`. Sends an email alert when the folder reaches `PRX_DISK_CAPACITY_ALERT_PCT`% of `PRX_PREVOYANT_MAX_SIZE_MB`. Cleanup must be approved via the dashboard — no automatic deletion. |
| `PRX_DISK_MONITOR_INTERVAL_MINS` | `60` | Minutes between disk checks. |
| `PRX_PREVOYANT_MAX_SIZE_MB` | `500` | Size quota for `~/.prevoyant/` in MB. The alert threshold is a percentage of this value. |
| `PRX_DISK_CAPACITY_ALERT_PCT` | `80` | Percentage of the size quota at which to send an alert email. E.g. 80% of 500 MB = alert fires at 400 MB. |
| `PRX_DISK_CLEANUP_INTERVAL_DAYS` | `7` | Days between cleanup passes (surfaces a pending-cleanup notice on the dashboard). |

### Ticket Watcher (optional)

Continuously monitors Jira tickets on a configurable schedule and emails AI-generated progress digests. Manage watched tickets at `/dashboard/watch`.

Set `PRX_WATCH_ENABLED=Y` to activate.

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_WATCH_ENABLED` | `N` | Set to `Y` to start the ticket watcher background worker. Can be toggled from Settings — no restart required. |
| `PRX_WATCH_POLL_INTERVAL` | `1d` | Default interval pre-selected when adding a ticket: `1h`, `1d`, `2d`, or `5d`. |
| `PRX_WATCH_MAX_POLLS` | `0` | Default maximum polls per ticket when adding (0 = unlimited). |
| `PRX_WATCH_LOG_KEEP_DAYS` | `30` | Delete poll log files older than this many days during disk cleanup. |
| `PRX_WATCH_LOG_KEEP_PER_TICKET` | `10` | Keep at most this many log files per ticket (oldest removed first) during disk cleanup. |

Poll logs are written to `~/.prevoyant/watch/logs/{TICKET_KEY}/` — one timestamped file per poll. The live log tail is available from the Watch dashboard while a poll is in flight.

### Claude Budget Tracker (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_MONTHLY_BUDGET` | — | Monthly budget in USD. The dashboard tracks spend against this limit using codeburn local token calculation (labelled "codeburn calc'd"). |

---

## Prerequisites

Run the setup script — it auto-detects your OS and handles everything below. Manual commands are listed here as a fallback only.

### PDF Generation

The skill generates reports via pandoc → Chrome headless → HTML fallback (tried in order, first success wins).

**pandoc (best output quality):**

| Platform | Command |
|----------|---------|
| macOS | `brew install pandoc` |
| Linux | `sudo apt install pandoc` / `sudo dnf install pandoc` |
| Windows | `winget install JohnMacFarlane.Pandoc` |
| Manual | [pandoc.org/installing.html](https://pandoc.org/installing.html) |

**Chrome headless:** no setup needed if Chrome is already installed.

**HTML fallback:** saves a styled `.html` file — open in any browser and print to PDF.

### Node.js + codeburn (token budget tracking)

`npx` (bundled with Node.js) runs [codeburn](https://github.com/getagentseal/codeburn) to measure actual Claude token spend. **codeburn is installed globally by `setup.sh`** and falls back to `npx --yes codeburn@latest` on first use. Node.js itself must be present.

| Platform | Command |
|----------|---------|
| macOS | `brew install node` or [nodejs.org](https://nodejs.org) |
| Linux | `curl -fsSL https://deb.nodesource.com/setup_lts.x \| sudo -E bash - && sudo apt install -y nodejs` |
| Windows | `winget install OpenJS.NodeJS.LTS` or [nodejs.org](https://nodejs.org) |

> If Node.js is not installed, budget tracking is silently skipped and the skill falls back to manual token estimation. No other functionality is affected.

### uvx (Jira MCP)

| Platform | Command |
|----------|---------|
| macOS / Linux | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Windows | `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 \| iex"` |

### ast-grep (optional — structural code search)

`ast-grep` (`sg`) enhances Step 5 code location with syntax-aware search — it matches Java class hierarchies, method calls, and overrides by AST structure rather than text, eliminating grep false positives from comments and string literals. The skill falls back to pure grep if `sg` is not installed.

| Platform | Command |
|----------|---------|
| macOS | `brew install ast-grep` |
| Linux / Windows WSL | `cargo install ast-grep` (requires Rust) or download a binary from [github.com/ast-grep/ast-grep/releases](https://github.com/ast-grep/ast-grep/releases) |

Verify: `sg --version`

### Git
The repository at `REPO_DIR` must be present locally. The skill creates branches there.

---

## Knowledge Base

Every session feeds into a **shared, persistent knowledge base** stored as plain Markdown files. The KB grows richer after every ticket — capturing business rules, root causes, recurring patterns, and regression risks.

### Storage modes

| Mode | Location | Distribution | Encryption |
|------|----------|-------------|------------|
| **local** (default) | `$HOME/.prevoyant/knowledge-base/` | None — private to one machine | None |
| **distributed** | Local clone of `PRX_KB_REPO` | Via git push/pull to your team's private repo | Optional AES-256-CBC |

**Local mode:** zero setup — the KB is created automatically on the first session.

**Distributed mode:** share the KB across your team via a private git repository you own.

```bash
# Set in your shell profile or .env:
export PRX_KB_MODE=distributed
export PRX_KB_REPO="git@github.com:myorg/team-kb.git"
# Optional — default is $HOME/.prevoyant/kb:
export PRX_KB_LOCAL_CLONE="$HOME/.prevoyant/kb"
```

The skill clones the repo and initialises the directory structure automatically on the first session.

**Optional encryption** (defense-in-depth — useful if company policy requires data encrypted at rest):
```bash
export PRX_KB_KEY="your-strong-secret-passphrase"
```
Never commit `PRX_KB_KEY`. Share it with teammates through a secure channel (1Password, secrets manager, etc.).

### KB structure

```
team-kb/
├── INDEX.md                        # Combined Memory Palace + Master Index
├── tickets/
│   ├── PROJ-1234.md                # Per-ticket session record
│   └── PROJ-1235.md
├── shared/                         # Accumulated team knowledge (ticket-driven)
│   ├── business-rules.md           # Domain invariants discovered across all tickets
│   ├── architecture.md             # Class hierarchies, data flows, ownership decisions
│   ├── patterns.md                 # Recurring bug/fix patterns with frequency counters
│   ├── regression-risks.md         # Known fragile areas requiring care on every change
│   ├── process-efficiency.md       # Bryan's session log: cost, budget status, changes applied
│   └── skill-changelog.md          # Full audit trail of every Bryan SKILL.md change (before/after, commit hash, revert status)
├── core-mental-map/                # Compressed, always-growing codebase model (codebase-driven)
│   ├── INDEX.md                    # Quick index: topics, entry counts, last-updated
│   ├── architecture.md             # System layers, component boundaries, key class relationships
│   ├── business-logic.md           # Core domain invariants and state machine rules
│   ├── data-flows.md               # Key data flows, RPC contracts, write paths
│   ├── tech-stack.md               # Technologies, frameworks, key library choices
│   └── gotchas.md                  # Non-obvious couplings, footguns, edge-case traps
├── personas/memory/                # Agent personal memory — grows with every session
│   ├── morgan/                     # One file per session: {YYYYMMDD-TICKET}.md
│   ├── alex/
│   ├── sam/
│   ├── jordan/
│   ├── henk/
│   ├── riley/
│   └── bryan/
└── lessons-learned/                # Per-developer sprint retrospective entries
    ├── alice.md                    # Developer's own lessons (pitfalls, hard-won insights)
    └── bob.md
```

In `KB_MODE=distributed` all files on disk are `.md.enc`; the plain `.md` files exist only in a temp working directory during the session.

`INDEX.md` holds two sections:
- **Memory Palace** — vivid trigger phrases mapped to system rooms; primary retrieval (≤ 3 reads regardless of KB size)
- **Master Index** — flat table greppable by ticket key, component, label, and trigger; fallback if Palace has no match

#### Folder purposes

| Folder | Driven by | What it contains |
|--------|-----------|-----------------|
| `shared/` | Tickets | Root causes, business rules, patterns, regression risks, process efficiency log |
| `core-mental-map/` | Codebase | Architecture, data flows, tech stack, gotchas (compressed facts) |
| `personas/memory/` | Sessions | Each agent's personal memory — observations, calibration, surprises — one file per session per agent |
| `lessons-learned/` | Developers | Per-person sprint retrospective entries: pitfalls and hard-won insights |

Every session starts by reading relevant `core-mental-map/` sections, all `lessons-learned/` files, and the last five personal memory files for each agent. Agents emit `[CMM+]` markers for codebase facts and `[LL+]` markers for lessons; both are written back to the KB at the end of every session. Each agent also writes a personal memory file (Step 13i) capturing what they observed, predicted, and got surprised by — so agents get sharper with every session they participate in.

### Lessons Learned

Each developer keeps a personal file at `lessons-learned/{name}.md`. Entries are written in two ways:

- **Manually** — after a sprint retrospective or investigation, append an entry directly to your file using the format below.
- **Automatically** — agents emit `[LL+]` markers during investigation; these are appended to the current developer's file at session end (Step 13h).

```markdown
## LL-001 — {short title}
date: 2026-04-14 | sprint: Sprint 42 | ticket: PROJ-1234
PITFALL: {the trap to avoid — specific and actionable}
KEY: {the corrective rule in one line}
ref: {file:line or "—"}
```

The developer identity is resolved from `$PRX_DEVELOPER_NAME` (if set) or `git config user.name`. Agents read all developer files at session start and surface matching entries in the Prior Knowledge block so future sessions know which pitfalls to avoid.

### Multi-developer usage

In distributed mode, the skill runs `git pull --rebase` before every push. `INDEX.md` is fully rebuilt from `tickets/*.md` and `shared/*.md` after every pull, eliminating merge conflicts. A `.gitattributes` union merge strategy is applied to all KB files so concurrent pushes are automatically reconciled.

---

## Automated Polling (optional)

`scripts/poll-jira.sh` polls Jira every hour for tickets assigned to you with status **To Do**, **Open**, **Parked**, or **Blocked**, and triggers Prevoyant automatically for any new ones.

### Credentials file

Copy and fill in `scripts/.jira-credentials.example`:
```bash
cp scripts/.jira-credentials.example scripts/.jira-credentials
chmod 600 scripts/.jira-credentials
```

```bash
# .jira-credentials
JIRA_URL="https://yourcompany.atlassian.net"
JIRA_USER="firstname.lastname@yourcompany.com"
JIRA_TOKEN="your-api-token-here"
```

### Schedule

**macOS — launchd:**
```bash
# Edit the plist — replace /Users/YOUR_USERNAME with your home path
cp scripts/com.prevoyant.poll-jira.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.prevoyant.poll-jira.plist
launchctl list | grep com.prevoyant.poll-jira
```

Enable **Power Nap** (System Settings → Battery → Options) so the job fires while the lid is closed.

**Linux — cron:**
```bash
crontab -e
# Add:
0 * * * * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus /bin/bash $HOME/prevoyant/scripts/poll-jira.sh
```

**Windows — Task Scheduler (WSL):**
1. Open Task Scheduler → Create Basic Task
2. Trigger: Daily, repeat every 1 hour
3. Action: Program = `wsl`, Arguments = `bash /home/<wsl-user>/prevoyant/scripts/poll-jira.sh`

### Headless mode

When triggered by the polling script, `AUTO_MODE=true` is set and all interactive confirmation gates are bypassed with safe defaults. Branch creation and file edits are skipped — the skill runs the full analysis and saves the PDF. The developer reviews the PDF and applies the fix manually.

### Test manually
```bash
bash scripts/poll-jira.sh
tail -20 scripts/poll-jira.log
```

---

## Prevoyant Server

An optional Node.js service that runs alongside the plugin as an always-on ambient agent. It receives Jira webhook events, queues tickets for analysis, spawns Claude, and surfaces live progress on a web dashboard — so tickets are processed automatically the moment they land in your queue, with no manual invocation needed.

**Key capabilities:** real-time webhook receiver · live pipeline dashboard · job queue with stop/kill · session persistence across restarts · automatic PDF report discovery

→ **[Full documentation: docs/prevoyant-server.md](docs/prevoyant-server.md)**

---

## What It Does — Step Reference

### Dev Mode (12 steps)

| Step | What happens |
|------|-------------|
| **0** | Initialise KB; pull latest if distributed; query by components/labels; present Prior Knowledge block |
| **1** | Fetch the Jira issue (13 fields: summary, type, priority, status, assignee, reporter, labels, components, versions, description, comments, attachments) |
| **2** | Analyse description + all linked tickets + attachments → problem statement, acceptance criteria, optional draw.io diagram |
| **3** | Read all comments → extract prior investigation findings, decisions, constraints |
| **4** | Create feature branch (`Feature/{TICKET_KEY}_{Title}`) from the correct base (fix version → affected version → `development`) |
| **5** | Locate affected code via grep-first/read-second approach → file map with confidence gate |
| **6** | Write numbered reproduction steps with prerequisites, expected vs actual, service restart guidance |
| **7** | Root cause analysis: **Engineering Panel** (bug) — Morgan chairs; Alex, Sam, Jordan investigate; Henk checks business necessity and client value (step 7h-ii); Riley assesses test coverage; scored verdict + Root Cause Statement. **Direct analysis** (enhancement) — Enhancement Statement |
| **8** | Propose fix anchored to Root Cause/Enhancement Statement; Morgan fix review (including Henk's client-value view); optional apply to branch |
| **9** | Impact analysis — usage reference search, layer-by-layer impact table, regression risks, retest checklist |
| **10** | Change summary — files touched, commit message, PR description template |
| **11** | Session stats — elapsed time, actual token usage and cost delta via codeburn (fallback: manual estimation) |
| **12** | Generate PDF report → save to `CLAUDE_REPORT_DIR`; email if `PRX_EMAIL_TO` is set |
| **13** | Write session record to KB; push if distributed |

### PR Review Mode (10 steps)

| Step | What happens |
|------|-------------|
| **R0** | KB initialise + query |
| **R1** | Fetch Jira ticket |
| **R2** | Full problem understanding including all linked tickets |
| **R3** | Read comments |
| **R4** | Locate feature branch (`Feature/{TICKET_KEY}_*`), run `git diff` to retrieve full changeset |
| **R5** | Engineering Panel code review — same team as Dev Mode; Alex (code quality), Sam (logic + acceptance criteria), Jordan (20-pattern defensive checklist), Henk (business rule alignment + client-value impact), Riley (test coverage); Morgan scores and delivers binding verdict |
| **R6** | Consolidated findings — Critical/Major/Minor issues with `file:line`, fix recommendations, Positives, Conditions for Approval |
| **R7** | Session stats — same as Step 11 (codeburn actual data, fallback: estimation) |
| **R8** | PDF review report |
| **R9** | Update KB with review findings; push if distributed |

**Review verdict:** ✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT

### Estimate Mode (9 steps)

Story points = **Complexity + Risk + Repetition** (not hours). Scale: 1 · 2 · 3 · 5 · 8 · 13 · 20 · ? Each engineer votes through their domain lens, explicitly citing KB and system knowledge.

| Step | What happens |
|------|-------------|
| **E0** | KB & system knowledge load — pull KB; each engineer reads `core-mental-map/` (architecture, gotchas, data-flows), `shared/patterns.md` `[ESTIMATE-PATTERN]` entries, past ticket `## Estimation` records, and `lessons-learned/` for the affected components |
| **E1** | Ingest ticket — fetch all Jira fields and acceptance criteria; surface existing story points as context only (no anchoring) |
| **E2** | Scope & dimension analysis — Engineering Panel jointly maps work areas and rates Complexity / Risk / Repetition with KB evidence; spike gate (critical unknowns) and split gate (4+ high-effort areas) applied before voting |
| **E3** | Planning Poker Round 1 — simultaneous vote on 1·2·3·5·8·13·20·?; each panel member scores all three dimensions through their domain lens (Morgan: architecture; Alex: backend; Sam: business logic; Jordan: infra/security; Henk: business rules and client workflows; Riley: testing) citing specific KB entries |
| **E4** | Debate & consensus — rounds anchored to dimensions: highest voter names which dimension is underweighted and cites system evidence; lowest responds with counter-evidence; others react and re-vote; up to 3 rounds |
| **E5** | Final estimate — story points, dimension summary (C/R/R), confidence (High/Medium/Low), key assumptions, what would change the estimate |
| **E6** | KB update — records estimate with full dimension breakdown in `tickets/{KEY}.md`; appends `[ESTIMATE-PATTERN]` to `shared/patterns.md` if a reusable complexity insight was found |
| **E7** | Bryan's retrospective — audits whether votes were grounded in KB evidence or gut feel; proposes estimation workflow improvements (opt-in) |

---

## Repository Structure

```
.
├── .claude-plugin/
│   └── marketplace.json          # Claude Code marketplace descriptor
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json           # Plugin metadata (name, version, author)
│   ├── package.json
│   ├── config/
│   │   ├── kb-schema.json        # KB layer config and schema version sentinel
│   │   └── personas/             # Agent persona definitions — one file per team member
│   │       ├── morgan.md         # Lead Developer: voice, reasoning style, priorities, relationships
│   │       ├── alex.md           # Senior Engineer 1: code archaeology & regression forensics
│   │       ├── sam.md            # Senior Engineer 2: runtime data flow & logic tracing
│   │       ├── jordan.md         # Senior Engineer 3: defensive patterns & structural anti-patterns
│   │       ├── henk.md           # Technical Lead: business rules & client-value authority
│   │       ├── riley.md          # Senior Lead Tester: regression risk & testability
│   │       ├── bryan.md          # Scrum Master: token audit & process retrospective
│   │       └── _memory-template.md  # Template for session memory files
│   └── skills/dev/
│       └── SKILL.md              # All skill logic lives here
├── server/                       # Prevoyant Server — optional ambient agent (see docs/prevoyant-server.md)
│   ├── index.js                  # Express app entry point
│   ├── dashboard/                # Dashboard routes, ticket tracker, pipeline stage definitions
│   ├── kb/                       # KB query, sync, and cache layer
│   │   ├── kbCache.js            # In-memory KB cache (invalidated on sync)
│   │   ├── kbQuery.js            # Semantic KB query with indexed memory retrieval
│   │   └── kbSync.js             # Real-time KB sync core (Redis doorbell + Git)
│   ├── memory/                   # Indexed agent memory — dual-backend (JSON + Redis)
│   │   ├── memoryAdapter.js      # Unified adapter: Redis primary, JSON fallback
│   │   ├── redisMemory.js        # Redis backend (PRX_REDIS_ENABLED)
│   │   └── jsonMemory.js         # JSON backend (PRX_MEMORY_INDEX_ENABLED)
│   ├── queue/                    # FIFO job queue (one Claude session at a time)
│   ├── runner/                   # Claude CLI spawner + poll scheduler
│   ├── watchers/                 # Ticket watcher coordination
│   │   ├── watchManager.js       # Coordinates add/stop/resume across worker + routes
│   │   └── watchStore.js         # CRUD on ~/.prevoyant/server/watched-tickets.json
│   ├── webhooks/                 # Jira webhook receiver
│   ├── workers/                  # Background worker threads
│   │   ├── diskMonitor.js        # Disk space tracking and alerts
│   │   ├── healthMonitor.js      # Watchdog: polls /health, emails on DOWN/UP
│   │   ├── kbSyncWorker.js       # KB sync worker: Redis XREAD poll loop
│   │   ├── ticketWatcherWorker.js # Jira ticket watcher: scheduled digest polls
│   │   └── updateChecker.js      # Checks GitHub for plugin updates
│   └── scripts/
│       ├── start.sh              # Start server in background (macOS / Linux)
│       ├── stop.sh               # Stop server by PID (macOS / Linux)
│       ├── start.ps1             # Start server in background (Windows — PowerShell)
│       ├── stop.ps1              # Stop server by PID (Windows — PowerShell)
│       ├── start.cmd             # Start server (Windows — CMD / double-click wrapper)
│       └── stop.cmd              # Stop server (Windows — CMD / double-click wrapper)
├── docs/
│   └── prevoyant-server.md       # Full Prevoyant Server documentation
├── scripts/
│   ├── setup.sh                  # One-shot prerequisite installer (macOS / Linux / WSL / Git Bash)
│   ├── setup.ps1                 # One-shot prerequisite installer (Windows — PowerShell)
│   ├── setup.cmd                 # One-shot prerequisite installer (Windows — CMD / double-click)
│   ├── check-budget.sh           # SessionStart hook: codeburn monthly budget check + session baseline capture
│   ├── poll-jira.sh              # Jira polling script (macOS / Linux / Windows WSL)
│   ├── com.prevoyant.poll-jira.plist  # macOS launchd schedule template
│   ├── .jira-credentials.example # Credentials template
│   └── send-report.py            # Email delivery helper
├── .claude/
│   ├── settings.json             # Shared SessionStart hooks (committed — loaded by all developers)
│   └── settings.local.json       # Per-machine Claude Code permissions (gitignored — generated by setup script)
├── .mcp.json                     # Jira MCP server config (committed — no credentials, just the command)
├── .mcp.json.example             # MCP server config template
├── .env.example                  # Environment variable template
└── README.md
```

All skill logic lives in `plugin/skills/dev/SKILL.md`. No compiled code, no runtime dependencies beyond what Claude Code provides.

> **Jira MCP:** `.mcp.json` is committed to this repo and already configured. It tells Claude Code to run `uvx mcp-atlassian`. You never need to edit it — credentials come from `.env` automatically.

> **Settings:** `.claude/settings.json` (committed) holds the shared `SessionStart` hooks that load `.env` and check the monthly budget — every developer gets these automatically on clone. `.claude/settings.local.json` (gitignored) holds per-machine permission approvals generated by the setup script. Any `Bash` permission entries referencing `SKILL.md` should use the relative path `plugin/skills/dev/SKILL.md` — not an absolute path — so the config works on any machine.

---

## Contributing

### Make changes

All skill logic is in one file:
```
plugin/skills/dev/SKILL.md
```

Edit this file to modify workflow steps, prompts, or project context.

### SKILL.md change history

Every change Bryan approves and pushes is recorded in two places:

| Where | What it contains |
|-------|-----------------|
| `## Skill Change Log` table at the top of `SKILL.md` | One row per change: SC#, version, date, git commit hash, type, summary, status — visible to anyone reading the file |
| `shared/skill-changelog.md` in the KB | Full detail: verbatim before/after wording, backlog ref, voter record, and revert status |

To **revert a Bryan change** that caused a regression:
```bash
# 1. Find the commit hash in the Skill Change Log table or skill-changelog.md
git log --oneline | grep "Bryan SC-"

# 2. Safe revert — creates a new commit, no history rewrite
git revert <COMMIT_HASH>
git push origin main
```
Then append `[REVERTED: {date} — revert-commit: {hash} — reason: ...]` to the matching `[SC-NNN]` entry in `skill-changelog.md`.

### Bump the version

When making a change, increment the version in **all three** files:

| File | Field |
|------|-------|
| `plugin/.claude-plugin/plugin.json` | `"version"` |
| `plugin/package.json` | `"version"` |
| `.claude-plugin/marketplace.json` | `"version"` inside the `plugins` array |

Follow [semantic versioning](https://semver.org): PATCH (bug fix), MINOR (new feature), MAJOR (breaking change).

### Commit and push

```bash
git add .
git commit -m "vX.Y.Z — short description"
git push origin main
```

### Update the plugin

After pushing, update your local installation:
```bash
claude plugin update prevoyant@dodogeny
```

> Do **not** run `git pull` directly inside `~/.claude/plugins/marketplaces/dodogeny` — Claude Code manages that directory.

---

## Upgrading

```bash
# If registered with a local path:
git -C ~/.claude/plugins/marketplaces/dodogeny pull
claude plugin update prevoyant@dodogeny

# If registered with the hosted Git URL:
claude plugin update prevoyant@dodogeny

# Verify:
claude plugin list
```

> **Your `.env` is safe.** It is gitignored and never touched by `git pull` or `claude plugin update`. If you re-run `scripts/setup.sh` after upgrading, it automatically backs up your `.env` to `.env.bak` before skipping it.

> **Pull fails with "untracked file: .claude/settings.local.json"?**
> This file is per-machine and is no longer tracked in the repo (gitignored since v1.2.2). Remove it, pull, then let the setup script recreate it:
> ```bash
> INSTALL=~/.claude/plugins/marketplaces/dodogeny
> rm "$INSTALL/.claude/settings.local.json"
> git -C "$INSTALL" pull
> bash "$INSTALL/scripts/setup.sh"   # recreates settings.local.json
> ```

---

## Uninstalling

### 0. Back up your Knowledge Base (recommended)

The KB accumulates root causes, patterns, regression risks, and lessons learned across every ticket. Back it up before uninstalling if you may want to restore it later.

**Local mode** (default — KB at `~/.prevoyant/knowledge-base/` or `$PRX_KNOWLEDGE_DIR`):

```bash
# macOS / Linux — creates a timestamped archive in your home directory
KB_DIR="${PRX_KNOWLEDGE_DIR:-$HOME/.prevoyant/knowledge-base}"
tar -czf "$HOME/prevoyant-kb-backup-$(date +%Y%m%d).tar.gz" -C "$(dirname "$KB_DIR")" "$(basename "$KB_DIR")"
echo "Backup saved to: $HOME/prevoyant-kb-backup-$(date +%Y%m%d).tar.gz"
```

```powershell
# Windows (PowerShell)
$KBDir = if ($env:PRX_KNOWLEDGE_DIR) { $env:PRX_KNOWLEDGE_DIR } else { "$env:USERPROFILE\.prevoyant\knowledge-base" }
$Archive = "$env:USERPROFILE\prevoyant-kb-backup-$(Get-Date -Format yyyyMMdd).zip"
Compress-Archive -Path $KBDir -DestinationPath $Archive
Write-Host "Backup saved to: $Archive"
```

**Distributed mode** (KB is already in your private git repo — just confirm the remote is up to date):

```bash
git -C "${PRX_KB_LOCAL_CLONE:-$HOME/.prevoyant/kb}" push
echo "KB is safely stored in your remote repo."
```

**To restore later**, reinstall the plugin (Quick Start steps 1–3), then:

```bash
# Local mode — extract into the KB directory
tar -xzf ~/prevoyant-kb-backup-YYYYMMDD.tar.gz -C ~/.prevoyant/

# Distributed mode — set PRX_KB_REPO in .env; the skill clones it automatically on first run
```

---

### 1. Disable and remove the plugin

```bash
claude plugin disable prevoyant@dodogeny
claude plugin uninstall prevoyant@dodogeny
```

### 2. Remove the marketplace registration

**macOS / Linux:**
```bash
python3 - <<'EOF'
import json, os
path = os.path.expanduser("~/.claude/settings.json")
if not os.path.exists(path):
    print("settings.json not found — nothing to do")
else:
    with open(path) as f:
        s = json.load(f)
    s.get("extraKnownMarketplaces", {}).pop("dodogeny", None)
    with open(path, "w") as f:
        json.dump(s, f, indent=2)
        f.write("\n")
    print("dodogeny removed from settings.json")
EOF
```

**Windows (PowerShell):**
```powershell
$path = "$env:USERPROFILE\.claude\settings.json"
if (Test-Path $path) {
    $s = Get-Content $path -Raw | ConvertFrom-Json
    if ($s.extraKnownMarketplaces.PSObject.Properties['dodogeny']) {
        $s.extraKnownMarketplaces.PSObject.Properties.Remove('dodogeny')
        $s | ConvertTo-Json -Depth 10 | Set-Content $path -Encoding UTF8
        Write-Host "dodogeny removed from settings.json"
    }
} else { Write-Host "settings.json not found — nothing to do" }
```

### 3. Remove the cloned repository (if installed locally)

```bash
rm -rf ~/.claude/plugins/marketplaces/dodogeny
```

**Windows:**
```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.claude\plugins\marketplaces\dodogeny"
```

### 4. Remove local data (optional)

The plugin never writes data outside its own directory and the KB location you configured. If you want a full clean:

```bash
# Knowledge base (local mode default)
rm -rf ~/.prevoyant

# PDF / HTML reports
rm -rf ~/.prevoyant/reports   # or the path set in CLAUDE_REPORT_DIR
```

> `.env` and `.claude/settings.local.json` inside the repo directory are also removed when you delete the repository in step 3.

---

## Changelog

### v1.2.8 — Ticket Watcher

- **Jira ticket monitoring with AI digests:** A new background worker (`server/workers/ticketWatcherWorker.js`) polls any Jira ticket on a configurable schedule (every hour, day, 2 days, or 5 days). On each poll it builds a structured four-step Watch Mode prompt (W0–W3: KB Query → Fetch Ticket → Progress Analysis → Digest Output) and invokes the Claude CLI with the configured Jira MCP — no direct API calls for the analysis itself. Claude fetches all ticket details and comments, then produces a structured digest: **Ticket Summary**, **Progress Assessment**, **Blockers & Concerns**, **What Should Happen Next**, and an **Overall Verdict** (ON TRACK / NEEDS ATTENTION / BLOCKED / STALLED). The digest is emailed via the existing SMTP stack. Zero new npm dependencies.

- **Jira change detection — skip unchanged polls:** Before invoking Claude, the worker makes a lightweight Jira REST call to fetch a snapshot of the ticket (`updated`, `commentCount`, `lastCommentUpdated`, `status`) and hashes it. If the hash matches the previous poll's snapshot, the Claude invocation is skipped entirely (no email sent, no tokens consumed). Claude only runs when the ticket has actually changed. The snapshot hash is persisted per-ticket so skips survive server restarts.

- **Poll log files:** Every poll (whether Claude ran or was skipped) writes a timestamped log to `~/.prevoyant/watch/logs/{TICKET_KEY}/`. The live log tail is streamed to the Watch dashboard in real time while a poll is in flight. Log retention is controlled by `PRX_WATCH_LOG_KEEP_DAYS` (default 30 days) and `PRX_WATCH_LOG_KEEP_PER_TICKET` (default 10 files per ticket); cleanup runs from the Disk Monitor page.

- **Dedicated Watch page** (`/dashboard/watch`): Add tickets with a key + interval + optional max-poll-count form. The table shows live status, poll counts, last/next poll times, and a truncated digest preview. Per-ticket actions: **Poll now** (immediate on-demand digest + email), **Stop**, **Resume** (restores a stopped ticket to active watching), and **Remove**.

- **Live progress panel:** While a poll is running, a blue in-progress card appears at the top of the Watch page showing which ticket is being processed and a real-time step log as Claude announces each stage. The page polls `/dashboard/watch/json` every 3 seconds and patches the table (status badges, poll counts, timestamps, blinking eye) without a full reload.

- **Animated eye icon on watching tickets:** Active tickets show a blinking eye SVG animation, making it immediately obvious which tickets are under active surveillance.

- **Survives restarts:** Watched tickets, their poll history, and snapshot hashes are persisted to `~/.prevoyant/server/watched-tickets.json`. The worker reattaches all active watches automatically on server start.

- **New config keys** (all editable in Settings → Ticket Watcher): `PRX_WATCH_ENABLED` (Y/N), `PRX_WATCH_POLL_INTERVAL` (default interval), `PRX_WATCH_MAX_POLLS` (default max polls, 0 = unlimited), `PRX_WATCH_LOG_KEEP_DAYS` (log file retention in days), `PRX_WATCH_LOG_KEEP_PER_TICKET` (max log files per ticket). Worker starts/stops reactively when the setting is toggled — no restart required.

### v1.2.7 — Indexed Agent Memory + Real-time KB Sync

- **Indexed agent memory with dual-backend support:** Each completed session is indexed (ticket key, summary, key findings, cost, timestamp) into a local JSON file at `~/.prevoyant/memory/index.json` and optionally into Redis. At session start, the server pre-loads the most relevant prior-session entries and injects them into the agent's context — replacing a full KB scan with a targeted lookup. This achieves a ~96% token reduction on the prior-knowledge retrieval step while keeping agents grounded in past work. The memory backend is selected via `PRX_MEMORY_INDEX_ENABLED` (JSON, default Y) and `PRX_REDIS_ENABLED` (Redis, takes priority when enabled). Both are written simultaneously when Redis is active so the JSON index stays warm as a hot-standby.

- **Live KB propagation across machines:** When a session completes on any machine, `server/kb/kbSync.js` does a `git push` (KB files travel to the private repo) then posts a ~100-byte notification to an [Upstash Redis](https://upstash.com/) stream — just `{ machine, ticket, commit }`. Every other connected machine is polling `XREAD` every 10 seconds (configurable); on a new notification it immediately does `git pull --rebase` and invalidates its local KB cache. Idle machines stay in sync between sessions so Step 0 KB queries always reflect the latest state. **No KB content ever touches Redis** — the stream is the doorbell, Git is the mail carrier.

- **Dual sync trigger modes:** `PRX_KB_SYNC_TRIGGER=session` (default) pushes after each session completes. `PRX_KB_SYNC_TRIGGER=filesystem` watches the KB directory for file changes and syncs immediately (useful when KB files are edited directly). `PRX_KB_SYNC_TRIGGER=both` enables both. A debounce (`PRX_KB_SYNC_DEBOUNCE_SECS`, default 3 s) prevents rapid-fire pushes on bulk writes.

- **Zero new npm dependencies:** The Upstash REST API is called with Node's built-in `https` module. A worker thread (`workers/kbSyncWorker.js`) runs the poll loop without blocking the main server process, following the same pattern as the existing health and disk monitors.

- **New config fields (all under `KNOWLEDGE BASE` in `.env`):** `PRX_REALTIME_KB_SYNC` (Y/N, default N), `PRX_UPSTASH_REDIS_URL`, `PRX_UPSTASH_REDIS_TOKEN`, `PRX_KB_SYNC_MACHINE` (hostname override), `PRX_KB_SYNC_POLL_SECS` (default 10), `PRX_KB_SYNC_TRIGGER` (`session` | `filesystem` | `both`), `PRX_KB_SYNC_DEBOUNCE_SECS` (default 3). All fields are also editable from the dashboard Settings page. Free tier on Upstash is more than sufficient.

### v1.2.6 — Henk, Agent Personas & Personal Memory

- **Henk — Technical Lead:** A seventh panel member has joined the Engineering Panel. Henk is a long-tenured system expert with encyclopedic knowledge of business rules and client workflows. Attentive to detail and drawing on years of first-hand system experience, Henk's role is to assess whether a fix is genuinely necessary and whether it delivers real value to existing clients — not all bugs need fixing, and not all fixes are client-safe. Morgan consults Henk at two key moments: **Step 7h-ii** (after the verdict — is the root cause a genuine defect and does fixing it bring client value?) and **Step 8c** (fix review — does the proposed change align with business rules and preserve client behaviour?). Henk is non-competing; he participates in all three modes (Dev, PR Review, Estimate) with a business-rule and client-impact lens.

- **Agent persona definitions:** Seven persona files — one per team member — live in `plugin/config/personas/`. Each file defines the agent's voice and communication style, reasoning approach, priorities, and relationships with other team members. Personas are static, developer-editable documents: any team member can open a persona file and refine it to better reflect how the agent should think and speak. Because each agent has a separate file, concurrent edits by different developers never produce merge conflicts. Agents read their persona at session start (Step 0b Layer 5) so their character and reasoning style are grounded before any analysis begins.

- **Agent personal memory:** Each agent now accumulates a personal memory that grows smarter with every session. At the end of every session (Step 13i), each participating agent writes a structured memory file to `{KB_WORK_DIR}/personas/memory/{agent}/{YYYYMMDD-TICKET}.md` capturing: what they observed, what predictions they made and whether they were right, what surprised them, and short-lived notes for the next session. At the start of each new session (Step 0b Layer 5), agents read their last five memory files and internalise the accumulated context before engaging — so an agent with 30 sessions behind them arrives knowing which areas of the codebase surprised them before, which patterns they tend to over-fit, and what they got right and wrong. **Conflict-free in distributed mode:** each session creates a uniquely named file (timestamp + ticket key), so concurrent sessions from different developers always produce new, non-overlapping files that git auto-merges without conflict.

- **Prior Knowledge block extended:** The session Prior Knowledge block (Step 0b) now includes an `AGENT PERSONAS & PERSONAL MEMORY` section summarising each agent's session count, last ticket, and most relevant personal insight for the current ticket.

- **KB directory structure:** `personas/memory/` subdirectories are initialised alongside all other KB directories on first run — in local mode, distributed mode, and the encrypted temp-dir path. All `mkdir -p` commands updated across every init path.

### v1.2.5 — Update Checker, Windows Server Scripts, Plugin Rename

- **Automatic update checker:** A new background thread (`workers/updateChecker.js`) polls the GitHub repository at random intervals between **6 and 24 hours** to detect when a new plugin version is available. When a newer version is found, a yellow banner appears at the top of the dashboard showing the current vs latest version, a "View changes" link to GitHub releases, and an **Upgrade now** button. Clicking Upgrade runs `git pull --ff-only` in the repo root then automatically restarts the server — the button gives live feedback and the page reloads when the restart completes. A one-time email notification is also sent per new version (using the configured SMTP credentials). No new env vars required — runs automatically on every server start.
- **Windows server scripts:** New start/stop scripts for running prevoyant-server on Windows. Use `server\scripts\start.cmd` / `stop.cmd` from Command Prompt (or double-click in Explorer), or `server\scripts\start.ps1` / `stop.ps1` from PowerShell directly. Mirrors the same PID-file approach as the existing macOS/Linux `start.sh` / `stop.sh` — checks for a stale PID, installs npm deps if missing, runs `node index.js` in the background, and writes `.server.pid`. The dashboard's **Upgrade now** flow is also platform-aware and uses the PowerShell scripts on Windows.
- **Plugin rename:** Plugin identifier and skill prefix changed from `prevoyant-claude-plugin` to `prevoyant`. Install command is now `claude plugin install prevoyant@dodogeny`; skills are invoked as `/prevoyant:dev`, `/prevoyant:dev review`, `/prevoyant:dev estimate`. The npm `package.json` name (`prevoyant-claude-plugin`) is unchanged as it is not the Claude Code identifier.
- **Mid-job budget & billing monitoring:** While a ticket is being processed, a background check runs every 60 seconds comparing month-to-date spend (via codeburn) against `PRX_MONTHLY_BUDGET`. If the limit is reached the job is stopped automatically. Additionally, Anthropic billing errors in the process output (e.g. "credit balance is too low") are detected and trigger an immediate stop. Both cases are reflected in the dashboard without a page reload.
- **Interruption reason on dashboard:** Every interrupted job now shows a coloured banner on its detail page explaining why it was stopped — **budget exceeded** (red), **account balance too low** (red), **server restarted** (blue), or **stopped manually** (orange). The reason is persisted to disk and shown on the initial page load as well as surfaced live via the polling loop when a running job is interrupted.
- **codeburn migration:** Replaced `ccusage` with `codeburn` for all token cost tracking — session snapshots, dashboard budget cards, and the `SessionStart` hook. The `setup.sh` script installs codeburn globally on first run.

### v1.2.4 — Scheduling, Notifications, Queue Priority, Auto-retry, KB Backup/Import, Activity Tracker, Health Monitor, Disk Monitor

- **Scheduled ticket processing:** When adding a ticket via the dashboard, optionally set a future date/time for processing. Scheduled jobs survive server restarts — the schedule is persisted to disk and re-armed automatically on startup. Missed schedules are marked `interrupted` rather than silently dropped.
- **Delete ticket:** Each ticket row now has a delete button. A confirmation dialog warns that all ticket information will be permanently removed before proceeding.
- **"Next Scan" info strip:** The dashboard header now shows the exact date/time the next scheduled poll will run (previously showed time since last startup, which was not actionable).
- **Queue priority:** Tickets can be flagged as **Urgent** at submission time (inserted at the front of the queue). Any queued ticket can also be promoted to the front via a **Prioritise** button on its row. A priority badge distinguishes urgent jobs visually.
- **Auto-retry on failure:** Failed jobs are automatically retried up to `PRX_RETRY_MAX` times with exponential backoff (`PRX_RETRY_BACKOFF` seconds base, doubling each attempt). Retry countdown is shown on the ticket row. Retries can be cancelled via the existing stop button. Both settings are configurable in the Automation section of Settings.
- **Notifications settings section:** New Settings section to configure email alerts. Requires `PRX_EMAIL_TO` to be set. Options include:
  - **Level:** Full (all events), Compact (one summary email per job), Urgent (issues and decision prompts only), Mute (disabled)
  - **Mute for N days:** Temporarily suppress all notifications for a set number of days
  - **Event checkboxes:** 18 granular events across 5 groups — Jira (ticket created, updated, assigned to me), Job Lifecycle (queued, started, completed, failed, retrying, stopped, scheduled), Pipeline Dev stages (R&CA, Propose Fix, Impact Analysis, PDF Report), Pipeline Review stages (Panel Review, PDF Report), Pipeline Estimate stages (Planning Poker, KB Update)
- **Webhook & Polling section rename:** The "Webhook Server" settings section is now "Webhook & Polling" with a clearer description of the poll interval field and its fallback role.
- **KB Backup & Export:** Settings page now shows knowledge base file counts and a **Download Backup** button that streams a `.tar.gz` archive of the entire `~/.prevoyant/` directory.
- **KB Import:** Upload a `.tar.gz` backup directly from the dashboard. Existing files are never overwritten — only new files are extracted. Partial success (some files kept) is reported separately from a full failure.
- **Health Monitor (Watchdog):** An optional in-process background thread (`workers/healthMonitor.js`) that polls `GET /health` on a configurable interval and sends an urgent email alert when the server stops responding. Enabled via `PRX_WATCHDOG_ENABLED=Y` in Settings › Health Monitor. Configurable check interval (`PRX_WATCHDOG_INTERVAL_SECS`, default 60 s) and consecutive-failure threshold before alerting (`PRX_WATCHDOG_FAIL_THRESHOLD`, default 3). Sends a recovery email when the server comes back up. Planned shutdowns via `stop.sh`, dashboard restart, or `SIGTERM`/`SIGINT` send a graceful-stop signal to the thread so no false DOWN alert is fired. Uses the SMTP credentials already configured in Email Delivery — no extra dependencies. Note: as an in-process thread it shares the process lifecycle; a hard OS kill (`SIGKILL` / OOM) cannot be caught by any in-process solution.
- **Activity Tracker:** New page at `/dashboard/activity` (accessible via the Activity link in the dashboard header). Records every significant server event across 19 event types: ticket lifecycle (queued, started, completed, failed, interrupted, retrying, scheduled, deleted, prioritized, re-run), pipeline stage transitions, Jira webhook events (received or skipped with reason), Jira poll runs (`poll_triggered` with trigger label), server starts, settings saves, and KB export/import. Each event captures timestamp, event type, ticket key, actor (system/user/jira), and structured details. Three live Chart.js graphs show events per hour/day/month (toggled), tickets processed over 30 days, and token cost (USD) over 30 days. Filterable table by event type (all 19 types always shown regardless of history), ticket key, actor, and date range. History is persisted to `~/.prevoyant/server/activity-log.json` (within the server-specific subfolder) and survives server restarts with no data loss. Legacy `activity-log.json` at the old path is auto-migrated on first start.
- **Disk Monitor:** An optional in-process background thread (`workers/diskMonitor.js`) that tracks the total size of `~/.prevoyant/` against a configurable size quota (`PRX_PREVOYANT_MAX_SIZE_MB`, default 500 MB). Enabled via `PRX_DISK_MONITOR_ENABLED=Y` in Settings › Disk Monitor. Configurable check interval (`PRX_DISK_MONITOR_INTERVAL_MINS`, default 60) and cleanup interval (`PRX_DISK_CLEANUP_INTERVAL_DAYS`, default 7 days). An alert fires when the folder reaches `PRX_DISK_CAPACITY_ALERT_PCT`% of the quota (default 80%, so at 400 MB of a 500 MB quota), giving early warning before the hard limit is hit (4-hour cooldown between repeated alerts). Overall machine disk capacity is still shown on the page for reference but does not drive alerting. When the cleanup interval elapses, a pending-cleanup notification appears on the **Disk Monitor page** (`/dashboard/disk`) — a dashboard **Approve Cleanup** button must be clicked before any files are deleted (no automatic deletion). An additional **Run Cleanup Now** button is always visible for on-demand house-cleaning. Cleanup removes session directories older than 30 days and trims `disk-log.json` and `activity-log.json` to their most recent entries. The page shows a `.prevoyant Quota` progress bar (MB used vs. quota), a two-column table of what will be cleaned vs. what is permanently protected (knowledge base files, reports, `.env`, recent sessions). Knowledge base files are safeguarded at the route level — the resolved KB path is checked before any deletion. History of snapshots is persisted to `~/.prevoyant/server/disk-log.json` (up to 720 entries, ~30 days at hourly checks) and `~/.prevoyant/server/disk-status.json`. A usage-over-time chart (Chart.js) shows `.prevoyant` folder size and overall disk utilisation. A Disk icon in the dashboard header nav turns orange when cleanup is pending.
- **Claude Budget Tracker:** The dashboard shows real-time Claude API spend against the configured monthly budget (`PRX_MONTHLY_BUDGET`). Cost is calculated from local token counts via codeburn (labelled "codeburn calc'd"). Token breakdown (input / cache-read / cache-write / output tokens) is shown in the budget card for transparency. Displayed in two places: a **Budget item in the info strip** (colour-coded remaining) and a **Budget card** in the cards row with progress bar and per-token breakdown. Cache is 2 minutes; saving settings immediately busts the cache.

### v1.2.3 — Prevoyant Server (Ambient Agent) + Path Rebranding

- **Prevoyant Server:** New optional Node.js server (`server/`) that runs as an always-on ambient agent alongside the Claude Code plugin. Start with `cd server && npm install && npm start`. Provides two capabilities:
  - **Real-time webhooks:** Registers with Jira as a webhook receiver (`POST /jira-events?token=WEBHOOK_SECRET`) and triggers `poll-jira.sh` analysis immediately when a ticket event arrives — no polling delay.
  - **Scheduled polling fallback:** Runs `poll-jira.sh` on a configurable day interval (`WEBHOOK_POLL_INTERVAL_DAYS`) as a fallback when webhooks are unavailable.
- **Stats dashboard:** Built-in web dashboard at `http://localhost:3000/dashboard` showing which Jira tickets have been processed, their current status (queued / running / completed / failed), processing duration, and exact disk locations of generated PDF/HTML reports. Auto-refreshes every 30 seconds. JSON API available at `/dashboard/json`.
- **Health endpoint:** `GET /health` returns server status and timestamp for monitoring integrations.
- **Path rebranding:** All default paths changed from `~/.dev-skill/` to `~/.prevoyant/` — knowledge base, KB clone, reports directory, and temp session dirs. Existing installations continue to work via the `PRX_KNOWLEDGE_DIR` / `PRX_KB_LOCAL_CLONE` / `CLAUDE_REPORT_DIR` env vars if you have data you want to preserve at the old paths.
- **launchd plist renamed:** `scripts/com.dev-skill.poll-jira.plist` → `scripts/com.prevoyant.poll-jira.plist` to match the new namespace.

### v1.2.2 — Token Budget Tracking + Estimate Mode

- **Estimate Mode:** New third mode (`/prevoyant:dev estimate PROJ-1234`) where the Engineering Panel runs Planning Poker using the Asana story points methodology — effort measured as **Complexity + Risk + Repetition**, not hours, on a modified Fibonacci scale (1·2·3·5·8·13·20·?). Before voting, each engineer loads the KB (`core-mental-map/`, `patterns.md`, `gotchas.md`, past ticket estimates, lessons learned) so votes are grounded in acquired system knowledge, not gut feel. All five engineers vote simultaneously, then debate is structured by dimension (which of the three factors is causing disagreement?) rather than just "your number is too high." Up to 3 rounds; Morgan makes a binding final call if still split. Confidence level (High/Medium/Low) reflects how many rounds were needed. Agreed points are recorded in the KB as `[ESTIMATE-PATTERN]` entries for future sessions.
- **codeburn integration:** Actual Claude token spend is now measured using [codeburn](https://www.npmjs.com/package/codeburn), which reads Claude Code's local JSONL files offline — no network call, no auth required. codeburn is downloaded automatically via `npx --yes` on first use; Node.js is installed automatically if not present (Homebrew → nvm on macOS, apt/dnf → nvm on Linux).
- **SessionStart budget check:** `scripts/check-budget.sh` runs at every session start. It captures a daily-spend baseline to `/tmp/.prx-session-start-spend` (used by Step 11 for per-session delta) and injects the current month's actual spend and budget status into Claude's session context. A system-level warning is surfaced when spend ≥ 80%.
- **Step 11 / R7 / E7 — actual costs:** Instead of estimating tokens from content volume, Claude now runs `npx codeburn@latest report --format json` and subtracts the session-start baseline to report the exact cost of the current session. Manual estimation is retained as a fallback when Node.js is unavailable.
- **Step 14 / R10 / E7 (Bryan) — realtime token stats via codeburn:** Bryan runs `npx codeburn@latest report --format json` (month-to-date spend and session delta against the check-budget.sh baseline) to get authoritative figures from Claude Code's local JSONL logs — no network call, no auth. Monthly spend replaces the manual `process-efficiency.md` sum; session cost feeds the per-ticket rolling average used for TOKEN_ALERT and BUDGET_ALERT detection. Falls back to Step 11 figures and the manual sum if codeburn is unavailable.
- **Bryan — token intervention:** Bryan now records each ticket's cost against the 5-session rolling average. When a session costs > 150% of the rolling average (**TOKEN_ALERT**) or monthly spend exceeds 80% of `PRX_MONTHLY_BUDGET` (**BUDGET_ALERT**), Bryan escalates from the normal single-change proposal to **Intervention Mode**: identifies the top 3 most expensive steps, proposes a targeted SKILL.md reduction for each with dollar-savings estimates, and presents them as a ranked set for team consensus. BUDGET_ALERT additionally projects how many sessions remain before the monthly limit is breached at the current burn rate.
- **Developer confirmation gate:** Before Bryan applies any approved SKILL.md change (Step 14c) or compaction pass (Step 14d), an interactive confirmation box shows the exact before/after wording, problem solved, process impact, and estimated token saving. The developer must explicitly confirm before any file is modified. Skipped automatically in `AUTO_MODE=Y`.
- **Permissions:** `Bash(npx --yes codeburn@latest *)` added to `.claude/settings.local.json` allowlist so the budget check runs without prompts.
- **Setup scripts:** `scripts/setup.sh` (macOS / Linux / WSL / Git Bash) and `scripts/setup.ps1` (Windows PowerShell) auto-detect the OS and install all prerequisites in one pass — `uvx`, Node.js, pandoc, `.env` copy, and `~/.claude/settings.json` marketplace registration. `scripts/setup.cmd` provides a double-click launcher for Windows CMD users. Installation cascades through available package managers (Homebrew → nvm on macOS; apt → dnf → nvm on Linux; winget → Chocolatey → Scoop on Windows) with graceful fallback and platform-specific manual instructions on failure.

### v1.2.1

- **Core Mental Map:** New `core-mental-map/` KB folder — a compressed, always-growing codebase model (architecture, business logic, data flows, tech stack, gotchas) contributed by agents every session via `[CMM+]` markers. Agents read it at session start, cross-check against live code, and write corrections or confirmations back — so the team's collective understanding compounds with every ticket worked.
- **Knowledge Base:** Merged `PALACE.md` and `INDEX.md` into a single `INDEX.md` file with two sections (`## Memory Palace` and `## Master Index`). Simplifies retrieval — one file, two layers.
- **Distributed KB — first contributor:** Added checks to ensure `PRX_KB_KEY` is set when required (encrypted repos) and that the first-time contributor flow handles an existing remote branch gracefully.
- **Email reports:** `send-report.py` delivers PDF/HTML analysis and review reports via SMTP immediately after saving. Configure via `PRX_EMAIL_TO` and `PRX_SMTP_*` env vars.
- **PR Review diff:** Review mode (Step R4) now uses `git diff` to detect changed files precisely, restricting the review panel to only the files actually modified on the feature branch.
- **Plugin registry:** Published as `prevoyant@dodogeny`.
- **Token efficiency:** Engineering Panel complexity gate (Step 7b-pre) fast-paths simple fixes; context pruned before Step 9; Riley made conditional on engineer divergence; KB integrity sweep at session start.
- **Polling script:** `--force TICKET-KEY` re-queues a previously seen ticket; `PRX_JIRA_PROJECT` scopes JQL to a single project.
- **Configurability:** `PRX_REPORT_VERBOSITY` (full/compact/minimal) controls terminal output without affecting PDF content; `PRX_ATTACHMENT_MAX_MB` caps non-image attachment size (default: unlimited).
- **Resilience:** MCP retry-with-backoff (3 attempts, 30 s apart) before failing; PDF tool pre-check at session start with graceful fallback.
- **KB stale detection:** Opportunistic validation during file reads; auto-heal writes `RELOCATED`/`DELETED` tags in Step 13c rather than silently leaving broken references.
- **Lessons Learned:** New `lessons-learned/` KB folder — per-developer files for recording pitfalls and sprint retrospective insights. Agents read all files at session start and surface matching entries in the Prior Knowledge block; `[LL+]` markers let agents flag new lessons during investigation (Step 13h / R9h). Works in both local and distributed mode.
- **Settings fix:** Removed hardcoded absolute path to `SKILL.md` from `.claude/settings.local.json`; replaced with the relative path `plugin/skills/dev/SKILL.md` so the config works on any machine.
- **Bryan — Scrum Master:** New team member (opt-in via `PRX_INCLUDE_SM_IN_SESSIONS_ENABLED=Y`) who observes every session silently and runs a structured retrospective (Step 14 / R10). Tracks cumulative monthly spend against `PRX_MONTHLY_BUDGET` (default: $20.00 — matching a standard Claude subscription), flagging ⚠️ at >80% and ❌ at 100%. Maintains a prioritised improvement backlog, tracks recurring blockers, proposes one focused SKILL.md sharpening change per session, and runs a full compaction pass every `PRX_SKILL_COMPACTION_INTERVAL` sessions. Requires unanimous consensus before applying; pushes after `PRX_SKILL_UPGRADE_MIN_SESSIONS` sessions.
- **SKILL.md internal versioning & audit trail:** Every Bryan change is recorded with its git commit hash in two places: a `## Skill Change Log` table embedded at the top of SKILL.md (SC#, version, date, commit, type, summary, status) and a full `[SC-NNN]` entry in `shared/skill-changelog.md` (verbatim before/after wording, voters, revert status). Any change can be safely rolled back with `git revert <commit>`.
- **process-efficiency.md merge safety:** Redesigned as an append-only journal (session records, backlog items, blockers expressed as tagged entries, never mutated in-place). Header and velocity dashboard are auto-rebuilt from journal data after every pull — the same pattern as `INDEX.md` — so concurrent pushes from multiple developers are always lossless with `merge=union`.

### v1.2.0

- **PR Review Mode:** New mode triggered by the word `review` — same four-person engineering panel (Morgan, Alex, Sam, Jordan, Riley) operates as code reviewers. 7-section PDF report.
- **Knowledge Base:** Distributed mode with optional AES-256-CBC encryption; Memory Palace retrieval; inline `[KB+]` annotation during active work; `INDEX.md` rebuilt from source files after every pull.
- **Morgan's JIRA Historical Investigation:** Morgan searches closed/resolved JIRA tickets on the same components before every panel briefing.
- **Enhancement workflow:** Direct Analysis path (Step 7-ENH) bypasses the Engineering Panel for enhancement tickets.
- **PDF reports:** Full-detail 11-section report capturing every step output verbatim.
- **Headless mode:** `AUTO_MODE=true` bypasses all interactive gates; polling script (`poll-jira.sh`) triggers analysis on a schedule.

### v1.1.0

- Engineering Panel (Morgan + Alex + Sam + Jordan + Riley) for root cause analysis
- Riley (Senior Lead Tester) added with Testing Impact Assessment and testability challenges
- Class hierarchy check for enhancement tickets
- Jordan's defensive pattern checklist expanded from 11 to 20 patterns
- MCP setup via `.mcp.json` (replacing plugin-based approach)

### v1.0.0 — Initial Release

- 12-step dev workflow: ticket ingestion → branch → locate code → replicate → propose fix → impact analysis → PDF report
- Grep-first, read-second code location approach
- Three-tier base branch priority (fix version → affected version → development)
- PDF generation via pandoc → Chrome headless → HTML fallback

---

## License

MIT
