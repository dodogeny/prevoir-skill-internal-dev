---
name: dev
description: Prevoir internal developer workflow skill. Use when a developer provides a Jira ticket URL or ticket key (e.g. IV-1234) and wants to start development work. Handles the full workflow from reading the Jira ticket to proposing a code fix — including reading the description, understanding the problem, checking comments, creating a git branch, locating affected code, and proposing a fix with explanation.
version: 1.1.0
---

# Prevoir Dev Workflow Skill

Full end-to-end developer onboarding workflow for V1 Jira tickets. Guides Claude through reading, understanding, branching, locating, and fixing a reported issue or enhancement.

## Configuration

Before executing any step, resolve the following variable by running `echo $HOME` via Bash:

```
REPO_DIR = $HOME/git/insight
```

Use `REPO_DIR` wherever the repository path is referenced throughout this skill.

## Headless Mode

If the environment variable `AUTO_MODE=true` is set, the skill runs in **analysis-only mode** with no interactive prompts and no side effects:

| Gate | Interactive behaviour | Headless default |
|------|-----------------------|-----------------|
| Step 1 — MCP failure | Stop and wait for developer | Print `HEADLESS_ERROR: {reason}` and exit immediately |
| Step 4a — Base branch unconfirmed | Ask developer which branch to use | Default to `development`; note the fallback in output |
| Step 4c — Branch creation | Run `git checkout -b …` | **Skip** — report the branch name that would be created, run no git commands |
| Step 5 — Low file-map confidence | Stop and ask developer | Proceed with `⚠️ LOW CONFIDENCE — manual review required` |
| Step 6e — Low replication confidence | Stop and ask developer | Proceed with `⚠️ LOW CONFIDENCE — assumptions noted` |
| Step 7c — Apply fix prompt | Ask yes / no / partial | **Default to no** — propose the fix only; do not call Edit or modify any files |

In headless mode, Steps 1–9 still run and produce full output. Steps 10 and 11 (session stats + PDF report) run as normal so the PDF is saved to disk.

---

## When to Use This Skill

Invoke when the developer provides:
- A Jira ticket URL: `https://prevoirsolutions.atlassian.net/browse/IV-XXXX`
- A Jira ticket key: `IV-XXXX`
- A phrase like `/prevoir:dev IV-3672` or `/dev IV-3672` or "start dev on IV-3672" or "pick up IV-3672"

Do NOT invoke for general code questions, PR reviews, or questions unrelated to starting work on a Jira ticket.

## Workflow Steps

Execute all steps **in order**. Do not skip steps. Present output to the developer as you complete each one.

---

### Step 1 — Read the Jira Ticket

Use `mcp__jira__get_issue` with the ticket key extracted from the input. Request only the fields needed: `summary`, `issuetype`, `priority`, `status`, `assignee`, `reporter`, `labels`, `components`, `fixVersions`, `versions`, `description`, `comment`, `attachment`. Do not fetch sprint metadata, change logs, epic links, or watcher lists.

**If the MCP call fails** (authentication error, ticket not found, MCP server not running):
- State the exact error returned
- Do not proceed to Step 2
- Instruct the developer to verify: (1) the Atlassian MCP is running, (2) the API token is valid, (3) the ticket key is correct
- Stop here until the developer confirms the issue is resolved

Display:
- **Summary** (ticket title)
- **Type** (Story / Bug / Support / Task)
- **Priority**
- **Status**
- **Assignee** and **Reporter**
- **Labels** and **Components**
- **Fix Version** (target release)
- **Full description** — extract all text from the ADF body content

---

### Step 2 — Understand the Problem

Analyse the description and produce a concise internal summary:

- **What is the problem / enhancement?** (1–2 sentences)
- **Who is affected?** (which user role, client, or system)
- **What is the expected behaviour?**
- **What is the current (broken/missing) behaviour?**
- **Acceptance criteria** — list each criterion clearly

