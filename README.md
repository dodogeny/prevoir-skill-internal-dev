# Dev Skill — Claude Code Plugin `v1.2.1`

A [Claude Code](https://claude.ai/code) plugin that gives Claude a structured, end-to-end developer workflow for Jira tickets. Two modes:

- **Dev Mode** — hand Claude a ticket key and it walks through the full cycle: ticket ingestion → root cause analysis → proposed fix → PDF report (12 steps).
- **PR Review Mode** — hand Claude a ticket key with the word `review` and the engineering panel reviews the code changes on the associated feature branch, producing a structured PDF findings report.

---

## Overview

Invoke the skill with a Jira ticket key and Claude runs a structured multi-step workflow — no manual searching, no copy-pasting ticket details, no guessing where to start.

### Dev Mode — `/prx:dev PROJ-1234`

1. **KB query** — pull the team's knowledge base; surface prior knowledge on the ticket's components
2. **Ingest ticket** — fetch Jira fields, description, attachments, and all linked tickets
3. **Analyse & contextualise** — produce a problem statement, acceptance criteria, and an optional draw.io flow diagram
4. **Read comments** — extract prior investigation findings, decisions, and constraints
5. **Create branch** — determine the correct base branch (fix version → affected version → development) and check out `Feature/{TICKET_KEY}_{Title}`
6. **Locate affected code** — grep-first/read-second approach; build a file map with confidence gate
7. **Replicate the issue** — numbered reproduction steps with prerequisites, expected vs actual, service restart guidance
8. **Root cause analysis** — Engineering Panel (Morgan chairs; Alex, Sam, Jordan investigate; Riley assesses test coverage) for bugs; Direct Analysis for enhancements; scored verdict + Root Cause Statement
9. **Propose the fix** — code changes anchored to the Root Cause Statement; Morgan fix review; optional apply to branch
10. **Impact analysis** — usage reference search, layer-by-layer impact table, regression risks, retest checklist
11. **Change summary** — files touched, commit message, PR description template ready to paste
12. **Session stats** — elapsed time, estimated tokens, estimated cost
13. **PDF report** — full-detail report saved to `CLAUDE_REPORT_DIR`; emailed if `PRX_EMAIL_TO` is set
14. **Update KB** — write session record; push to shared repo if distributed
15. **Bryan's retrospective** — Scrum Master audits token spend, flags process friction, proposes one SKILL.md improvement; unanimous team vote; pushes to main after `PRX_SKILL_UPGRADE_MIN_SESSIONS` sessions

### PR Review Mode — `/prx:dev review PROJ-1234`

1. **KB query** — pull the team's knowledge base; surface prior knowledge on the ticket's components
2. **Read ticket** — fetch Jira fields and description
3. **Understand problem** — full analysis including all linked tickets and attachments
4. **Read comments** — extract prior investigation and decisions
5. **Fetch code changes** — locate the feature branch; run `git diff` to retrieve the full changeset
6. **Engineering Panel review** — same four-person team as Dev Mode, now operating as reviewers: Alex (code quality), Sam (logic + acceptance criteria), Jordan (20-pattern defensive checklist), Riley (test coverage); Morgan scores and delivers a binding verdict
7. **Consolidated findings** — Critical/Major/Minor issues with `file:line` and fix recommendations; Positives; Conditions for Approval
8. **Session stats** — elapsed time, estimated tokens, estimated cost
9. **PDF review report** — saved as `{TICKET_KEY}-review.pdf` in `CLAUDE_REPORT_DIR`
10. **Update KB** — record review verdict, confirmed rules, pattern bumps; push if distributed
11. **Bryan's retrospective** — same as Dev Mode; token audit uses review session stats

**Review verdict:** ✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT

---

## Quick Start

### 1. Install the plugin

**macOS / Linux:**
```bash
git clone https://github.com/dodogeny/prx-skill-internal-dev.git \
  ~/.claude/plugins/marketplaces/dodogeny
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/dodogeny/prx-skill-internal-dev.git "$env:USERPROFILE\.claude\plugins\marketplaces\dodogeny"
```

Add to `~/.claude/settings.json` (create the file if it does not exist):

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
      "source": { "source": "github", "repo": "dodogeny/prx-skill-internal-dev" }
    }
  }
}
```
> With this option, run `claude plugin marketplace update dodogeny` before installing.

Then install and enable:
```bash
claude plugin install prx@dodogeny
claude plugin enable prx@dodogeny
claude plugin list   # should show prx@dodogeny with ✔ enabled
```

---

### 2. Install `uvx` (required for the Jira MCP server)

`uvx` is part of the `uv` Python package manager. The commands below check whether it is already installed and skip the install if so.

**macOS / Linux:**
```bash
command -v uvx &>/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
```

**Windows (PowerShell):**
```powershell
if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) {
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
}
```

---

### 3. Create `.env` and fill in your values

This is the **only file you need to edit**. Everything else — the MCP server, the skill, and the polling script — reads from it automatically.

Copy `.env.example` to `.env` **in the same folder where you cloned this repo** (the project root, next to this README):

```bash
# Run this from the project root
cd ~/.claude/plugins/marketplaces/dodogeny   # or wherever you cloned the repo
cp .env.example .env
```

Open `.env` and set the three required values:

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
/prx:dev PROJ-1234
```

