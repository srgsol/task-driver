# Jira Provider — Design Spec

**Date:** 2026-10-12
**Status:** draft — builder check done, pending approval
**Scope:** task-driver tracker layer (issue source + write-back). Git, gates, `gh`, executor, and the agent prompt are untouched.

## Goal

task-driver currently talks only to Linear, and it hardcodes Linear's workflow
(state names `Todo`, `In Progress`, `Backlog`, `Done`/`Canceled`) and label names
(`task-driver`, `ai:error`). The author runs task-driver against personal Linear
repos, but their company uses **Jira Cloud**. They want to point task-driver at
Jira repos with the **same functionality**, choosing the provider per repo, in a
single config file that can mix both.

The provider is a per-repo config choice. The claim/state machinery — which the
author correctly flagged as the fragile part — is generalized into a per-repo,
provider-agnostic workflow map, so a Linear repo with renamed states and a Jira
repo with custom transitions both work without code changes.

## Decisions made in this session

| #   | Decision                   | Choice                                                                                                                                          |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Provider selection         | `provider` field at **repo level** (`linear` \| `jira`); one config file may mix both                                                           |
| 2   | Workflow mapping           | **Per-repo**, provider-agnostic; removes the hardcoded state names                                                                              |
| 3   | Jira deployment            | **Jira Cloud** (REST v3, `*.atlassian.net`)                                                                                                     |
| 4   | Jira auth                  | email + API token (Basic auth), mirroring Linear's key-resolution pattern                                                                       |
| 5   | Error path                 | "park on error" becomes an **optional** workflow step — always label + comment, move only if configured; the `error` label is the re-pick guard |
| 6   | Blocked-issue filter       | Keep parity; Jira uses issue links (`blocks`/`is blocked by`); `resolution != null` means resolved                                              |
| 7   | `getIssue` / `createIssue` | In scope for parity; Jira-shaped signatures                                                                                                     |
| 8   | Label names                | Per-repo configurable, with the current names as defaults                                                                                       |

## The tracker abstraction

The processing loop (`src/loop.mjs`) should stop depending on `linear.mjs`
directly and depend on a provider-neutral **tracker** interface. This is not a
new concept — it is exactly the surface the loop already uses, renamed and
generalized:

```
Issue = { id, identifier, title, description, url, labels: string[] }

listOpen(repo)            -> Issue[]     // pickable issues (open state + pick label, minus blocked and error-labeled)
comment(issue, body)      -> void
transition(repo, issue, step) -> void    // step ∈ "claim" | "reopen" | "park"
addLabel(issue, label)    -> void        // label name comes from repo.labels.error
getIssue(identifier)      -> Issue
createIssue(input)        -> Issue        // provider-shaped input (see below)
```