If the ticket type is a **Bug**, explicitly state:
> "This is a defect — the system is doing X but should be doing Y."

If the ticket type is a **Story/Enhancement**, explicitly state:
> "This is an enhancement — the system currently lacks X; we need to add Y."

#### Diagnostic Artefact Analysis

Download and analyse all qualifying attachments from the ticket. Apply these rules:

| Attachment type | Size limit | Action |
|----------------|------------|--------|
| Images / screenshots | ≤ 10 MB | Describe visually — UI state, error messages, highlighted fields |
| Log files (`.log`, `.txt`) | ≤ 10 MB | Scan for stack traces, exceptions, and error patterns |
| Thread dumps (`.tdump`, `.txt` with thread stacks) | ≤ 10 MB | Full analysis — see below |
| Memory / heap dumps (`.hprof`, `.heap`) | ≤ 10 MB | Full analysis — see below |
| XML / config files | ≤ 10 MB | Check for relevant config values, malformed entries |
| draw.io diagrams (`.drawio`, `.xml`) | ≤ 10 MB | Describe the flow depicted |
| Binary files, archives (`.zip`, `.jar`, `.war`, `.class`) | any | Skip — state "skipped (binary/archive)" |
| Any file > 10 MB | — | Skip — state "skipped (exceeds 10 MB limit)" |

For each attachment analysed, state its filename, type, size, and a one-line summary of what was found before the detailed analysis below.

---

**Screenshots / Images:**
- Describe the UI state visible — screen name, error banners, field values, highlighted rows
- Note any error codes, HTTP status, or modal messages visible in the screenshot

**Thread Dumps** (`.tdump`, `.txt`, `.log` files containing thread stack traces):
- Identify threads in `BLOCKED`, `WAITING`, or `TIMED_WAITING` state
- Look for deadlock indicators (threads waiting on locks held by each other)
- Extract the top stack frames from the relevant thread — note the class and method at the point of contention
- Summarise: "Thread `X` is blocked at `ClassName.method():line` waiting for lock held by thread `Y`"

**Memory Dumps / Heap Dumps** (`.hprof`, `.heap`, OOM log excerpts):
- Identify the object type dominating heap usage
- Note the `OutOfMemoryError` message and which heap space was exhausted (heap, metaspace, stack)
- Extract any GC log patterns if present (frequent full GCs, long pause times)
- Summarise: "Heap exhausted by `N` instances of `ClassName` — likely a retention/leak in `FlowX`"

**Application / Server Logs** (`.log`, stack trace excerpts in description or attachments):
- Extract the full exception chain (root cause first)
- Note the first application frame in the stack trace (below any framework frames)
- Note timestamps and whether the error is intermittent or consistent
- Summarise: "`NullPointerException` at `ClassName.method():line` — triggered when `condition`"

**XML / Config Files:**
- Identify the config type (worker config, routing rule, datasource, etc.)
- Note any values that appear incorrect, missing, or relevant to the reported issue

If no attachments are present, state: "No attachments found — proceeding from description only."
If attachments are present but none are qualifying types, state: "Attachments present but all skipped (binary/archive or exceeds 10 MB)."

Carry all findings forward into the **Prior Investigation Summary** in Step 3 and the **Root Cause Analysis** in Step 7.

#### Issue Diagram (optional)

For issues involving a **non-obvious data flow or multi-step component interaction** (e.g. a race condition, a cross-layer call chain, a plugin → backend → DB path), generate a draw.io XML diagram and save it to `/tmp/{TICKET_KEY}-diagram.drawio`.

The diagram should show:
- The **happy path** (what should happen) as a green flow
- The **broken path** (what actually happens) as a red flow
- Key method calls and data values annotated at each transition point

State: `Diagram saved to /tmp/{TICKET_KEY}-diagram.drawio`

**Skip this diagram automatically for** trivial single-file bugs, simple null checks, or straightforward field additions where the flow is self-evident from the code. State: `Diagram skipped — single-file change, flow is self-evident.`

