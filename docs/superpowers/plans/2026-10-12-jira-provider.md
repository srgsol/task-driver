# Jira Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** task-driver drives issues from Jira Cloud repos alongside Linear repos, with the provider chosen per repo in one config file, preserving today's workflow semantics (pick → claim → implement → verify → PR → comment back).

**Architecture:** A provider-neutral `Tracker` (`src/tracker.mjs`) is built per repo from `repo.provider`. It wraps either the existing Linear client or a new Jira Cloud REST v3 client (`src/jira.mjs`), translating the per-repo `workflow`/`labels` config into GraphQL or REST calls. The loop only talks to the tracker; config validation normalizes the new fields with backwards-compatible Linear defaults. Jira's comment/description text round-trips through a small Atlassian Document Format (ADF) helper (`src/adf.mjs`).

**Tech Stack:** Node.js ESM, built-in `fetch`, no new runtime dependencies (JSDoc-typed for `tsc --noEmit`), Jira Cloud REST v3, existing Linear GraphQL client.

**Spec:** `docs/superpowers/specs/2026-10-12-jira-provider-design.md` (the plan argues from it; executors read both).

## Global Constraints

- No new runtime dependencies; Jira client is plain `fetch` with the same 429/5xx exponential-backoff retry pattern as `linear.mjs` (duplicate the helper locally — `jira.mjs` is self-contained like `linear.mjs`).
- TDD with `node --test`; tests live in `test/<module>.test.mjs` mirroring existing files; the Jira client is tested against an injected fake `fetch` (no live Jira needed, per spec).
- Existing configs keep validating and behaving identically: `provider` defaults to `"linear"`; Linear `workflow` defaults to `{ open: "Todo", claim: "In Progress", reopen: "Todo", park: "Backlog" }`; `labels` defaults to `{ pick: "task-driver", error: "ai:error" }`.
- Shared `Issue` shape (both providers, unchanged for the loop): `{ id, identifier, title, description, url, labels: string[] }`. For Jira, `id === identifier ===` the issue key (e.g. `"PROJ-12"`).
- Commit after each task.
- Do not modify `git/gh/executor/params/gates/sh/slug` or `implement.md`; agent prompts, branch naming, gates, and dry-run behavior are unchanged except as stated per task.

## Review Focus

The five input classes / failure modes most likely to bite a user, with the test that pins each (added to the owning task):

