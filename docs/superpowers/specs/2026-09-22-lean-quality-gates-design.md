# Lean Quality Gates — Design Spec

**Date:** 2026-09-22  
**Status:** design approved; implementation not started  
**Scope:** quality gates for **task-driver** and for **repos it drives** (both)

## Goal

Strengthen pre-PR assurance with a **lean**, fast, deterministic gate set:
behavior tests, typecheck, and lint — without formatters, coverage floors,
dependency audits, or e2e.

## Decisions made in this session

| #   | Decision                        | Choice                                                                            |
| --- | ------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Scope                           | **Both** task-driver and driven repos                                             |
| 2   | Heaviness                       | **A — lean** (fast, deterministic only)                                           |
| 3   | Approach                        | **Canonical triad recommendation:** `test` · `tsc` · `lint`                       |
| 4   | Source of truth                 | **Per-repo `gates[]` in `task-driver.config.json`** — not a hard platform rule    |
| 5   | task-driver typing              | **Keep `.mjs`**; add `tsc --noEmit` via `allowJs` + `checkJs` (no tree migration) |
| 6   | Format / coverage / audit / e2e | **Out of scope** this pass                                                        |
| 7   | Gate runner (`src/gates.mjs`)   | **Unchanged** — still runs declared commands; all must exit 0                     |
| 8   | tiktak gates                    | **No change** — already declares the triad                                        |

## Gate contract

### Platform rule (hard)

- task-driver does **not** invent gates for a repo.
- Each target repo (including task-driver itself when listed) declares its own
  `gates[]` in `task-driver.config.json`.
- The controller runs exactly those commands and treats the set as green only
  when every entry exits 0.
- Repos may declare fewer, more, or different gates; the config entry wins.

### Lean recommendation (soft)

For repos that want a solid minimum, prefer this order and naming:

| Name   | Typical command    | Role          |
| ------ | ------------------ | ------------- |
| `test` | `npm test`         | Behavior      |
| `tsc`  | `npx tsc --noEmit` | Types         |
| `lint` | `npm run lint`     | Static checks |

Names in config should match what humans and agents see in prompts; command
forms may use `npm run typecheck` instead of `npx tsc --noEmit` if the script
is equivalent.

## Per-repo plan

### tiktak (driven)

Already declares `test` / `tsc` / `lint`. **No config or tooling change** in
this work.

### task-driver (this repo)

Today: `test` + `lint`. Target: add `tsc` once typecheck is green.

1. Add `typescript` as a devDependency.
2. Add `tsconfig.json` with roughly:
   - `allowJs: true`, `checkJs: true`, `noEmit: true`
   - ESM-aligned `module` / `moduleResolution` (e.g. `NodeNext`)
   - `include` covering `src/**/*.mjs` (tests optional; prefer `src` first if
     that keeps the first green run smaller)
3. Fix `checkJs` findings with minimal JSDoc / small cleanups — **do not**
   rename to `.ts`.
4. Optionally add `"typecheck": "tsc --noEmit"` in `package.json` for local use.
5. Update this repo’s `gates[]` in `task-driver.config.json` to:

   ```json
   [
     { "name": "test", "cmd": "npm", "args": ["test"] },
     { "name": "tsc", "cmd": "npx", "args": ["tsc", "--noEmit"] },
     { "name": "lint", "cmd": "npm", "args": ["run", "lint"] }
   ]
   ```

6. Document in README that the lean triad is a **recommendation**, while
   actual gates are whatever each repo declares in config.

## Out of scope

- Migrating `.mjs` → `.ts`
- Prettier/Biome format gates
- Coverage thresholds
- `npm audit` / security scanners
- Integration or e2e suites beyond existing `node --test` unit tests
- Changing gate-runner semantics or adding built-in gate kinds
- Changing other driven repos’ gate lists (unless their own config is edited
  deliberately later)

## Success criteria

- Locally for task-driver: `npm test`, `npx tsc --noEmit`, and `npm run lint`
  all exit 0.
- `task-driver.config.json` lists those three gates for the task-driver repo
  entry.
- tiktak’s declared gates remain unchanged.
- README states the per-repo config rule and the lean recommendation clearly.

## Non-goals / explicit non-assurances

- A green `tsc` gate does **not** validate JSON/API payloads at runtime
  (config, Linear, `gh` output). Types/`checkJs` are compile-time only.
- Lean gates do not replace human review at merge.