**PR Review Mode:**
```
/prx:dev review PROJ-1234
```

> `/dev` is the shorthand (no namespace prefix). Use `/prx:dev` if another installed plugin also has a `dev` skill.

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
| `PRX_KNOWLEDGE_DIR` | `$HOME/.dev-skill/knowledge-base` | Override the local KB path (local mode only). |
| `PRX_KB_REPO` | — | URL of your team's private KB git repository (distributed mode — required). |
| `PRX_KB_LOCAL_CLONE` | `$HOME/.dev-skill/kb` | Local clone path for the KB repo (distributed mode). |
| `PRX_KB_KEY` | — | AES-256-CBC passphrase for encrypting KB files at rest (distributed mode, optional). |

### Source Repository Cross-Check (optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `PRX_SOURCE_REPO_URL` | — | Hosted URL of your codebase (e.g. `https://github.com/myorg/myrepo`). When set, the skill cross-checks KB `file:line` references against the live main branch. Omit to skip. |

### Report Output

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_REPORT_DIR` | `$HOME/.dev-skill/reports` | Folder where PDF/HTML reports are saved. Created automatically if it does not exist. |

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
| `PRX_BUDGET_BUG` | `0.06` | Target cost ceiling (USD) per bug ticket. Bryan flags sessions over this as ⚠️ Over budget. |
| `PRX_BUDGET_ENHANCEMENT` | `0.04` | Target cost ceiling (USD) per enhancement ticket. |

---

## Prerequisites

### PDF Generation

The skill generates reports via pandoc → Chrome headless → HTML fallback (tried in order, first success wins).

**pandoc (best output quality):**
```bash
brew install pandoc       # macOS
apt install pandoc        # Linux
# Windows: https://pandoc.org/installing.html
```

**Chrome headless:** no setup needed if Chrome is already installed.

**HTML fallback:** saves a styled `.html` file — open in any browser and print to PDF.

### Git
The repository at `REPO_DIR` must be present locally. The skill creates branches there.

---

## Knowledge Base

Every session feeds into a **shared, persistent knowledge base** stored as plain Markdown files. The KB grows richer after every ticket — capturing business rules, root causes, recurring patterns, and regression risks.

### Storage modes

| Mode | Location | Distribution | Encryption |
|------|----------|-------------|------------|
| **local** (default) | `$HOME/.dev-skill/knowledge-base/` | None — private to one machine | None |
| **distributed** | Local clone of `PRX_KB_REPO` | Via git push/pull to your team's private repo | Optional AES-256-CBC |

**Local mode:** zero setup — the KB is created automatically on the first session.

**Distributed mode:** share the KB across your team via a private git repository you own.

```bash
# Set in your shell profile or .env:
export PRX_KB_MODE=distributed
export PRX_KB_REPO="git@github.com:myorg/team-kb.git"
# Optional — default is $HOME/.dev-skill/kb:
export PRX_KB_LOCAL_CLONE="$HOME/.dev-skill/kb"
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
│   └── process-efficiency.md       # Bryan's session log: cost, budget status, changes applied
├── core-mental-map/                # Compressed, always-growing codebase model (codebase-driven)
│   ├── INDEX.md                    # Quick index: topics, entry counts, last-updated
│   ├── architecture.md             # System layers, component boundaries, key class relationships
│   ├── business-logic.md           # Core domain invariants and state machine rules
│   ├── data-flows.md               # Key data flows, RPC contracts, write paths
│   ├── tech-stack.md               # Technologies, frameworks, key library choices
│   └── gotchas.md                  # Non-obvious couplings, footguns, edge-case traps
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
| `lessons-learned/` | Developers | Per-person sprint retrospective entries: pitfalls and hard-won insights |

