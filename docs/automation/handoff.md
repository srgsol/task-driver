# Handoff — Linear → PR automation controller

**Date:** 2026-09-17
**Status:** design not started; context below is the agreed foundation.

## Goal

Automate development end-to-end: read an open **Linear** issue → implement →
verify → push a branch → open a **GitHub PR** → link the PR back on the Linear
issue. Must work across **multiple repos**, each with its **own credentials**,
and runs may execute **concurrently**.

## Decisions already locked in

1. **Source of truth = Linear** (team `SER`). GitHub Issues are unused — the
   loop reads `linear_list_issues`, never GitHub issues.
2. **Credentials = per-repo fine-grained PAT in each checkout's `.env`**,
   injected per `gh` invocation via `GH_TOKEN`. **Never** `gh auth login` in
   automation (global keyring state races under concurrency).
3. **Push over SSH** (`git@github.com:…`); the PAT only covers `gh` API calls
   (PR create, checks).
4. **Concurrency isolation = one subprocess per repo** (env vars are
   per-process, not per-thread).
5. **Human stays at the merge step** (Tier 2). Rationale: this is an Expo app
   with manual/device verification (audio, timers) that tests can't cover.
   Automation opens PRs; merging stays manual.
6. **Optional upgrade:** GitHub App (one private key, short-lived per-repo
   installation tokens) if per-repo PAT rotation becomes painful.

## Already built / done

- **Global skill `gh-auth`** at `~/.pi/agent/skills/gh-auth/SKILL.md` — encodes
  the `.env` + `GH_TOKEN` per-command pattern, with a common-mistakes table.
- **`.gitignore` hardened** in tiktak (`.env`, `.env.*`, `!.env.example`).
- **`.env`** holds `GITHUB_TOKEN` (fine-grained PAT, user `srgsol`), gitignored.
  Verified: repo metadata read ✅, PR read + **write** ✅ (PR #2 created with
  it). `Contents: write` untested (push was SSH).
- **Whole loop run manually once, successfully:** SER-9…12 fixes → 5 commits →
  49 tests + tsc + lint green → **PR #2** → merged (`02f9eb2`) → branch cleaned
  up.

## Current state (facts)

- Repo `srgsol/tiktak`, **private**, Expo + TypeScript, `master` at `02f9eb2`,
  tree clean.
- Gates: `npm test` (14 suites, 49 pass) · `npx tsc --noEmit` · `npm run lint`.
- `gh` v2.99.0, **no global login** (keyring empty) — all gh usage must inject
  the `.env` token.
- **No `.github/` dir** → no CI workflows, no branch protection.
- Linear: team `SER`; open issues are onboarding noise only (SER-1…4, SER-7);
  real work currently clear.
- In-session Linear tools: `linear_list_issues`, `linear_get_issue`,
  `linear_update_issue`, `linear_add_comment`, …
- Linear extension also lives at `.pi/extensions/linear/` in the tiktak repo.

## Open decisions for the controller

1. **Shape A (local loop)** vs **Shape B (CI-native)** — recommended: start with
   A (batch open Linear issues), promote to B once trusted.
2. **Trigger** — manual batch / scheduled / Linear webhook.
3. **Branch/worktree convention** — e.g. `fix/SER-9-<slug>`.
4. **Guardrails** — max iterations, token budget, "comment on the issue and
   stop" failure path.
5. **Parallelism** — sequential first, or N concurrent subprocesses?
6. **Linear write-back** — auto-comment PR link + move state (Todo → In Progress
   → In Review)?
7. **CI layer** — `.github/workflows/ci.yml` running the three gates + branch
   protection on `master`.

## Next step

Design the controller — this is **architectural**: start with the
`brainstorming` skill (classify → clarifiers → approaches → spec → plan), then
implement. First artifact: a design doc covering credential store, per-repo
subprocess, branch conventions, quality gates, Linear write-back, and failure
handling.
