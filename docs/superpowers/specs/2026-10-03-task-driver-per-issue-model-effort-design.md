# Per-Issue Model & Effort — Design Spec

**Date:** 2026-10-03
**Status:** design approved; implementation not started
**Scope:** task-driver controller only (agent run parameters)

## Goal

Let each Linear issue choose its own `pi` **model** and **thinking effort**,
because issue difficulty varies per task. Parameters are carried as Linear
**labels with short aliases**, decoded to real values inside task-driver so that
model IDs never live in Linear. Unlabeled issues behave exactly as today.

## Decisions made in this session

| #   | Decision                 | Choice                                                              |
| --- | ------------------------ | ------------------------------------------------------------------- |
| 1   | Granularity              | **Alias labels, not raw model IDs** — decode in config              |
| 2   | Label carrier            | Linear labels, group `ai`: `ai:model-<alias>` / `ai:effort-<alias>` |
| 3   | Unknown / multiple alias | **Fail the issue** (never run the wrong model silently)             |
| 4   | Failure marker           | Move to `Backlog` **and** add label `ai:error`                      |
| 5   | Resolution owner         | New pure module `src/params.mjs`                                    |
| 6   | Model ID validation      | Pass-through (no catalog check); bad ID = failed agent run          |
| 7   | Fallback when no label   | No `--model` flag (pi default); `--thinking config.thinking`        |

## Label convention

Linear treats `:` (and `/`) as a group separator, so `ai:model-fast` creates an
`ai` group containing a label whose **leaf name** is `model-fast`. The `ai`
group is cosmetic; the controller matches on the leaf name only, so grouped and
ungrouped labels both resolve.

| Label (leaf)         | Meaning                              | Decoded to                         |
| -------------------- | ------------------------------------ | ---------------------------------- |
| `model-<alias>`      | which model                          | `--model config.models[alias]`     |
| `effort-<alias>`     | thinking effort                      | `--thinking config.efforts[alias]` |
| `error` (under `ai`) | triage marker added on config errors | (controller-written, never read)   |

`error` is written by the controller, never consumed by it.

## Config schema

Two new **optional** top-level maps in `task-driver.config.json`:

```json
{
  "models": { "fast": "openai/gpt-4o-mini", "sonnet-4.5": "anthropic/claude-sonnet-4.5" },
  "efforts": { "low": "low", "high": "high" }
}
```

Validation at load time (`src/config.mjs`):

- `models`: object of `string → string`; values must be non-empty. **Not**
  checked against pi's catalog — a genuinely bad ID surfaces as a normal failed
  agent run (existing failure path), not a config error.
- `efforts`: object of `string → string`; values must be one of
  `off | minimal | low | medium | high | xhigh | max` (pi `--thinking` levels).
- Both maps are optional. When absent, any `model-*` / `effort-*` label is an
  unknown-alias error (see Failure semantics).

`repos[]`, `attempts`, `timeoutMs`, `gateTimeoutMs`, and the existing global
`thinking` are unchanged. The global `thinking` remains the fallback when an
issue has no `effort-*` label.

## Resolution — `src/params.mjs`

New pure module, no I/O:

```js
resolveAgentParams(labels, config) =>
  | { ok: true,  model?: string, thinking: string }
  | { ok: false, error: string }
```

Rules (leaf names matched against `^model-(.+)$` and `^effort-(.+)$`):

| Issue labels                 | Result                                                               |
| ---------------------------- | -------------------------------------------------------------------- |
| (none)                       | `{ ok: true, model: undefined, thinking: config.thinking }`          |
| `model-fast`                 | `{ ok: true, model: config.models.fast, thinking: config.thinking }` |
| `model-fast` + `effort-high` | `model = config.models.fast`, `thinking = config.efforts.high`       |
| `effort-high` only           | `{ ok: true, model: undefined, thinking = config.efforts.high }`     |
| `model-<unknown>`            | `{ ok: false, error: "unknown model alias <alias>" }`                |
| `effort-<unknown>`           | `{ ok: false, error: "unknown effort alias <alias>" }`               |
| two or more `model-*`        | `{ ok: false, error: "multiple model labels" }`                      |
| two or more `effort-*`       | `{ ok: false, error: "multiple effort labels" }`                     |

`model` is `undefined` only when no `model-*` label is present; the executor
omits `--model` in that case. `thinking` is always a concrete level.

## Linear client changes — `src/linear.mjs`

1. **`listOpenIssues`** query adds `labels { nodes { name } }`; the returned
   issue gains `labels: string[]` (leaf names). The `task-driver` filter is
   unchanged.
