# Lean Quality Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task-driver’s declared gates the lean triad `test` · `tsc` · `lint` by adding a `checkJs` typecheck over existing `.mjs` sources, without migrating the tree.

**Architecture:** Install TypeScript as a dev-only checker (`tsc --noEmit` with `allowJs`/`checkJs`). Keep runtime entrypoints as `node …/*.mjs`. Fix the few real `checkJs` errors with JSDoc / small catch hardening. Then update the on-disk config and the config unit test that pins gate names. Do not change `src/gates.mjs` or tiktak’s gate list.

**Tech Stack:** Node ESM (`.mjs`), `typescript` + `@types/node` (devDependencies), existing `node:test` + ESLint.

**Spec:** `docs/superpowers/specs/2026-09-22-lean-quality-gates-design.md`

## Global Constraints

- **Keep `.mjs` source** — do not rename to `.ts` or add an emit/build step.
- **Per-repo gates are the source of truth** — only edit task-driver’s `gates[]` in `task-driver.config.json`; leave tiktak’s triad unchanged.
- **Gate runner unchanged** — do not modify `src/gates.mjs` semantics.
- **Lean only** — no format, coverage, audit, or e2e gates.
- **`tsconfig` policy:** `allowJs` + `checkJs` + `noEmit` + `strict: true` + **`noImplicitAny: false`** (avoids a full JSDoc-on-every-param migration while still catching real mismatches). Include only `src/**/*.mjs` in this pass.
- Probe result (do not rediscover blindly): after `@types/node` + that tsconfig, remaining errors are in `src/sh.mjs` (destructured opts default `= {}`) and `src/loop.mjs` (`log = () => {}` arity + `catch (err)` as `unknown`).

---

## File Structure

```
task-driver/
├── tsconfig.json                 # NEW — checkJs program for src/**/*.mjs
├── package.json                  # + typescript, @types/node; + typecheck script
├── package-lock.json             # lockfile update
├── task-driver.config.json       # task-driver gates → test, tsc, lint
├── src/sh.mjs                    # JSDoc on runSync/runAsync options
├── src/loop.mjs                  # type log callback + safe err.message
├── test/config.test.mjs          # assert gate names ["test","tsc","lint"]
├── README.md                     # lean recommendation + updated examples
└── docs/superpowers/specs/2026-09-22-lean-quality-gates-design.md  # already written
```

No new runtime modules. No changes under tiktak.

---

### Task 1: Typecheck tooling green (`tsc --noEmit` on `src/`)

**Files:**
- Create: `tsconfig.json`
- Modify: `package.json` (devDependencies + `typecheck` script)
- Modify: `package-lock.json` (via npm)
- Modify: `src/sh.mjs`
- Modify: `src/loop.mjs`

**Interfaces:**
- Consumes: existing `runSync` / `runAsync` / `createLoop` call sites (signatures stay runtime-identical).
- Produces: `npx tsc --noEmit` exits 0; optional `npm run typecheck` aliases the same command.

- [ ] **Step 1: Install checker deps**

Run:

```bash
npm install --save-dev typescript@~5.9.0 @types/node@^22
```

Expected: `package.json` `devDependencies` includes `typescript` and `@types/node`; lockfile updates; exit 0.

- [ ] **Step 2: Add `tsconfig.json`**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "noImplicitAny": false,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.mjs"]
}
```

- [ ] **Step 3: Add `typecheck` script in `package.json`**

In the `scripts` object, add (keep existing scripts):

```json
"typecheck": "tsc --noEmit"
```

Final scripts should include at least:

```json
"lint": "eslint .",
"test": "node --test \"test/*.test.mjs\"",
"typecheck": "tsc --noEmit"
```

- [ ] **Step 4: Run typecheck — expect known failures**

Run: `npm run typecheck`

Expected: exit non-zero. Errors limited to approximately:

- `src/sh.mjs` — `Property 'cwd'/'env'/… does not exist on type '{}'` on destructured defaults
- `src/loop.mjs` — `Expected 0 arguments, but got 1` on `log(...)`; `err` is `unknown` in `catch`

If the error set is larger, fix those too with the same style (JSDoc / `instanceof Error`); do not disable `checkJs`.

- [ ] **Step 5: Fix `src/sh.mjs` with JSDoc on options**

Replace the top of `src/sh.mjs` so the exported functions are:

```js
import { spawn, spawnSync } from "node:child_process";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string }} [opts]
 */