Every session starts by reading relevant `core-mental-map/` sections and all `lessons-learned/` files. Agents emit `[CMM+]` markers for codebase facts and `[LL+]` markers for lessons; both are written back to the KB at the end of every session.

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

`scripts/poll-jira.sh` polls Jira every hour for tickets assigned to you with status **To Do**, **Open**, **Parked**, or **Blocked**, and triggers the dev skill automatically for any new ones.

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
cp scripts/com.dev-skill.poll-jira.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.dev-skill.poll-jira.plist
launchctl list | grep com.dev-skill.poll-jira
```

Enable **Power Nap** (System Settings → Battery → Options) so the job fires while the lid is closed.

**Linux — cron:**
```bash
crontab -e
# Add:
0 * * * * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus /bin/bash $HOME/dev-skill/scripts/poll-jira.sh
```

**Windows — Task Scheduler (WSL):**
1. Open Task Scheduler → Create Basic Task
2. Trigger: Daily, repeat every 1 hour
3. Action: Program = `wsl`, Arguments = `bash /home/<wsl-user>/dev-skill/scripts/poll-jira.sh`

### Headless mode

When triggered by the polling script, `AUTO_MODE=true` is set and all interactive confirmation gates are bypassed with safe defaults. Branch creation and file edits are skipped — the skill runs the full analysis and saves the PDF. The developer reviews the PDF and applies the fix manually.

### Test manually
```bash
bash scripts/poll-jira.sh
tail -20 scripts/poll-jira.log
```

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
| **7** | Root cause analysis: **Engineering Panel** (bug) — Morgan chairs; Alex, Sam, Jordan investigate; Riley assesses test coverage; scored verdict + Root Cause Statement. **Direct analysis** (enhancement) — Enhancement Statement |
| **8** | Propose fix anchored to Root Cause/Enhancement Statement; Morgan fix review; optional apply to branch |
| **9** | Impact analysis — usage reference search, layer-by-layer impact table, regression risks, retest checklist |
| **10** | Change summary — files touched, commit message, PR description template |
| **11** | Session stats — elapsed time, estimated tokens, estimated cost |
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
| **R5** | Engineering Panel code review — same four-person team; Alex (code quality), Sam (logic + acceptance criteria), Jordan (20-pattern defensive checklist), Riley (test coverage); Morgan scores and delivers binding verdict |
| **R6** | Consolidated findings — Critical/Major/Minor issues with `file:line`, fix recommendations, Positives, Conditions for Approval |
| **R7** | Session stats |
| **R8** | PDF review report |
| **R9** | Update KB with review findings; push if distributed |

**Review verdict:** ✅ APPROVED / ⚠️ APPROVED WITH CONDITIONS / 🔄 REQUEST CHANGES / ❌ REJECT

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
│   └── skills/dev/
│       └── SKILL.md              # All skill logic lives here
├── scripts/
│   ├── poll-jira.sh              # Jira polling script (macOS / Linux / Windows WSL)
│   ├── com.dev-skill.poll-jira.plist  # macOS launchd schedule template
│   ├── .jira-credentials.example # Credentials template
│   └── send-report.py            # Email delivery helper
├── .mcp.json.example             # MCP server config template
├── .env.example                  # Environment variable template
└── README.md
```

