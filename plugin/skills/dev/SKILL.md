---
name: dev
description: Prevoir internal developer workflow skill. Use when a developer provides a Jira ticket URL or ticket key (e.g. IV-1234) and wants to start development work. Handles the full workflow from reading the Jira ticket to proposing a code fix — including reading the description, understanding the problem, checking comments, creating a git branch, locating affected code, and proposing a fix with explanation.
version: 1.2.0
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
| Step 7b — Morgan briefing *(Bug only)* | Morgan opens session and briefs team | Morgan briefing runs as normal; no developer input required |
| Step 7d — Mid-point check-in *(Bug only)* | Engineers and Riley report progress to Morgan | All four submit status; Morgan responds automatically |
| Step 7f — Riley's questions + Morgan cross-examination *(Bug only)* | Riley poses open question; Morgan cross-examines | All questions and responses generated automatically; no developer input required |
| Step 7g — Team debate *(Bug only)* | Open floor for one challenge round | Debate runs automatically; if no challenges, state "No challenges" and proceed |
| Step 7h — Morgan verdict *(Bug only)* | Morgan scores and declares adopted root cause | Verdict runs automatically; proceed with highest-scoring hypothesis |
| Step 8c — Morgan fix review | Morgan vets the proposed fix | Review runs automatically; if REWORK REQUIRED, revise once and re-run; if still failing, proceed with `⚠️ UNRESOLVED — developer review required` |
| Step 8d — Apply fix prompt | Ask yes / no / partial | **Default to no** — propose the fix only; do not call Edit or modify any files |

In headless mode, Steps 1–10 run and produce full output with all interactive gates bypassed using safe defaults. Steps 11 and 12 (session stats + PDF report) run as normal so the PDF is saved to disk.

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

If any comments contain previous investigation work (root cause findings, code traces, attempted fixes, identified files, test results, or partial solutions), extract and explicitly carry these forward as **known context** for Steps 5, 7, and 8. Do not re-investigate what has already been established.

Produce a **Prior Investigation Summary** block if applicable:

```
Prior Investigation Summary:
- Root cause identified: [what was found]
- Files already identified: [list]
- Attempted fixes: [what was tried and outcome]
- Confirmed working / not working: [what was already validated]
- Remaining unknowns: [what is still unresolved]
```

This summary must be referenced in Step 7 (Root Cause Analysis) and Step 8 (Propose the Fix) — build the solution on top of what is already known rather than starting from scratch.

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
5. **Class hierarchy** *(mandatory for enhancement tickets adding new fields or methods)* — identify the full inheritance chain of the target class:
   ```bash
   grep -rn "extends {TargetClass}\|class {TargetClass} extends" --include="*.java" {REPO_DIR}/
   ```
   - Confirm the abstract base class (if any) and grep for all sibling subclasses
   - Ask: does the new infrastructure (fields, getters/setters, utility methods) belong in the concrete class, or in the abstract base so future subclasses inherit it automatically?
   - **Rule:** If the abstract base already owns similar state for other listeners/workers in the same family, the new state belongs there too. Keep only the concrete-class-specific config wiring (`getConfig()` items, `setAttribute()` cases) in the concrete class.
   - Add the abstract base class to the file map with role "Abstract base — owns shared infrastructure"

#### Grep-First, Read-Second Rule (mandatory)

Never read an entire source file speculatively. Always follow this sequence:

1. `Grep` for the relevant class name, method name, or keyword → get the exact file path and line number
2. `Read` only the relevant line range (the method ± ~20 lines of surrounding context)
3. Only read the full file if the method spans many lines or the grep result is ambiguous

Reading a 40-line method costs ~60 tokens. Reading a 2,000-line Java file costs ~3,000 tokens. Apply this discipline to every file in this step and in Step 8.

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

### Step 7 — Root Cause Analysis

This step has two paths. **Choose the correct path based on the Decision Tree result in 7a:**

| Ticket type | Path |
|-------------|------|
| **BUG** (Data / UI / Async / Regression) | Engineering Panel → 7b through 7i |
| **ENHANCEMENT** (feature that never existed) | Direct Analysis → Step 7-ENH, then skip to Step 8 |

Do not guess — verify every claim by reading code at the specific location. The Grep-First rule applies throughout this step.

---

#### 7a. Diagnostic Decision Tree

Before anyone begins investigating, classify the failure mode. This classification drives Morgan's briefing and each engineer's focus:

```
Issue reported
    │
    ├─► BUG (defect — something that worked before or should work now)
    │       │
    │       ├─► DATA ISSUE? (wrong value stored / returned)
    │       │       ├─► Missing null/empty check → Hypothesis: NPE or silent empty result
    │       │       ├─► Wrong field read or written → Hypothesis: Field mapping error
    │       │       └─► DB query incorrect → Hypothesis: SQL / ORM misconfiguration
    │       │
    │       ├─► UI ISSUE? (screen not rendering, action not triggering)
    │       │       ├─► Event handler missing or broken → Hypothesis: GWT callback not wired
    │       │       ├─► Service call fails silently → Hypothesis: RPC error swallowed
    │       │       └─► State not refreshed after action → Hypothesis: Missing panel reload
    │       │
    │       ├─► ASYNC / TIMING ISSUE? (intermittent, race condition)
    │       │       ├─► Multiple callbacks competing → Hypothesis: Race condition
    │       │       ├─► Lock / transaction conflict → Hypothesis: Deadlock / dirty read
    │       │       └─► Worker processing order → Hypothesis: Out-of-order execution
    │       │
    │       └─► REGRESSION? (was working, now broken)
    │               ├─► Check git log on affected files (last 90 days)
    │               └─► Identify which commit introduced the change
    │
    └─► ENHANCEMENT (feature that never existed)
            ├─► Pure addition → no breakage risk; identify insertion point
            └─► Modification of existing flow → treat sub-paths as BUG branches above
```

State: `Decision tree path: {BUG → DATA ISSUE → Missing null check}` (or whichever branch matched).

**→ If ENHANCEMENT: proceed to Step 7-ENH below and skip the Engineering Panel entirely.**
**→ If BUG: proceed to 7b (Engineering Panel).**

---

#### Step 7-ENH — Enhancement Direct Analysis *(Enhancement tickets only — skip for bugs)*

Read the files identified in Step 5 and produce a direct analysis. No panel. No debate.

**7-ENH-a. What needs to be added**
- Explain what the feature is and why it currently does not exist
- State clearly: *"The system currently lacks X. We need to add Y at Z."*
- Reference specific file paths and line numbers where the addition will land

**7-ENH-b. Insertion point analysis**
- Identify every file, method, and layer that must be touched
- For each insertion point, state:
  - What already exists there and why it is the correct anchor
  - What new code goes in (field, method, config item, UI hook — be specific)