export function runSync(cmd, args, { cwd, env, input } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, onChunk?: (stream: "stdout" | "stderr", text: string) => void }} [opts]
 */
export function runAsync(cmd, args, { cwd, env, timeoutMs, onChunk } = {}) {
  return new Promise((resolve) => {
    // stdin MUST be closed ("ignore" -> /dev/null): pi treats an open, non-TTY
    // stdin as piped input and waits forever for EOF that never arrives.
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;
    child.stdout.on("data", (d) => { stdout += d; if (onChunk) onChunk("stdout", String(d)); });
    child.stderr.on("data", (d) => { stderr += d; if (onChunk) onChunk("stderr", String(d)); });
    if (timeoutMs) {
      timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    }
    const done = (res) => { if (timer) clearTimeout(timer); resolve(res); };
    child.on("close", (code) => done({ exitCode: code, timedOut, stdout, stderr }));
    child.on("error", (err) => done({ exitCode: null, timedOut, stdout, stderr: `${stderr}${err}` }));
  });
}
```

Keep the rest of the function bodies identical to today aside from the JSDoc above.

- [ ] **Step 6: Fix `src/loop.mjs` — typed `log` default and safe `err` access**

In `createLoop`’s parameter list, change the default so `log` accepts a string:

```js
export function createLoop({ config, skillPath, linear, git, gates, gh, executor, workRoot, readPlan = readPlanFromDisk, log = (/** @type {string} */ _msg) => {} }) {
```

For every `catch (err)` in this file that uses `err.message`, replace with a narrow:

```js
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log(`  ⚠️  ${issue.identifier}: claim failed (${message}) — skipping`);
  // …keep the existing return / control flow…
}
```

Apply the same `err instanceof Error ? err.message : String(err)` pattern at each existing `catch (err)` site in `src/loop.mjs` that currently reads `err.message` (there are three such sites in the current file). Do not change control flow.

- [ ] **Step 7: Re-run typecheck — expect green**

Run: `npm run typecheck`

Expected: exit 0, no diagnostics.

- [ ] **Step 8: Regression — unit tests + lint still green**

Run:

```bash
npm test && npm run lint
```

Expected: all tests pass; ESLint clean.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json src/sh.mjs src/loop.mjs
git commit -m "$(cat <<'EOF'
Add checkJs typecheck for src without migrating off .mjs.

EOF
)"
```

---

### Task 2: Declare `tsc` in task-driver gates (TDD on config pin)

**Files:**
- Modify: `test/config.test.mjs`
- Modify: `task-driver.config.json`

**Interfaces:**
- Consumes: `loadConfig` from Task 1 era (unchanged).
- Produces: task-driver repo entry gates named exactly `["test", "tsc", "lint"]` with commands matching the lean recommendation.

- [ ] **Step 1: Update the failing config pin test**

In `test/config.test.mjs`, replace the existing test:

```js
test("task-driver repo declares both test and lint gates", () => {
  const p = fileURLToPath(new URL("../task-driver.config.json", import.meta.url));
  const c = loadConfig(p);
  const td = c.repos.find((r) => r.name === "task-driver");
  assert.ok(td, "task-driver repo is configured");
  assert.deepEqual(td.gates.map((g) => g.name), ["test", "lint"]);
});
```

with:

```js
test("task-driver repo declares test, tsc, and lint gates", () => {
  const p = fileURLToPath(new URL("../task-driver.config.json", import.meta.url));
  const c = loadConfig(p);
  const td = c.repos.find((r) => r.name === "task-driver");
  assert.ok(td, "task-driver repo is configured");
  assert.deepEqual(td.gates.map((g) => g.name), ["test", "tsc", "lint"]);
  assert.deepEqual(td.gates, [
    { name: "test", cmd: "npm", args: ["test"] },
    { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
    { name: "lint", cmd: "npm", args: ["run", "lint"] },
  ]);
});
```