All skill logic lives in `plugin/skills/dev/SKILL.md`. No compiled code, no runtime dependencies beyond what Claude Code provides.

---

## Contributing

### Make changes

All skill logic is in one file:
```
plugin/skills/dev/SKILL.md
```

Edit this file to modify workflow steps, prompts, or project context.

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
claude plugin update prx@dodogeny
```

> Do **not** run `git pull` directly inside `~/.claude/plugins/marketplaces/dodogeny` — Claude Code manages that directory.

---

## Upgrading

```bash
# If registered with a local path:
git -C ~/.claude/plugins/marketplaces/dodogeny pull
claude plugin update prx@dodogeny

# If registered with the hosted Git URL:
claude plugin update prx@dodogeny

# Verify:
claude plugin list
```

---

## Changelog

### v1.2.1

- **Core Mental Map:** New `core-mental-map/` KB folder — a compressed, always-growing codebase model (architecture, business logic, data flows, tech stack, gotchas) contributed by agents every session via `[CMM+]` markers. Agents read it at session start, cross-check against live code, and write corrections or confirmations back — so the team's collective understanding compounds with every ticket worked.
- **Knowledge Base:** Merged `PALACE.md` and `INDEX.md` into a single `INDEX.md` file with two sections (`## Memory Palace` and `## Master Index`). Simplifies retrieval — one file, two layers.
- **Distributed KB — first contributor:** Added checks to ensure `PRX_KB_KEY` is set when required (encrypted repos) and that the first-time contributor flow handles an existing remote branch gracefully.
- **Email reports:** `send-report.py` delivers PDF/HTML analysis and review reports via SMTP immediately after saving. Configure via `PRX_EMAIL_TO` and `PRX_SMTP_*` env vars.
- **PR Review diff:** Review mode (Step R4) now uses `git diff` to detect changed files precisely, restricting the review panel to only the files actually modified on the feature branch.
- **Plugin registry:** Published as `prx@dodogeny`.
- **Token efficiency:** Engineering Panel complexity gate (Step 7b-pre) fast-paths simple fixes; context pruned before Step 9; Riley made conditional on engineer divergence; KB integrity sweep at session start.
- **Polling script:** `--force TICKET-KEY` re-queues a previously seen ticket; `PRX_JIRA_PROJECT` scopes JQL to a single project.
- **Configurability:** `PRX_REPORT_VERBOSITY` (full/compact/minimal) controls terminal output without affecting PDF content; `PRX_ATTACHMENT_MAX_MB` caps non-image attachment size (default: unlimited).
- **Resilience:** MCP retry-with-backoff (3 attempts, 30 s apart) before failing; PDF tool pre-check at session start with graceful fallback.
- **KB stale detection:** Opportunistic validation during file reads; auto-heal writes `RELOCATED`/`DELETED` tags in Step 13c rather than silently leaving broken references.
- **Lessons Learned:** New `lessons-learned/` KB folder — per-developer files for recording pitfalls and sprint retrospective insights. Agents read all files at session start and surface matching entries in the Prior Knowledge block; `[LL+]` markers let agents flag new lessons during investigation (Step 13h / R9h). Works in both local and distributed mode.
- **Bryan — Scrum Master:** New team member who observes every session silently and runs a post-session retrospective (Step 14 / R10). Audits token spend against configurable per-ticket-type budgets (`PRX_BUDGET_BUG`, `PRX_BUDGET_ENHANCEMENT`), identifies process friction, and proposes one focused SKILL.md improvement per session. Requires unanimous consensus from Morgan, Riley, and one engineer before applying. Pushes changes to the plugin repo's main branch after `PRX_SKILL_UPGRADE_MIN_SESSIONS` sessions (default: 3). Maintains a running efficiency log in `shared/process-efficiency.md`.

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