1. A Jira repo config missing `jiraProject` (or top-level `jiraBaseUrl`) → startup validation error with a clear message, no API calls. _Pinned in Task 1, `test/config.test.mjs`._
2. A Jira `workflow.open` as an array of statuses → all listed statuses are pickable, and `reopen` returns to the first element. _Pinned in Task 3 (JQL `status in (...)`), Task 4 (reopen target)._
3. A Jira issue blocked by an issue whose `fields.resolution` is non-null (e.g. Won't Fix, Duplicate) → the blocker counts as resolved and the candidate stays pickable. _Pinned in Task 3, blocker-filter tests._
4. A Jira config-error issue (no `park` status) → the `ai:error` label keeps it from being re-picked on subsequent runs; no park transition is attempted. _Pinned in Task 3 (error-label exclusion) + Task 6 (config-error path)._
5. A Jira transition with no name match (e.g. board renamed a status) → no-op with a warning, no POST to `/transitions`, the run continues. _Pinned in Task 3, transition tests._

---

### Task 1: Config schema for provider, workflow, labels

**Files:**

- Modify: `src/config.mjs`
- Test: `test/config.test.mjs`

**Interfaces:**

- Consumes: existing `validateConfig(raw)` / `loadConfig(path)`.
- Produces: each normalized `config.repos[i]` gains:
  - `provider: "linear" | "jira"` (default `"linear"`);
  - `workflow: { open: string | string[], claim: string, reopen?: string, park?: string }` — Linear: `{ open: "Todo", claim: "In Progress", reopen: "Todo", park: "Backlog" }`; Jira: `open` and `claim` required, `reopen`/`park` omitted when not set;
  - `labels: { pick: string, error: string }` (defaults `{ pick: "task-driver", error: "ai:error" }`).
- Top-level `config.jiraBaseUrl`: required (non-empty, starts with `http://` or `https://`) when any repo has `provider: "jira"`.
- Validation error message fragments (assert these in tests):
  - `"requires jiraProject when provider is jira"`
  - `"jiraBaseUrl is required when any repo uses provider jira"`
  - `"workflow.open must be a non-empty string"` (linear) / `"workflow.open must be a non-empty string or array of strings"` (jira)
  - `"workflow.claim must be a non-empty string"`
  - `"provider must be 'linear' or 'jira'"`
  - `jiraBaseUrl` non-http string → `"jiraBaseUrl must be a valid http(s) URL"`.

- [ ] **Step 1: Write the failing happy-path test.** In `test/config.test.mjs`: `validateConfig` of a config with one linear repo (existing shape: `name, path, team: "SER", project: "tik-tak", remote, gates: []`) and one jira repo `{ name: "company-repo", path: "../company-repo", provider: "jira", jiraProject: "PROJ", remote: "git@github.com:example/company-repo.git", gates: [], workflow: { open: ["To Do"], claim: "In Progress" }, labels: { pick: "task-driver", error: "ai:error" } }`, plus `jiraBaseUrl: "https://x.atlassian.net"` → returns; assert linear repo normalizes to `provider: "linear"`, `workflow: { open: "Todo", claim: "In Progress", reopen: "Todo", park: "Backlog" }`, `labels: { pick: "task-driver", error: "ai:error" }`; jira repo keeps `provider: "jira"`, its `workflow`/`labels` as given, `jiraProject: "PROJ"`.
- [ ] **Step 2: Write the failing validation tests.** (a) jira repo missing `jiraProject` → throws with fragment from "requires jiraProject when provider is jira". (b) jira repo but no `jiraBaseUrl` → fragment "jiraBaseUrl is required when any repo uses provider jira". (c) linear repo with `workflow: { open: ["To Do"] }` → fragment "workflow.open must be a non-empty string". (d) jira repo with `workflow: {}` (no open) → fragment "workflow.open must be a non-empty string or array of strings". (e) jira repo with `workflow: { open: "To Do" }` (no claim) → fragment "workflow.claim must be a non-empty string". (f) `provider: "jiras"` → fragment "provider must be 'linear' or 'jira'". (g) `jiraBaseUrl: "atlassian.net"` (no scheme) → fragment "jiraBaseUrl must be a valid http(s) URL".
- [ ] **Step 3: Implement.** Add `provider`/`jiraProject`/`jiraBaseUrl`/`workflow`/`labels` handling to `validateConfig` in `src/config.mjs`; keep all existing linear checks; attach normalized values to every repo in the returned config.
- [ ] **Step 4: Run.** `node --test test/config.test.mjs` → all pass (including all pre-existing tests).
- [ ] **Step 5: Commit.** `git add src/config.mjs test/config.test.mjs && git commit -m "feat(config): provider, workflow, labels, jiraBaseUrl"`

### Task 2: ADF helpers (markdown ⇄ Atlassian Document Format)

**Files:**

- Create: `src/adf.mjs`
- Test: `test/adf.test.mjs`

**Interfaces:**

- Produces:
  - `markdownToAdf(markdown: string): { type: "doc", version: 1, content: object[] }` — for Jira comment bodies. Rules: a line starting with `#` → `h1`–`h6` node (strip the hashes, text after the first space); consecutive lines starting with `- ` → one `ul` of `li` nodes; lines inside `fences` → one `code` node, `text` = interior lines joined by `\n`; blank lines separate blocks; every other non-empty line → `paragraph` with a single `text` node.
  - `adfToText(adf: object | null | undefined): string` — for reading Jira descriptions. Rules: `text` → `node.text`; `code` → `node.text`; `h1`–`h6` → `"#" * n + " " + inner text`; `paragraph` → its text node text; `ul` → each `li` as `"- " + li text`, lines joined by `\n`; `hr` → `"---"`; `doc`/top-level → blocks joined by `\n`; `null`/`undefined` → `""`.

- [ ] **Step 1: Write the failing `markdownToAdf` test.** Assert `markdownToAdf("# Plan\n\n- a\n- b\n\n``` \npipe x\n```\nplain")` yields `type: "doc"`, `version: 1`, and `content` deep-equal to `[{ type: "h1", content: [{ type: "text", text: "Plan" }] }, { type: "ul", content: [{ type: "li", content: [{ type: "text", text: "a" }] }, { type: "li", content: [{ type: "text", text: "b" }] }] }, { type: "code", text: "pipe x" }, { type: "paragraph", content: [{ type: "text", text: "plain" }] }]`.
- [ ] **Step 2: Write the failing `adfToText` test.** Assert `adfToText({ type: "doc", version: 1, content: [{ type: "h2", content: [{ type: "text", text: "Gates" }] }, { type: "ul", content: [{ type: "li", content: [{ type: "text", text: "test" }] }] }, { type: "paragraph", content: [{ type: "text", text: "done" }] }] })` equals `"## Gates\n- test\ndone"`.
- [ ] **Step 3: Write the failing edge tests.** `adfToText(null)` → `""`; `adfToText({ type: "code", text: "x\ny" })` → `"x\ny"`.
- [ ] **Step 4: Implement.** Pure functions in `src/adf.mjs` per the rules above.
- [ ] **Step 5: Run.** `node --test test/adf.test.mjs` → all pass.
- [ ] **Step 6: Commit.** `git add src/adf.mjs test/adf.test.mjs && git commit -m "feat: ADF (markdown/ADF) helpers for Jira comments and descriptions"`

### Task 3: Jira Cloud REST v3 client

**Files:**

- Create: `src/jira.mjs`
- Test: `test/jira.test.mjs`

**Interfaces:**

- Consumes: `markdownToAdf`, `adfToText` (Task 2); `repo` = normalized config repo from Task 1 (`provider: "jira"`, `jiraProject`, `workflow`, `labels`, optional `jiraIssueType` default `"Task"`, optional `jiraBlockingLinkTypes` default `["blocks"]`); `creds = { baseUrl, email, apiToken }`.
- Produces:
  - `getJiraCredentials(): { email, apiToken } | null` — `JIRA_EMAIL` + `JIRA_API_TOKEN` env vars (both set), else `~/.pi/jira.json` (`{ email, apiToken }`, trimmed); `null` when unresolved.
  - `createJiraClient(creds, { fetchImpl, retry })` → `{ listOpenIssues(repo), getIssue(identifier), comment(issueId, body), transition(issueId, statusName), addLabel(issueId, label), createIssue(input) }`.
  - `listOpenIssues(repo)` → `Issue[]`; JQL `project = "<jiraProject>" AND status = "<open>" AND labels = "<pick>"` (array `open` → `status in ("A", "B")`); paginated `startAt`/`maxResults=100`; blocks issues whose blocker is unresolved and issues carrying `labels.error`; blocker lookup = one batched search `issuekey in ("<blocker keys>")` (chunked at 100, fields `resolution,statusCategory`); blocker resolved = `fields.resolution != null` OR `statusCategory.key === "done"`.
  - `transition(issueId, statusName)`: GET `/rest/api/3/issue/<issueId>/transitions`; match numeric-id string first, else exact `name`, else `to.name`; no match → no POST, `console.error` warning, return (no-op).
  - `createIssue(input: { project, issueType, title, description? })` → `Issue`.
- [ ] **Step 1: Write the failing `listOpenIssues` tests.** Fake fetch: (a) single `open` → request path `/rest/api/3/search?` URL contains JQL `project = "PROJ" AND status = "To Do" AND labels = "task-driver"`, `Authorization: Basic ${btoa("u@x.com:t")}`; search response one issue `{ key: "PROJ-12", fields: { summary: "Fix bug", description: { type: "doc", ...ADF... }, labels: ["task-driver"], status: { name: "To Do", category: "To Do" }, issuelinks: [] }, browseUrl: "https://x.atlassian.net/browse/PROJ-12" }` → returns `[{ id: "PROJ-12", identifier: "PROJ-12", title: "Fix bug", description: "<adf text>", url: browseUrl, labels: ["task-driver"] }]`. (b) array `open: ["To Do", "In Progress"]` → JQL contains `status in ("To Do", "In Progress")`. (c) pagination: first page 2 issues + `startAt: 0, maxResults: 2, total: 3` → second request `startAt=2` → 3 issues total. (d) blockers: candidate `PROJ-12` with `issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "PROJ-99" }, inwardIssue: { key: "PROJ-12" } }]` (type name matched case-insensitively against `jiraBlockingLinkTypes`) and blocker response (separate fake fetch for the batch search) `fields.resolution` null → candidate dropped; with blocker `fields.resolution: { id: "2", name: "Won't Fix" }` → candidate kept; (e) candidate with `labels: ["task-driver", "ai:error"]` → dropped.
- [ ] **Step 2: Implement `listOpenIssues`** (+ private `buildJql(repo)`, `searchPage`, blocker-batch logic; JQL values are config-controlled strings, wrapped in double quotes, no escaping).
- [ ] **Step 3: Run** `node --test test/jira.test.mjs` → listOpen issues pass.
- [ ] **Step 4: Write the failing `getIssue` test.** GET `/rest/api/3/issue/PROJ-12?fields=summary,description,labels,status,url`; missing issue (HTTP 404) → throws.
- [ ] **Step 5: Write the failing `comment` test.** POST `/rest/api/3/issue/PROJ-12/comment` with ADF body = `markdownToAdf(body)`.
- [ ] **Step 6: Write the failing `transition` tests.** (a) transition list `[{ id: "1000", name: "Start Progress", to: { name: "In Progress" } }]`, `transition("PROJ-12", "In Progress")` → POST `/rest/api/3/issue/PROJ-12/transitions` body `{ transition: { id: "1000" } }`. (b) `transition("PROJ-12", "1000")` (numeric) → same POST. (c) `transition("PROJ-12", "Does Not Exist")` → no POST, `console.error` called.
- [ ] **Step 7: Write the failing `addLabel` + `createIssue` tests.** `addLabel(issue, "ai:error")` → PUT `/rest/api/3/issue/PROJ-12` body `{ update: { labels: [ { add: "ai:error" } ] } }`; `createIssue({ project: "PROJ", issueType: "Task", title: "T", description: "d" })` → POST `/rest/api/3/issue` body `fields.project.key: "PROJ"`, `fields.issuetype.name: "Task"`, `fields.summary: "T"`, `fields.description` = ADF doc; response with `key` + `browseUrl` → `Issue`.
- [ ] **Step 8: Write the failing retry test.** First call HTTP 429, second 200 → resolves with no throw (default `attempts: 3`); three 500s → throws.
- [ ] **Step 9: Implement** `getIssue`, `comment`, `transition`, `addLabel`, `createIssue`, `getJiraCredentials`, and the retry wrapper (mirror `linear.mjs`'s `RetryableLinearError` pattern, renamed `RetryableJiraError`, default attempts 3 / base delay 250ms, `sleep` injectable).
- [ ] **Step 10: Run.** `node --test test/jira.test.mjs` → all pass.
- [ ] **Step 11: Commit.** `git add src/jira.mjs test/jira.test.mjs && git commit -m "feat: Jira Cloud REST v3 client"`

### Task 4: Provider-neutral tracker

**Files:**

- Create: `src/tracker.mjs`
- Test: `test/tracker.test.mjs`

**Interfaces:**

- Consumes: `providers = { linear?, jira? }` (LinearClient from Task 5 / JiraClient from Task 3); normalized repo config (Task 1).
- Produces: `createTracker(repo, { linear, jira })` →
  - `listOpen(): Promise<Issue[]>` → `client.listOpenIssues(repo)`;
  - `comment(issue, body)`, `addLabel(issue, label)` → `client.<op>(issue.id, …)`;
  - `transition(issue, step)` for `step ∈ "claim" | "reopen" | "park"`: target = `workflow.claim` / `workflow.reopen ?? workflow.open` (first element if `open` is an array) / `workflow.park`; `park` unset → no-op return; linear → `linear.moveState(issue.id, target)`, jira → `jira.transition(issue.id, target)`;
  - `getIssue(identifier)`, `createIssue(input)` → passthrough to the provider client.

- [ ] **Step 1: Write the failing linear tests.** Fake repo (provider linear, default workflow) + fake `linear` client recording calls: `listOpen()` → `linear.listOpenIssues(repo)`; `comment(issue, body)` → `linear.comment(issue.id, body)`; `addLabel(issue, label)` → `linear.addLabel(issue.id, label)`; `transition(issue, "claim")` → `linear.moveState(issue.id, "In Progress")`; `transition(issue, "reopen")` → `linear.moveState(issue.id, "Todo")`; `transition(issue, "park")` → `linear.moveState(issue.id, "Backlog")`.
- [ ] **Step 2: Write the failing jira tests.** Fake jira repo `workflow: { open: "To Do", claim: "In Progress" }` + fake `jira` client: `transition(issue, "claim")` → `jira.transition(issue.id, "In Progress")`; `transition(issue, "park")` → no call (park unset); `transition(issue, "reopen")` → `jira.transition(issue.id, "To Do")`; with `open: ["To Do", "In Review"]` → `reopen` targets `"To Do"` (first element); explicit `reopen: "To Do"` wins over default.
- [ ] **Step 3: Write the failing passthrough / error tests.** `getIssue`/`createIssue` delegate to the right client; jira repo with `jira` null → throws (message names the repo).
- [ ] **Step 4: Implement** `src/tracker.mjs`.
- [ ] **Step 5: Run.** `node --test test/tracker.test.mjs` → all pass.
- [ ] **Step 6: Commit.** `git add src/tracker.mjs test/tracker.test.mjs && git commit -m "feat: provider-neutral tracker"`

### Task 5: Make the Linear provider config-driven

**Files:**

- Modify: `src/linear.mjs`
- Test: `test/linear.test.mjs`

**Interfaces:**

- Consumes: none new.
- Produces: `listOpenIssues(repo)` (was `listOpenIssues(teamKey, projectName)`) using `repo.team`, `repo.project`, `repo.workflow.open`, `repo.labels.pick`; the `labels` field mapping changes to `group:leaf` (`parent ? parent.name + ":" + node.name : node.name`; the GraphQL query gains `parent { name }` under `labels { nodes { … } }`); after mapping, filters out issues whose labels include `repo.labels.error` (the re-pick guard).
- `moveState`, `comment`, `addLabel`, `getIssue`, `createIssue` unchanged.

- [ ] **Step 1: Write the failing config-driven filter test.** `listOpenIssues` with repo `{ team: "SER", project: "tik-tak", workflow: { open: "WIP" }, labels: { pick: "auto" } }` → GraphQL filter `state.name == "WIP"` and `labels.name == "auto"`.
- [ ] **Step 2: Write the failing label-shape test.** Issue labels `[{ name: "error", parent: { name: "ai" } }, { name: "task-driver", parent: null }]` → returned `labels: ["ai:error", "task-driver"]`.
- [ ] **Step 3: Write the failing re-pick guard test.** Issue with labels `["ai:error", "task-driver"]`, repo `labels.error: "ai:error"` → excluded from results.
- [ ] **Step 4: Update pre-existing tests** to the new `listOpenIssues(repo)` signature (they cover the existing defaults `Todo` / `task-driver`).
- [ ] **Step 5: Implement** the changes in `src/linear.mjs`.
- [ ] **Step 6: Run.** `node --test test/linear.test.mjs` → all pass.
- [ ] **Step 7: Commit.** `git add src/linear.mjs test/linear.test.mjs && git commit -m "feat(linear): workflow/label config-driven picks and re-pick guard"`

### Task 6: Loop drives the tracker

**Files:**

- Modify: `src/loop.mjs`
- Test: `test/loop.test.mjs`

**Interfaces:**

- Consumes: `makeTracker: (repo) => Tracker` (replaces the `linear` dep in `createLoop`); `Tracker` from Task 4.
- Produces: unchanged `createLoop(...)` public surface; per-repo `const tracker = makeTracker(repo)` inside `processRepo`.
- Loop changes (exact):
  - `processRepo`: `const tracker = makeTracker(repo);` — `const issues = await tracker.listOpen();`; log line uses `repo.project ?? repo.jiraProject`.
  - Claim: `tracker.transition(issue, "claim")`; all `linear.comment` → `tracker.comment(issue, …)`.
  - Config error: `tracker.addLabel(issue, repo.labels.error)`; `tracker.transition(issue, "park")`.
  - Failure: `tracker.transition(issue, "reopen")`.
  - PR body header: `## ${repo.provider === "jira" ? "Jira" : "Linear"}`.
  - Dry-run claim line: `→ ${repo.workflow.claim}`.

- [ ] **Step 1: Write the failing success-path test.** `makeTracker` returns a fake tracker that records calls; happy path (agent passes, gates green, PR created) → records `transition(issue, "claim")`, `comment` for claim/params/plan/PR, `addLabel` never called, `transition(issue, "park"/"reopen")` never called; PR body contains `## Jira` when `repo.provider === "jira"` (and `## Linear` for a linear repo).
- [ ] **Step 2: Write the failing config-error test.** `params` reject path → records `addLabel(issue, "ai:error")` with a custom `repo.labels.error` (e.g. `"broken"`) and `transition(issue, "park")`; outcome `"config-error"`.
- [ ] **Step 3: Write the failing failure-path test.** Agent/gates fail after attempts → records `transition(issue, "reopen")`; branch pushed, PR not created; outcome `"failed"`.
- [ ] **Step 4: Write the failing claim-failure test.** `tracker.transition(issue, "claim")` rejects → issue skipped (`"skipped"`), agent not run.
- [ ] **Step 5: Write the failing mixed-config test.** `createLoop` with `config.repos` = [linear repo, jira repo] and a `makeTracker` that returns a different fake tracker per repo → both repos processed (both trackers' `listOpen` called, one PR body with `## Linear`, one with `## Jira`). Covers the spec's mixed-config criterion.
- [ ] **Step 6: Implement** the `loop.mjs` changes.
- [ ] **Step 7: Run.** `node --test test/loop.test.mjs` → all pass.
- [ ] **Step 8: Commit.** `git add src/loop.mjs test/loop.test.mjs && git commit -m "feat(loop): drive providers via per-repo tracker"`

### Task 7: CLI wiring, docs, integration

**Files:**

- Modify: `src/cli.mjs`, `README.md`

**Interfaces:**

- Consumes: `loadConfig`, `getLinearApiKey` (existing), `getJiraCredentials`, `createLinearClient`, `createJiraClient`, `createTracker`, `createLoop`.
- Produces: CLI resolves credentials per provider presence (Linear key only if any linear repo; Jira creds + `config.jiraBaseUrl` only if any jira repo), and passes `makeTracker: (repo) => createTracker(repo, { linear, jira })` to `createLoop`.

- [ ] **Step 1: Implement CLI changes.** Provider detection from `config.repos`; jira creds: `getJiraCredentials()` (missing → `console.error("task-driver: JIRA_EMAIL/JIRA_API_TOKEN not set and ~/.pi/jira.json not found.")` + `process.exit(1)`, mirroring the existing LINEAR key message); `--help` unchanged; dry-run and result logging unchanged.
- [ ] **Step 2: Verify credential gate.** Config with a jira repo and no Jira creds / `~/.pi/jira.json` → exit 1 with the error above. (Manual check via a throwaway config in `/tmp`.)
- [ ] **Step 3: Update `README.md`.** Title → "task-driver — Linear/Jira → PR automation"; add Jira to the auth list (`JIRA_EMAIL`/`JIRA_API_TOKEN` or `~/.pi/jira.json`, plus `jiraBaseUrl` in config); extend the config table with `provider`, `jiraProject`, `jiraBaseUrl`, `jiraIssueType`, `jiraBlockingLinkTypes`, `workflow`, `labels`; add a complete example repo entry matching the spec's Jira example.
- [ ] **Step 4: Run the full suite + tsc + lint.** `npm test` (all `test/*.test.mjs`), `npx tsc --noEmit`, `npm run lint` → all green.
- [ ] **Step 5: Commit.** `git add src/cli.mjs README.md && git commit -m "feat(cli): per-repo provider wiring; docs"`

## Out of scope (per spec)

- Jira Server/Data Center support (Cloud only).
- `task-driver add-repo` CLI (tracked separately, SER-25); `getIssue`/`createIssue` are groundwork for it.
- OAuth 2.0 / app-based Jira auth.
- Rich ADF markdown rendering in comments beyond the minimal `markdownToAdf` rules (Task 2).
- Transition caching (the spec suggested it; dropped — transition lists are status-dependent and a fetch per transition call is at most a few per run).

## Deviations from the spec (noted, semantics unchanged)

- Files stay flat (`src/jira.mjs`, `src/adf.mjs`, `src/tracker.mjs`) matching the existing `src/<module>.mjs` pattern, rather than the spec's `src/providers/` suggestion.
- `Tracker` is built per repo (repo baked in); its methods take no `repo` argument, so `loop` and `cli` never branch on provider.
- Jira `createIssue` description is sent as ADF (consistent with comments), verified live.