`transition` takes a **logical step**, not a state/transition name. The provider
resolves the step to a concrete move using the repo's workflow map. `park` is a
no-op when the repo does not configure a park target (decision #5).

A small factory (`src/tracker.mjs` or equivalent) picks the provider from
`repo.provider`. Both providers implement the same interface. The loop and CLI
never branch on provider.

### Workflow map (provider-agnostic)

Each repo entry carries an optional `workflow` object:

```json
"workflow": {
  "open":   "Todo",        // pick state. Linear: single state name. Jira: status name or array of status names (JQL `status in (...)`).
  "claim":  "In Progress", // claim target (Linear state name; Jira transition name)
  "reopen": "Todo",        // return-to-open target; defaults to `open` when omitted
  "park":   "Backlog"      // optional error target; no move when omitted/empty
}
```

How each provider interprets a value:

| Key      | Linear                                                                                 | Jira                                                                                      |
| -------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `open`   | pick state (single name); also the failure `moveState` target and the `reopen` default | status name, or an array of status names (`status in (...)`), used in the JQL pick filter |
| `claim`  | state name passed to `moveState`                                                       | transition name (matched by `name`, or by destination `to.name`)                          |
| `reopen` | state name passed to `moveState`                                                       | transition name (same matching)                                                           |
| `park`   | state name passed to `moveState`                                                       | transition name (same matching); no-op when unset                                         |

**Linear defaults** (preserve today's behavior exactly, so existing configs are
unchanged): `open = Todo`, `claim = In Progress`, `reopen = Todo`, `park = Backlog`.

**Jira defaults**: none for `open`/`claim` (required in config), `reopen`
defaults to `open` (its first element when `open` is an array; resolved via
destination-status matching, see below), `park` defaults to unset.

`workflow.open` accepts a **single string or an array** of status names. Jira
projects often have several not-done statuses (`To Do`, `In Progress`, `In
Review`); the array form maps to JQL `status in (...)`, so the repo lists every
status it treats as pickable work. The single-string form is the common case and
stays valid.

### Labels

Per-repo, optional, defaults applied to both providers:

```json
"labels": { "pick": "task-driver", "error": "ai:error" }
```

`pick` is the label that marks an issue for task-driver (used in the pick
filter); `error` is the triage label added on config errors (currently
`ai:error`).

**Re-pick guard.** `listOpen` excludes any issue already carrying the `error`
label — in addition to the open-status + pick-label filter. On a config error the
loop comments, adds the `error` label, and (optionally) parks. The label is what
actually keeps a broken issue from being re-picked every run; the `park` move is
a cosmetic nicety. This matters because a standard Jira flow (`Todo → In
Progress → In Review → Done`) has no "Backlog" status, so the label-based guard
is the only mechanism there.

**Label string shape.** `Issue.labels` carries labels as they exist in the
provider: on Linear, `group:leaf` (or just `leaf` if the label has no group;
the client query gains `parent { name }`); on Jira, the flat label itself
(Jira has no label groups). The re-pick guard therefore matches `labels.error`
as a plain string on both providers, and `params.mjs` needs no change: its
existing `ai:` / `ai/` prefix-stripping makes `model-*` / `effort-*` labels
resolve identically either way.

## Config schema (proposed)

Top-level gains one optional key (required only when any repo uses Jira):

```json
"jiraBaseUrl": "https://your-company.atlassian.net"
```

This assumes a **single Jira Cloud tenant** for the whole config (the author's
company uses one Jira; personal projects stay on Linear). Multi-tenant Jira is
out of scope — if it ever appears, `jiraBaseUrl` moves to per-repo.

Repo entries gain:

```json
{
  "name": "company-repo",
  "path": "../company-repo",
  "provider": "jira",                 // default "linear"
  "jiraProject": "PROJ",              // required when provider = "jira"
  "jiraIssueType": "Task",            // optional, default "Task" (used by createIssue)
  "jiraBlockingLinkTypes": ["blocks"],// optional, default ["blocks"]
  "workflow": { "open": "To Do", "claim": "Start Progress", "reopen": "To Do" },
  "labels": { "pick": "task-driver", "error": "ai:error" },
  "remote": "…",
  "gates": [ … ]
}
```

Existing Linear repo entries keep `team` and `project` exactly as today; they are
used only by the Linear provider and are ignored by Jira. Exact field names are a
proposal — the builder may rename them as long as the semantics above hold.

**Concrete Jira example** (the author's company workflow — `Todo → In Progress →
In Review → Done`, pick = `task-driver` label, wait status `Todo`):

```json
{
  "name": "company-repo",
  "path": "../company-repo",
  "provider": "jira",
  "jiraProject": "PROJ",
  "jiraIssueType": "Task",
  "jiraBlockingLinkTypes": ["blocks"],
  "workflow": {
    "open": "To Do",
    "claim": "In Progress"
  },
  "labels": { "pick": "task-driver", "error": "ai:error" },
  "remote": "…",
  "gates": [ … ]
}
```

Here `claim: "In Progress"` resolves via the destination-status (`to.name`) path
— the underlying transition may be named "Start Progress" — `reopen` is omitted
and defaults to `open` the same way. `park` is deliberately omitted: there is no
park status in this workflow, so config-error issues are handled by the `ai:error`
label alone. Status names must match the board exactly (standard Scrum: `To Do`
/ `In Progress` / `In Review` / `Done`).

Validation (`src/config.mjs`):

- `provider` ∈ `{linear, jira}`; defaults to `linear`.
- When `provider = jira`: `jiraProject` required; `jiraBaseUrl` must be present
  (top-level); `workflow.open` (string or non-empty array) and `workflow.claim`
  required.
- When `provider = linear`: `workflow.open` must be a single string.
- `workflow.reopen` / `workflow.park` optional; `reopen` defaults to `open`
  (first element when `open` is an array).
- `jiraBlockingLinkTypes` non-empty array of strings when present.

## Jira provider — `src/providers/jira.mjs`

Cloud REST v3, base URL from `jiraBaseUrl`. Auth is HTTP Basic
(`base64(email:apiToken)`). Constructor accepts an injectable `fetch` and retry
options so it is unit-testable exactly like the Linear client today.

A live Jira Cloud instance and API token are available (author-provided), so
the "verify during implementation" items are checked against the live instance,
not guessed: ADF comment body, blocked-filter field expansion, and `browseUrl`
shape. The `addLabel` body shape below is verified against the Atlassian v3
docs.

**Credentials** — resolve like Linear's key: `JIRA_EMAIL` + `JIRA_API_TOKEN` env
vars first, else `~/.pi/jira.json` (`{ "email", "apiToken" }`). Missing
credentials fail fast at CLI startup with a clear message (same UX as today's
"LINEAR_API_KEY not set").

**Retry** — reuse the existing 429/5xx exponential-backoff behavior (extract the
shared helper from `linear.mjs`, or duplicate; builder's choice).

Operations and their endpoints:

| Operation     | Endpoint / shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listOpen`    | `GET /rest/api/3/search/jql` with JQL `project = <jiraProject> AND status = "<workflow.open>" AND labels = "<labels.pick>"`, paginated (`startAt`/`maxResults`, 100/page). Fields: `key, summary, description, labels, status, issuelinks, url`. `Issue.url` = `browseUrl` (human link used in PR bodies and logs — verify field presence in v3 search results, fall back to `self`). Filter blocked issues in code (below) and drop any issue already carrying `labels.error`. |
| `getIssue`    | `GET /rest/api/3/issue/{key}?fields=summary,description,labels,status,url`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `createIssue` | `POST /rest/api/3/issue` with `{ fields: { project: { key }, issuetype: { name }, summary, description } }`; `Issue.url` = response `browseUrl` (fall back to `self` — verify live shape). Input shape: `{ project, issueType, title, description }`.                                                                                                                                                                                                                           |
| `comment`     | `POST /rest/api/3/issue/{key}/comment`. Body format is a **known wrinkle**: v3 expects Atlassian Document Format (ADF). Builder to use a single plain-text paragraph ADF node (or the v2 comment endpoint) so the existing markdown strings keep working; verify against the live API during implementation.                                                                                                                                                                    |
| `transition`  | `GET /rest/api/3/issue/{key}/transitions` then `POST /rest/api/3/issue/{key}/transitions` with `{ transition: { id } }`. Resolve the configured name by matching transition `name` or destination `to.name` (accept a numeric id directly too). Cache the transition list per issue (it depends on current status).                                                                                                                                                             |
| `addLabel`    | `PUT /rest/api/3/issue/{key}` with `{ "update": { "labels": [ { "add": "<label>" } ] } }` (add-only; existing labels survive). Jira labels are free-form — no pre-creation needed (unlike Linear's resolve-or-create).                                                                                                                                                                                                                                                          |

#### Reading descriptions (ADF)

Jira Cloud v3 returns `description` (and comment bodies) as Atlassian Document
Format — a JSON structure, not a string — whereas `Issue.description` is
`string | null` and the loop interpolates it into the agent prompt. The provider
must therefore **render ADF to plain text** (recursive text extraction from the
`content` nodes) when reading a description, falling back to requesting
`?expand=renderedFields` and stripping HTML if needed. Comments we _write_ stay
plain text (see the `comment` row); only reads need this. This adds a small pure
helper and its own test surface.

#### Transition resolution

`transition` resolves the configured name against the issue's available
transitions as follows, in order:

1. If the configured value is numeric, treat it as a transition **id**.
2. Otherwise match by transition `name` (exact, case-sensitive), then by
   destination status `to.name`.
3. On multiple matches, prefer the exact `name` match; otherwise take the first.
4. `reopen` defaults to `open`, resolved via the `to.name` path (a transition
   whose destination status equals the open status).
5. If **no** matching transition exists — including "no transition back to the
   open status" — treat the step as a **no-op with a logged warning** (same
   semantics as `park`); the comment is still posted, and the issue simply stays
   where it is until a human moves it.

### Blocked-issue filter (parity with Linear)

Linear skips an issue blocked by an unresolved issue via `relations`. Jira has
issue **links** instead. When A blocks B, the link type is `Blocks` (outward
`blocks`, inward `is blocked by`), `outwardIssue` = A, `inwardIssue` = B.

For each candidate B, look at its `issuelinks`; for every link whose type's
outward name is in `jiraBlockingLinkTypes` and whose `inwardIssue` is B, inspect
the `outwardIssue` (blocker A). If A is unresolved, drop B. **"Resolved"** =
`A.fields.resolution != null` (any resolution: Done, Won't Fix, Duplicate,
Cancelled, …) with status-category `done` as a fallback signal — this is the Jira
equivalent of Linear's terminal `{Done, Canceled}`, and avoids enumerating
status names. The builder must confirm the exact field expansion needed so linked
issues' `resolution`/`status` are present in the search response (add an
`expand`/field request or a follow-up fetch if not).

The link-type name is admin-configurable per Jira instance, hence
`jiraBlockingLinkTypes` in config (decision #6), defaulting to the standard
`["blocks"]`.

## Linear provider changes — `src/linear.mjs` → `src/providers/linear.mjs`

The Linear client keeps its GraphQL operations but stops hardcoding state names
and label names:

- `listOpenIssues` filter uses `workflow.open` and `labels.pick` instead of
  literal `"Todo"` / `"task-driver"`, and drops issues already carrying
  `labels.error` (the re-pick guard).
- `listOpenIssues` returns labels as `group:leaf` (or just `leaf` when the
  label has no group; the GraphQL query gains `parent { name }`), so the guard
  and `params.mjs` see a uniform label string across providers.
- `moveState(issueId, step)` resolves `step` through `workflow` (`claim` →
  `workflow.claim`, `reopen` → `workflow.reopen`, `park` → `workflow.park`).
- `addLabel(issueId, label)` keeps the resolve-or-create logic but the label name
  is supplied by the caller (`repo.labels.error`), not hardcoded `"ai:error"`.
- `getIssue` / `createIssue` unchanged in behavior; they now live behind the
  tracker interface.

## Loop changes — `src/loop.mjs`

Mechanical, no behavior change for Linear repos with default workflow:

- `processRepo` calls `tracker.listOpen(repo)` instead of
  `linear.listOpenIssues(repo.team, repo.project)`.
- The claim step: `linear.moveState(issue.id, "In Progress")` →
  `tracker.transition(repo, issue, "claim")`.
- Config-error path: `linear.addLabel(issue.id, "ai:error")` →
  `tracker.addLabel(issue, repo.labels.error)`; `linear.moveState(issue.id,
"Backlog")` → `tracker.transition(repo, issue, "park")` (no-op when unset).
- Failure path: `linear.moveState(issue.id, "Todo")` →
  `tracker.transition(repo, issue, "reopen")`.
- All `linear.comment` → `tracker.comment`.
- PR body: the literal `## Linear` section header becomes provider-derived
  (`## Jira` for Jira repos); the issue link already uses `issue.url`.
- README: generalize the title and auth section (add `JIRA_EMAIL` /
  `JIRA_API_TOKEN` env vars or `~/.pi/jira.json`; document the new config
  fields).

The `Issue` shape (`id`, `identifier`, `title`, `description`, `url`, `labels`)
is unchanged, so branch naming and agent prompts are untouched.

## CLI wiring — `src/cli.mjs`

Build the tracker via the factory (`createTracker(config, credentials)`) instead
of `createLinearClient(apiKey)` directly. Resolve Linear credentials only when a
Linear repo exists; resolve Jira credentials + `jiraBaseUrl` only when a Jira
repo exists. Both are cheap and only fetched once at startup.

## Testing

The Jira client is unit-tested against an injected fake `fetch` (same pattern as
`test/linear.test.mjs` today), so no live Jira instance is needed.

| File                          | Coverage                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/jira.test.mjs` (new)    | JQL built from config (single + multi status); pagination; comment; transition resolution by name / `to.name` / id / no-match no-op; ADF description → plain text; addLabel update operation; blocked filter (blocks + resolved/unresolved blocker); createIssue; getIssue; Basic-auth header; retry on 429/5xx |
| `test/tracker.test.mjs` (new) | factory picks provider by `repo.provider`; defaults to linear                                                                                                                                                                                                                                                   |
| `test/config.test.mjs`        | provider validation; Jira required fields; workflow/labels defaults; `jiraBlockingLinkTypes` shape                                                                                                                                                                                                              |
| `test/loop.test.mjs`          | loop calls `tracker.*` with logical steps; `park` no-op when unset; `repo.labels.error` used for the error label                                                                                                                                                                                                |
| `test/linear.test.mjs`        | `listOpenIssues`/`moveState` use workflow + label names instead of literals                                                                                                                                                                                                                                     |

## Out of scope

- Jira **Server / Data Center** (Cloud only — decision #3).
- Anything Git, gates, `gh`, executor, or `implement.md` related.
- OAuth 2.0 / app-based Jira auth (Basic with API token only for now).
- The CLI `task-driver add-repo` feature (SER-25) — `getIssue`/`createIssue` only
  lay groundwork; no CLI is built here.
- Rich-text (ADF) rendering of markdown comments — plain text is sufficient.

## Success criteria

- A config with a `provider: "jira"` repo lists its open issues, claims one,
  drives the agent, and posts comments + the PR link back to Jira.
- Jira-repo PRs carry the issue link under a `## Jira` header; Linear repos
  keep `## Linear`.
- A mixed config (one Linear repo + one Jira repo) runs both in one invocation.
- An existing Linear-only config behaves identically to today (defaults match
  the current hardcoded values).
- A Linear repo with a non-standard workflow works via its `workflow` map without
  code changes.
- `getIssue` and `createIssue` work against Jira with Jira-shaped input.
- Blocked Jira issues (blocked by an unresolved issue) are skipped, matching
  Linear's behavior.
- `npm test`, `npx tsc --noEmit`, `npm run lint` all pass.

## Non-goals / explicit non-assurances

- No guarantee the configured Jira transition/status names exist — a bad name
  surfaces as an ordinary claim failure (skipped), not a startup error.
- Jira labels are flat; the Linear `ai:` label-group nicety does not exist in
  Jira (the `ai:error` literal is simply a label there). The `params.mjs` prefix
  stripping already makes `model-*`/`effort-*` labels flat-safe.
- Jira transitions that require a screen or required fields (e.g. assignee) will
  fail the claim with a 400 — no auto-fill is implemented in v1. If this bites,
  a follow-up can set the assignee to the authenticated user on claim.
- Blocked-filter correctness depends on the instance's link-type configuration;
  the default `["blocks"]` may need adjusting per instance.
