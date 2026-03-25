# Prevoir Internal Dev Skill — Claude Code Plugin `v1.1.0`

A [Claude Code](https://claude.ai/code) plugin that gives Claude a structured, end-to-end developer workflow for V1 Jira tickets. Instead of manually reading a ticket, searching for files, and figuring out where to start, you invoke one command and Claude walks through the full cycle — from ticket ingestion to a proposed fix and archived report.

---

## What It Does

When you hand Claude a Jira ticket key (`IV-XXXX`), the skill executes **11 steps automatically**, presenting output at each step as it completes.

---

### Step 1 — Ingest Ticket

Fetches the Jira issue requesting only the 13 fields that matter — summary, type, priority, status, assignee, reporter, labels, components, fix version, affected versions, description, comments, and attachments. Sprint metadata, change logs, epic links, and watcher lists are not fetched.

If the MCP call fails (authentication error, ticket not found, MCP not running), Claude states the exact error and stops — it does not proceed with partial or missing data. The developer is given clear recovery steps before continuing.

---

### Step 2 — Analyse & Contextualise

Claude analyses everything gathered in Step 1 and produces:

- **Attachment review & diagnostic artefact analysis** — All qualifying attachments up to 10 MB are downloaded and analysed. Binary files, archives, and files over 10 MB are skipped automatically. Each attachment is identified by filename, type, and a one-line finding before detailed analysis:
  - *Screenshots / images* — UI state, error banners, field values, and any visible error codes are described
  - *Log files* — scanned for stack traces, exception chains, and error patterns; root cause frame extracted
  - *Thread dumps* — blocked/waiting threads identified, deadlock chains traced, contention point noted with class/method/line
  - *Memory / heap dumps* — dominant object type identified, exhausted heap space noted, GC patterns extracted
  - *XML / config files* — relevant config values checked for incorrect or missing entries
  - *draw.io diagrams* — flow depicted is described
  All findings are carried forward into the root cause analysis in Step 7.
- **Problem statement** — A concise description of what is broken or missing, who is affected, what the expected behaviour is, what the current behaviour is, and a clear list of acceptance criteria. Bugs are explicitly labelled as defects; enhancements are explicitly labelled as stories.
- **Prior investigation summary** — If any comments contain previous investigation work (root cause findings, code traces, attempted fixes, identified files, or partial solutions), Claude extracts and carries these forward as known context. This prevents re-investigating what is already established.
- **Issue diagram** (optional) — For issues involving a non-obvious data flow or multi-step component interaction, Claude generates a draw.io XML diagram (`.drawio` file) showing the happy path alongside the broken path, annotated with the key method calls and data values involved. Trivial single-file bugs skip this automatically.

---

### Step 3 — Create Development Branch

Claude determines the correct base branch using a three-tier priority:

1. **Fix Version is set** → derives the version string (e.g. `1.24.292` from `1.24.292.p1`), then checks whether `Feature/Release_{VERSION}` exists locally or on the remote. If found, forks from it so the fix builds on top of any release-level work already in progress. If not found, falls back to the plain version branch.
2. **Affected Versions is set** → forks from the plain version branch (e.g. `1.24.292`), stripping any patch suffix.
3. **Neither set** → forks from `development`.

**Confirmation gate:** Before any `git checkout`, Claude verifies the base branch exists locally or on the remote. If it cannot be confirmed in either place, Claude stops and asks the developer which branch to use rather than silently forking from a stale HEAD.

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
- **Service restart guidance** — which spawner, worker, or application server must be restarted to pick up the fix during local testing, listed per layer (Plugin/Worker, Backend API, GWT Frontend)

A **confidence gate** applies: High confidence proceeds automatically; Medium notes the assumption and proceeds; Low pauses and asks the developer to clarify before continuing to the fix.

---

### Step 6 — Propose the Fix

Claude reads the identified files (using targeted line ranges from Step 4) and produces:

- **Root cause analysis** — a precise explanation of *why* the bug occurs or *why* the feature is missing, with specific `ClassName.java:line` references. Builds on any prior investigation from Step 2 (including thread/memory dump findings) rather than re-deriving known facts.
- **Code changes** — only the code that needs to change, shown as clear before/after blocks. Each change is explained individually.
- **Apply to branch (interactive)** — after presenting the fix, Claude asks whether to apply the changes directly to the feature branch. Options: `yes` (apply all), `no` (developer applies manually), `partial` (apply selected files only). Changes are applied using targeted edits — no commit is made.
- **DB migration scripts** — if the fix requires schema changes, both an Oracle (`.sql`) and a PostgreSQL (`.pg`) script are provided. V1 supports both engines and SQL syntax is not assumed to be compatible across them.

---

### Step 7 — Impact Analysis

A full review of the consequences of the fix across the entire application — backed by active codebase searching, not assumptions:

- **Files changed table** — every file touched, the action taken (modified/created/deleted), what changed, and why
- **Usage reference search** — for every modified method, class, field, or API, Claude greps the full codebase and produces a reference table of all callers and usages found. Public methods, interface implementations, DB columns, and GWT RPC service methods are all checked. A symbol confirmed unused outside its class is explicitly stated as such.
- **Application-wide impact** — a layer-by-layer impact table covering: GWT Frontend, Backend API, Plugin/Workers, DB/Schema, and Shared Utilities. Each layer states the impact level and detail. Layers with zero references found are confirmed as unaffected.
- **Regression risks** — for each change: which existing flows are affected, callers that may behave differently after the change, DB data impact, and any race conditions or null pointer risks introduced
- **Affected clients/environments** — whether the fix is generic (all clients), client-specific (named client due to config differences), or DB-specific (different behaviour on Oracle vs PostgreSQL)
- **Retest checklist** — screens and flows outside the primary fix that should be smoke-tested, derived from the actual callers found in the usage search
- **Risk level** — rated objectively based on caller count: Low (0–1 callers), Medium (2–5), High (6+ or DB/shared utility change) — stated prominently with a justification sentence

---

### Step 8 — Change Summary (Steps 8 & 9 in SKILL.md)

Claude compiles a developer-ready summary covering:

- **Files touched** — table of every file modified, created, or deleted with a one-line description
- **What changed and why** — one paragraph per file explaining the change and the reasoning
- **Suggested commit message** — ready-to-paste, following the project convention: `IV-XXXX_Title_VERSION`
- **PR description template** — a fully populated pull request body including Jira link, branch, risk level, what changed, how to test, retest areas, and DB migration flag — ready to paste directly into GitHub/Bitbucket

---

### Step 9 — Change Summary

Claude compiles a developer-ready summary covering:

- **Files touched** — table of every file modified, created, or deleted with a one-line description
- **What changed and why** — one paragraph per file explaining the change and the reasoning
- **Suggested commit message** — ready-to-paste, following the project convention: `IV-XXXX_Title_VERSION`
- **PR description template** — a fully populated pull request body including Jira link, branch, risk level, what changed, how to test, retest areas, and DB migration flag — ready to paste directly into GitHub/Bitbucket

---

### Step 10 — Session Stats

Prints a single summary line with elapsed time, estimated token usage, and estimated cost at Sonnet 4.6 pricing:

```
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)
```

---

### Step 11 — PDF Analysis Report

Claude generates a full PDF report of the complete analysis and saves it to a configurable output folder:

- **Output folder** — reads `$CLAUDE_REPORT_DIR` environment variable if set; defaults to `$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/` (works on macOS, Linux, and Windows)
- **PDF generation** — tries three methods in order, stopping at the first that succeeds:
  1. **`pandoc`** — best quality, handles tables and code blocks correctly; install via `brew install pandoc` (macOS), `apt install pandoc` (Linux), or the [pandoc installer](https://pandoc.org/installing.html) (Windows)
  2. **Chrome / Chromium headless** — uses `--print-to-pdf`; works on all platforms if Chrome is installed; no additional setup required
  3. **HTML fallback** — saves a styled `.html` file and instructs the developer to print to PDF from their browser
- **Confirmation** — always displays both the output folder and the full file path after saving
- **Cleanup** — intermediate temp files (`/tmp/{TICKET_KEY}-analysis.md`, `.html`) are removed after the report is saved

---

## Polling Script Setup

The polling script monitors Jira for tickets assigned to you with status **To Do**, **Open**, **Parked**, or **Blocked**, and triggers the dev skill automatically for any new ones found. Follow the steps for your operating system.

---

### Step 1 — Get your Jira API token

1. Log in to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Name it (e.g. `Prevoir Poll Jira`) and click **Create**
4. Copy the token — it will not be shown again

---

### Step 2 — Download the script files

Copy `poll-jira.sh` from this repository to your scripts folder:

**macOS / Linux:**
```bash
# Create the scripts folder
mkdir -p ~/Documents/Prevoir/Scripts

# Copy files from this repo
cp poll-jira.sh ~/Documents/Prevoir/Scripts/
```

**Windows (WSL terminal):**
```bash
mkdir -p ~/prevoir-scripts
cp /mnt/c/path/to/poll-jira.sh ~/prevoir-scripts/
```

---

### Step 3 — Create the credentials file

Create a file named `.jira-credentials` in the same folder as `poll-jira.sh`. Replace the dummy values with your real details:

**macOS / Linux:**
```bash
cat > ~/Documents/Prevoir/Scripts/.jira-credentials << 'EOF'
JIRA_USER="firstname.lastname@prevoir.mu"
JIRA_TOKEN="your-api-token-here"
EOF

chmod 600 ~/Documents/Prevoir/Scripts/.jira-credentials
```

**Windows (WSL terminal):**
```bash
cat > ~/prevoir-scripts/.jira-credentials << 'EOF'
JIRA_USER="firstname.lastname@prevoir.mu"
JIRA_TOKEN="your-api-token-here"
EOF

chmod 600 ~/prevoir-scripts/.jira-credentials
```

The file should look like this (dummy values shown):

```bash
JIRA_USER="john.doe@prevoir.mu"
JIRA_TOKEN="ATATT3xFfGF0tNH4BP5CQ3NHz8YraPNlH1pj1QzcsBNq4ZcG_XXXXXXXXXXXXXXXX"
```

> **Security:** `chmod 600` restricts the file to your user account only. Never commit this file to git — it is listed in `.gitignore`.

---

### Step 4 — Make the script executable

**macOS / Linux / WSL:**
```bash
chmod +x ~/Documents/Prevoir/Scripts/poll-jira.sh      # macOS / Linux
chmod +x ~/prevoir-scripts/poll-jira.sh                # WSL
```

---

### Step 5 — Test it manually

Run the script once to confirm it connects to Jira and processes tickets correctly:

**macOS / Linux:**
```bash
bash ~/Documents/Prevoir/Scripts/poll-jira.sh
```

**Windows (WSL):**
```bash
bash ~/prevoir-scripts/poll-jira.sh
```

Then check the log:

```bash
tail -20 ~/Documents/Prevoir/Scripts/poll-jira.log     # macOS / Linux
tail -20 ~/prevoir-scripts/poll-jira.log               # WSL
```

Expected output for a successful run with no new tickets:

```
2026-03-25 10:00:01 Polling Jira for Parked/Blocked tickets...
2026-03-25 10:00:02 No Parked/Blocked tickets found.
2026-03-25 10:00:02 Done. 0 new ticket(s) processed.
```

Expected output when a new ticket is found:

```
2026-03-25 10:00:01 Polling Jira for Parked/Blocked tickets...
2026-03-25 10:00:02 New ticket detected: IV-3891 — starting analysis
2026-03-25 10:12:44 Analysis complete for IV-3891 (exit 0)
2026-03-25 10:12:44 Done. 1 new ticket(s) processed.
```

Common errors:

| Log message | Cause | Fix |
|-------------|-------|-----|
| `ERROR: Credentials file not found` | `.jira-credentials` missing or wrong path | Re-run Step 3 |
| `ERROR: Jira API returned HTTP 401` | Invalid API token or wrong email | Regenerate token at id.atlassian.com |
| `ERROR: Jira API returned HTTP 403` | Account lacks access to the IV project | Ask your Jira admin to grant read access |
| `ERROR: Jira API returned HTTP 404` | Wrong Jira base URL | Verify `JIRA_BASE` in the script |

---

### Step 6 — Schedule it

#### macOS — register the launchd job

```bash
# Copy the plist
cp com.prevoir.poll-jira.plist ~/Library/LaunchAgents/

# Register (starts immediately and persists across reboots)
launchctl load ~/Library/LaunchAgents/com.prevoir.poll-jira.plist

# Verify
launchctl list | grep com.prevoir.poll-jira
```

Enable **Power Nap** so the job can fire while the lid is closed on mains power:
> System Settings → Battery → Options → Enable Power Nap

#### Linux — add a cron entry

```bash
crontab -e
```

Add this line (runs every 60 minutes):

```
0 * * * * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus /bin/bash $HOME/Documents/Prevoir/Scripts/poll-jira.sh
```

Verify the cron entry was saved:

```bash
crontab -l
```

#### Windows — Task Scheduler

1. Open **Task Scheduler** → **Create Basic Task**
2. **Name:** `Prevoir Poll Jira`
3. **Trigger:** Daily → check **Repeat task every 1 hour**
4. **Action:** Start a program
   - **Program:** `wsl`
   - **Arguments:** `bash /home/<your-wsl-username>/prevoir-scripts/poll-jira.sh`
5. On the **General** tab: select **"Run only when user is logged on"**
6. Click **Finish**

Verify by right-clicking the task → **Run** and checking the log file in WSL.

---

### Step 7 — Verify end-to-end

Once scheduled, confirm the job fires correctly by checking the log after the first scheduled run:

```bash
tail -f ~/Documents/Prevoir/Scripts/poll-jira.log      # macOS / Linux (live tail)
tail -f ~/prevoir-scripts/poll-jira.log                # WSL
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

### PDF Generation (for Step 11)

The skill tries three methods in order — no setup is required if Chrome or Chromium is already installed.

**Method 1 — pandoc (best output quality):**
```bash
# macOS
brew install pandoc

# Linux
apt install pandoc

# Windows — download installer from https://pandoc.org/installing.html
```

**Method 2 — Chrome / Chromium headless (no install needed if Chrome is present):**

No setup required. The skill detects Chrome automatically on macOS, Linux, and Windows.

**Method 3 — HTML fallback:**

If neither pandoc nor Chrome is available, the report is saved as a styled `.html` file. Open it in any browser and use **File → Print → Save as PDF**.

> Python `weasyprint` is no longer used — it has unreliable native dependencies on Windows.

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
/dev IV-3672
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

> `/dev` is the shorthand — it uses just the skill name. `/prevoir:dev` is the fully qualified form that includes the plugin namespace. Both work; use the fully qualified form if another installed plugin also has a skill named `dev`.

Claude will immediately begin executing all 11 steps in order, presenting output for each step as it completes.

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
Base branch: Feature/Release_1.26.064 (Fix Version set; Feature/Release branch found)
Created: Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts
HEAD: abc1234

## Step 4 — Affected Code
| File | Role | Key Location | Recent Git History |
...
File map confidence: High — proceeding.

## Step 5 — Replicate the Issue
Prerequisites: ...
Steps: 1. Log in as admin...
Confidence: Medium
Restart: Backend-only change — restart the application server (Tomcat/embedded).

## Step 6 — Proposed Fix
Root cause: CaseManager.java:2272 — pendingAlertResolve flag is never set...
Before/After: ...

## Step 7 — Impact Analysis
Risk: Low | Files changed: 2 | Retest: 3 items

## Step 8 — Change Summary
Files: 2 modified | Commit message ready to paste | PR description ready to paste

## Step 9 — (internal step number — see SKILL.md)

## Step 10 — Session Stats
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)

## Step 11 — PDF Report
📄 Analysis Report Generated
   Folder : ~/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/
   File   : ~/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/IV-3672-analysis.pdf
   Format : PDF (Chrome headless)

> Ready to code. Branch `Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts` is checked out.
> Start with `CaseManager.java:2272`.
```

---

## Automated Polling (Headless Mode)

In addition to manual invocation, the skill supports a fully automated mode that polls Jira on a schedule and triggers analysis without any developer interaction.

### How it works

A shell script (`poll-jira.sh`) runs **every 60 minutes** via macOS `launchd`. It:

1. Queries Jira for tickets assigned to you with status **To Do**, **Open**, **Parked**, or **Blocked**
2. Compares against a local seen-tickets cache — skips anything already processed
3. For each new ticket, runs the skill with `AUTO_MODE=true` (analysis-only mode — see below)
4. Sends a macOS notification when analysis is complete
5. Logs all activity to `poll-jira.log`

### Headless / analysis-only mode

When `AUTO_MODE=true` is set, all interactive confirmation gates are bypassed and the skill runs end-to-end without pausing:

| Gate | Normal behaviour | Headless default |
|------|-----------------|-----------------|
| Step 1 — MCP failure | Stop and wait for developer | Exit immediately with `HEADLESS_ERROR: {reason}` |
| Step 4 — Base branch unconfirmed | Ask developer which branch | Default to `development`; note the fallback |
| Step 4 — Branch creation | Run `git checkout -b …` | **Skipped** — reports the branch name only; no git commands run |
| Step 5 — Low file-map confidence | Stop and ask developer | Proceed with `⚠️ LOW CONFIDENCE — manual review required` |
| Step 6 — Low replication confidence | Stop and ask developer | Proceed with `⚠️ LOW CONFIDENCE — assumptions noted` |
| Step 7 — Apply fix prompt | Ask yes / no / partial | **Defaults to no** — proposes the fix only; no files are edited |

The full 11-step analysis still runs and the PDF report is saved to disk. The developer reviews the PDF and applies the fix manually.

### Files

| File | Location | Purpose |
|------|----------|---------|
| `poll-jira.sh` | `~/Documents/Prevoir/Scripts/` | Main polling script |
| `.jira-credentials` | `~/Documents/Prevoir/Scripts/` | API credentials (chmod 600 — owner only) |
| `.jira-seen-tickets` | `~/Documents/Prevoir/Scripts/` | Cache of already-processed ticket keys |
| `poll-jira.log` | `~/Documents/Prevoir/Scripts/` | Full run log with timestamps |
| `com.prevoir.poll-jira.plist` | `~/Library/LaunchAgents/` | macOS launchd job — fires every 60 minutes, Power Nap compatible |

### Platform support

The script (`poll-jira.sh`) is cross-platform bash. It detects the OS at runtime and uses the appropriate notification mechanism:

| Platform | Notifications | Scheduler |
|----------|--------------|-----------|
| macOS | `osascript` (built-in) | `launchd` |
| Linux | `notify-send` (`libnotify`) | `cron` |
| Windows | WSL + PowerShell balloon tip | Task Scheduler |

---

### macOS setup

The scripts are already installed and the launchd job is registered. No further setup is required.

Verify the job is loaded:

```bash
launchctl list | grep com.prevoir.poll-jira
```

Enable **Power Nap** so the job can fire while the lid is closed on mains power:

> System Settings → Battery → Options → Enable Power Nap

Manage the schedule:

```bash
# Disable
launchctl unload ~/Library/LaunchAgents/com.prevoir.poll-jira.plist

# Re-enable
launchctl load ~/Library/LaunchAgents/com.prevoir.poll-jira.plist
```

---

### Linux setup

#### 1. Copy the script and credentials

```bash
mkdir -p ~/prevoir-scripts
cp poll-jira.sh ~/prevoir-scripts/
cp .jira-credentials ~/prevoir-scripts/
chmod 600 ~/prevoir-scripts/.jira-credentials
chmod +x ~/prevoir-scripts/poll-jira.sh
```

#### 2. Install notification support (if not already present)

```bash
# Debian / Ubuntu
sudo apt install libnotify-bin

# Fedora / RHEL
sudo dnf install libnotify
```

> If `notify-send` is unavailable, the script still runs — notifications are silently skipped and all activity is logged to `poll-jira.log`.

#### 3. Schedule with cron

```bash
crontab -e
```

Add this line to run every 60 minutes:

```
0 * * * * /bin/bash $HOME/prevoir-scripts/poll-jira.sh
```

> **Note:** cron jobs do not inherit your desktop session, so `notify-send` may not display if `DBUS_SESSION_BUS_ADDRESS` is not set. To fix this, add the following at the top of the cron entry:
> ```
> 0 * * * * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus /bin/bash $HOME/prevoir-scripts/poll-jira.sh
> ```

---

### Windows setup (via WSL)

The script runs inside WSL (Windows Subsystem for Linux). Notifications appear as Windows balloon tips via PowerShell.

#### 1. Enable WSL (if not already installed)

Open PowerShell as Administrator and run:

```powershell
wsl --install
```

Restart when prompted. Ubuntu is installed by default.

#### 2. Copy the script into WSL

From inside a WSL terminal:

```bash
mkdir -p ~/prevoir-scripts
cp /mnt/c/path/to/poll-jira.sh ~/prevoir-scripts/
cp /mnt/c/path/to/.jira-credentials ~/prevoir-scripts/
chmod 600 ~/prevoir-scripts/.jira-credentials
chmod +x ~/prevoir-scripts/poll-jira.sh
```

#### 3. Install dependencies inside WSL

```bash
sudo apt update && sudo apt install curl python3
```

#### 4. Schedule with Windows Task Scheduler

1. Open **Task Scheduler** → **Create Basic Task**
2. Name: `Prevoir Poll Jira`
3. Trigger: **Daily**, repeat every **1 hour**
4. Action: **Start a program**
   - Program: `wsl`
   - Arguments: `bash /home/<your-wsl-username>/prevoir-scripts/poll-jira.sh`
5. Finish

> Ensure the task is set to **"Run only when user is logged on"** so WSL and PowerShell notifications work correctly.

---

### Running manually (all platforms)

```bash
bash ~/Documents/Prevoir/Scripts/poll-jira.sh        # macOS
bash ~/prevoir-scripts/poll-jira.sh                  # Linux / WSL
```

### Resetting the seen-tickets cache

If you want the script to re-analyse tickets it has already processed, clear the cache:

```bash
> ~/Documents/Prevoir/Scripts/.jira-seen-tickets       # macOS
> ~/prevoir-scripts/.jira-seen-tickets                 # Linux / WSL
```

---

## Repository Structure

```
.
├── .claude-plugin/
│   └── marketplace.json              # Claude Code marketplace descriptor
├── plugin/
│   ├── .claude-plugin/
│   │   └── plugin.json               # Plugin metadata (name, version, author)
│   ├── package.json                  # Node package metadata
│   └── skills/
│       └── dev/
│           └── SKILL.md              # The skill definition — all 11 steps
├── scripts/
│   ├── poll-jira.sh                  # Jira polling script (macOS / Linux / Windows WSL)
│   ├── com.prevoir.poll-jira.plist   # macOS launchd schedule template
│   └── .jira-credentials.example    # Credentials template (safe to commit — dummy values)
├── .gitignore
└── README.md
```

> **Not in the repo (gitignored):**
> - `scripts/.jira-credentials` — your real API token; created locally from `.jira-credentials.example`
> - `scripts/.jira-seen-tickets` — runtime cache of processed ticket keys
> - `scripts/poll-jira.log` / `poll-jira-error.log` — runtime logs

The entire skill logic lives in `plugin/skills/dev/SKILL.md`. It is a markdown file that Claude Code loads as a prompt extension when the skill is invoked. No compiled code, no runtime dependencies beyond what Claude Code provides.

---

## Updating the Skill

### For maintainers

Edit `plugin/skills/dev/SKILL.md`, commit, and push to GitHub.

### For team members

#### Option A — Claude plugin update command (recommended)

Claude Code manages the marketplace directory internally. Always use the Claude-managed command to update — do **not** run `git pull` directly inside `~/.claude/plugins/marketplaces/prevoir` as Claude Code may wipe the folder when it detects external changes.

```bash
claude plugin update prevoir@prevoir
```

#### Option B — Reinstall (if Option A fails)

If the update command fails or the plugin appears broken:

**macOS / Linux:**
```bash
claude plugin uninstall prevoir@prevoir
claude plugin install prevoir@prevoir
```

**Windows (PowerShell):**
```powershell
claude plugin uninstall prevoir@prevoir
claude plugin install prevoir@prevoir
```

#### Verify the update

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

## Contributing

### 1. Clone the repository

```bash
git clone https://github.com/dodogeny/prevoir-skill-internal-dev.git
```

### 2. Open in your IDE

**IntelliJ IDEA:**
- File → Open → select the cloned folder
- IntelliJ will detect it as a project automatically

**Eclipse:**
- File → Open Projects from File System → select the cloned folder
- Eclipse project files (`.project`, `.classpath`, `.settings/`) are gitignored and will be generated locally

### 3. Make your changes

All skill logic lives in a single file:

```
plugin/skills/dev/SKILL.md
```

Edit this file to modify the workflow steps, prompts, or project context.

### 4. Bump the version

When making a change, increment the version number in **all three** of the following files:

| File | Field |
|------|-------|
| `plugin/.claude-plugin/plugin.json` | `"version"` |
| `plugin/package.json` | `"version"` |
| `.claude-plugin/marketplace.json` | `"version"` inside the `plugins` array |

Follow [semantic versioning](https://semver.org): `MAJOR.MINOR.PATCH`
- **PATCH** (e.g. `1.0.1`) — bug fix or wording tweak
- **MINOR** (e.g. `1.1.0`) — new step or significant behaviour change
- **MAJOR** (e.g. `2.0.0`) — breaking restructure

### 5. Commit and push

```bash
git add .
git commit -m "vX.Y.Z — short description of change"
git push origin main
```

### 6. Notify team to update

After pushing, notify the team to run:

```bash
claude plugin update prevoir@prevoir
```

> Do **not** advise running `git pull` directly inside `~/.claude/plugins/marketplaces/prevoir` — Claude Code manages that directory and may wipe it if it detects external git changes.

---

## Changelog

### v1.1.1

| # | Area | Change |
|---|------|--------|
| 1 | Skill — Headless Mode | Added `AUTO_MODE=true` support — all interactive gates bypass with safe defaults; branch creation and file edits are skipped; full analysis and PDF report still run |
| 2 | Automation — `poll-jira.sh` | New cross-platform polling script — queries Jira every 60 minutes for Parked/Blocked tickets; detects OS at runtime and uses `osascript` (macOS), `notify-send` (Linux), or PowerShell balloon tip (Windows WSL) for notifications |
| 3 | Automation — `com.prevoir.poll-jira.plist` | macOS launchd job — fires every 60 minutes via `StartInterval`; Power Nap compatible; logs stdout and stderr separately |
| 4 | Automation — `.jira-credentials` | Credentials file (chmod 600) — keeps API token out of the script body |
| 5 | README — Fix | Removed duplicate Step 9/Step 10 headings in the What It Does section |
| 6 | README — Automated Polling section | New section documenting headless mode, the polling script, file locations, setup, and cache management |

---

### v1.1.0

| # | Step | Change |
|---|------|--------|
| 1 | Step 1 — Ingest Ticket | Field restriction — fetches only 13 specific fields; skips sprint, epic, watcher, and changelog data to reduce token usage |
| 2 | Step 1 — Ingest Ticket | MCP failure guard — stops on auth error / ticket not found / MCP unavailable and gives recovery instructions before proceeding |
| 3 | Step 2 — Analyse & Contextualise | Draw.io issue diagram — generates a happy-path vs broken-path `.drawio` diagram for non-trivial flows; auto-skips for single-file bugs |
| 4 | Step 3 — Create Branch | Feature/Release branch search — checks for `Feature/Release_{VERSION}` before falling back to the plain version branch |
| 5 | Step 3 — Create Branch | Base branch confirmation gate — verifies branch exists locally or remotely before any `git checkout`; asks developer if not found |
| 6 | Step 4 — Locate Code | Grep-first, read-second rule — explicitly forbids speculative full-file reads; token cost rationale documented |
| 7 | Step 4 — Locate Code | Recent git history column added to file map — runs `git log --oneline -3` per primary file |
| 8 | Step 4 — Locate Code | Confidence gate — Low confidence stops and asks; Medium flags assumption and proceeds |
| 9 | Step 5 — Replicate Issue | Replication confidence gate — Low stops and asks; Medium proceeds with explicit flag |
| 10 | Step 5 — Replicate Issue | Service restart guidance — tells developer which spawner/service to restart per layer (plugin, backend, frontend) |
| 11 | Step 7 — Propose Fix | DB migration scripts explicitly cover both Oracle (`.sql`) and PostgreSQL (`.pg`) |
| 12 | Step 8 — Change Summary | PR description template added — fully populated pull request body ready to paste (Jira link, branch, risk, test steps, retest areas, DB migration flag) |
| 13 | Step 10 — Session Stats | New step — prints elapsed time, estimated token count, and estimated cost at Sonnet 4.6 pricing |
| 14 | Step 11 — PDF Report | Temp file cleanup — removes `/tmp/{TICKET_KEY}-analysis.md` and `.html` after report is saved |
| 15 | Step 11 — PDF Report | Default output folder updated to `$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/` |

---

### v1.0.0 — Initial Release

| # | Step | Feature |
|---|------|---------|
| 1 | Ingest Ticket | Fetches Jira issue fields (summary, type, priority, status, assignee, reporter, labels, components, fix version, affected versions, description, comments, attachments) |
| 2 | Analyse & Contextualise | Attachment & diagnostic artefact analysis (screenshots, log files, thread dumps, memory/heap dumps, XML/config, draw.io diagrams) up to 10 MB per file |
| 2 | Analyse & Contextualise | Problem statement with bug vs enhancement classification |
| 2 | Analyse & Contextualise | Prior investigation carry-forward — extracts known root causes and findings from comments to avoid re-investigation |
| 2 | Analyse & Contextualise | Optional draw.io issue diagram for non-trivial data flows |
| 3 | Create Branch | Three-tier base branch priority: Fix Version → Affected Versions → `development` |
| 3 | Create Branch | Pauses and asks if base branch cannot be confirmed locally or remotely |
| 4 | Locate Code | Grep-first, read-second approach — never reads full files speculatively |
| 4 | Locate Code | File map table with role, key location, and recent git history per file |
| 4 | Locate Code | Confidence gate — pauses and asks if relevant code cannot be located with certainty |
| 5 | Replicate Issue | Numbered reproduction steps with prerequisites, expected result, actual result |
| 5 | Replicate Issue | Confidence gate — Low confidence pauses and asks; Medium notes assumptions and proceeds |
| 6 | Propose Fix | Root cause analysis with exact `ClassName.java:line` references |
| 6 | Propose Fix | Before/after code change blocks per file |
| 6 | Propose Fix | Interactive apply-to-branch — `yes` / `no` / `partial` selection |
| 6 | Propose Fix | DB migration scripts for both Oracle (`.sql`) and PostgreSQL (`.pg`) |
| 7 | Impact & Risk | Usage reference search — greps full codebase for all callers of modified methods, classes, and fields |
| 7 | Impact & Risk | Application-wide layer impact table (GWT Frontend, Backend API, Plugin/Workers, DB/Schema, Shared Utilities) |
| 7 | Impact & Risk | Regression risk analysis per change |
| 7 | Impact & Risk | Affected clients/environments classification (generic / client-specific / DB-specific) |
| 7 | Impact & Risk | Retest checklist derived from actual callers found |
| 7 | Impact & Risk | Objective risk rating: Low (0–1 callers) / Medium (2–5) / High (6+ or DB/shared utility) |
| 7 | Impact & Risk | Suggested commit message in project convention format |
| 8 | Change Summary | Files touched table with action and summary per file |
| 9 | Session Stats | Elapsed time, estimated token usage, and estimated cost at Sonnet 4.6 pricing |
| 10 | PDF Report | PDF generation via pandoc → Chrome headless → HTML fallback |
| 10 | PDF Report | Configurable output folder via `$CLAUDE_REPORT_DIR` (defaults to `~/Documents/Claude-Analyzed-Tickets/`) |
| 10 | PDF Report | Confirms output folder and full file path after saving |

---

## License

Internal use only — Prevoir.