2. **`addLabel(issueId, labelName)`** — new method. `labelName` is the full
   `group:leaf` string (e.g. `ai:error`).
   - Resolve-or-create: look up the leaf under its group
     (`issueLabels { nodes { id name parent { name } isGroup } }`). If the group
     or leaf is missing, create it via `issueLabelCreate` (group first, with
     `isGroup`, then the leaf with `parentId`).
   - Apply by reading the issue's current `labelIds` and writing the **union**
     via `issueUpdate` (Linear replaces the whole set, so existing labels must
     be preserved).
   - Exact mutation shape is verified against the Linear schema during
     implementation.

## Loop changes — `src/loop.mjs`

Order in `processIssue`, **resolve before claim**:

1. `resolveAgentParams(issue.labels, config)`.
2. On `ok: false` → failure path (below); outcome `config-error`. **No claim, no
   branch, no agent, no token spend.**
3. On `ok: true` → claim (`In Progress` + comment) → branch → run agent with
   resolved `model` / `thinking` (both attempts of the repair loop use the same
   resolved values).

Claim comment gains `(model <alias>, effort <alias>)` when set, for auditability
on the issue. Dry run prints the resolved model + thinking per
issue and lists `config-error` issues.

### Failure semantics (decision #3/#4)

On `ok: false`:

1. Comment: `❌ task-driver: <error>. Fix the label or add the alias to task-driver.config.json.`
2. `addLabel(issue.id, "ai:error")`.
3. `moveState(issue.id, "Backlog")` (SER has a `Backlog` state; confirmed).
4. Return `{ identifier, outcome: "config-error" }`.

Re-pick guard: the pick filter is `state = Todo`, so `Backlog` removes it. If a
human fixes the label and moves it back to Todo, it is re-claimed correctly.

## Executor changes — `src/executor.mjs`

`runAgent` accepts `model?: string` in addition to `thinking`. Argument build:

- append `--model <model>` only when `model` is set;
- append `--thinking <thinking>` always (unchanged today).

The agent's credential stripping, log streaming, and timeout behavior are
unchanged.

## Observability

- Dry run: per-issue resolved `model` / `thinking` (or `config-error`).
- Claim comment: `(model …, effort …)` when set.
- Run-parameters comment: the resolved model id + thinking level (with the alias
  or default each came from) posted on the issue right after claiming, so the
  record survives later removal of the labels.
- PR body: unchanged (model/effort are run-time choices, not repo facts).
- Logs: the resolved values are already visible in the `pi` invocation and the
  dry-run/claim lines.

## Testing

| File                         | Coverage                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/params.test.mjs` (new) | full alias table: none, model-only, effort-only, both, unknown model, unknown effort, multiple model, multiple effort; `thinking` fallback     |
| `test/config.test.mjs`       | `models`/`efforts` optional; effort level validation; non-string/non-empty model; unknown fields tolerated as today                            |
| `test/executor.test.mjs`     | `--model` present/absent; `--thinking` value                                                                                                   |
| `test/loop.test.mjs`         | resolve-before-claim ordering; `config-error` → comment + `addLabel("ai:error")` + Backlog + no agent run; claim comment includes model/effort |
| `test/linear.test.mjs`       | `listOpenIssues` returns `labels`; `addLabel` resolves/creates and unions `labelIds`                                                           |

## Out of scope

- Per-repo model/effort vocabularies (single global maps for now).
- Escalating model/effort on the repair attempt.
- Per-issue `attempts` / `timeoutMs` overrides.
- Validating model IDs against the pi catalog.
- CLI `task-driver add-repo` and any unrelated refactors.
- Any change to `implement.md` or the agent prompt.

## Success criteria

- An issue labeled `model-<alias>` / `effort-<alias>` runs `pi` with the decoded
  `--model` / `--thinking`.
- An unlabeled issue runs identically to today (no `--model`, global
  `thinking`).
- An issue with an unknown or conflicting alias is commented, tagged
  `ai:error`, moved to `Backlog`, and never runs the agent.
- `npm test`, `npx tsc --noEmit`, and `npm run lint` all pass in task-driver.
- Dry run shows the resolved model/effort per issue.

## Non-goals / explicit non-assurances

- No guarantee a given `--model` ID is valid — pi reports that at run time.
- No protection against a human adding both a correct and a conflicting label
  other than the `multiple … labels` error.
- `ai:error` + `Backlog` remove an issue from automatic re-claim, but a human
  can move it back to Todo while still mislabeled; it will re-fail deterministically.
