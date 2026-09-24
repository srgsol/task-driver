# Handoff Controller — Design Spec

**Date:** 2026-09-17
**Status:** design approved; implementation not started
**Foundation:** `docs/automation/handoff.md` (locked decisions and current state)

## Goal

Automate development end-to-end: read an open **Linear** issue → implement →
verify → push a branch → open a **GitHub PR** → link the PR back on the Linear
issue. Multi-repo, per-repo credentials, concurrent-capable (v1 runs
sequentially). A human stays at the merge step.

## Decisions made in this session

| #   | Decision          | Choice                                                                                                            |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Shape             | **A (local loop)**, designed seam-first so B is adapter work                                                      |
| 2   | Trigger           | **Manual CLI batch** (`npm run handoff`)                                                                          |
| —   | Multi-repo        | **Config-driven from day one** (starts with one repo entry)                                                       |
| 3   | Branch convention | **`SER-<num>-<slug>`** (no type prefix)                                                                           |
| 4   | Guardrails        | **2 attempts/issue · 15-min timeout · `--thinking medium`** · failure = comment + push partial + return to `Todo` |
| 5   | Parallelism       | **Sequential first** (concurrency is a later config knob)                                                         |
| 6   | Write-back        | **Middle:** claim `Todo→In Progress` + comment · PR-link comment, stay `In Progress` · no `In Review` hop         |
| 7   | CI layer          | **Deferred to Shape B** (trigger: first time you merge a PR you didn't personally test)                           |
| —   | Naming            | **`handoff`**                                                                                                     |
| —   | Claim filter      | **`state = Todo` AND label `handoff`**                                                                            |
| —   | Division of labor | **Approach 1: thin controller, fat agent**                                                                        |

**Branch slug:** kebab-cased, lowercased issue title, truncated to ~40 chars
(e.g. `SER-9-fix-step-drag-handles`). Commit message mirrors this with no type
prefix: `SER-9: <title>`. PR title = the issue title.

## Architecture & components

```
handoff.config.json ──► ┌───────────────────────── controller (Node CLI) ─────────────────────────┐
                        │                                                                        │
  Linear API ◄──────────┤  linear.js      loop.js      gh.js (PR create)                         │
  (LINEAR_API_KEY)       │                                                                        │
                        │   executor.js ── spawns ──►  pi -p --mode json   (one subprocess/repo)  │
                        └─────────────────────────────────────────────────────────────────────────┘
                                     │  env: no GH_TOKEN / no LINEAR_API_KEY · timeout 15 min
                                     ▼
                          pi agent: implement → npm test/tsc/lint → commit → git push (SSH)
```

1. **`handoff` CLI** — a Node script, entry `npm run handoff`. Deterministic
   orchestration, no LLM. Runs the queue one issue at a time and exits with a
   summary.
2. **`handoff.config.json`** — declares the repos (path, team, remote) plus
   global knobs (attempts, timeout, thinking level).
3. **`linear.js`** — fetch-based GraphQL client (mirrors the in-repo
   extension's auth: raw key, no `Bearer`). Reads open issues, claims them,
   posts comments, moves state.
4. **`gh.js`** — wraps the `gh` CLI, injecting `GH_TOKEN` from the repo's
   `.env` per command (the `gh-auth` pattern). v1 job: create the PR.
5. **`executor.js`** — spawns `pi -p --mode json` per repo with the right env
   and timeout, captures the result.
6. **`implement.md`** — a skill/prompt file describing the agent's exact job.

**Seams kept explicit for Shape B reuse:** `IssueSource` (= `linear.js`),
`Executor` (= `executor.js`), `CredentialProvider` (reads `.env` in A, CI
secrets in B), `Trigger` (CLI now, cron/webhook later).

**File layout:** everything in a new `handoff/` directory in the tiktak repo
(the reference repo), alongside the existing `scripts/`.

### Why a dedicated `linear.js`

The Linear extension's access exists _inside a pi session_ (registered via
`pi.registerTool`), not as an importable library. The controller is a plain
deterministic Node script that _spawns_ pi — it has no session, no tool
harness, no LLM — so it cannot use the extension. The pi subprocess
deliberately has _no_ Linear access either (`--no-extensions`): it receives the
issue text in its prompt and owns only code. `linear.js` is ~60–80 lines
covering the four operations the controller needs. Extracting a shared core
with the extension is deferred until the duplication grows.

## Config, credentials, and clients

**`handoff/handoff.config.json`:**

```json
{
  "repos": [
    { "name": "tiktak", "path": ".", "team": "SER", "remote": "git@github.com:srgsol/tiktak.git" }
  ],
  "attempts": 2,
  "timeoutMs": 900000,
  "thinking": "medium"
}
```

- `repos[].path` — checkout location (`.` for the repo containing `handoff/`,
  absolute paths for other repos).
- `repos[].team` — the Linear team key to poll.

**Credentials — three sources, none global:**

| Credential           | Where it lives                     | Who uses it   | How                                          |
| -------------------- | ---------------------------------- | ------------- | -------------------------------------------- |
| `GITHUB_TOKEN` (PAT) | each repo's `.env`                 | `gh.js`       | injected as `GH_TOKEN` per command           |
| `LINEAR_API_KEY`     | env var **or** `~/.pi/linear.json` | `linear.js`   | env first, then the `~/.pi/linear.json` file |
| SSH key              | `~/.ssh` + agent                   | pi subprocess | push over `git@github.com:…`                 |

Asymmetry: **Linear is one key** (team-wide, not per-repo, so _not_ in any
repo `.env`); **GitHub is one PAT per repo** (the whole point of per-process
isolation).

**`linear.js` — four operations:**

1. `listOpenIssues(team)` — `state.name = Todo` AND `labels: { name: { eq: "handoff" } }`.
2. `comment(issueId, body)` — `commentCreate`.
3. `moveState(issueId, stateName)` — `issueUpdate`, resolving state id within the issue's team.
4. `getIssue(identifier)` — full title/description for the prompt.

**`gh.js` — one operation:** `createPR(repo, { base: "master", head, title, body })`.

## Run loop

One `npm run handoff` invocation, per repo (and sequentially within it):

```
read open issues (team=SER, state=Todo, label=handoff)
        │
        ▼
   claim: Todo ──► In Progress  +  comment "🤖 handoff: implementing SER-9 …"
        │
        ▼
   pi run (15-min timeout) ──► verify: exit 0 · branch pushed · gates re-run green
        │
        ├── green ──────────► gh pr create (base=master, head=SER-9-<slug>)
        │                       │
        │                       └──► comment PR link + gate summary  (stays In Progress)
        │
        └── red (attempt 1) ─► repair pass: pi run #2 with failure output appended
                │
                ├── green ──► PR + comment (as above)
                └── red/crash/timeout ──► failure path (see Error handling)
```

**Branch lifecycle — one issue = one branch:**

- Each issue is implemented on its own branch `SER-<num>-<slug>`, created by
  the **controller** (`git checkout master && git checkout -b SER-9-<slug>`)
  immediately before spawning pi.
- The pi agent works only on that branch (switching off it is a MUST NOT) and
  pushes it; the PR is `base=master, head=SER-<num>-<slug>`.
- After the PR opens (or the failure path completes), the controller returns
  the checkout to `master` so the next issue starts clean. The branch lives on
  the remote (and locally) until the PR is merged.

**The three Linear moments per issue:**

1. **Claim** — `moveState(Todo → In Progress)` + comment (branch name + start time).
2. **PR opened** — comment with PR link + three-gate summary + the plan (if
   one was written). State stays `In Progress`; a human sets `Done` at merge.
3. **Failure** — comment (what was attempted, which gate failed, the plan if
   any) + branch pushed but no PR + state returned to `Todo`.

**Claim filter:** `state.name = Todo` AND `labels: { name: { eq: "handoff" } }`
— only issues explicitly flagged for automation are picked (sidesteps
onboarding noise). The `handoff` label must exist in the SER team and is left
on after claiming (trace marker; cannot cause re-picks because `Todo` is gone).

**Idempotency:** claiming is the only `Todo → In Progress` transition, and the
queue only picks `Todo` issues, so re-running never double-claims or
double-PRs. Known gap: a hard crash _after_ claim but _before_ PR leaves an
issue stuck in `In Progress`; v1 recovery is moving it back to `Todo` manually.
A `--recover` flag to auto-detect orphans is a later add, not v1.

## pi subprocess contract

```
pi --print --mode json \
   --session-id handoff-<repo>-<issue> \
   --approve \
   --no-extensions \
   --skill handoff/implement.md \
   --thinking medium \
   "Implement SER-9: <title>\n\n<description>\n\nBranch: SER-9-<slug>"
```

- **`--no-extensions`** enforces "the agent never touches Linear" _by
  construction_ (no Linear tools in its session), not just by instruction.
- **env:** cwd = repo path; inherits the model API key. **No** `GH_TOKEN`, **no**
  `LINEAR_API_KEY` — the agent does SSH push only.
- **timeout:** 15 min (900 000 ms).

**`implement.md` — the agent's contract (tiered):**

- **Classify first** (trivial vs non-trivial), mirroring the brainstorming
  classify step.
- **Trivial** → implement directly (TDD for any logic), run `npm test`,
  `npx tsc --noEmit`, `npm run lint` until green, commit `SER-9: <title>`,
  `git push -u origin SER-9-<slug>` over SSH.
- **Non-trivial** → produce a short plan using the brainstorming _method_:
  ask the clarifiers and **auto-accept the recommended/default answer to each,
  recording the assumption** (there is no human in the loop). Write the plan to
  `handoff/plans/SER-<num>.md`, then implement that plan, run the gates until
  green, commit, push.
- MUST: respect `AGENTS.md` · stay on the `SER-9-<slug>` branch.
- MUST NOT: open a PR · touch Linear · merge · change CI/config · switch off
  the `SER-9-<slug>` branch.

The plan reaches Linear via the **controller**, not the agent (`--no-extensions`
holds): the controller posts the plan file as part of the PR-opening comment
(or the failure comment).

**Verification — the controller does not trust the agent's self-report.** On
exit it independently checks: (1) exit code `0`, (2) branch exists and is
pushed (`git ls-remote`), (3) re-runs the three gates itself in that checkout.
All three green → PR. (The agent runs gates to know when it's done; the
controller's run is the independent verification gating the PR.)

**Repair pass (attempt 2):** same `--session-id` (resumes the session context)

- the failure output appended to the prompt.

**Logs:** JSON transcript per run → `handoff/logs/<repo>-<issue>-<attempt>.json`
(for failure comments and debugging).

## Error handling & failure modes

| #   | Failure point                                          | Behavior                                                                                                               |
| --- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | Linear read fails (API down / bad key)                 | Abort run, non-zero exit, clear message. Nothing claimed.                                                              |
| 2   | Pre-flight: repo dirty / wrong branch / missing `.env` | Skip that repo with a clear error — never clobber WIP.                                                                 |
| 3   | Claim fails (state transition error)                   | Log + skip that issue, continue the batch.                                                                             |
| 4   | pi crash / timeout / gates red (any red)               | One repair pass (attempt 2, same session, failure appended).                                                           |
| 5   | Still red after 2 attempts                             | Failure path: comment (attempted + which gate failed + plan, if any) · push partial branch (no PR) · return to `Todo`. |
| 6   | PR create fails (gh error, bad token)                  | Comment failure + branch name (open manually); code done and pushed → leave `In Progress`.                             |
| 7   | Write-back comment fails after PR                      | Non-fatal: PR exists; log + surface in summary.                                                                        |

- **#4 treats timeout like any red** — one repair pass (also 15-min capped),
  then #5. `--thinking medium` + the label-gated queue keeps this rare.
- **#5 vs #6 differ by intent:** implementation failure (#5) returns the issue
  to `Todo` for retry; plumbing failure (#6) leaves done-and-pushed work in
  `In Progress` — nothing to re-implement, just a missing PR.

## Testing

1. **Unit tests** (`node --test`, mocked `fetch`/`spawn`): config validation,
   the label/state filter construction, the exact `gh pr create` argv + env,
   the branch-slug generator, and the green/red/repair/failure decision logic.
2. **`--dry-run` mode** — prints what it _would_ do (claim, spawn, PR,
   comments) without doing any of it. First thing run against real Linear data.
3. **End-to-end on a throwaway issue** — a real `SER-13` with a trivial change,
   labeled `handoff`, run the real loop, watch claim → implement → gates →
   push → PR → comment, then merge + close manually.
4. **Failure-injection** — one `handoff` issue with an unsatisfiable
   requirement, to confirm the failure path end-to-end (2 attempts → comment +
   partial push → back to `Todo`).

## Out of scope (deferred, with re-entry triggers)

- **Shape B (CI-native)** — re-enter when the loop is trusted and you want the
  merge gate enforced, not advisory. The seams (`Executor`, `CredentialProvider`,
  `Trigger`) make this adapter work + one `.github/workflows/*.yml`.
- **CI workflow + branch protection** — same moment as Shape B.
- **Concurrency** (`--jobs N`, same-repo worktrees) — re-enter when multiple
  issues queue up in one repo at once.
- **`--recover` for orphaned `In Progress` issues** — re-enter if crashes-after-claim become frequent.
- **GitHub App** (per-repo installation tokens) — re-enter if PAT rotation becomes painful.
- **Shared Linear client core with the extension** — re-enter if the duplication grows.

## Success criteria

- `npm run handoff` turns a `Todo` + `handoff`-labeled SER issue into a green,
  pushed branch and an open PR with a comment linking it back on the issue.
- Re-running is safe (no double-claim, no double-PR).
- The controller's own gate re-run — not the agent's claim — decides whether a
  PR opens.
- A human merges after device/manual verification; automation never merges.
