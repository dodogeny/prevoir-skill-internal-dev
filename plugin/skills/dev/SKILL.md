---
name: dev
description: Prevoir internal developer workflow skill. Use when a developer provides a Jira ticket URL or ticket key (e.g. IV-1234) and wants to start development work. Handles the full workflow from reading the Jira ticket to proposing a code fix — including reading the description, understanding the problem, checking comments, creating a git branch, locating affected code, and proposing a fix with explanation.
version: 1.0.0
---

# Prevoir Dev Workflow Skill

Full end-to-end developer onboarding workflow for V1 Jira tickets. Guides Claude through reading, understanding, branching, locating, and fixing a reported issue or enhancement.

## Configuration

Before executing any step, resolve the following variable by running `echo $HOME` via Bash:

```
REPO_DIR = $HOME/git/insight
```

Use `REPO_DIR` wherever the repository path is referenced throughout this skill.

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

Use `mcp__jira__get_issue` with the ticket key extracted from the input.

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

Check the **Affected Versions** field from the Jira ticket (from Step 1).

| Affected Version value | Base branch to use |
|------------------------|-------------------|
| Not set / empty        | `development`     |
| e.g. `1.24.292.p1`    | `1.24.292`        |
| e.g. `1.24.292`        | `1.24.292`        |

Rule: Strip any suffix after the third version segment (e.g. `.p1`, `.hotfix`) — always use the base `major.minor.patch` format as the branch name.

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

Use the ticket **Labels** and **Components** as hints:
- `CaseManager` → `fcfrontend/.../view/CaseManager.java`
- `AlertCentral` → `fcfrontend/.../view/AlertCentral.java` and backend alert APIs
- `FRAMS` → case/alert related backend in `fcbackend/src/main/java/com/fc/api/`
- `Plugin`/`Worker` → `fcplugin/src/main/java/com/fc/plugin/`
- DB changes → `fcbuild/scripts/upgrades/`

Present a **file map** — list each file with its role.

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
- **High** — reproduction steps are fully derived from ticket + code analysis
- **Medium** — some assumptions made; developer should verify one step
- **Low** — limited information in ticket; developer must investigate further before confirming steps

If confidence is Medium or Low, list the specific unknowns or assumptions made.

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

#### 7c. DB Migration (if needed)
If the fix requires schema changes, provide the upgrade script template:
```sql
-- v1.XX.XXX.sql / .pg
-- IV-XXXX: <description>
ALTER TABLE ...
```

---

### Step 8 — Impact Analysis

Assess the full consequences of the proposed fix across the system. This step is separate from the fix itself — it forces deliberate review of what else could be affected.

#### 8a. Files Changed
List every file touched by the fix with a one-line description of what changed and why:

| File | Change | Reason |
|------|--------|--------|
| `fcfrontend/.../CaseManager.java` | Added `pendingAlertResolve` flag and async callback chain | Core fix for alert resolution |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | New table / column | Schema required for fix |

#### 8b. Regression Risks
For each change, identify what existing behaviour could break:
- Which existing flows pass through the modified code?
- Are there other callers of modified methods / APIs?
- Could the DB change affect existing data or other screens that read the same table?
- Flag any race conditions, null pointer risks, or async timing concerns introduced

#### 8c. Affected Clients / Environments
State whether the fix is:
- **Generic** — affects all clients running this version
- **Client-specific** — only affects a named client (e.g. FNB, VCL, DRC) due to config or data differences
- **DB-specific** — behaviour differs between Oracle and PostgreSQL implementations

#### 8d. Related Areas to Retest
List screens, flows, or features outside the primary fix that should be smoke-tested:
- e.g. "Alert Central resolve button should still work independently"
- e.g. "Case Details tab resolve should behave the same as All Cases tab"

#### 8e. Estimated Risk Level
Rate the overall risk of the change:
- **Low** — isolated change, no shared code paths, easy to revert
- **Medium** — touches shared logic; regression testing recommended
- **High** — modifies core flow, shared utilities, or DB schema; thorough QA required

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

---

---

## Output Format

Present output in clearly labelled sections matching the 9 steps above. Use markdown headings. Keep each section concise but complete. After Step 9, end with:

> **Ready to code.** Branch is created. Start with `{primary file}:{line number}`. Refer to Step 9 for the change summary and suggested commit message when done.

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