---

### Step 3 — Read Comments for Additional Context

Use `mcp__jira__get_comments` to fetch all comments on the ticket.

Summarise:
- Any clarifications from the reporter or PO
- Decisions made in comments that affect implementation
- Known constraints, edge cases, or related tickets mentioned
- Any prior investigation or partial fixes already done

If there are no comments, state: "No comments — proceed from description only."

#### Prior Investigation Carry-Forward

If any comments contain previous investigation work (root cause findings, code traces, attempted fixes, identified files, test results, or partial solutions), extract and explicitly carry these forward as **known context** for Steps 5, 6, and 7. Do not re-investigate what has already been established.

Produce a **Prior Investigation Summary** block if applicable:

```
Prior Investigation Summary:
- Root cause identified: [what was found]
- Files already identified: [list]
- Attempted fixes: [what was tried and outcome]
- Confirmed working / not working: [what was already validated]
- Remaining unknowns: [what is still unresolved]
```

This summary must be referenced in Step 7 (Propose the Fix) — build the solution on top of what is already known rather than starting from scratch.

---

### Step 4 — Create the Development Branch

#### 4a. Determine the Base Branch

Use the following priority order to determine the base branch:

1. **Fix Versions is set** → derive the version string (e.g. `1.24.292` from `1.24.292.p1`), then check whether a release feature branch exists:
   ```bash
   git branch --list "Feature/Release_{VERSION}" && git branch -r | grep "Feature/Release_{VERSION}"
   ```
   - If `Feature/Release_{VERSION}` exists (locally or remotely) → fork from it, so the fix builds on top of any release-level work already in progress
   - If not found → fork from the plain version branch (e.g. `1.24.292`)
2. **Fix Versions is empty, Affected Versions is set** → fork from the plain version branch (e.g. `1.24.292`)
3. **Both are empty** → fork from `development`

| Version value          | Feature/Release branch found? | Base branch to use              |
|------------------------|------------------------------|---------------------------------|
| Not set / empty        | —                            | `development`                   |
| e.g. `1.24.292.p1`    | Yes (`Feature/Release_1.24.292`) | `Feature/Release_1.24.292`  |
| e.g. `1.24.292.p1`    | No                           | `1.24.292`                      |
| e.g. `1.24.292`        | Yes                          | `Feature/Release_1.24.292`      |
| e.g. `1.24.292`        | No                           | `1.24.292`                      |

Rule: Strip any suffix after the third version segment (e.g. `.p1`, `.hotfix`) — always use the base `major.minor.patch` format as the version string.

**Base branch confirmation gate:** Before running any `git checkout` or `git checkout -b` command, verify the chosen base branch exists either locally or on the remote:
```bash
git branch --list {BASE_BRANCH}
git branch -r | grep "origin/{BASE_BRANCH}"
```
If it cannot be confirmed in either location, **stop and ask the developer** which branch to use rather than silently forking from a stale or incorrect HEAD.

State clearly which base branch will be used and why before running any git command.

#### 4b. Determine the Feature Branch Name

Use this format:
```
Feature/{TICKET_KEY}_{Ticket_Summary_Title_Case_Underscored}
```

Rules:
- Replace spaces with underscores
- Remove special characters (except underscores)
- Title-case each word
- Keep it under 80 characters total
- Prefix always `Feature/`

Example: `IV-3672` + "Resolving Cases should Resolve Alerts"
→ `Feature/IV-3672_Resolving_Cases_Should_Resolve_Alerts`

#### 4c. Create the Branch

Run the following commands **in the repository working directory** (`{REPO_DIR}/`):

First, check if the base branch exists locally:

```bash
git branch --list {BASE_BRANCH}
```

- **If the branch exists locally** — check it out directly, no remote sync:
  ```bash
  git checkout {BASE_BRANCH}
  git checkout -b Feature/{TICKET_KEY}_{Formatted_Title}
  ```

