# handoff — Linear → PR automation

Reads **`Todo` + `handoff`-labeled** Linear issues, drives a headless `pi`
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
targets checkouts by path (see `handoff.config.json`). It is not vendored into
any target repo.

## Requirements

- **Linear API key** — `LINEAR_API_KEY` env var, or `~/.pi/linear.json`.
- **`GITHUB_TOKEN`** — a fine-grained PAT in each target repo's `.env`
  (gitignored), injected as `GH_TOKEN` per `gh` command. Never run
  `gh auth login` here. See the global `gh-auth` pi skill
  (`~/.pi/agent/skills/gh-auth/SKILL.md`) for the pattern.
- **SSH push access** to each target remote (the PAT is only for `gh` API calls).
- A **`handoff` label** in the Linear team. The controller only picks issues
  that are `Todo` **and** carry this label.
- A **clean `master`** checkout in each target repo (see [Rules](#rules)).

## Usage

Run from this repo's root:

```bash
npm run handoff:dry    # dry run — prints the plan, changes nothing
npm run handoff        # real run
npm test               # unit tests (node --test, no dependencies)
```

`repos[].path` is resolved relative to `handoff.config.json`, so you can run
from any directory.

## Configuration

`handoff.config.json`:

```json
{
  "repos": [
    { "name": "tiktak", "path": "../tiktak", "team": "SER", "remote": "git@github.com:srgsol/tiktak.git" }
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
| `repos[].remote` | Informational (push uses the checkout's own remote) |
| `repos[].gates` | Optional; defaults to `npm test`, `npx tsc --noEmit`, `npm run lint` |
| `attempts` | Max `pi` runs per issue (1 = no repair pass) |
| `timeoutMs` | Wall-clock cap per `pi` run (`900000` = 15 min) |
| `thinking` | `pi --thinking` level (`off`…`max`) |

Per-repo gates example:

```json
{ "name": "tiktak", "path": "../tiktak", "team": "SER", "remote": "git@github.com:srgsol/tiktak.git",
  "gates": [
    { "name": "test", "cmd": "npm", "args": ["test"] },
    { "name": "tsc",  "cmd": "npx", "args": ["tsc", "--noEmit"] },
    { "name": "lint", "cmd": "npm", "args": ["run", "lint"] }
  ] }
```

## Conventions

| Thing | Value |
|---|---|
| Branch | `SER-<num>-<slug>` — kebab-cased, lowercased title, ≤ 40 chars |
| Base | `master` |
| Commit | `SER-<num>: <title>` |
| PR title | the issue title |
| Session id | `handoff-<repo>-<ISSUE>` |

## Run artifacts

Per-run logs and agent plans live **in this repo**, under `work/<repo>/`:

```
work/<repo>/logs/<session-id>.jsonl   # streamed pi transcript
work/<repo>/plans/<ISSUE>.md          # agent-written implementation plan
```

`work/` is gitignored. Watch a run live:

```bash
tail -f work/tiktak/logs/handoff-tiktak-SER-15.jsonl | jq .
```

The agent's plan path and gate commands are injected into its task message; the
plan is then read back from `work/<repo>/plans/` and persisted into the Linear
issue description.

## Rules

- Each target checkout **must be on a clean `master`**. The controller creates
  each issue's branch from `master` and returns to `master` after every issue.
- Only `Todo` + `handoff`-labeled issues are picked. Claiming moves them to
  `In Progress`, so re-running is safe.

## Tests

```bash
npm test   # node --test, no dependencies
```

## Docs

- `docs/automation/handoff.md` — original foundation and current state
- `docs/superpowers/specs/2026-09-17-handoff-controller-design.md` — controller design
- `docs/superpowers/plans/2026-09-17-handoff-controller.md` — original implementation plan
