# Prevoir Internal Dev Skill — Claude Code Plugin `v1.0.0`

A [Claude Code](https://claude.ai/code) plugin that gives Claude a structured, end-to-end developer workflow for V1 Jira tickets. Instead of manually reading a ticket, searching for files, and figuring out where to start, you invoke one command and Claude walks through the full cycle — from ticket ingestion to a proposed fix and archived report.

---

## What It Does

When you hand Claude a Jira ticket key (`IV-XXXX`), the skill executes **9 steps automatically**, presenting output at each step as it completes.

---

### Step 1 — Ingest Ticket

Fetches the Jira issue using only the fields that matter — summary, type, priority, status, assignee, reporter, labels, components, fix version, affected versions, description, comments, and attachments. Everything else (sprint metadata, change logs, epic links, watchers) is skipped to keep token usage low.

Claude displays a structured ticket summary including the full description text extracted from Jira's ADF format, and lists all comments with their author, date, and full content.

---

### Step 2 — Analyse & Contextualise

Claude analyses everything gathered in Step 1 and produces:

- **Attachment review** — Any qualifying attachments (images, screenshots, log files, XML/config files, draw.io diagrams) under 2MB are downloaded and analysed. Screenshots are described visually; log files are scanned for stack traces and errors; config files are checked for relevant values. Binary files and large archives are skipped automatically.
- **Problem statement** — A concise description of what is broken or missing, who is affected, what the expected behaviour is, what the current behaviour is, and a clear list of acceptance criteria. Bugs are explicitly labelled as defects; enhancements are explicitly labelled as stories.
- **Prior investigation summary** — If any comments contain previous investigation work (root cause findings, code traces, attempted fixes, identified files, or partial solutions), Claude extracts and carries these forward as known context. This prevents re-investigating what is already established.
- **Issue diagram** (optional) — For issues involving a non-obvious data flow or multi-step component interaction, Claude generates a draw.io XML diagram (`.drawio` file) showing the happy path alongside the broken path, annotated with the key method calls and data values involved. Trivial single-file bugs skip this automatically.

---

### Step 3 — Create Development Branch

Claude determines the correct base branch using a three-tier priority:

1. **Fix Version is set** → searches for an existing release feature branch matching that version (e.g. `Feature/Release_1.24.292`). If found, forks from it so the fix builds on top of any release-level work already in progress.
2. **Affected Versions is set** → forks from the version branch (e.g. `1.24.292`), stripping any patch suffix.
3. **Neither set** → forks from `development`.

If the base branch cannot be confirmed locally or remotely, Claude pauses and asks rather than silently forking from a stale HEAD.

The feature branch is named: `Feature/IV-XXXX_Ticket_Summary_In_Title_Case` and checked out ready to code.

---

### Step 4 — Locate Affected Code

Claude searches the V1 codebase using a **grep-first, read-second** approach — it never reads an entire file speculatively. The flow is:

1. `Grep` to find the relevant class, method name, or keyword → get the exact file path and line number
2. `Read` only the relevant line range (the method ± surrounding context)
3. Full file reads only if the method spans many lines or the grep result is ambiguous

This is the primary token-saving measure — reading a 40-line method costs ~60 tokens vs ~3,000 tokens to read a 2,000-line Java file in full.

Claude builds a **file map** — a table of every affected file, its role in the fix, and the specific method or line range identified. The map also notes recent git history on primary files to surface related recent changes.

A **confidence gate** runs after the file map: if Claude cannot locate the relevant code with reasonable certainty, it pauses and asks for guidance rather than generating a speculative fix on the wrong files.

---

### Step 5 — Replicate the Issue

Claude produces complete, numbered reproduction instructions that any developer on the team can follow without prior knowledge of the issue:

- **Prerequisites** — which V1 modules must be running, which user role is needed, what test data must exist, any environment-specific notes (Oracle vs PostgreSQL, specific config flags)
- **Reproduction steps** — numbered step-by-step actions from login through to the symptom
- **Expected result** — what the system should do when working correctly
- **Actual result** — the exact symptom the reporter observes

A **confidence gate** applies: High confidence proceeds automatically; Medium notes the assumption and proceeds; Low pauses and asks the developer to clarify before continuing to the fix.

---

### Step 6 — Propose the Fix

Claude reads the identified files (using targeted line ranges from Step 4) and produces:

- **Root cause analysis** — a precise explanation of *why* the bug occurs or *why* the feature is missing, with specific `ClassName.java:line` references. Builds on any prior investigation from Step 2 rather than re-deriving known facts.
- **Code changes** — only the code that needs to change, shown as clear before/after blocks. Each change is explained individually.
- **DB migration scripts** — if the fix requires schema changes, both an Oracle (`.sql`) and a PostgreSQL (`.pg`) script are provided. V1 supports both engines and SQL syntax is not assumed to be compatible across them.

---

### Step 7 — Impact, Risk & Change Summary

A unified review of the consequences of the fix:

- **Files changed table** — every file touched, the action taken (modified/created/deleted), what changed, and why
- **Regression risks** — for each change: which existing flows pass through the modified code, whether other callers of modified methods exist, DB data impact, and any race conditions or null pointer risks introduced
- **Affected clients/environments** — whether the fix is generic (all clients), client-specific (named client due to config differences), or DB-specific (different behaviour on Oracle vs PostgreSQL)
- **Retest checklist** — screens and flows outside the primary fix that should be smoke-tested before release
- **Risk level** — Low / Medium / High with a brief rationale
- **Suggested commit message** — a ready-to-paste commit message following the project convention: `IV-XXXX_Title_VERSION`

---

### Step 8 — Archive Report

Claude compiles a compact **summary card** (not a full transcript) and archives it:

- Writes `/tmp/IV-XXXX-analysis.md` — a one-page card covering the problem, root cause, fix table, retest items, and commit message
- Converts to PDF using `pandoc` (preferred) or Python `weasyprint`
- Copies both files to `~/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/`

---

### Step 9 — Session Stats

Prints a single line with elapsed time, estimated token usage, and estimated cost at Claude Sonnet 4.6 pricing:

```
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)
```

---

## Prerequisites

### Claude Code
- [Claude Code CLI](https://claude.ai/code) installed and authenticated
- Claude Code version that supports the plugin/skill system

### Jira MCP

The skill uses the **Atlassian MCP server** to read Jira tickets, download attachments, and search issues. This must be installed and authenticated before the skill will work.

#### 1. Install the Atlassian plugin in Claude Code

```bash
claude plugin install atlassian
```

#### 2. Generate a Jira API token

1. Log in to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a name (e.g. `Claude Code - V1`) and click **Create**
4. Copy the token — it will not be shown again

#### 3. Configure the MCP server

When Claude Code first invokes the Atlassian MCP, it will prompt for credentials. Enter:

| Field | Value |
|-------|-------|
| Jira URL | `https://prevoirsolutions.atlassian.net` |
| Email | your Atlassian account email (e.g. `you@prevoir.mu`) |
| API Token | the token generated in step 2 |

Credentials are stored securely in your local Claude Code config and are not committed to any repository.

#### 4. Verify the connection

In a Claude Code session, ask:
```
search for Jira issue IV-1
```

If the Atlassian MCP is configured correctly, Claude will return the issue details. If you see an authentication error, re-check your API token and Jira URL.

> **Note:** The API token grants the same permissions as your Atlassian account. Ensure your account has at minimum read access to the `IV` project in `prevoirsolutions.atlassian.net`.

### Git
The repository must be present at `$HOME/git/insight/` locally. The skill resolves this path dynamically at runtime using `$HOME`. The skill creates branches there.

> **Different repo location?** Open `plugin/skills/dev/SKILL.md` and update the `REPO_DIR` line in the **Configuration** section near the top:
> ```
> REPO_DIR = $HOME/git/insight
> ```
> Change `git/insight` to the path of your local repository relative to your home directory (e.g. `$HOME/projects/v1` or an absolute path like `/opt/repos/insight`).

### PDF Generation (for Step 8)
The skill uses `pandoc` (preferred) or Python `weasyprint` to generate the PDF report. At least one must be available:
```bash
# Check pandoc
which pandoc

# Or install weasyprint via pip
pip3 install markdown2 weasyprint
```

---

## Installation

### 1. Clone the marketplace repository

**macOS / Linux:**
```bash
git clone https://github.com/dodogeny/prevoir-skill-internal-dev.git \
  ~/.claude/plugins/marketplaces/prevoir
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/dodogeny/prevoir-skill-internal-dev.git "$env:USERPROFILE\.claude\plugins\marketplaces\prevoir"
```

### 2. Register the marketplace

Locate your Claude Code `settings.json` file:

| OS | Path |
|----|------|
| macOS / Linux | `~/.claude/settings.json` |
| Windows | `C:\Users\<username>\.claude\settings.json` |

> If the file does not exist, create it.

Add the following — replacing `<username>` with your username on Windows, or using the `~/.claude/...` path on macOS/Linux:

**macOS / Linux:**
```json
{
  "extraKnownMarketplaces": {
    "prevoir": {
      "source": {
        "source": "directory",
        "path": "/Users/<username>/.claude/plugins/marketplaces/prevoir"
      }
    }
  }
}
```

**Windows:**
```json
{
  "extraKnownMarketplaces": {
    "prevoir": {
      "source": {
        "source": "directory",
        "path": "C:\\Users\\<username>\\.claude\\plugins\\marketplaces\\prevoir"
      }
    }
  }
}
```

> If `extraKnownMarketplaces` already exists in your settings, add the `"prevoir"` entry inside it.

**Alternatively**, if you prefer to skip the manual clone and point directly to the hosted Git URL:
```json
{
  "extraKnownMarketplaces": {
    "prevoir": {
      "source": {
        "source": "github",
        "repo": "dodogeny/prevoir-skill-internal-dev"
      }
    }
  }
}
```
> Note: With this option you must also run `claude plugin marketplace update prevoir` before installing, to fetch the marketplace content from GitHub.

### 3. Install the plugin

```bash
claude plugin install prevoir@prevoir
```

### 4. Verify

```bash
claude plugin list
```

You should see `prevoir@prevoir` listed as installed.

---

## Usage

Invoke the skill from any Claude Code session using any of these forms:

```
/prevoir:dev IV-3672
```
```
start dev on IV-3672
```
```
pick up IV-3672
```
```
https://prevoirsolutions.atlassian.net/browse/IV-3672
```

Claude will immediately begin executing all 9 steps in order, presenting output for each step as it completes.

### Example output structure

```
## Step 1 — Ticket Ingestion
IV-3672 | Bug | High | Assigned: Javed Neemuth
Summary: Resolving Cases should Resolve Alerts
...

## Step 2 — Analysis & Context
Problem: Alert Central alerts remain open after a case is resolved...
Prior Investigation: None — proceeding fresh.
Diagram saved to /tmp/IV-3672-diagram.drawio

## Step 3 — Branch Created
Base branch: development (Fix Version not set; Affected Versions not set)
Created: Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts
HEAD: abc1234

## Step 4 — Affected Code
| File | Role | Key Location |
...
File map confidence: High — proceeding.

## Step 5 — Replicate the Issue
Prerequisites: ...
Steps: 1. Log in as admin...
Confidence: Medium

## Step 6 — Proposed Fix
Root cause: CaseManager.java:2272 — pendingAlertResolve flag is never set...
Before/After: ...

## Step 7 — Impact & Risk
Risk: Low | Files changed: 2 | Retest: 3 items
Commit: IV3672_Resolving_Cases_Should_Resolve_Alerts_1.26.064

## Step 8 — Archived
PDF: ~/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/IV-3672-analysis.pdf

## Step 9
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)

> Ready to code. Branch `Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts` is checked out.
> Start with `CaseManager.java:2272`.
```

---

## Repository Structure

```
.
├── .claude-plugin/
│   └── marketplace.json        # Claude Code marketplace descriptor
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json         # Plugin metadata (name, version, author)
│   ├── package.json            # Node package metadata
│   └── skills/
│       └── dev/
│           └── SKILL.md        # The skill definition — all 9 steps
├── .gitignore
└── README.md
```

The entire skill logic lives in `plugin/skills/dev/SKILL.md`. It is a markdown file that Claude Code loads as a prompt extension when the skill is invoked. No compiled code, no runtime dependencies beyond what Claude Code provides.

---

## Updating the Skill

### For maintainers

Edit `plugin/skills/dev/SKILL.md`, commit, and push to GitHub.

### For team members

To pull the latest version of the skill:

```bash
claude plugin update prevoir@prevoir
```

Verify the update was applied:

```bash
claude plugin list
```

The version number next to `prevoir@prevoir` should reflect the latest release.

---

## Project Context (V1)

The skill is purpose-built for the V1 codebase:

| Area | Path |
|------|------|
| GWT Frontend | `fcfrontend/src/main/java/com/fc/fe/` |
| Backend API | `fcbackend/src/main/java/com/fc/api/` |
| Models | `fcbackend/src/main/java/com/fc/model/` |
| Plugin/Workers | `fcplugin/src/main/java/com/fc/plugin/` |
| DB Upgrades | `fcbuild/scripts/upgrades/` |

- **Jira project:** `IV` at `https://prevoirsolutions.atlassian.net`
- **Tech stack:** Java, GWT, Oracle + PostgreSQL, Maven
- **Main branch:** `development`
- **Branch convention:** `Feature/IV-XXXX_Title_In_Title_Case`

---

## License

Internal use only — Prevoir.