- **If the branch does NOT exist locally** — fetch it from remote first, then fork:
  ```bash
  git fetch origin {BASE_BRANCH}
  git checkout -b {BASE_BRANCH} origin/{BASE_BRANCH}
  git checkout -b Feature/{TICKET_KEY}_{Formatted_Title}
  ```

Confirm the branch was created and is checked out.

---

### Step 5 — Locate Affected Code

Based on the ticket description, comments, and labels, search the codebase at `{REPO_DIR}/` to identify:

1. **Primary files likely affected** — use Grep/Glob to locate relevant classes, methods, or config
2. **Entry point** — where does the flow start? (API endpoint, UI event handler, worker, scheduled job)
3. **Data flow** — trace the relevant path through the layers (Frontend → API → DataSource → DB, or Worker → Plugin → etc.)
4. **Related files** — any model, DTO, or DB script changes that will likely be needed

#### Grep-First, Read-Second Rule (mandatory)

Never read an entire source file speculatively. Always follow this sequence:

1. `Grep` for the relevant class name, method name, or keyword → get the exact file path and line number
2. `Read` only the relevant line range (the method ± ~20 lines of surrounding context)
3. Only read the full file if the method spans many lines or the grep result is ambiguous

Reading a 40-line method costs ~60 tokens. Reading a 2,000-line Java file costs ~3,000 tokens. Apply this discipline to every file in this step and in Step 7.

Use the ticket **Labels** and **Components** as hints:
- `CaseManager` → `fcfrontend/.../view/CaseManager.java`
- `AlertCentral` → `fcfrontend/.../view/AlertCentral.java` and backend alert APIs
- `FRAMS` → case/alert related backend in `fcbackend/src/main/java/com/fc/api/`
- `Plugin`/`Worker` → `fcplugin/src/main/java/com/fc/plugin/`
- DB changes → `fcbuild/scripts/upgrades/`

Present a **file map** — list each file with its role, the specific method or line range identified, and recent git history for primary files:

| File | Role | Key Location | Recent Git History |
|------|------|-------------|-------------------|
| `fcfrontend/.../CaseManager.java` | Primary fix target | `resolveCase():2272` | Last modified: 3 days ago by Javed — "IV-3641 fix alert sync" |

To populate the Recent Git History column, run:
```bash
git log --oneline -3 -- {file_path}
```

#### Confidence Gate

After building the file map, assess your certainty:

- **High** — the relevant class, method, and line number are confirmed via grep → proceed automatically
- **Medium** — file identified but exact method is ambiguous; note the assumption and proceed, flagging it clearly
- **Low** — cannot locate the relevant code with reasonable certainty → **stop and ask the developer** for guidance before continuing to Step 6

State the confidence level explicitly: `File map confidence: High — proceeding.`

---

### Step 6 — Replicate the Issue

Based on the ticket description, comments, and located code, produce clear step-by-step reproduction instructions that any developer on the team can follow to observe the problem firsthand before attempting a fix.

#### 6a. Prerequisites
List everything needed before reproduction can begin:
- Required modules / spawners that must be running (e.g. Case Service, Alert Scanner)
- Specific user roles or permissions needed
- Test data that must exist (e.g. a case with open alerts, a specific alert type)
- Environment notes (e.g. Oracle vs Postgres, specific config flags)

#### 6b. Reproduction Steps
Number each step. Be explicit — do not assume prior knowledge:

```
1. Log in as a user with [role] permissions.
2. Navigate to [Screen] via [Menu path].
3. [Perform action — e.g. "Select a case with at least 2 open alerts in Alert Central."]
4. [Perform the triggering action — e.g. "Use the Actions dropdown → Change Status → RESOLVED."]
5. Navigate to Alert Central and search for the alerts that were in the case.
```

#### 6c. Expected Result
State clearly what **should** happen if the system were working correctly.

#### 6d. Actual Result (the bug / gap)
State clearly what **actually** happens — the symptom the reporter sees.

