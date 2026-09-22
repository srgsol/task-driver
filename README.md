# task-driver — Linear → PR automation

Reads **`Todo` + `task-driver`-labeled** Linear issues, drives a headless `pi`
agent per issue (implement → run gates → commit → push), re-verifies
independently, opens a GitHub PR, and comments the PR link back on the issue.
A human stays at the merge step.

```
claim (Todo → In Progress + comment)
   → create branch SER-<num>-<slug> from master
   → pi agent: write plan → implement → gates → commit → git push (SSH)
   → controller re-verifies: exit 0 · branch pushed · gates green
   → save plan into the issue description
   → gh pr create  →  comment PR link on the issue
   → back to master; next issue
```

Only the controller touches Linear and GitHub. The `pi` agent gets no Linear
tools and no GitHub token (`--no-extensions`, stripped env).

This is a **standalone, multi-repo application** — it lives in its own repo and
targets checkouts by path (see `task-driver.config.json`). It is not vendored into
any target repo.

## Requirements

- **Linear API key** — `LINEAR_API_KEY` env var, or `~/.pi/linear.json`.
- **`GITHUB_TOKEN`** — a fine-grained PAT in each target repo's `.env`
  (gitignored), injected as `GH_TOKEN` per `gh` command. Never run
  `gh auth login` here. See the global `gh-auth` pi skill
  (`~/.pi/agent/skills/gh-auth/SKILL.md`) for the pattern.
- **SSH push access** to each target remote (the PAT is only for `gh` API calls).
- A **`task-driver` label** in the Linear team, and a **Linear project per repo**
  (see [Configuration](#configuration)). The controller only picks issues that
  are `Todo`, carry this label, **and** live in the repo's configured project.
- A **clean `master`** checkout in each target repo (see [Rules](#rules)).

## Usage

Run from this repo's root:

```bash
npm run task-driver:dry    # dry run — prints the plan, changes nothing
npm run task-driver        # real run
npm test               # unit tests (node --test, no dependencies)
```

`repos[].path` is resolved relative to `task-driver.config.json`, so you can run
from any directory.

## Project layout

```
src/                      # application source (CLI + controller modules)
test/                     # unit tests (node --test, no dependencies)
docs/                     # design and handoff docs
work/                     # per-run logs and plans (gitignored)
task-driver.config.json   # repo + gate configuration
implement.md              # agent skill/prompt injected into pi runs
package.json
```

## Configuration

`task-driver.config.json`:

```json
{
  "repos": [
    { "name": "tiktak", "path": "../tiktak", "team": "SER", "project": "tik-tak", "remote": "git@github.com:srgsol/tiktak.git" }
  ],
  "attempts": 2,
  "timeoutMs": 900000,
  "thinking": "medium"
}
```

| Key | Meaning |
|---|---|
| `repos[].name` | Label used in session ids, log names, and messages |
| `repos[].path` | Checkout location, relative to this config file |
| `repos[].team` | Linear team key to poll |
| `repos[].project` | Linear project name to poll (exact match). Each repo routes only issues in this project. |
| `repos[].remote` | Informational (push uses the checkout's own remote) |
| `repos[].gates` | Optional; the full list to run. When omitted, `DEFAULT_GATES` applies: `npm test`, `npx tsc --noEmit`, `npm run lint`. When present, it **replaces** the defaults entirely — list every gate you want, including `test`, since there is no merge. See [Gates](#gates). |
| `attempts` | Max `pi` runs per issue (1 = no repair pass) |
| `timeoutMs` | Wall-clock cap per `pi` run (`900000` = 15 min) |
| `thinking` | `pi --thinking` level (`off`…`max`) |

### Gates

When a repo omits `gates`, a default set is applied (defined as `DEFAULT_GATES`
in `src/config.mjs`):

| Name | Command |
|---|---|
| `test` | `npm test` |
| `tsc` | `npx tsc --noEmit` |
| `lint` | `npm run lint` |

**Providing `gates` replaces the defaults, it does not extend them.** If a repo
lacks TypeScript or a `lint` script, omit the defaults and list every gate it
actually has:

```json
{ "name": "task-driver", "path": ".", "team": "SER", "project": "task-driver", "remote": "git@github.com:srgsol/task-driver.git",
  "gates": [
    { "name": "test", "cmd": "npm", "args": ["test"] }
  ] }
```

A repo that wants the default three plus an extra one lists all four explicitly.

## Adding a repository

To bring a new repository under the controller, do the following:

1. **Checkout** the target repo at a known path (repos live as siblings of this
   repo by default, e.g. `../<repo>`).
2. **Ensure a clean `master`** — the controller creates each issue's branch from
   `master` and returns to it afterwards (see [Rules](#rules)).
3. **Credentials** — a fine-grained `GITHUB_TOKEN` in the target repo's
   gitignored `.env` (injected per `gh` command as `GH_TOKEN`), plus SSH push
   access to its remote. Never run `gh auth login`. See the global `gh-auth`
   skill.
4. **Linear label + project** — the `task-driver` label must exist in the repo's
   Linear team, and the repo's issues must live in a dedicated Linear project
   (the controller only picks `Todo` + `task-driver`-labeled issues **in that
   project**).
5. **Add an entry** to `repos` in `task-driver.config.json`. `path` is resolved
   relative to this config file. Set `gates` only if the repo's gates differ
   from the defaults — and when you do, list *every* gate the repo has, since
   `gates` replaces `DEFAULT_GATES` (see [Gates](#gates)):

```json
{ "name": "<repo>", "path": "../<repo>", "team": "SER", "project": "<project>", "remote": "git@github.com:srgsol/<repo>.git" }
```

6. **Verify** with a dry run, which lists the plan without changing anything:

```bash
npm run task-driver:dry
```

Right now this is a manual edit to `task-driver.config.json`. There is a Linear
issue tracking a CLI option to add a repository (`task-driver add-repo`):
[SER-25](https://linear.app/sergisoler/issue/SER-25/add-task-driver-add-repo-cli-subcommand).

## Conventions

| Thing | Value |
|---|---|
| Branch | `SER-<num>-<slug>` — kebab-cased, lowercased title, ≤ 40 chars |
| Base | `master` |
| Commit | `SER-<num>: <title>` |
| PR title | the issue title |
| Session id | `task-driver-<repo>-<ISSUE>` |

## Run artifacts

Per-run logs and agent plans live **in this repo**, under `work/<repo>/`:

```
work/<repo>/logs/<session-id>.jsonl   # streamed pi transcript
work/<repo>/plans/<ISSUE>.md          # agent-written implementation plan
```

`work/` is gitignored. Watch a run live:

```bash
tail -f work/tiktak/logs/task-driver-tiktak-SER-15.jsonl | jq .
```

The agent's plan path and gate commands are injected into its task message; the
plan is then read back from `work/<repo>/plans/` and persisted into the Linear
issue description.

## Rules

- Each target checkout **must be on a clean `master`**. The controller creates
  each issue's branch from `master` and returns to `master` after every issue.
- Only `Todo` + `task-driver`-labeled issues in the repo's configured project are
  picked. Claiming moves them to `In Progress`, so re-running is safe.

## Tests

```bash
npm test   # node --test, no dependencies
```

## Docs

- `docs/automation/task-driver.md` — original foundation and current state
- `docs/superpowers/specs/2026-09-17-task-driver-controller-design.md` — controller design
- `docs/superpowers/plans/2026-09-17-task-driver-controller.md` — original implementation plan
