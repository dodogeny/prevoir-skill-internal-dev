# Prevoir Internal Dev Skill — Claude Code Plugin `v1.2.0`

A [Claude Code](https://claude.ai/code) plugin that gives Claude a structured, end-to-end developer workflow for V1 Jira tickets. Instead of manually reading a ticket, searching for files, and figuring out where to start, you invoke one command and Claude walks through the full cycle — from ticket ingestion to a proposed fix and archived report.

---

## What It Does

When you hand Claude a Jira ticket key (`IV-XXXX`), the skill executes **12 steps automatically**, presenting output at each step as it completes.

---

### Step 1 — Ingest Ticket

Fetches the Jira issue requesting only the 13 fields that matter — summary, type, priority, status, assignee, reporter, labels, components, fix version, affected versions, description, comments, and attachments. Sprint metadata, change logs, epic links, and watcher lists are not fetched.

If the MCP call fails (authentication error, ticket not found, MCP not running), Claude states the exact error and stops — it does not proceed with partial or missing data. The developer is given clear recovery steps before continuing.

---

### Step 2 — Analyse & Contextualise

Claude analyses the ticket description and all attachments, and produces:

- **Attachment review & diagnostic artefact analysis** — All qualifying attachments up to 10 MB are downloaded and analysed. Binary files, archives, and files over 10 MB are skipped automatically. Each attachment is identified by filename, type, and a one-line finding before detailed analysis:
  - *Screenshots / images* — UI state, error banners, field values, and any visible error codes are described
  - *Log files* — scanned for stack traces, exception chains, and error patterns; root cause frame extracted
  - *Thread dumps* — blocked/waiting threads identified, deadlock chains traced, contention point noted with class/method/line
  - *Memory / heap dumps* — dominant object type identified, exhausted heap space noted, GC patterns extracted
  - *XML / config files* — relevant config values checked for incorrect or missing entries
  - *draw.io diagrams* — flow depicted is described
  All attachment findings are carried forward into the root cause analysis in Step 7.
- **Problem statement** — A concise description of what is broken or missing, who is affected, what the expected behaviour is, what the current behaviour is, and a clear list of acceptance criteria. Bugs are explicitly labelled as defects; enhancements are explicitly labelled as stories.
- **Issue diagram** (optional) — For issues involving a non-obvious data flow or multi-step component interaction, Claude generates a draw.io XML diagram (`.drawio` file) showing the happy path alongside the broken path, annotated with the key method calls and data values involved. Trivial single-file bugs skip this automatically.

---

### Step 3 — Read Comments & Context

Claude fetches all comments on the ticket and extracts:

- **Clarifications** from the reporter or PO that affect scope or behaviour
- **Decisions** made in comments that change the implementation approach
- **Known constraints, edge cases, or related tickets** referenced by the team
- **Prior investigation summary** — if any comments contain previous investigation work (root cause findings, code traces, attempted fixes, identified files, or partial solutions), Claude extracts these as a structured block and carries them forward as known context for Steps 5, 7, and 8. This prevents re-investigating what is already established.

If there are no comments, Claude states this and proceeds from the description only.

---

### Step 4 — Create Development Branch

Claude determines the correct base branch using a three-tier priority:

1. **Fix Version is set** → derives the version string (e.g. `1.24.292` from `1.24.292.p1`), then checks whether `Feature/Release_{VERSION}` exists locally or on the remote. If found, forks from it so the fix builds on top of any release-level work already in progress. If not found, falls back to the plain version branch.
2. **Affected Versions is set** → forks from the plain version branch (e.g. `1.24.292`), stripping any patch suffix.
3. **Neither set** → forks from `development`.

**Confirmation gate:** Before any `git checkout`, Claude verifies the base branch exists locally or on the remote. If it cannot be confirmed in either place, Claude stops and asks the developer which branch to use rather than silently forking from a stale HEAD.

The feature branch is named: `Feature/IV-XXXX_Ticket_Summary_In_Title_Case` and checked out ready to code.

---

### Step 5 — Locate Affected Code

Claude searches the V1 codebase using a **grep-first, read-second** approach — it never reads an entire file speculatively. The flow is:

1. `Grep` to find the relevant class, method name, or keyword → get the exact file path and line number
2. `Read` only the relevant line range (the method ± surrounding context)
3. Full file reads only if the method spans many lines or the grep result is ambiguous

This is the primary token-saving measure — reading a 40-line method costs ~60 tokens vs ~3,000 tokens to read a 2,000-line Java file in full.

Claude builds a **file map** — a table of every affected file, its role in the fix, and the specific method or line range identified. The map also notes recent git history on primary files to surface related recent changes.

For **enhancement tickets that add new fields or methods**, Claude performs a mandatory **class hierarchy check**: it greps for the target class's inheritance chain, identifies the abstract base class (if any), and finds all sibling subclasses. This determines whether the new infrastructure (fields, getters/setters, utility methods) belongs in the concrete class or in the abstract base — where it would be inherited automatically by all current and future subclasses. Only config wiring (`getConfig()` items, `setAttribute()` cases) stays in the concrete class.

A **confidence gate** runs after the file map: if Claude cannot locate the relevant code with reasonable certainty, it pauses and asks for guidance rather than generating a speculative fix on the wrong files.

---

### Step 6 — Replicate the Issue

Claude produces complete, numbered reproduction instructions that any developer on the team can follow without prior knowledge of the issue:

- **Prerequisites** — which V1 modules must be running, which user role is needed, what test data must exist, any environment-specific notes (Oracle vs PostgreSQL, specific config flags)
- **Reproduction steps** — numbered step-by-step actions from login through to the symptom
- **Expected result** — what the system should do when working correctly
- **Actual result** — the exact symptom the reporter observes
- **Service restart guidance** — which spawner, worker, or application server must be restarted to pick up the fix during local testing, listed per layer (Plugin/Worker, Backend API, GWT Frontend)

A **confidence gate** applies: High confidence proceeds automatically; Medium notes the assumption and proceeds; Low pauses and asks the developer to clarify before continuing to Step 7.

---

### Step 7 — Root Cause Analysis

Step 7 has two paths. The correct path is chosen based on the Diagnostic Decision Tree (7a):

| Ticket type | Path |
|-------------|------|
| **Bug** (Data / UI / Async / Regression) | Engineering Panel (7b–7i) |
| **Enhancement** (feature that never existed) | Direct Analysis (Step 7-ENH) |

#### 7a. Diagnostic Decision Tree

The failure mode is classified first:
- **BUG — Data Issue** → NPE, field mapping error, SQL/ORM misconfiguration
- **BUG — UI Issue** → GWT callback not wired, RPC error swallowed, missing panel reload
- **BUG — Async/Timing Issue** → race condition, deadlock, out-of-order execution
- **BUG — Regression** → was working, now broken — Alex leads
- **Enhancement** → pure addition or modification of existing flow → **skip the Engineering Panel; go to Step 7-ENH**

---

#### Step 7-ENH — Enhancement Direct Analysis *(Enhancement tickets only)*

For enhancements, Claude skips the Engineering Panel entirely and performs a direct analysis:

1. **What needs to be added** — explains what the feature is and why it does not currently exist; states `"The system currently lacks X. We need to add Y at Z."` with specific file:line references
2. **Insertion point analysis** — identifies every file, method, and layer that must be touched, with a reason for each; runs the class hierarchy check (same as Step 5) to confirm whether new fields/methods belong in the abstract base or the concrete class
3. **Git history check** — confirms no partial implementation exists in any branch; if a partial exists, builds on it rather than duplicating
4. **Enhancement Statement** — a structured summary block (replaces the Root Cause Statement for Step 8):

```
ENHANCEMENT STATEMENT
────────────────────────────────────────────────────────────────────
What is missing : [one sentence — what the system cannot currently do]
Insertion points: [file:line for each touch point]
Approach        : [one paragraph — the design decision]
Class hierarchy : [N/A / Confirmed concrete class is correct /
                   Moved to {AbstractBase} — {N} sibling classes benefit]
Partial exists  : [No — confirmed by git log / Yes — {branch:file:line}]
Confidence      : High / Medium / Low
────────────────────────────────────────────────────────────────────
```

If confidence is Low, Claude stops and asks for developer clarification before proceeding to Step 8.

After completing Step 7-ENH, Claude proceeds directly to Step 8 (Propose the Fix).

---

#### Engineering Panel *(Bug tickets only — 7b through 7i)*

For bug tickets, a four-person senior engineering team convenes: **Morgan** (Lead Developer) chairs and has final authority; **Alex**, **Sam**, and **Jordan** (Senior Engineers) investigate independently under a time constraint and compete for the best analysis. The team debates, challenges each other's findings, and converges on a single agreed root cause.

**The team:**

| Role | Name | Background | Mandate |
|------|------|-----------|---------|
| **Lead Developer** | **Morgan** | 20 yrs Java, ex-systems architect, deep GWT/Spring/Oracle | Chairs. Sets schedule. Reviews hypotheses. Asks probing questions. Facilitates debate. Gives binding verdict. Approves the Root Cause Statement. Riley's concerns are factored into Morgan's verdict and Fix Review. |
| Senior Engineer | Alex | 12 yrs Java/GWT | Code archaeology & regression forensics — *"Every bug has a birthday."* |
| Senior Engineer | Sam | 10 yrs full-stack Java, Spring, GWT RPC | Runtime data flow & logic — *"Follow the data to the divergence point."* |
| Senior Engineer | Jordan | 15 yrs Java, architect background | Defensive patterns & structural anti-patterns — *"I've catalogued every way Java devs shoot themselves in the foot."* Jordan runs a prioritised 20-pattern checklist covering null safety, async errors, silent exceptions, thread safety, resource leaks, mutable static state, layer violations, serialization mismatches, broken equals/hashCode contracts, breaking API changes, circular dependencies, hardcoded environment values, and class hierarchy ownership. |
| **Senior Lead Tester** | **Riley** | 18 yrs QA & test architecture, Java enterprise, GWT, regression suites | Maps test surface and regression risk. Questions engineer findings on impact and testability grounds. Not competing — challenging. Riley's open question must be answered before a fix is approved; any High regression risk must be addressed or explicitly accepted by Morgan. |

Morgan and Riley are not competing — Morgan arbitrates, Riley challenges. Morgan's verdict is binding and must include a response to Riley's assessment.

**How the session runs:**

| Phase | Who | Time | What happens |
|-------|-----|------|-------------|
| **Briefing** | Morgan | 1 min | Reads ticket + file map, assigns focus areas to engineers and Riley, sets schedule |
| **Investigation** | Alex, Sam, Jordan + Riley | 4 min | Engineers investigate independently (max 8 ops each); Riley maps impact surface (max 6 ops) |
| **Mid-point check-in** | All | T+2 min | All four report progress to Morgan; Morgan acknowledges or redirects |
| **Hypothesis + assessment submission** | All | T+4 min | Engineers submit structured hypotheses; Riley submits Testing Impact Assessment |
| **Riley's questions + cross-examination** | Riley + Morgan | T+5 min | Riley poses open question to named engineer; Morgan cross-examines all hypotheses |
| **Debate** | All | T+5–6 min | One round of challenges — engineers on code grounds, Riley on impact/testability grounds |
| **Morgan's verdict** | Morgan | T+6 min | Scores hypotheses (max 15 pts), addresses Riley's assessment, declares adopted root cause |

Each engineer has a maximum of **8 targeted grep/read operations**; Riley has **6**. Morgan may run up to **4 additional targeted reads** to verify contested claims.

Morgan applies a 9-criterion scoring rubric (max 15 pts — the 9th criterion awards +1 if the fix direction is testable and Riley raised no High regression risk against it). The highest scorer wins. Morgan must include a **Tester's view** block in the verdict addressing Riley's regression risk and open question. The final Root Cause Statement includes a **Tester note** field capturing any outstanding Riley concern the fix author must handle.

#### Morgan Reviews the Proposed Fix (Step 8 gate)

After the fix is proposed in Step 8, Morgan vets it across **seven checks**: mechanism alignment, surgical scope, regression risk, team note honoured, DB safety, abstract class ownership, and **tester concerns addressed** (Riley's High/Medium impact concerns from Step 7e must be resolved or explicitly accepted as risk). Verdict is one of:

- **✅ APPROVED** — fix is correct, surgical, and safe to apply
- **⚠️ APPROVED WITH CONDITIONS** — apply after addressing a specific requirement
- **🔄 REWORK REQUIRED** — fix does not address the mechanism; Morgan provides direction for revision

The fix is not applied until Morgan approves.

---

### Step 8 — Propose the Fix

Claude reads the identified files and produces a fix grounded in the analysis from Step 7:
- **Bug tickets** — anchored to the Root Cause Statement from Step 7i (winning engineer, approved by Morgan)
- **Enhancement tickets** — anchored to the Enhancement Statement from Step 7-ENH

- **Proposed solution** — plain-language description of the approach before any code is shown
- **Code changes** — only the code that needs to change, shown as clear before/after blocks. Each change is explicitly tied to the root cause mechanism.
- **Alternative approaches** — a brief table of alternatives considered and why they were rejected
- **Apply to branch (interactive)** — after presenting the fix, Claude asks whether to apply the changes directly to the feature branch. Options: `yes` (apply all), `no` (developer applies manually), `partial` (apply selected files only). Changes are applied using targeted edits — no commit is made.
- **DB migration scripts** — if the fix requires schema changes, both an Oracle (`.sql`) and a PostgreSQL (`.pg`) script are provided. V1 supports both engines and SQL syntax is not assumed to be compatible across them.

---

### Step 9 — Impact Analysis

A full review of the consequences of the fix across the entire application — backed by active codebase searching, not assumptions:

- **Files changed table** — every file touched, the action taken (modified/created/deleted), what changed, and why
- **Usage reference search** — for every modified method, class, field, or API, Claude greps the full codebase and produces a reference table of all callers and usages found. Public methods, interface implementations, DB columns, and GWT RPC service methods are all checked. A symbol confirmed unused outside its class is explicitly stated as such.
- **Application-wide impact** — a layer-by-layer impact table covering: GWT Frontend, Backend API, Plugin/Workers, DB/Schema, and Shared Utilities. Each layer states the impact level and detail. Layers with zero references found are confirmed as unaffected.
- **Regression risks** — for each change: which existing flows are affected, callers that may behave differently after the change, DB data impact, and any race conditions or null pointer risks introduced
- **Affected clients/environments** — whether the fix is generic (all clients), client-specific (named client due to config differences), or DB-specific (different behaviour on Oracle vs PostgreSQL)
- **Retest checklist** — screens and flows outside the primary fix that should be smoke-tested, derived from the actual callers found in the usage search
- **Risk level** — rated objectively based on caller count: Low (0–1 callers), Medium (2–5), High (6+ or DB/shared utility change) — stated prominently with a justification sentence

---

### Step 10 — Change Summary

Claude compiles a developer-ready summary covering:

- **Files touched** — table of every file modified, created, or deleted with a one-line description
- **What changed and why** — one paragraph per file explaining the change and the reasoning
- **Suggested commit message** — ready-to-paste, following the project convention: `IV-XXXX_Title_VERSION`
- **PR description template** — a fully populated pull request body including Jira link, branch, **root cause statement** from Step 6, risk level, what changed, how to test, retest areas, and DB migration flag — ready to paste directly into GitHub/Bitbucket

---

### Step 11 — Session Stats

Prints a single summary line with elapsed time, estimated token usage, and estimated cost at Sonnet 4.6 pricing:

```
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)
```

---

### Step 12 — PDF Analysis Report

Claude generates a full-detail PDF report of the complete analysis — every section from every step — and saves it to a configurable output folder.

#### Report contents

The PDF is structured in 11 sections, one per step. Every section is fully populated from the actual analysis output — nothing is summarised or omitted:

| Section | Contents captured |
|---------|------------------|
| **Step 1 — Jira Ticket** | Full field table (key, type, priority, status, assignee, reporter, labels, components, fix/affected versions) + complete ticket description verbatim + attachment list |
| **Step 2 — Problem Understanding** | Problem statement table (what/who/expected/actual/acceptance criteria), ticket classification, attachment analysis findings, draw.io diagram note |
| **Step 3 — Comments & Context** | Comment summary bullets, full Prior Investigation Summary block (if found) |
| **Step 4 — Development Branch** | Base branch selected + reason, feature branch name, creation status |
| **Step 5 — Locate Affected Code** | Full file map table (file, role, key location, recent git history), confidence level, full class hierarchy analysis (if performed) |
| **Step 6 — Replication Guide** | Prerequisites, environment, numbered replication steps, expected vs actual table, confidence level, service restart guidance |
| **Step 7 — Root Cause Analysis** | **Bug tickets:** full Engineering Panel session — Morgan's briefing, mid-point check-in (Alex/Sam/Jordan/Riley), all four hypothesis/assessment blocks, Riley's question + engineer response, Morgan's cross-examination + engineer responses, full debate round, Morgan's scored verdict (with Tester's view), Root Cause Statement (with Tester note). **Enhancement tickets:** full Enhancement Statement (7-ENH) |
| **Step 8 — Proposed Fix** | Quoted analysis anchor, full proposed solution narrative + all before/after code blocks with annotations, alternatives table, full Morgan Fix Review block (all 7 checks + verdict), DB migration scripts (if applicable) |
| **Step 9 — Impact Analysis** | Files changed table, usage reference search results table (all symbols), application-wide impact table, regression risks list, affected clients/environments, retest areas, risk level with justification |
| **Step 10 — Change Summary** | Change summary bullets, suggested commit message, full PR description template |
| **Step 11 — Session Statistics** | Steps completed, elapsed time, estimated tokens, estimated cost, ticket type, RCA path taken, fix applied flag |

#### Generation

- **Output folder** — reads `$CLAUDE_REPORT_DIR` environment variable if set; defaults to `$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/`
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

The skill uses the **Atlassian MCP server** (`mcp-atlassian`) to read Jira tickets, download attachments, and search issues. The MCP server is configured via a `.mcp.json` file placed in the project root — this is the recommended approach as it keeps credentials local to the project and does not require the Claude Code Atlassian plugin.

#### 1. Generate a Jira API token

1. Log in to [https://id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a name (e.g. `Claude Code - V1`) and click **Create**
4. Copy the token — it will not be shown again

#### 2. Install the MCP server dependency

The MCP server runs via `uvx` (part of the `uv` Python package manager). Install `uv` if you don't have it:

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

`uvx` is included with `uv` — no separate install needed.

#### 3. Create the `.mcp.json` file

A `.mcp.json.example` file is included in the repository root. Copy it and fill in your credentials:

```bash
cp .mcp.json.example .mcp.json
```

Then edit `.mcp.json` and replace the placeholder values with your real credentials:

```json
{
  "mcpServers": {
    "jira": {
      "command": "uvx",
      "args": ["mcp-atlassian"],
      "env": {
        "JIRA_URL": "https://prevoirsolutions.atlassian.net",
        "JIRA_USERNAME": "your.name@prevoir.mu",
        "JIRA_API_TOKEN": "your-api-token-here"
      }
    }
  }
}
```

> **Security:** `.mcp.json` is listed in `.gitignore` and will not be committed. Never commit a file containing a real API token.

#### 4. Verify the connection

Open a Claude Code session in the project directory and ask:
```
search for Jira issue IV-1
```

If the MCP server is configured correctly, Claude will return the issue details. If you see a tool-not-found or authentication error:
- Confirm `uvx` is on your `PATH` (`uvx --version`)
- Re-check your Jira URL, username, and API token in `.mcp.json`
- Ensure your Atlassian account has at minimum read access to the `IV` project

> **Note:** The API token grants the same permissions as your Atlassian account. The `.mcp.json` file is loaded automatically by Claude Code when you open a session in the project directory — no further setup is required.

### Git
The repository must be present at `$HOME/git/insight/` locally. The skill resolves this path dynamically at runtime using `$HOME`. The skill creates branches there.

> **Different repo location?** Open `plugin/skills/dev/SKILL.md` and update the `REPO_DIR` line in the **Configuration** section near the top:
> ```
> REPO_DIR = $HOME/git/insight
> ```
> Change `git/insight` to the path of your local repository relative to your home directory (e.g. `$HOME/projects/v1` or an absolute path like `/opt/repos/insight`).

### PDF Generation (for Step 12 — PDF Report)

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

### 5. Upgrading

How you upgrade depends on which registration method you used in Step 2.

#### If you registered with a local path (manual clone)

Pull the latest changes into your cloned directory, then update the plugin:

**macOS / Linux:**
```bash
git -C ~/.claude/plugins/marketplaces/prevoir pull
claude plugin update prevoir@prevoir
```

**Windows (PowerShell):**
```powershell
git -C "$env:USERPROFILE\.claude\plugins\marketplaces\prevoir" pull
claude plugin update prevoir@prevoir
```

#### If you registered with the hosted Git URL

Claude Code manages the fetch from GitHub. Just run:

```bash
claude plugin update prevoir@prevoir
```

#### Verify the upgrade

```bash
claude plugin list
```

The version number next to `prevoir@prevoir` should reflect the latest release.

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

Claude will immediately begin executing all 12 steps in order, presenting output for each step as it completes.

### Example output structure

```
## Step 1 — Ticket Ingestion
IV-3672 | Bug | High | Assigned: Javed Neemuth
Summary: Resolving Cases should Resolve Alerts
...

## Step 2 — Analysis & Context
Problem: Alert Central alerts remain open after a case is resolved...
Diagram saved to /tmp/IV-3672-diagram.drawio

## Step 3 — Comments & Context
No prior investigation in comments — proceeding fresh.
No constraints or edge cases noted.

## Step 4 — Branch Created
Base branch: Feature/Release_1.26.064 (Fix Version set; Feature/Release branch found)
Created: Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts
HEAD: abc1234

## Step 5 — Affected Code
| File | Role | Key Location | Recent Git History |
...
File map confidence: High — proceeding.

## Step 6 — Replicate the Issue
Prerequisites: ...
Steps: 1. Log in as admin...
Confidence: Medium
Restart: Backend-only change — restart the application server (Tomcat/embedded).

## Step 7 — Root Cause Analysis (Engineering Panel)
Decision tree path: BUG → UI Issue → Boolean Flag Not Reset

── Morgan — Briefing ─────────────────────────────────────────────
Ticket: IV-3672 — Resolving Cases should Resolve Alerts
Classification: BUG → UI Issue → likely flag or callback not wired
Alex  → Check git history on CaseManager.java near resolveCase()
Sam   → Trace from the resolve button click down through the save callback
Jordan → Lead with patterns #1, #2, #3 (UI issue classification)
Schedule: T+2 check-in, T+4 hypotheses due, T+6 verdict
──────────────────────────────────────────────────────────────────

── Mid-Point Check-In (T+2) ──────────────────────────────────────
Alex  (3/8 ops): Found commit abc1234 — looks like a flag removal. Diffing now.
Sam   (3/8 ops): Traced to resolveCase():2272 — save callback fires but no alert chain reached.
Jordan (1/8 ops): Pattern #2 matched immediately at CaseManager.java:2272.

Morgan: Alex, confirm whether the removal was intentional — check the commit message.
        Sam and Jordan, you're converging on the same location — finish your evidence.
──────────────────────────────────────────────────────────────────

┌─ Alex — History & Regression Hypothesis ───────────────────────┐
│ Root cause   : pendingAlertResolve flag removed in commit abc1234 │
│                (IV-3601 "cleanup unused flags") — unintentional   │
│                deletion; commit message does not mention alerts   │
│ Evidence     : abc1234 — CaseManager.java:2272, flag assignment   │
│                deleted in that PR's cleanup sweep                 │
│ Fix direction: Restore the flag assignment before the save call   │
│ Confidence   : High  |  Ops used: 4 / 8                          │
│ Unknowns     : None — commit diff is conclusive                   │
└────────────────────────────────────────────────────────────────────┘

┌─ Sam — Data Flow & Logic Hypothesis ───────────────────────────┐
│ Root cause   : resolveCase():2272 sets RESOLVED status but        │
│                pendingAlertResolve is never set true; the async   │
│                callback ScreenCallBackAlertsForResolve is never   │
│                reached — alert chain is dead                      │
│ Evidence     : CaseManager.java:2272 — flag field exists,         │
│                onSuccess() fires, but flag is false; callback     │
│                guard `if (pendingAlertResolve)` is never entered  │
│ Fix direction: Set flag = true before the save onSuccess()        │
│ Confidence   : High  |  Ops used: 5 / 8                          │
│ Unknowns     : None — divergence point confirmed                  │
└───────────────────────────────────────────────────────────────────┘

┌─ Jordan — Defensive Patterns Hypothesis ───────────────────────┐
│ Root cause   : Boolean Flag Not Reset (#2) — pendingAlertResolve  │
│                field declared, never set true on the resolve path │
│ Pattern match: #2 Boolean Flag Not Reset                          │
│ Evidence     : CaseManager.java:2272 — `this.pendingAlertResolve  │
│                = false;` only; no `= true` on resolve branch      │
│ Fix direction: Add `pendingAlertResolve = true;` before save call │
│ Confidence   : High  |  Ops used: 2 / 8                          │
│ Unknowns     : None — pattern match unambiguous                   │
└───────────────────────────────────────────────────────────────────┘

── Morgan's Cross-Examination ─────────────────────────────────────
→ Alex: "The commit message says 'cleanup unused flags' — how do
   you know the removal was unintentional rather than a deliberate
   decision to disable alert resolution?"

Alex: "The linked ticket IV-3601 is about UI cleanup — no mention
   of alert behaviour. The flag is still referenced by the callback
   guard 5 lines below. If the intent was to remove alert resolution
   entirely, the guard and the callback class would also be gone."

→ Sam: "You say the callback guard `if (pendingAlertResolve)` is
   never entered. Is the callback even registered at the point
   resolveCase() is called, or does registration also need fixing?"

Sam: "The callback is registered in the constructor — it's always
   live. The only missing piece is setting the flag to true on the
   resolve path. The callback itself is wired correctly."

── Team Debate ────────────────────────────────────────────────────
Jordan challenges Alex: "You're attributing this to a commit removal.
But if that commit was intentional at the time, restoring the flag
alone might not be enough — someone might have removed it to fix a
different bug. Sam's flow trace confirms the mechanism; mine confirms
the pattern. The history is supporting evidence, not the cause."

Alex responds: "Fair. The root cause is the missing flag on the
resolve path. The commit confirms when it disappeared. Jordan's
pattern naming is the cleaner statement. I'll defer to that framing."

Morgan: "Good. Debate closed."
──────────────────────────────────────────────────────────────────

── Morgan's Verdict ───────────────────────────────────────────────
Scores:
  Alex   : 9 / 14 pts — strong historical evidence; correctly
                         deferred after debate shows good judgment
  Sam    : 11 / 14 pts — flow trace is thorough and confirms the
                          exact mechanism; callback registration
                          question answered well under pressure
  Jordan : 12 / 14 pts — matched the pattern in 2 ops, evidence is
                          code-level and unambiguous, survived
                          Alex's implicit challenge cleanly

My assessment: All three converged on the same location and mechanism.
Jordan named it fastest with the most precise code evidence. Sam's
callback registration clarification is important — it confirms the
fix is a single-line change. Alex's commit adds useful audit trail.
The adopted root cause is Jordan's with Sam's callback note added.

╔══════════════════════════════════════════════════════════════════╗
║  🏆  BEST ANALYSIS: Jordan           Score: 12 / 14 pts          ║
║  Morgan: "Pattern named precisely, evidence in 2 ops, fix        ║
║           direction immediately actionable. Sam's callback        ║
║           clarification incorporated into Team Note."            ║
╚══════════════════════════════════════════════════════════════════╝

ROOT CAUSE STATEMENT
────────────────────────────────────────────────────────────────────
Author    : Jordan  |  Approved by: Morgan
Location  : CaseManager.java:2272
Mechanism : pendingAlertResolve flag never set true on the resolve
            path — the callback guard `if (pendingAlertResolve)`
            is never entered; alert resolution chain is never reached
Trigger   : User resolves a case via Actions → Change Status → RESOLVED
Fix dir.  : Set pendingAlertResolve = true before the save onSuccess
            and wire ScreenCallBackAlertsForResolve
Confidence: High
Team note : Callback is already registered in constructor — only the
            flag assignment is missing. Single-line fix. (Sam)
────────────────────────────────────────────────────────────────────

## Step 8 — Proposed Fix
Root cause anchored at CaseManager.java:2272 (Jordan / approved by Morgan)...
Before/After: ...
Alternatives considered: 1 (rejected — higher regression risk)

── Morgan's Fix Review ────────────────────────────────────────────
Mechanism alignment : Confirmed — fix sets the flag Jordan identified
Surgical scope      : Confirmed — 1 file, 1 line changed
Regression risk     : Low — flag only affects the resolve code path
Team note honoured  : Yes — no callback registration change needed
DB safety           : N/A — no schema change

Morgan's verdict: ✅ APPROVED
──────────────────────────────────────────────────────────────────

## Step 9 — Impact Analysis
Risk: Low | Files changed: 2 | Retest: 3 items

## Step 10 — Change Summary
Files: 2 modified | Commit message ready to paste | PR description (with root cause + Jordan/Morgan attribution) ready to paste

## Step 11 — Session Stats
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)

## Step 12 — PDF Report
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
| Step 7 — Morgan briefing *(Bug only)* | Morgan opens and assigns focus | Briefing runs automatically |
| Step 7 — Mid-point check-in *(Bug only)* | Engineers and Riley report progress to Morgan | All four submit status; Morgan responds automatically |
| Step 7 — Riley's questions + cross-examination & debate *(Bug only)* | Riley questions engineer; Morgan cross-examines; one challenge round | Runs automatically; no developer input required |
| Step 7 — Morgan's verdict *(Bug only)* | Morgan scores and declares root cause | Verdict runs automatically |
| Step 8 — Morgan fix review | Morgan vets the proposed fix | Runs automatically; rework loop runs once if needed |
| Step 8 — Apply fix prompt | Ask yes / no / partial | **Defaults to no** — proposes the fix only; no files are edited |

The full 12-step analysis still runs and the PDF report is saved to disk. The developer reviews the PDF and applies the fix manually.

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
├── .mcp.json                             # Jira MCP server config (gitignored — contains your API token)
├── .mcp.json.example                     # Template for .mcp.json — copy and fill in your credentials
├── .gitignore
└── README.md
```

> **Not in the repo (gitignored):**
> - `.mcp.json` — Jira MCP server config containing your API token; create from the template in the Jira MCP Prerequisites section
> - `scripts/.jira-credentials` — your real API token for the polling script; created locally from `.jira-credentials.example`
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

### v1.2.0

#### Root Cause Analysis — Engineering Panel (Step 7 / SKILL)

| # | Area | Change |
|---|------|--------|
| 1 | Step 7 — Engineering Panel | **New dedicated RCA step** — replaced single-angle analysis with a structured 4-person senior engineering panel. Morgan (Lead Developer) chairs; Alex, Sam, and Jordan (Senior Engineers) investigate independently and compete for best analysis. |
| 2 | Step 7 — Morgan (Lead Developer) | 20-yr Java/GWT/Spring/Oracle expert. Sets the investigation schedule, assigns focus areas, poses probing questions, facilitates one debate round, scores all hypotheses, and gives a binding verdict. Not competing — arbitrates. |
| 3 | Step 7 — Engineer Personas | Alex (12 yrs): git history & regression forensics — *"Every bug has a birthday."* Sam (10 yrs): runtime data flow & logic tracing — *"Follow the data to the divergence point."* Jordan (15 yrs, architect): defensive patterns & anti-patterns — *"I've catalogued every way Java devs shoot themselves in the foot."* |
| 4 | Step 7 — Phased 6-minute session | Six sequential phases: Morgan briefing (1 min) → parallel investigation (4 min) → mid-point check-in (T+2) → hypothesis submission (T+4) → cross-examination & debate (T+5–6) → Morgan's verdict (T+6). |
| 5 | Step 7 — Investigation Budget | Each engineer: 4-minute window / max 8 targeted grep-read operations. Stop-early rule triggers if High confidence evidence is found in ≤ 4 ops. Morgan may run up to 4 additional reads to independently verify contested claims. |
| 6 | Step 7 — Mid-Point Check-In (T+2) | All three engineers submit a brief progress status to Morgan mid-investigation. Morgan acknowledges, redirects off-track engineers, or calls an early stop if conclusive evidence has already been found. |
| 7 | Step 7 — Morgan Cross-Examination | After hypothesis submission, Morgan poses 1–2 targeted probing questions per hypothesis to stress-test reasoning. Engineers respond with code evidence, not opinion. |
| 8 | Step 7 — Team Debate | One round of engineer-to-engineer challenges. Any engineer may challenge another's hypothesis with specific counter-evidence; the challenged engineer responds once. Morgan moderates and closes the debate. |
| 9 | Step 7 — Competitive Scoring (max 14 pts) | 8 criteria scored by Morgan: code evidence (+3), fix direction (+2), intermittent explanation (+2), calibrated confidence (+1), independent corroboration (+2), found efficiently ≤ 5 ops (+1), survived cross-examination (+2), debate challenge deflected (+1). |
| 10 | Step 7 — Verdict outcomes | 🏆 Best Analysis (endorsement), 🤝 Consensus (joint credit), 🏆 + 📝 Refinement (Morgan improves the winning hypothesis), or ⚡ Morgan Override (independent read finds what the team missed). |
| 11 | Step 7 — Root Cause Statement | Authored by the winning engineer, approved by Morgan. Includes a Team Note capturing any debate nuance the fix author must not overlook. |
| 12 | Step 8 — Morgan Fix Review | Before the fix is applied, Morgan vets it across 5 checks: mechanism alignment, surgical scope, regression risk, team note honoured, DB safety. Verdict: ✅ Approved / ⚠️ Approved with Conditions / 🔄 Rework Required (one rework loop allowed). |
| 13 | Step 8 — Propose Fix | Root Cause Statement quoted verbatim as mandatory anchor. Each code change annotated with which mechanism it addresses. Alternative approaches table added. |
| 14 | Step 10 — Change Summary | PR description template updated to include Root Cause Statement with winning engineer attribution and Morgan's approval. |
| 15 | Steps renumbered | New dedicated RCA step inserted as Step 7 (SKILL). Old Step 7 (Propose Fix) → Step 8. Old Step 8 (Impact) → Step 9. Old Step 9 (Summary) → Step 10. Old Step 10 (Stats) → Step 11. Old Step 11 (PDF) → Step 12. Total: 12 SKILL steps. |

#### Engineering Panel — Senior Lead Tester (Riley)

| # | Area | Change |
|---|------|--------|
| 22 | Step 7 — Team | **Riley added as Senior Lead Tester** — 18 yrs QA and test architecture for Java enterprise and GWT applications. Riley is not competing for Best Analysis — Riley challenges and assesses from a testing perspective. Riley's concerns carry weight: any High regression risk or unanswered open question must be addressed by Morgan in the verdict and Fix Review. |
| 23 | Step 7b — Briefing | **Morgan's briefing extended** — Riley receives an explicit assignment in the Lead Briefing block: map the test surface, identify affected user flows, flag edge cases the engineers may miss, and raise any testability concern with the suspected fix direction. Schedule updated to include Riley's question slot at T+5. |
| 24 | Step 7c — Investigation | **Riley's parallel impact assessment** — runs alongside engineer investigation with a capped budget of 6 operations. Riley reviews the ticket acceptance criteria, replication guide, affected file map, and all user flows passing through suspect files. Output: affected flows, edge cases, testability assessment, and one open question directed at a specific engineer or Morgan. |
| 25 | Step 7d — Mid-point check-in | **Riley added to mid-point check-in** — Riley submits a progress status alongside the three engineers. Morgan may redirect Riley's focus (e.g. "the cancel path concern is valid — include a test scenario for it"). |
| 26 | Step 7e — Assessment submission | **Testing Impact Assessment block** — Riley submits a structured assessment (hypothesis risk, affected flows, edge cases, testability, regression risk severity, open question) at T+4 alongside the engineer hypotheses. The assessment is advisory, not scored. |
| 27 | Step 7f — Cross-examination | **Riley's questions phase** — Riley poses the Open question to the named engineer before Morgan's cross-examination begins. The engineer responds with evidence. Morgan's questions follow. |
| 28 | Step 7g — Debate | **Riley can challenge in the debate round** — Riley may mount one challenge on impact or testability grounds (not code grounds). Challenge format matches engineer challenges but focuses on affected flows and regression risk. |
| 29 | Step 7h — Verdict | **Scoring rubric extended to 15 pts** — new 9th criterion: +1 if the fix direction is testable and Riley raised no High regression risk against it. Verdict block now includes a mandatory **Tester's view** paragraph where Morgan addresses Riley's assessment. Summary block includes a Riley line. |
| 30 | Step 7i — Root Cause Statement | **Tester note field added** — the Root Cause Statement now includes an optional Tester note (Riley's key concern or confirmation) that the fix author must not overlook. |
| 31 | Step 8c — Morgan Fix Review | **Seventh check added: Tester concerns** — Morgan confirms whether Riley's High/Medium impact concerns are addressed by the proposed fix, or explicitly accepts them as risk. Fix Review output block updated with `Tester concerns` field. |

#### Enhancement Workflow — Direct Analysis Path

| # | Area | Change |
|---|------|--------|
| 32 | Step 7 — Enhancement tickets | **Engineering Panel skipped for enhancements** — when the Decision Tree classifies a ticket as Enhancement, Step 7 now routes directly to Step 7-ENH (Direct Analysis) and bypasses the full Engineering Panel. The panel (Morgan + Alex + Sam + Jordan + Riley) is for bugs only. |
| 33 | Step 7-ENH — Direct Analysis | **New four-part enhancement analysis**: (a) what needs to be added (file:line references), (b) insertion point analysis per touch point with class hierarchy check, (c) git history check confirming no partial implementation exists, (d) Enhancement Statement block that anchors Step 8 (replaces Root Cause Statement for enhancements). |
| 34 | Step 8 — Anchor | **Dual anchor support** — Step 8 now anchors to either the Root Cause Statement (bug) or Enhancement Statement (enhancement) depending on ticket type. Annotation text updated to reference the correct statement type. |

#### PDF Report — Full-Detail Capture

| # | Area | Change |
|---|------|--------|
| 35 | Step 12 — PDF Report | **Report upgraded from placeholder to full-detail capture** — the Markdown source template (12b) now contains a structured section for every step. Each section is populated verbatim from the actual analysis output — no summaries, no abbreviations. The full Engineering Panel session (all phases: briefing, mid-point, hypotheses, Riley's assessment, cross-examination, debate, verdict, Root Cause Statement) is reproduced in the report. Enhancement tickets reproduce the full Enhancement Statement. |
| 36 | Step 12 — PDF Report | **11-section structure defined** — one section per step (Steps 1–11), each with explicit sub-headings and table/block templates matching the step's actual output format. Covers: Jira fields + description, problem statement table, comment summary + prior investigation, branch details, file map + class hierarchy, replication steps + service restart guidance, full RCA session or Enhancement Statement, full proposed fix + Morgan Fix Review, impact tables + regression risks, change summary + PR template, session statistics. |
| 37 | Step 12 — PDF Report | **README Step 12 section updated** — now includes a Report Contents table describing what is captured in each of the 11 sections, so developers know the report contains the complete analysis record. |

#### Analysis Quality — Enhancements & Abstract Class Ownership

| # | Area | Change |
|---|------|--------|
| 16 | Step 5 — Locate Code | **Class hierarchy check (mandatory for enhancements)** — when an enhancement ticket adds new fields or methods, Claude now greps the full inheritance chain of the target class, identifies the abstract base and all sibling subclasses, and explicitly determines whether the new infrastructure belongs in the concrete class or the abstract base. The abstract base (if applicable) is added to the file map with role "Abstract base — owns shared infrastructure". |
| 17 | Step 7 — Jordan (Defensive Patterns) | **New pattern #11: Wrong Ownership Level** — Jordan now checks whether new fields, getters/setters, or utility methods are placed in the correct class. If the concrete class has an abstract base that already owns similar state, the new infrastructure belongs in the base; only `getConfig()` items and `setAttribute()` cases stay in the concrete class. Priority order updated: Enhancements → {11, 7}. |
| 18 | Step 8 — Morgan's Fix Review | **New check #6: Abstract class ownership** — Morgan now explicitly verifies whether new infrastructure added to a concrete class should be moved to its abstract base. Runs `grep "extends {AbstractBase}"` to find siblings. Fix Review output updated with new `Abstract class ownership` field. |
| 19 | Prerequisites — Jira MCP | **Replaced plugin-based MCP setup with `.mcp.json` approach** — the Atlassian MCP server is now configured via a project-level `.mcp.json` file using `uvx mcp-atlassian`. The file is gitignored. Setup instructions updated with `uv` install steps and credential template. |
| 21 | Step 7 — Jordan (Defensive Patterns) | **Pattern #1 Null Pointer expanded to 6 sub-cases** — Jordan now checks all six distinct NPE triggers: (a) service/RPC return value not null-checked, (b) `Map.get()` result used without a null guard, (c) method chain with no intermediate null guards (`a.getB().getC()`), (d) null wrapper auto-unboxed in arithmetic or boolean expression, (e) `str.equals("literal")` where `str` may be null (should be `"literal".equals(str)`), (f) enhanced `for` loop over a collection that could itself be null (distinct from pattern #5 which covers non-null but empty/unchecked collections). |
| 20 | Step 7 — Jordan (Defensive Patterns) | **Expanded checklist from 11 to 20 patterns** — nine new patterns added: #12 Resource Leak (`Closeable` not closed in exception paths), #13 Mutable Static State (non-final statics shared across servlet requests), #14 Leaking Abstraction (DAO/ORM types surfacing in service or UI layer), #15 Circular Dependency (package-level import cycles), #16 Breaking API Change (public signature change without backward-compatible overload), #17 equals/hashCode Contract Broken (one overridden without the other, or mutable field in hashCode), #18 Serialization Mismatch (field added/removed without updating `serialVersionUID` in GWT DTOs), #19 Unchecked Cast Without Guard (cast not preceded by `instanceof`), #20 Hardcoded Environment Value (IP/port/timeout baked into logic). Priority order updated: Data issues → {1, 5, 6, 9, 12, 13}; Regressions → {2, 8, 17, 18}; Enhancements → {11, 7, 16}; Architecture → {14, 15, 19, 20}. |

#### Automation & Headless Mode

| # | Area | Change |
|---|------|--------|
| 16 | Skill — Headless Mode (`AUTO_MODE=true`) | All interactive gates bypass with safe defaults — branch creation and file edits are skipped; full analysis and PDF report still run |
| 17 | Headless — Morgan phases | All Morgan phases (briefing, mid-check, cross-examination, debate, verdict, fix review) run automatically with no developer input; rework loop runs once if Morgan returns REWORK REQUIRED |
| 18 | Automation — `poll-jira.sh` | New cross-platform polling script — queries Jira every 60 minutes for tickets assigned to you with status To Do, Open, Parked, or Blocked; detects OS at runtime and uses `osascript` (macOS), `notify-send` (Linux), or PowerShell balloon tip (Windows WSL) |
| 19 | Automation — `com.prevoir.poll-jira.plist` | macOS launchd job — fires every 60 minutes via `StartInterval`; Power Nap compatible when plugged in; logs stdout and stderr to separate files |
| 20 | Automation — `.jira-credentials` | Credentials file (chmod 600, gitignored) — keeps Jira API token and email out of the script body |
| 21 | README — Automated Polling section | New section documenting headless mode, polling script, file locations, cross-platform setup, and cache management |

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