#### 6e. Replication Confidence
Rate how confidently this replication guide reflects the issue:
- **High** — reproduction steps are fully derived from ticket + code analysis → proceed automatically
- **Medium** — some assumptions made; note the assumption, proceed, and flag it clearly
- **Low** — limited information in ticket → **stop and ask the developer** to clarify before continuing to Step 7

If confidence is Medium or Low, list the specific unknowns or assumptions made.

#### 6f. Service Restart Guidance

If the fix touches the **Plugin or Worker layer** (`fcplugin/`), state which spawner or service must be restarted locally to pick up the change:

```
To test this fix locally, restart:
  - [Spawner/Worker name] — e.g. "CaseResolutionWorker" or "AlertScannerWorker"
  - Any dependent service that loads the plugin at startup
```

If the fix touches only the **GWT Frontend** (`fcfrontend/`), state: `Frontend-only change — recompile GWT module; no backend restart required.`

If the fix touches only the **Backend API** (`fcbackend/`), state: `Backend-only change — restart the application server (Tomcat/embedded).`

If the fix touches **multiple layers**, list each service that needs restarting in the correct order.

---

### Step 7 — Propose the Fix

Read the identified files and produce:

#### 7a. Root Cause Analysis
- Explain **why** the bug occurs or **why** the feature is missing
- Reference specific file paths and line numbers
- Be precise: "The issue is in `CaseManager.java:2272` — the flag is only set when..."

#### 7b. Proposed Solution
- Describe the approach before showing code
- Show **only the code that needs to change** (diff-style or clear before/after blocks)
- Explain each change and why it's needed

#### 7c. Apply Fix to Feature Branch (Interactive)

After presenting the proposed solution, ask the developer:

> **Would you like me to apply these changes to the feature branch now?**
> - `yes` — apply all proposed changes directly to the files on the current feature branch
> - `no` — skip; the developer will apply manually
> - `partial` — ask which specific changes to apply

If the developer answers **yes** or **partial**:
- Use the Edit tool to apply changes to each identified file
- After each file is modified, confirm: "Applied change to `{file}:{line}`"
- Do NOT commit — leave the changes staged for the developer to review and commit using the suggested message from Step 9c

If the developer answers **no**, continue to Step 8 without modifying any files.

#### 7d. DB Migration (if needed)
If the fix requires schema changes, provide the upgrade script template:
```sql
-- v1.XX.XXX.sql / .pg
-- IV-XXXX: <description>
ALTER TABLE ...
```

---

### Step 8 — Impact Analysis

Assess the full consequences of the proposed fix across the entire application. This step requires active codebase searching — do not rely on assumptions. Use Grep to find every reference to changed symbols before drawing conclusions.

#### 8a. Files Changed
List every file touched by the fix with a one-line description of what changed and why:

| File | Change | Reason |
|------|--------|--------|
| `fcfrontend/.../CaseManager.java` | Added `pendingAlertResolve` flag and async callback chain | Core fix for alert resolution |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | New table / column | Schema required for fix |

#### 8b. Usage Reference Search (mandatory)

For **every method, class, field, or API endpoint** modified by the fix, search the full codebase for all callers and references:

```
Grep: {modified method or class name} → across {REPO_DIR}/
```

For each symbol changed, produce a reference table:

| Symbol Changed | Type | Callers / References Found | Files |
|----------------|------|---------------------------|-------|
| `resolveAlertCentral(...)` | method | 3 callers | `CaseManager.java`, `AlertCentral.java`, `CaseDetailsPanel.java` |
| `pendingAlertResolve` | field | local to `CaseManager` | `CaseManager.java` only |

Rules:
- If a changed method is `public` or `protected` — always search for all callers across the full repo
- If a changed method is `private` — confirm it is only called within the same class
- If a changed interface or abstract method — find all implementing classes
- If a DB column or table is changed — grep for all SQL references and ORM mappings to that table/column
- If a GWT RPC service method signature changes — find all client call sites and the corresponding server-side implementation