- [ ] **Step 2: Run the pin test — expect FAIL**

Run:

```bash
node --test test/config.test.mjs
```

Expected: FAIL on `task-driver repo declares test, tsc, and lint gates` (still `["test","lint"]` on disk).

- [ ] **Step 3: Update `task-driver.config.json` gates for the task-driver repo only**

Change the task-driver entry’s `gates` to:

```json
"gates": [
  { "name": "test", "cmd": "npm", "args": ["test"] },
  { "name": "tsc", "cmd": "npx", "args": ["tsc", "--noEmit"] },
  { "name": "lint", "cmd": "npm", "args": ["run", "lint"] }
]
```

Leave the tiktak entry untouched.

- [ ] **Step 4: Re-run config tests — expect PASS**

Run:

```bash
node --test test/config.test.mjs
```

Expected: all tests in that file PASS.

- [ ] **Step 5: Full gate triad locally**

Run:

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add test/config.test.mjs task-driver.config.json
git commit -m "$(cat <<'EOF'
Declare tsc in task-driver gates alongside test and lint.

EOF
)"
```

---

### Task 3: README — recommendation vs config source of truth

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: none.
- Produces: docs that match the spec’s hard rule (per-repo `gates[]`) and soft lean triad.

- [ ] **Step 1: Update Project layout**

In the Project layout tree, after the `eslint.config.js` line, add:

```text
tsconfig.json             # checkJs typecheck for the `tsc` gate (src/**/*.mjs)
```

- [ ] **Step 2: Update the Gates section examples**

Replace the task-driver-only example that currently shows only `test` + `lint` with the triad:

```json
{ "name": "task-driver", "path": ".", "team": "SER", "project": "task-driver", "remote": "git@github.com:srgsol/task-driver.git",
  "gates": [
    { "name": "test", "cmd": "npm", "args": ["test"] },
    { "name": "tsc", "cmd": "npx", "args": ["tsc", "--noEmit"] },
    { "name": "lint", "cmd": "npm", "args": ["run", "lint"] }
  ] }
```

Immediately under the paragraph that starts with “Every repo must declare its gates explicitly”, ensure this clarification appears (add if missing):

```markdown
There is no global default gate set. The lean recommendation for repos that
want a solid minimum is `test` · `tsc` · `lint`, but each repo lists exactly
what the controller should run.
```

Keep the existing “A repo that also typechecks and lints lists those too” triad example (it already matches).

- [ ] **Step 3: Mentions of local commands (optional clarity)**

In Usage or near Gates, ensure humans see:

```bash
npm test
npm run typecheck
npm run lint
```

If Usage already only shows `npm test`, extend that block rather than inventing a new top-level section.

- [ ] **Step 4: Sanity — docs-only, gates still green**

Run:

```bash
npm test && npm run typecheck && npm run lint
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
Document per-repo gates and the lean test/tsc/lint recommendation.

EOF
)"
```

Also add the design spec if it is still untracked:

```bash
git add docs/superpowers/specs/2026-09-22-lean-quality-gates-design.md
git commit -m "$(cat <<'EOF'
Add lean quality gates design spec.

EOF
)"
```

(If you prefer one docs commit at the start of the branch, fold the spec into the first commit of Task 1 instead — either is fine; do not leave the approved spec untracked.)

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Per-repo `gates[]` is source of truth | Task 2 (only task-driver entry); Task 3 docs |
| Lean triad recommendation | Tasks 2–3 |
| Keep `.mjs`; checkJs typecheck | Task 1 |
| tiktak unchanged | Explicit non-touch in Tasks 1–3 |
| Gate runner unchanged | No `src/gates.mjs` edits |
| No format/coverage/audit/e2e | Global constraints |
| README clarification | Task 3 |
| Success: test + tsc + lint green | Task 2 Step 5; Task 3 Step 4 |

Placeholder scan: none.  
Type/name consistency: gate names `test` / `tsc` / `lint`; commands match config test deepEqual.