- Run the class hierarchy check (same as Step 5 mandatory check): confirm new fields or methods belong in the abstract base, not the concrete subclass, where applicable

**7-ENH-c. Git history check**
- Run `git log --oneline --all -- {primary_file}` for each affected file
- Confirm: no partial implementation of this feature already exists in any branch
- If a partial exists: note it explicitly and build on it rather than duplicating

**7-ENH-d. Enhancement Statement**

Produce the following block — this replaces the Root Cause Statement for Step 8:

```
ENHANCEMENT STATEMENT
────────────────────────────────────────────────────────────────────
What is missing : [one sentence — what the system cannot currently do]
Insertion points: [file:line for each touch point]
Approach        : [one paragraph — the design decision, e.g. new field
                  in AbstractJsonListener wired through getConfig() in
                  the concrete class; new UI config item; new DB column]
Class hierarchy : [N/A / Confirmed concrete class is correct /
                   Moved to {AbstractBase} — {N} sibling classes benefit]
Partial exists  : [No — confirmed by git log / Yes — {branch:file:line}]
Confidence      : High / Medium / Low
────────────────────────────────────────────────────────────────────
```

If confidence is **Low** (insertion points unclear after reading the code), stop and ask the developer for clarification before proceeding to Step 8.

**→ After completing Step 7-ENH, skip to Step 8 directly.**

---

#### Engineering Panel *(Bug tickets only — 7b through 7i)*

**The team:**

| Role | Name | Background | Mandate |
|------|------|-----------|---------|
| **Lead Developer** | **Morgan** | 20 yrs Java, ex-systems architect, deep GWT/Spring/Oracle | Chairs the session. Sets schedule. Reviews all hypotheses. Debates. Gives final verdict. Approves the Root Cause Statement. |
| Senior Engineer 1 | Alex | 12 yrs Java/GWT | Code archaeology & regression forensics |
| Senior Engineer 2 | Sam | 10 yrs full-stack Java, Spring, GWT RPC | Runtime data flow & logic tracing |
| Senior Engineer 3 | Jordan | 15 yrs Java, systems architect background | Defensive patterns & structural anti-patterns |
| **Senior Lead Tester** | **Riley** | 18 yrs QA & test architecture, Java enterprise, GWT, regression suites | Assesses testability and impact of each hypothesis. Questions engineer findings. Flags regression risk and edge cases. Riley's concerns are factored into Morgan's verdict and Fix Review. |

Engineers (Alex, Sam, Jordan) are competing for the **Best Analysis** distinction. Morgan is not competing — Morgan arbitrates. Morgan's verdict is binding and may endorse, refine, or override any engineer's hypothesis. Riley is not competing — Riley challenges and assesses from a testing perspective.

---

#### 7b. Morgan Opens — Lead Briefing (1-minute block)

Morgan reads the ticket summary, the file map from Step 5, the replication guide from Step 6, and the decision tree classification. Morgan then opens the session:

```
┌─ Morgan — Lead Briefing ────────────────────────────────────────┐
│ Ticket     : {TICKET_KEY} — {summary}                            │
│ Classification: {Decision tree path}                             │
│ Primary suspect area: {file:line or layer identified in Step 5}  │
│                                                                  │
│ Team assignments:                                                │
│   Alex  → Focus on git history of {primary_file}. Flag anything │
│            touched in the last 90 days near {method/class}.      │
│   Sam   → Trace from {entry_point} down. Find the divergence.   │
│   Jordan → Run your pattern checklist. Decision tree says        │
│            {classification}, so lead with patterns {X, Y, Z}.   │
│   Riley → Map the test surface. Identify affected user flows,    │
│            edge cases the engineers may miss, and flag any        │
│            testability concern with the suspected fix direction.  │
│                                                                  │
│ Schedule:                                                        │
│   T+2 min : Mid-point check-in (all four report progress)       │
│   T+4 min : Final hypotheses + Riley's assessment due            │
│   T+5 min : Riley's questions + Morgan's cross-examination       │
│   T+6 min : Debate round + my verdict                           │
│                                                                  │
│ Rules: Evidence only. File:line or commit references required.   │
│ Riley — your concerns carry weight. Flag anything that would     │
│ make this fix untestable or hide a regression.                   │
└────────────────────────────────────────────────────────────────────┘
```

---

#### 7c. Parallel Investigation — Engineers and Tester Investigate (4-minute block)

Each engineer has a **4-minute investigation window**, capped at **8 targeted grep/read operations** before committing to a hypothesis. Riley runs a parallel impact assessment capped at **6 operations**. The budget enforces focus: reach defensible conclusions quickly, not exhaustively.

**Budget rules (apply to Alex, Sam, and Jordan):**
- **High-confidence evidence found in ≤ 4 ops?** Stop immediately and go to mid-point check-in. Do not over-investigate.
- **No clear hypothesis after 8 ops?** Commit to the best available hypothesis, rate it Medium or Low confidence, and state explicitly what additional information would confirm it.
- Every claim must be backed by a specific `file:line` or commit reference. Unsupported assertions will be challenged by Morgan.
- Present findings as if briefing a tech lead: precise, brief, right.

**Budget rules (Riley):**
- 6 operations maximum — Riley is mapping impact, not tracing code.
- Operations count reads of the ticket description, Step 2/5/6 outputs, and any targeted grep/file reads.
- Riley does not need to find the root cause — Riley needs to answer: *"If the fix goes where the engineers think, what breaks, what is untestable, and what are the edge cases?"*

---

**Alex — Code History & Regression**
*"Every bug has a birthday. Find the commit, find the cause."*

Operations (in priority order — stop early if High confidence is reached):
1. `git log --oneline -10 -- {primary_file}` for each file in the Step 5 file map
2. `git log --oneline --since="90 days ago" -- {primary_file}` for broader history
3. Identify the most recent commit touching the relevant method or class
4. Inspect the suspect commit: `git show {commit_hash} -- {file}` — read only relevant diff hunks
5. Check if the issue correlates with a version branch merge or cherry-pick
6. For enhancement tickets: confirm no partial implementation exists in git history
7. Cross-reference suspect commit date with related Jira tickets in comments
8. Confirm fix path is clear of conflicting in-progress changes on the branch

---

**Sam — Data Flow & Runtime Logic**
*"Follow the data. The divergence point is the bug."*