#### 8c. Application-Wide Impact

Based on the usage reference search, describe the impact across each application layer:

| Layer | Impact | Detail |
|-------|--------|--------|
| GWT Frontend | e.g. Medium | `CaseManager` change affects resolve flow; 2 other panels call same service |
| Backend API | e.g. Low | No API signature change; internal logic only |
| Plugin / Workers | e.g. None | No worker classes reference changed code |
| DB / Schema | e.g. High | Column rename affects 4 SQL queries across 3 upgrade scripts |
| Shared Utilities | e.g. Low | `RecordHelper` change only affects timed-wait resume path |

If a layer is not affected, state "None — confirmed by grep (0 references found)."

#### 8d. Regression Risks
For each change, identify what existing behaviour could break:
- Which existing flows pass through the modified code?
- Could the DB change affect existing data or other screens that read the same table?
- Flag any race conditions, null pointer risks, or async timing concerns introduced
- Flag any callers found in 8b that may behave differently after the change

#### 8e. Affected Clients / Environments
State whether the fix is:
- **Generic** — affects all clients running this version
- **Client-specific** — only affects a named client (e.g. FNB, VCL, DRC) due to config or data differences
- **DB-specific** — behaviour differs between Oracle and PostgreSQL implementations

#### 8f. Related Areas to Retest
List screens, flows, or features outside the primary fix that should be smoke-tested — derived from the callers found in 8b:
- e.g. "Alert Central resolve button should still work independently"
- e.g. "Case Details tab resolve should behave the same as All Cases tab"

#### 8g. Risk Level

Rate the overall risk of the change based on the usage reference search results:

| Rating | Criteria |
|--------|----------|
| **Low** | Change is isolated; 0–1 callers found; no shared utilities or DB touched; easy to revert |
| **Medium** | 2–5 callers found; touches shared logic or a secondary screen; regression testing recommended |
| **High** | 6+ callers found; modifies a public API, shared utility, or DB schema; thorough QA required before release |

State the rating prominently:

> **Risk Level: Medium** — 3 callers of `resolveAlertCentral` found across 2 screens; existing Alert Central resolve path must be retested.

---

### Step 9 — Change Summary

Produce a concise, developer-friendly summary of everything that was done. This serves as a reference for commit messages, PR descriptions, and handover notes.

#### 9a. Files Touched

List every file modified, created, or deleted by the fix:

| File | Action | Summary of Change |
|------|--------|-------------------|
| `fcfrontend/.../CaseManager.java` | Modified | Added alert resolution chain triggered on case resolve |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | Created | Added new table `B_TR_TASK_RESPONSES` |

#### 9b. What Was Changed and Why

For each file, one short paragraph explaining:
- What was changed (the what)
- Why it was necessary to make this change (the why)
- Any notable decisions or trade-offs made

#### 9c. Suggested Commit Message

Provide a ready-to-use commit message following the project convention:

```
{VERSION}_{TICKET_KEY} {Short description of fix}

- {Bullet point of key change 1}
- {Bullet point of key change 2}
```

Example:
```
IV3672_Resolving_Cases_should_Resolve_Alerts_1.26.064 IV3672 Mustakeem Lee

- Added pendingAlertResolve flag to trigger alert resolution after case save
- Added ScreenCallBackAlertsForResolve to fetch and filter unresolved alerts
- Added ScreenCallBackResolveAlerts to finalise resolution via resolveAlertCentral
```

#### 9d. PR Description Template

Provide a ready-to-paste pull request description:

```
## {TICKET_KEY} — {Ticket Summary}

**Jira:** https://prevoirsolutions.atlassian.net/browse/{TICKET_KEY}
**Branch:** {feature branch name}
**Base:** {base branch}
**Risk:** {Low / Medium / High} — {one-line justification from Step 8g}

---

## What changed
{One paragraph describing the fix — the what and the why}

## Files changed
{Files touched table from Step 9a — abbreviated to file name and one-line summary}

## How to test
{Reproduction steps from Step 6b, rewritten as a verification checklist}

## Retest areas
{Retest checklist from Step 8f}

## DB migration required
{Yes — run v1.XX.XXX.sql/.pg before deploying | No}
```

---

### Step 10 — Session Stats

Print a single summary line covering elapsed time, estimated token usage, and estimated cost at current Sonnet 4.6 pricing:

```
{TICKET_KEY} | ~{N}m elapsed | ~{X} in / ~{Y} out tokens | est. cost ${Z} (Sonnet 4.6)
```

Pricing reference (Sonnet 4.6 as of skill version 1.1.0):
- Input: $3.00 / 1M tokens
- Output: $15.00 / 1M tokens

Estimate token counts from the volume of content processed (Jira fields, attachments, file reads, analysis produced). These are approximations — label them clearly with `~`.

Example:
```
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)
```

---

### Step 11 — Generate PDF Analysis Report

After Step 9 is complete, generate a full PDF report of the analysis and save it to disk.

#### 11a. Configuration

Resolve the output folder using this priority order:

1. If the environment variable `CLAUDE_REPORT_DIR` is set, use it
2. Otherwise default to: `$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/`

```bash
REPORT_DIR="${CLAUDE_REPORT_DIR:-$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets}"
mkdir -p "$REPORT_DIR"
```

#### 11b. Generate Markdown Source

Write a temporary Markdown file at `/tmp/{TICKET_KEY}-analysis.md` containing the full analysis from all steps:

```
# {TICKET_KEY} — {Ticket Summary}

**Date:** {today's date}
**Branch:** {feature branch name}
**Analyst:** Claude (Prevoir Dev Skill v1.1.0)

---

## Step 1 — Jira Ticket
{content}

## Step 2 — Problem Understanding
{content}

## Step 3 — Comments & Context
{content}

## Step 4 — Branch Created
{content}

## Step 5 — Affected Code
{content}

## Step 6 — Replication Guide
{content}

## Step 7 — Proposed Fix
{content}

## Step 8 — Impact Analysis
{content}

## Step 9 — Change Summary
{content}

## Step 10 — Session Stats
{content}
```

#### 11c. Convert to PDF

Try each method in order, stopping at the first that succeeds. These methods work reliably on macOS, Linux, and Windows without platform-specific library dependencies.

**Method 1 — `pandoc` (preferred, best cross-platform support):**

Check if pandoc is available:
```bash
which pandoc        # macOS / Linux
where pandoc        # Windows
```

If available, convert directly from Markdown to PDF:
```bash
pandoc /tmp/{TICKET_KEY}-analysis.md \
  -o "{REPORT_DIR}/{TICKET_KEY}-analysis.pdf" \
  --pdf-engine=wkhtmltopdf \
  -V geometry:margin=2cm \
  -V fontsize=11pt
```

If `wkhtmltopdf` is not available, try the HTML intermediary instead:
```bash
pandoc /tmp/{TICKET_KEY}-analysis.md \
  -o /tmp/{TICKET_KEY}-analysis.html \
  --standalone --metadata title="{TICKET_KEY} Analysis"
```
Then proceed to Method 2 to print the HTML to PDF.

> **Install pandoc:** https://pandoc.org/installing.html — available via `brew install pandoc` (macOS), `apt install pandoc` (Linux), or the Windows installer.

**Method 2 — Chrome / Chromium headless (no install required if Chrome is present):**

Check for a browser:
```bash
# macOS
which google-chrome || which chromium || \
  ls "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" 2>/dev/null

# Linux
which google-chrome || which chromium-browser || which chromium

# Windows (PowerShell)
where chrome
```

First convert the Markdown to a styled HTML file:
```python
python3 -c "
import markdown2, pathlib
md = pathlib.Path('/tmp/{TICKET_KEY}-analysis.md').read_text()
html = '''<!DOCTYPE html><html><head><meta charset=\"utf-8\">
<style>
  body{font-family:Segoe UI,Arial,sans-serif;margin:40px;line-height:1.7;color:#222}
  h1{color:#1a1a2e}h2{color:#16213e;border-bottom:1px solid #ddd;padding-bottom:4px}
  pre{background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto}
  code{background:#f4f4f4;padding:2px 5px;border-radius:3px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ccc;padding:8px;text-align:left}
  th{background:#f0f0f0}
  blockquote{border-left:4px solid #ccc;margin:0;padding-left:16px;color:#555}
</style></head><body>''' + markdown2.markdown(md, extras=['fenced-code-blocks','tables','strike']) + '</body></html>'
pathlib.Path('/tmp/{TICKET_KEY}-analysis.html').write_text(html)
"
```

Then print to PDF using Chrome headless:
```bash
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --no-sandbox --disable-gpu \
  --print-to-pdf="{REPORT_DIR}/{TICKET_KEY}-analysis.pdf" \
  "file:///tmp/{TICKET_KEY}-analysis.html"

# Linux
google-chrome --headless --no-sandbox --disable-gpu \
  --print-to-pdf="{REPORT_DIR}/{TICKET_KEY}-analysis.pdf" \
  "file:///tmp/{TICKET_KEY}-analysis.html"

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --headless --disable-gpu `
  --print-to-pdf="{REPORT_DIR}\{TICKET_KEY}-analysis.pdf" `
  "file:///C:/Users/$env:USERNAME/AppData/Local/Temp/{TICKET_KEY}-analysis.html"
```

**Method 3 — HTML fallback** (if neither pandoc nor Chrome are available):

Save the styled HTML file produced in Method 2 directly to the report folder:
```bash
cp /tmp/{TICKET_KEY}-analysis.html "{REPORT_DIR}/{TICKET_KEY}-analysis.html"
```

Inform the developer:
> "PDF generation unavailable (pandoc and Chrome not found). Report saved as HTML instead. Open in any browser and use File → Print → Save as PDF to convert manually."

#### 11d. Archive and Confirm

After saving, display the following to the developer (always show both the folder and the full file path):

```
📄 Analysis Report Generated
   Folder : {REPORT_DIR}/
   File   : {REPORT_DIR}/{TICKET_KEY}-analysis.pdf
   Format : PDF  ← (or "HTML (PDF libraries unavailable)" if Method 3 was used)
```

#### 11e. Temp File Cleanup

After the report is confirmed saved, remove the intermediate temp files:

```bash
rm -f /tmp/{TICKET_KEY}-analysis.md /tmp/{TICKET_KEY}-analysis.html
```

If removal fails, note it but do not treat it as a blocking error.

Then end with:

> **Ready to code.** Branch is created. Start with `{primary file}:{line number}`. Refer to Step 9 for the change summary and suggested commit message when done.

---

---

## Output Format

Present output in clearly labelled sections matching the 11 steps above. Use markdown headings. Keep each section concise but complete. Step 11 produces the final confirmation message and report path — that replaces the closing "Ready to code" statement.

---

## Project Context

- **Repository:** `{REPO_DIR}/`
- **Main branch:** `development`
- **Branch format:** `Feature/{TICKET_KEY}_{Title}`
- **Jira project:** `IV` — `https://prevoirsolutions.atlassian.net`
- **Tech stack:** Java (GWT frontend, Spring-like backend), Oracle + PostgreSQL, Maven
- **Key paths:**
  - Frontend: `fcfrontend/src/main/java/com/fc/fe/`
  - Backend API: `fcbackend/src/main/java/com/fc/api/`
  - Models: `fcbackend/src/main/java/com/fc/model/`
  - Plugin/Workers: `fcplugin/src/main/java/com/fc/plugin/`
  - DB upgrades: `fcbuild/scripts/upgrades/`