Operations (in priority order — stop early if High confidence is reached):
1. Locate the entry point from Step 5 (UI event handler, API endpoint, worker trigger)
2. Read the entry method (relevant line range — Grep-First applies)
3. Follow the first significant call in the chain — grep, then read the target method
4. Continue layer by layer: UI → service → DAO/plugin → DB until divergence is found
5. At each hop: is correct data present? Is a null check missing? Is a flag propagated?
6. Identify the exact line where actual state deviates from required state
7. Verify fix direction: confirm the correct value *would* be available if the divergence is patched
8. Note secondary effects downstream of the divergence point

Additional Sam checks at every hop:
- GWT async callback result used outside its callback scope?
- Method return value silently discarded?
- Conditional branch short-circuits before the critical operation executes?
- Service method calling a deprecated path instead of the updated one?

---

**Jordan — Defensive Patterns & Structural Anti-Patterns**
*"I've catalogued every way Java developers shoot themselves in the foot."*

Jordan checks patterns in priority order driven by the decision tree classification:

| Pri | Pattern | What Jordan checks |
|-----|---------|-------------------|
| 1 | **Null Pointer** | Object dereferenced without a prior null guard. Jordan checks all six sub-cases: **(a) Service/RPC return** — result of a service call, RPC, or REST response used directly without null check; **(b) Map.get() result** — `map.get(key)` used without null guard (key may be absent); **(c) Method chain** — `a.getB().getC().getValue()` with no intermediate null guard — any link can be null; **(d) Null unboxing** — `Integer`/`Long`/`Boolean` field auto-unboxed in an arithmetic or boolean expression while the wrapper is null; **(e) String comparison** — `str.equals("literal")` where `str` may be null — should be `"literal".equals(str)` or an explicit null guard; **(f) For-each on null collection** — enhanced `for` loop over a field or return value that could be null (no empty-collection guard, distinct from pattern #5 which covers size/`.get(0)` on a non-null list). |
| 2 | **Boolean Flag Not Reset** | Flag set in one path but never cleared in the complementary path |
| 3 | **GWT Async Callback Lost** | Async callback result used outside its own closure scope |
| 4 | **Silent Exception Swallow** | Catch block empty or logging only — masking the real failure |
| 5 | **Empty Collection Guard** | List iterated or `.get(0)` called without size/null check |
| 6 | **Partial Transaction** | DB write immediately depended upon in the next call without flush |
| 7 | **Missing Method Override** | New overload added to interface/abstract class, not implemented in subclass |
| 8 | **Wrong Layer Call** | UI code directly accessing DAO or utility, bypassing the service layer |
| 9 | **DB Dialect Gap** | `ROWNUM` vs `LIMIT`, `NVL` vs `COALESCE`, `SYSDATE` vs `NOW()` etc. |
| 10 | **Thread Safety** | Shared field read/written from multiple threads without synchronisation |
| 11 | **Wrong Ownership Level** | New fields or methods placed in a concrete class when the abstract base is the correct owner. Check: does the concrete class extend an abstract base that already owns similar infrastructure (e.g. fields, utility methods, config helpers)? `grep "extends {AbstractBase}"` to find all siblings — if siblings exist or would benefit, the new state belongs in the abstract base; only config wiring (`getConfig()` items, `setAttribute()` cases) stays in the concrete class. |
| 12 | **Resource Leak** | `Connection`, `InputStream`, `ResultSet`, or other `Closeable` opened but not closed in a `finally` block or `try-with-resources` — especially in exception paths where the happy-path close is bypassed. |
| 13 | **Mutable Static State** | Static fields that are non-final and mutable — in a servlet container these are shared across requests and threads, causing cross-request contamination. Non-final statics are a silent shared-state bug. |
| 14 | **Leaking Abstraction** | Implementation-specific types (e.g., a DAO exception class, an ORM entity) surfacing in the service or UI layer — the layer boundary was breached at the type level, not just the call level. Complements pattern #8 (Wrong Layer Call). |
| 15 | **Circular Dependency** | Package A imports package B which imports package A — violates clean layering and signals a design split that was never completed. Check for cycles at the package level when a new import is added. |
| 16 | **Breaking API Change** | Public method signature changed (parameter added/removed, type changed, checked exception added) without a backward-compatible overload — any existing caller becomes a compile or runtime failure. |
| 17 | **equals/hashCode Contract Broken** | `equals()` overridden without `hashCode()` (or vice versa), or `hashCode()` includes a mutable field — objects placed in `HashSet` or `HashMap` silently misbehave. |
| 18 | **Serialization Mismatch** | `Serializable` class had fields added or removed without updating `serialVersionUID` — relevant in GWT where DTOs cross the wire and persisted sessions may deserialize stale versions. |
| 19 | **Unchecked Cast Without Guard** | `(SomeType) obj` cast not preceded by an `instanceof` check — a `ClassCastException` waiting on a non-obvious code path, typically in a generic handler or polymorphic dispatch. |
| 20 | **Hardcoded Environment Value** | IP addresses, port numbers, timeouts, or threshold values baked into logic rather than pulled from config — breaks silently when deployed to a different environment. |

Priority order by classification: UI issues → {1, 2, 3, 4}; Data issues → {1, 5, 6, 9, 12, 13}; Async issues → {3, 7, 10}; Regressions → {2, 8, 17, 18}; Enhancements → {11, 7, 16}; Architecture → {14, 15, 19, 20}.

---

**Riley — Testing Impact & Regression Assessment**
*"A fix that can't be verified is a fix that can't be trusted."*

Operations (in priority order — stop when impact picture is clear):
1. Re-read the ticket's expected behaviour and acceptance criteria (Step 2 problem statement)
2. Review the Step 6 replication guide — assess completeness; identify gaps (missing preconditions, untested data states, concurrent-user scenarios)
3. From the Step 5 file map, identify every user-facing flow that passes through the affected files — not just the primary path
4. For each affected flow: what does a tester do to confirm it works after the fix? Is the fix observable from the UI/API, or does it require DB-level verification?
5. Enumerate edge cases the engineer hypotheses have not addressed: null/empty inputs, DB dialect differences, multi-client data isolation, state at session boundaries
6. Assess the regression surface: list existing behaviours that the proposed fix direction could silently break — focus on shared utilities, common service methods, and anything called by more than one screen

Riley does **not** assert a root cause. Riley asserts impact, risk, and testability.

---

#### 7d. Mid-Point Check-In — T+2 minutes

Each engineer submits a brief progress report to Morgan after approximately 4 operations used. Morgan acknowledges, redirects if needed, or issues a targeted follow-up question.

```
─── Mid-Point Check-In ────────────────────────────────────────────

Alex (ops used: N/8):
  Status: [e.g. "Found a suspect commit — diffing now" or "Nothing
           suspicious yet in history — broadening to 90-day range"]

Sam (ops used: N/8):
  Status: [e.g. "Traced to service layer — divergence likely in
           resolveCase(); reading next" or "Entry method is thin —
           tracing into the callback chain"]

Jordan (ops used: N/8):
  Status: [e.g. "Pattern #2 matched early — Boolean Flag Not Reset
           confirmed at CaseManager.java:2272" or "No clear pattern
           yet — continuing through lower-priority checks"]

Riley (ops used: N/6):
  Status: [e.g. "Three affected flows identified — the fix direction
           Sam is heading towards would be testable from the UI.
           Flagging one edge case: the cancel path is not covered
           by the replication guide." or "Impact surface is wider
           than expected — two other screens call the same service
           method. Flagging regression risk."]

─── Morgan's Response ─────────────────────────────────────────────

[Morgan reads all four statuses and responds with one of:]

  ✓ On track — continue as assigned.

  ↻ Redirect: [e.g. "Alex, the commit you're looking at is from
    a different branch — check the merge commit instead." or
    "Sam, skip the DAO layer for now — the UI handler is more
    likely; go back and read resolveCase() directly." or
    "Riley, the cancel path concern is valid — make sure you
    have a test scenario for it in your assessment."]

  ⚡ Early call: [e.g. "Jordan, if you've confirmed that pattern
    at line 2272 with code evidence, stop — that's enough. Write
    your hypothesis now and let the others finish."]
────────────────────────────────────────────────────────────────────
```

---

#### 7e. Hypothesis Submission + Testing Assessment — T+4 minutes

All three engineers submit their final hypotheses. Riley submits a Testing Impact Assessment simultaneously. Each entry must fit the template exactly — no unsupported claims.

```
┌─ Alex — History & Regression Hypothesis ───────────────────────┐
│ Root cause   : [precise statement — what Alex believes]          │
│ Evidence     : [commit hash + file:line, or "no suspect commit — │
│                bug was always present since {first commit}"]     │
│ Fix direction: [how the history finding informs the fix]         │
│ Confidence   : High / Medium / Low                               │
│ Ops used     : [N / 8]                                           │
│ Unknowns     : [what git history alone cannot confirm]           │
└────────────────────────────────────────────────────────────────────┘

┌─ Sam — Data Flow & Logic Hypothesis ───────────────────────────┐
│ Root cause   : [precise divergence point — what code does vs.    │
│                what it must do]                                   │
│ Evidence     : [file:line — code snippet showing the divergence] │
│ Fix direction: [what change at the divergence point resolves it] │
│ Confidence   : High / Medium / Low                               │
│ Ops used     : [N / 8]                                           │
│ Unknowns     : [what flow tracing alone cannot confirm]          │
└───────────────────────────────────────────────────────────────────┘

┌─ Jordan — Defensive Patterns Hypothesis ───────────────────────┐
│ Root cause   : [precise statement — what Jordan believes]        │
│ Pattern match: [which pattern(s) from the table matched]         │
│ Evidence     : [file:line + one-line quote of offending code]    │
│ Fix direction: [how eliminating the pattern resolves the issue]  │
│ Confidence   : High / Medium / Low                               │
│ Ops used     : [N / 8]                                           │
│ Unknowns     : [what pattern analysis alone cannot confirm]      │
└───────────────────────────────────────────────────────────────────┘

┌─ Riley — Testing Impact Assessment ────────────────────────────┐
│ Hypothesis risk  : [which engineer's fix direction, if adopted,  │
│                    poses the highest regression risk — and why]  │
│ Affected flows   : [user flows / screens that must be smoke-     │
│                    tested after any fix in this area; at least   │
│                    the primary path + one adjacent flow]         │
│ Edge cases       : [boundary conditions, null/empty inputs,      │
│                    multi-client data isolation, session boundary  │
│                    states, or concurrent-user scenarios the       │
│                    engineer hypotheses have not addressed]        │
│ Testability      : [can the fix be verified from the UI/API, or  │
│                    does it require DB-level / log confirmation?  │
│                    Flag if the fix direction is not observable]   │
│ Regression risk  : High / Medium / Low                           │
│ Open question    : [one targeted question Riley directs at a      │
│                    specific engineer or Morgan — must be answered │
│                    before a fix is approved]                      │
│ Ops used         : [N / 6]                                        │
└────────────────────────────────────────────────────────────────────┘
```

Riley's assessment is **not scored** — it is advisory. However, any **High regression risk** or unanswered **Open question** must be explicitly addressed by Morgan in the verdict (7h) and Fix Review (8c).

---

#### 7f. Riley's Questions + Morgan's Cross-Examination — T+5 minutes

Riley poses the **Open question** from the Testing Impact Assessment directly to the named engineer or Morgan. Then Morgan reads all hypotheses and the testing assessment, and poses **1–2 targeted probing questions** to stress-test reasoning. Engineers respond in one paragraph — direct, evidence-backed.

```
─── Riley's Question ──────────────────────────────────────────────

Riley → {Engineer name or Morgan}:
  "[The Open question from Riley's assessment — e.g. 'Sam, your
   fix touches resolveCase() which is also called from the Alert
   Central panel. Have you confirmed that path is not affected?'
   or 'Jordan, you flagged Boolean Flag Not Reset — does the flag
   have the same reset gap on the cancel path, or only on error?']"

{Engineer} responds:
  [Direct answer — one paragraph, backed by file:line evidence
   or explicit acknowledgement if the concern stands unresolved]

─── Morgan's Questions ────────────────────────────────────────────

[Morgan selects the most important uncertainties across the three
hypotheses and Riley's assessment, then asks them directly. Examples:]

  → To Alex: "You say commit abc1234 is responsible. What was the
    stated reason for that change? Was it deliberate removal or
    accidental? Does the commit message or linked ticket clarify?"

  → To Sam: "You found the divergence at resolveCase():2272. Does
    the flag actually exist in scope at that point, or does the fix
    require introducing a new field entirely?"

  → To Jordan: "You matched Boolean Flag Not Reset. Does the flag
    get reset anywhere else in the class — e.g. on cancel or on
    error? Or is this the only path that should set it?"

─── Engineers Respond ─────────────────────────────────────────────

Alex responds: [direct answer — one paragraph, backed by evidence]

Sam responds: [direct answer — one paragraph, backed by evidence]

Jordan responds: [direct answer — one paragraph, backed by evidence]
────────────────────────────────────────────────────────────────────
```

Morgan uses up to **4 additional targeted reads** (beyond the engineers' budgets) to independently verify any claim that cannot be confirmed from the responses alone.

---

#### 7g. Team Debate — One Round

Morgan opens the floor for one round of cross-challenge. Any engineer **or Riley** may mount one challenge. Engineers challenge on code grounds; Riley challenges on impact or testability grounds. The challenged party responds once. Morgan moderates.

```
─── Debate Round ──────────────────────────────────────────────────

[Each challenge must cite specific evidence. Format:]

  {Engineer A or Riley} challenges {Engineer B}:
  "Your hypothesis says X, but I found Y at {file:line} which
  contradicts that because Z. My reading suggests [alternative]."

  — or, from Riley —

  "Your fix direction touches {file/method} which is also called
  from {other screen/flow}. I flagged this in my assessment.
  Without a guard at {location}, this fix will silently break
  {behaviour} for {scenario}. Have you accounted for that?"

  {Engineer B} responds:
  "That's a fair point. [Agree / Disagree because {evidence}].
  My hypothesis [stands / needs refinement: {updated claim}]."

  [Morgan may accept or reject refinements — one sentence each.]

─── Morgan closes debate ──────────────────────────────────────────
  "We have enough. Let me give my assessment."
────────────────────────────────────────────────────────────────────
```

If no one mounts a challenge, state: "No challenges — team and tester accept each other's findings."

---

#### 7h. Morgan's Verdict — T+6 minutes

Morgan weighs all evidence — original hypotheses, responses to questions, and the debate — then delivers a binding verdict. Morgan scores each hypothesis and declares the adopted root cause.

**Scoring rubric** (Morgan applies this to each hypothesis):

| Criterion | Points |
|-----------|--------|
| Specific `file:line` cited with code evidence | +3 |
| Fix direction is clear and immediately actionable | +2 |
| Explains *why* the bug is intermittent (if applicable) | +2 |
| Self-rated High confidence and evidence supports it | +1 |
| Corroborated by another engineer's independent finding | +2 |
| Found efficiently (≤ 5 ops used) | +1 |
| Survived cross-examination without needing revision | +2 |
| Debate challenge successfully deflected with evidence | +1 |
| Fix direction is testable and Riley raised no High regression risk against it | +1 |

Maximum score: 15 pts. Morgan applies the rubric, declares the highest scorer the winner, then issues a personal assessment — which **must** include a response to Riley's assessment.

```
─── Morgan's Verdict ──────────────────────────────────────────────

Scores:
  Alex   : {N} / 15 pts — [one-line assessment]
  Sam    : {N} / 15 pts — [one-line assessment]
  Jordan : {N} / 15 pts — [one-line assessment]

Tester's view:
  [Morgan addresses Riley's assessment — one to two sentences.
   Must state whether the adopted root cause and fix direction
   address Riley's regression risk and open question. If a High
   severity concern from Riley is unresolved, Morgan must state
   whether it is accepted risk or a blocker for the fix.]

My assessment:
  [Morgan weighs in personally — 2–4 sentences. Morgan may:
   (a) Endorse the highest-scoring hypothesis unchanged
   (b) Refine it: "Jordan's hypothesis is correct but incomplete —
       Sam's flow trace shows the flag is also missing on the
       cancel path, which explains the intermittent reports."
   (c) Override all three: "None of you went deep enough. I ran
       one more read on {file} and found {what Morgan found}."
   Morgan's assessment takes precedence over the score alone.]

Adopted root cause: [the hypothesis Morgan endorses, possibly
                     refined or Morgan's own if override]
────────────────────────────────────────────────────────────────────
```

**Verdict outcomes:**

| Outcome | Block displayed |
|---------|----------------|
| One engineer's score is clearly highest + Morgan agrees | `🏆 BEST ANALYSIS: {Name}` |
| Two or more engineers independently reached the same cause | `🤝 CONSENSUS: {Name} & {Name}` |
| Morgan refined the winning hypothesis | `🏆 BEST ANALYSIS: {Name}` + `📝 Refined by Morgan` note |
| Morgan overrode all three | `⚡ MORGAN OVERRIDE — independent read required` |

```
╔══════════════════════════════════════════════════════════════════╗
║  🏆  BEST ANALYSIS: {Engineer Name}        Score: {N} / 15 pts  ║
║  Reason: {One sentence — why this analysis was superior}         ║
║  Morgan: "{One sentence endorsement or refinement note}"         ║
║  Riley:  "{One sentence — tester concern status: resolved /      ║
║            accepted risk / flagged for fix review}"              ║
╚══════════════════════════════════════════════════════════════════╝
```

---

#### 7i. Root Cause Statement — Team Sign-Off

Produce the final root cause statement — authored by the winning engineer and approved by Morgan. This anchors Step 8.

```
ROOT CAUSE STATEMENT
────────────────────────────────────────────────────────────────────
Author    : {Winning Engineer Name}  |  Approved by: Morgan
Location  : {file:line}
Mechanism : [How the bug manifests — precise, code-level description]
Trigger   : [What user action or system event makes it observable]
Fix dir.  : [One sentence on the correct fix — detail in Step 8]
Confidence: High / Medium / Low
Team note : [Optional — one sentence capturing any nuance raised in
             the debate that the fix author must not overlook]
Tester note: [Riley's key concern or confirmation — e.g. "Regression
              risk on Alert Central resolve path — must be smoke-tested
              after fix applied" or "Fix is UI-observable; no DB
              verification required" — omit if no concern outstanding]
────────────────────────────────────────────────────────────────────
```

If overall confidence is **Low** after Morgan's verdict (no clear root cause even after debate), **stop and present the competing hypotheses to the developer**. In headless mode, proceed with the highest-scoring hypothesis and flag the ambiguity explicitly.

---

### Step 8 — Propose the Fix

Use the analysis from Step 7 as the mandatory anchor:
- **Bug tickets** — anchor to the Root Cause Statement from Step 7i (authored by the winning engineer, approved by Morgan). Every proposed change must directly address the mechanism stated there.
- **Enhancement tickets** — anchor to the Enhancement Statement from Step 7-ENH-d. Every proposed change must directly implement an insertion point listed there.

#### 8a. Proposed Solution
- Open by quoting the analysis anchor — the Root Cause Statement (bug tickets) or Enhancement Statement (enhancement tickets) — verbatim; do not paraphrase
- Describe the approach in plain language before showing any code
- Show **only the code that needs to change** (diff-style or clear before/after blocks)
- Annotate each change with: *"This addresses the [mechanism / insertion point] identified in Step 7"*
- If the Step 7 Team Note (bug) or Step 7-ENH confidence note (enhancement) flagged a nuance, confirm it is handled by the proposed fix

#### 8b. Alternative Approaches Considered

For each alternative considered and rejected, provide a brief entry:

| Alternative | Why rejected |
|-------------|-------------|
| {approach} | {reason — e.g. higher risk, side effects, does not address root cause mechanism} |

If only one viable approach exists, state: "No viable alternatives identified — single fix path confirmed."

#### 8c. Morgan Reviews the Proposed Fix

Before applying anything, Morgan vetted the proposed fix against the adopted root cause. Morgan checks:

1. **Mechanism alignment** — does the fix directly address the mechanism stated in the Root Cause Statement?
2. **Surgical scope** — is the fix minimal? Does it avoid touching code unrelated to the root cause?
3. **Regression risk** — does the fix introduce any new null risks, flag side effects, or break the complementary code path?
4. **Team note honoured** — if a nuance was flagged in Step 7i, is it handled?
5. **DB safety** — if a schema change is included, is it safe on both Oracle and PostgreSQL?
6. **Abstract class ownership** — if the fix adds new fields, getters/setters, or utility methods to a concrete class: confirm whether the abstract base class is the correct owner. Run `grep "extends {AbstractBase}" --include="*.java"` to find all subclasses. If the abstract base already owns similar state for sibling classes, move the new infrastructure there. Only `getConfig()` config item registrations and `setAttribute()` switch cases are concrete-class concerns — everything else belongs in the abstract base when a suitable one exists.
7. **Tester concerns addressed** — review Riley's Testing Impact Assessment (Step 7e) and Tester note (Step 7i). For each High or Medium concern Riley raised: confirm the proposed fix addresses it, or explicitly state it is accepted risk and why. If Riley's open question was not answered during cross-examination, answer it now before approving.

```
─── Morgan's Fix Review ───────────────────────────────────────────

Mechanism alignment      : [Confirmed / Issue: {what is misaligned}]
Surgical scope           : [Confirmed — N files, M lines changed /
                            Concern: {what is unnecessarily wide}]
Regression risk          : [Low — no new risks introduced /
                            Flag: {specific risk Morgan identified}]
Team note honoured       : [Yes / Not applicable / No — {what is missing}]
DB safety                : [Confirmed / N/A — no schema change /
                            Issue: {dialect problem spotted}]
Abstract class ownership : [N/A — no new fields or methods added /
                            Confirmed — concrete class is correct owner /
                            Moved to {AbstractBase} — {N} sibling subclasses
                            benefit; config wiring stays in concrete class]
Tester concerns          : [N/A — no High or Medium concerns raised /
                            Resolved — {Riley's concern} is addressed by
                            {specific change in the fix} /
                            Accepted risk — {Riley's concern} is not
                            addressed; accepted because {reason}]

Morgan's verdict:
  ✅ APPROVED — fix is correct, surgical, and safe to apply.

  — or —

  ⚠️  APPROVED WITH CONDITIONS — apply after addressing:
     [{specific condition Morgan requires before applying}]

  — or —

  🔄 REWORK REQUIRED — [{reason}]. Suggested direction:
     [{Morgan's suggested fix approach — one paragraph}]
────────────────────────────────────────────────────────────────────
```

**If Morgan returns REWORK REQUIRED:**
- Revise the proposed solution in 8a to address Morgan's direction
- Re-run Morgan's review (8c) against the revised fix
- Do not proceed to 8d until Morgan's verdict is Approved or Approved with Conditions

#### 8d. Apply Fix to Feature Branch (Interactive)

After Morgan approves the fix, ask the developer:

> **Would you like me to apply these changes to the feature branch now?**
> - `yes` — apply all proposed changes directly to the files on the current feature branch
> - `no` — skip; the developer will apply manually
> - `partial` — ask which specific changes to apply

If the developer answers **yes** or **partial**:
- Use the Edit tool to apply changes to each identified file
- After each file is modified, confirm: "Applied change to `{file}:{line}`"
- Do NOT commit — leave the changes staged for the developer to review and commit using the suggested message from Step 10c

If the developer answers **no**, continue to Step 9 without modifying any files.

#### 8e. DB Migration (if needed)
If the fix requires schema changes, provide the upgrade script template:
```sql
-- v1.XX.XXX.sql / .pg
-- IV-XXXX: <description>
ALTER TABLE ...
```

---

### Step 9 — Impact Analysis

Assess the full consequences of the proposed fix across the entire application. This step requires active codebase searching — do not rely on assumptions. Use Grep to find every reference to changed symbols before drawing conclusions.

#### 9a. Files Changed
List every file touched by the fix with a one-line description of what changed and why:

| File | Change | Reason |
|------|--------|--------|
| `fcfrontend/.../CaseManager.java` | Added `pendingAlertResolve` flag and async callback chain | Core fix for alert resolution |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | New table / column | Schema required for fix |

#### 9b. Usage Reference Search (mandatory)

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

#### 9c. Application-Wide Impact

Based on the usage reference search, describe the impact across each application layer:

| Layer | Impact | Detail |
|-------|--------|--------|
| GWT Frontend | e.g. Medium | `CaseManager` change affects resolve flow; 2 other panels call same service |
| Backend API | e.g. Low | No API signature change; internal logic only |
| Plugin / Workers | e.g. None | No worker classes reference changed code |
| DB / Schema | e.g. High | Column rename affects 4 SQL queries across 3 upgrade scripts |
| Shared Utilities | e.g. Low | `RecordHelper` change only affects timed-wait resume path |

If a layer is not affected, state "None — confirmed by grep (0 references found)."

#### 9d. Regression Risks
For each change, identify what existing behaviour could break:
- Which existing flows pass through the modified code?
- Could the DB change affect existing data or other screens that read the same table?
- Flag any race conditions, null pointer risks, or async timing concerns introduced
- Flag any callers found in 9b that may behave differently after the change

#### 9e. Affected Clients / Environments
State whether the fix is:
- **Generic** — affects all clients running this version
- **Client-specific** — only affects a named client (e.g. FNB, VCL, DRC) due to config or data differences
- **DB-specific** — behaviour differs between Oracle and PostgreSQL implementations

#### 9f. Related Areas to Retest
List screens, flows, or features outside the primary fix that should be smoke-tested — derived from the callers found in 9b:
- e.g. "Alert Central resolve button should still work independently"
- e.g. "Case Details tab resolve should behave the same as All Cases tab"

#### 9g. Risk Level

Rate the overall risk of the change based on the usage reference search results:

| Rating | Criteria |
|--------|----------|
| **Low** | Change is isolated; 0–1 callers found; no shared utilities or DB touched; easy to revert |
| **Medium** | 2–5 callers found; touches shared logic or a secondary screen; regression testing recommended |
| **High** | 6+ callers found; modifies a public API, shared utility, or DB schema; thorough QA required before release |

State the rating prominently:

> **Risk Level: Medium** — 3 callers of `resolveAlertCentral` found across 2 screens; existing Alert Central resolve path must be retested.

---

### Step 10 — Change Summary

Produce a concise, developer-friendly summary of everything that was done. This serves as a reference for commit messages, PR descriptions, and handover notes.

#### 10a. Files Touched

List every file modified, created, or deleted by the fix:

| File | Action | Summary of Change |
|------|--------|-------------------|
| `fcfrontend/.../CaseManager.java` | Modified | Added alert resolution chain triggered on case resolve |
| `fcbuild/scripts/upgrades/v1.XX.XXX.sql` | Created | Added new table `B_TR_TASK_RESPONSES` |

#### 10b. What Was Changed and Why

For each file, one short paragraph explaining:
- What was changed (the what)
- Why it was necessary to make this change (the why)
- Any notable decisions or trade-offs made

#### 10c. Suggested Commit Message

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

#### 10d. PR Description Template

Provide a ready-to-paste pull request description:

```
## {TICKET_KEY} — {Ticket Summary}

**Jira:** https://prevoirsolutions.atlassian.net/browse/{TICKET_KEY}
**Branch:** {feature branch name}
**Base:** {base branch}
**Risk:** {Low / Medium / High} — {one-line justification from Step 9g}

---

## Root Cause
{Root Cause Statement from Step 7d — location, mechanism, trigger}

## What changed
{One paragraph describing the fix — the what and the why}

## Files changed
{Files touched table from Step 10a — abbreviated to file name and one-line summary}

## How to test
{Reproduction steps from Step 6b, rewritten as a verification checklist}

## Retest areas
{Retest checklist from Step 9f}

## DB migration required
{Yes — run v1.XX.XXX.sql/.pg before deploying | No}
```

---

### Step 11 — Session Stats

Print a single summary line covering elapsed time, estimated token usage, and estimated cost at current Sonnet 4.6 pricing:

```
{TICKET_KEY} | ~{N}m elapsed | ~{X} in / ~{Y} out tokens | est. cost ${Z} (Sonnet 4.6)
```

Pricing reference (Sonnet 4.6 as of skill version 1.2.0):
- Input: $3.00 / 1M tokens
- Output: $15.00 / 1M tokens

Estimate token counts from the volume of content processed (Jira fields, attachments, file reads, analysis produced). These are approximations — label them clearly with `~`.

Example:
```
IV-3672 | ~14m elapsed | ~5,100 in / ~2,040 out tokens | est. cost $0.0462 (Sonnet 4.6)
```

---

### Step 12 — Generate PDF Analysis Report

After Step 10 is complete, generate a full PDF report of the analysis and save it to disk.

#### 12a. Configuration

Resolve the output folder using this priority order:

1. If the environment variable `CLAUDE_REPORT_DIR` is set, use it
2. Otherwise default to: `$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets/`

```bash
REPORT_DIR="${CLAUDE_REPORT_DIR:-$HOME/Documents/DevelopmentTasks/Claude-Analyzed-Tickets}"
mkdir -p "$REPORT_DIR"
```

#### 12b. Generate Markdown Source

Write a temporary Markdown file at `/tmp/{TICKET_KEY}-analysis.md`. Populate every section below verbatim from the output already produced in each step — do not summarise or abbreviate. Every table, code block, hypothesis box, statement block, and verdict produced earlier must appear in full. Use the placeholders as structural guides; replace each with the actual content from that step.

````
# {TICKET_KEY} — {Ticket Summary}

| Field | Value |
|-------|-------|
| Date | {today's date} |
| Analyst | Claude (Prevoir Dev Skill v1.2.0) |
| Ticket type | {Bug / Story / Enhancement} |
| Priority | {priority} |
| Status | {status} |
| Branch | {feature branch name} |
| Base branch | {base branch} |

---

## Step 1 — Jira Ticket

| Field | Value |
|-------|-------|
| Key | {TICKET_KEY} |
| Summary | {summary} |
| Type | {issuetype} |
| Priority | {priority} |
| Status | {status} |
| Assignee | {assignee} |
| Reporter | {reporter} |
| Labels | {labels or "None"} |
| Components | {components or "None"} |
| Fix Version(s) | {fixVersions or "Not set"} |
| Affected Version(s) | {versions or "Not set"} |

### Description

{Full ticket description text — verbatim, preserving all formatting}

### Attachments

{List each attachment by name and type, or "No attachments"}

---

## Step 2 — Problem Understanding

### Problem Statement

**Ticket classification:** {Bug (defect) / Story (enhancement)}

| Dimension | Detail |
|-----------|--------|
| What is broken / missing | {1–2 sentences} |
| Who is affected | {users / roles / clients} |
| Expected behaviour | {what should happen} |
| Actual behaviour | {what currently happens} |
| Acceptance criteria | {bulleted list from ticket} |

{If enhancement, include: "This is an enhancement — the system currently lacks X; we need to add Y."}

### Attachment Analysis

{For each attachment analysed: name, type, and key findings extracted.
If no attachments: "No attachments — analysis skipped."}

### Issue Diagram

{If a draw.io diagram was generated: "Issue diagram generated — see embedded diagram below." Include diagram source or note path.
If skipped: "Diagram skipped — single-file change / no complex data flow identified."}

---

## Step 3 — Comments & Context

### Comment Summary

{Bulleted list of key points from each comment — clarifications from reporter/PO, decisions made, constraints, related tickets, partial fixes.
If no comments: "No comments on ticket — proceeding from description only."}

### Prior Investigation Summary

{If prior investigation was found in comments, reproduce the full Prior Investigation Summary block:

  Prior Investigation Summary:
  - Root cause identified: {what was found}
  - Files already identified: {list}
  - Attempted fixes: {what was tried and outcome}
  - Confirmed working / not working: {what was already validated}
  - Remaining unknowns: {what is still unresolved}

If no prior investigation: "No prior investigation found in comments."}

---

## Step 4 — Development Branch

| Field | Value |
|-------|-------|
| Base branch | {base branch name} |
| Base branch source | {Fix Version / Affected Version / default: development} |
| Feature branch | {Feature/TICKET_KEY_Title} |
| Branch status | {Created and checked out / Skipped (headless mode)} |

---

## Step 5 — Locate Affected Code

### File Map

| File | Role | Key Location | Recent Git History |
|------|------|-------------|-------------------|
{Reproduce the complete file map table row by row}

**Confidence:** {High / Medium / Low} — {one-line reason}

### Class Hierarchy Analysis

{If performed (mandatory for enhancements adding fields/methods):

  Target class    : {ClassName}
  Extends         : {AbstractBase or "No abstract base"}
  Sibling classes : {list from grep, or "None found"}
  Decision        : {New infrastructure placed in AbstractBase / Concrete class is correct owner — no siblings benefit}

If not applicable: "Class hierarchy check not required — no new fields or methods added."}

---

## Step 6 — Replication Guide

### Prerequisites

{List of required preconditions — user role, test data, feature flags, environment config, etc.}

### Environment

{Which environment to use and any specific setup required}

### Replication Steps

{Numbered step-by-step list to reproduce the issue or trigger the missing feature}

### Expected vs Actual

| | Detail |
|---|--------|
| **Expected** | {what should happen} |
| **Actual** | {what currently happens} |

**Confidence:** {High / Medium / Low} — {one-line reason}

### Service Restart Guidance

{Which services need restarting after a fix is applied, in order — Plugin spawner, backend, GWT frontend, or "Frontend-only / Backend-only change" as applicable}

---

## Step 7 — Root Cause Analysis

{--- FOR BUG TICKETS: reproduce the full Engineering Panel session ---}

### 7a. Decision Tree Classification

**Path:** `{e.g. BUG → UI ISSUE → Service call fails silently}`

### 7b. Morgan's Lead Briefing

{Reproduce the full Morgan briefing box verbatim — ticket, classification, primary suspect area, team assignments for Alex / Sam / Jordan / Riley, schedule}

### 7c. Investigation — Mid-Point Check-In (T+2)

{Reproduce the full mid-point check-in block verbatim — Alex, Sam, Jordan, Riley status reports and Morgan's response}

### 7d. Hypothesis Submission (T+4)

{Reproduce each hypothesis box verbatim:
  - Alex — History & Regression Hypothesis
  - Sam — Data Flow & Logic Hypothesis
  - Jordan — Defensive Patterns Hypothesis
  - Riley — Testing Impact Assessment}

### 7e. Riley's Question + Morgan's Cross-Examination (T+5)

{Reproduce the full cross-examination block verbatim:
  - Riley's question and engineer's response
  - Morgan's questions and all engineer responses}

### 7f. Team Debate

{Reproduce the full debate round verbatim — each challenge, response, and Morgan's close.
If no challenges: "No challenges — team and tester accept each other's findings."}

### 7g. Morgan's Verdict (T+6)

{Reproduce the full verdict block verbatim:
  - Score table (Alex / Sam / Jordan — N/15 pts)
  - Tester's view paragraph
  - Morgan's personal assessment
  - Adopted root cause
  - Verdict outcome box (🏆 / 🤝 / ⚡)}

### 7h. Root Cause Statement

{Reproduce the full Root Cause Statement block verbatim — Author, Approved by, Location, Mechanism, Trigger, Fix direction, Confidence, Team note, Tester note}

{--- FOR ENHANCEMENT TICKETS: reproduce the Enhancement Direct Analysis ---}

### Enhancement Statement

{Reproduce the full Enhancement Statement block verbatim — What is missing, Insertion points, Approach, Class hierarchy, Partial exists, Confidence}

---

## Step 8 — Proposed Fix

### Analysis Anchor

{Reproduce the Root Cause Statement (bug) or Enhancement Statement (enhancement) verbatim — the anchor quoted at the top of the fix}

### 8a. Proposed Solution

{Reproduce the full solution narrative — approach description in plain language, then every before/after code block with annotations}

### 8b. Alternative Approaches Considered

| Alternative | Why rejected |
|-------------|-------------|
{Reproduce each row, or "No viable alternatives identified — single fix path confirmed."}

### 8c. Morgan's Fix Review

{Reproduce the full Fix Review block verbatim — all 7 checks and Morgan's verdict:
  Mechanism alignment, Surgical scope, Regression risk, Team note honoured,
  DB safety, Abstract class ownership, Tester concerns, Morgan's verdict (✅ / ⚠️ / 🔄)}

### 8d. DB Migration Scripts

{If schema changes required, reproduce full Oracle (.sql) and PostgreSQL (.pg) scripts.
If not required: "No schema changes — DB migration not required."}

---

## Step 9 — Impact Analysis

### 9a. Files Changed

| File | Change | Reason |
|------|--------|--------|
{Reproduce the complete files-changed table}

### 9b. Usage Reference Search

{Reproduce the full symbol reference table — every changed symbol with type, callers found, and files}

### 9c. Application-Wide Impact

| Layer | Impact | Detail |
|-------|--------|--------|
{Reproduce the complete impact table — GWT Frontend, Backend API, Plugin/Workers, DB/Schema, Shared Utilities}

### 9d. Regression Risks

{Bulleted list of regression risks identified — flows affected, null risks, async timing concerns, flag side effects}

### 9e. Affected Clients / Environments

**Scope:** {Generic — all clients / Client-specific: {name} / DB-specific: Oracle vs PostgreSQL}

{Explanation of why this scope applies}

### 9f. Related Areas to Retest

{Bulleted list of screens, flows, or features to smoke-test after the fix — derived from the caller search}

### 9g. Risk Level

**Overall risk:** {Low / Medium / High}

{One paragraph justifying the risk rating}

---

## Step 10 — Change Summary

### Summary of Changes

{Bulleted summary of every change made — file, what changed, and why}

### Suggested Commit Message

```
{Full commit message block — subject line + body}
```

### Pull Request Description

{Reproduce the full PR description template — Summary bullets, Test plan checklist, labels, risk level}

---

## Step 11 — Session Statistics

| Metric | Value |
|--------|-------|
| Steps completed | {N / 12} |
| Elapsed time | {HH:MM} |
| Estimated token count | {N tokens} |
| Estimated cost (Sonnet 4.6) | {$X.XX} |
| Ticket type | {Bug / Enhancement} |
| RCA path | {Engineering Panel / Direct Analysis (7-ENH)} |
| Fix applied to branch | {Yes / No / Partial} |

````

#### 12c. Convert to PDF

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

#### 12d. Archive and Confirm

After saving, display the following to the developer (always show both the folder and the full file path):

```
📄 Analysis Report Generated
   Folder : {REPORT_DIR}/
   File   : {REPORT_DIR}/{TICKET_KEY}-analysis.pdf
   Format : PDF  ← (or "HTML (PDF libraries unavailable)" if Method 3 was used)
```

#### 12e. Temp File Cleanup

After the report is confirmed saved, remove the intermediate temp files:

```bash
rm -f /tmp/{TICKET_KEY}-analysis.md /tmp/{TICKET_KEY}-analysis.html
```

If removal fails, note it but do not treat it as a blocking error.

Then end with:

> **Ready to code.** Branch is created. Start with `{primary file}:{line number}`. Refer to Step 10 for the change summary and suggested commit message when done.

---

---

## Output Format

Present output in clearly labelled sections matching the 12 steps above. Use markdown headings. Keep each section concise but complete. Step 12 produces the final confirmation message and report path — that replaces the closing "Ready to code" statement.

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
