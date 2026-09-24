# Handoff Controller Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `handoff` controller — a Node CLI that reads `handoff`-labeled `Todo` Linear issues, drives a headless pi agent per issue, verifies, opens a PR, and writes back to Linear.

**Architecture:** A thin, deterministic Node controller (no LLM) orchestrates per-issue headless `pi` subprocesses (the "fat agent"). The controller owns Linear read/write, git plumbing, quality-gate re-verification, and PR creation; the agent owns only implement → gates → commit → push. Seams (`linear`, `git`, `gates`, `gh`, `executor`) are injected so the loop is unit-testable and Shape B is adapter work.

**Tech Stack:** Node 22 (ESM via `.mjs`, no dependencies), built-in `node:test` runner, `child_process` for `pi`/`gh`/`git`/`npm`, `fetch` for Linear GraphQL.

**Spec:** `docs/superpowers/specs/2026-09-17-handoff-controller-design.md` — the plan argues from the spec, so the spec travels with it; executors read both.

## Global Constraints

- Controller code is **plain ESM `.mjs`** — do **NOT** add `"type": "module"` to `package.json` (the repo's `.js` files are CommonJS).
- Controller files must not be picked up by the app's jest/tsc/eslint: `.mjs` avoids jest (default `testMatch` won't match `.mjs`) and tsc (`include` is `**/*.ts`); add `handoff/**` to eslint ignores.
- Three gates, verbatim: `npm test` · `npx tsc --noEmit` · `npm run lint`.
- Never `gh auth login`; inject `GH_TOKEN` from the repo's `.env` per command (gh-auth skill).
- Push over SSH; the PAT only covers `gh` API calls.
- Branch `SER-<num>-<slug>` (slug = kebab, lowercase, ≤40 chars), base `master`, commit `SER-<num>: <title>`, PR title = issue title.
- Claim filter: `state = Todo` AND label `handoff`.
- Guardrails: 2 attempts · 15-min timeout (`900000` ms) · `--thinking medium` · failure = comment + push partial + return to `Todo`.
- Agent subprocess: `--no-extensions`, `--approve`, and **no** `GH_TOKEN`/`GITHUB_TOKEN`/`LINEAR_API_KEY` in its env.

---

## File Structure

```
handoff/
├── handoff.config.json     # repo list + guardrail knobs
├── cli.mjs                 # entry: parse args, wire deps, run loop, print summary
├── sh.mjs                  # spawn/spawnSync wrappers (runSync, runAsync) — the only place that touches child_process
├── config.mjs              # loadConfig/validateConfig + DEFAULTS
├── slug.mjs                # slugify + branchName
├── linear.mjs              # getLinearApiKey + createLinearClient (4 GraphQL ops)
├── git.mjs                 # createGit(runSync): isClean/currentBranch/checkout/createBranch/branchPushed/pushBranch
├── gates.mjs               # createGates(runSync): runGates (3 gates)
├── gh.mjs                  # getGhToken + createGh(runSync): createPR
├── executor.mjs            # createExecutor(runAsync): runAgent · readPlan
├── loop.mjs                # createLoop(deps): the orchestration state machine
├── implement.md            # the agent's skill/prompt
├── logs/                   # (gitignored) JSON transcripts
├── plans/                  # (gitignored) agent-written plan files
└── test/
    ├── sh.test.mjs
    ├── config.test.mjs
    ├── slug.test.mjs
    ├── linear.test.mjs
    ├── git.test.mjs
    ├── gates.test.mjs
    ├── gh.test.mjs
    ├── executor.test.mjs
    └── loop.test.mjs
```

`sh.mjs` is the single seam between the controller and `child_process`; every
other module takes `runSync`/`runAsync` (or a client built from them) as a
parameter so tests inject fakes instead of spawning real processes.

---

## Task 1: Scaffold — config, sh, slug, and repo wiring

**Files:**

- Create: `handoff/handoff.config.json`
- Create: `handoff/config.mjs`
- Create: `handoff/sh.mjs`
- Create: `handoff/slug.mjs`
- Create: `handoff/test/config.test.mjs`
- Create: `handoff/test/slug.test.mjs`
- Create: `handoff/test/sh.test.mjs`
- Modify: `package.json` (scripts)
- Modify: `.gitignore` (handoff artifacts)
- Modify: `eslint.config.js` (ignore `handoff/**`)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `loadConfig(path) → { repos:[{name,path,team,remote}], attempts, timeoutMs, thinking }`
  - `validateConfig(raw) → same` (throws on invalid)
  - `DEFAULTS = { attempts: 2, timeoutMs: 900000, thinking: "medium" }`
  - `runSync(cmd, args, {cwd, env, input}) → { status, stdout, stderr }`
  - `runAsync(cmd, args, {cwd, env, timeoutMs}) → Promise<{ exitCode, timedOut, stdout, stderr }>`
  - `slugify(title) → string`, `branchName(identifier, title) → string`

- [ ] **Step 1: Write `handoff/handoff.config.json`**

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

- [ ] **Step 2: Write `handoff/config.mjs`**

```js
import { readFileSync } from "node:fs";

export const DEFAULTS = { attempts: 2, timeoutMs: 900000, thinking: "medium" };

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error("config.repos must be a non-empty array");
  }
  const repos = raw.repos.map((r, i) => {
    if (!r.name || !r.path || !r.team || !r.remote) {
      throw new Error(`config.repos[${i}] must define name, path, team, remote`);
    }
    return { name: r.name, path: r.path, team: r.team, remote: r.remote };
  });
  const attempts = raw.attempts ?? DEFAULTS.attempts;
  const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs;
  const thinking = raw.thinking ?? DEFAULTS.thinking;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error("config.attempts must be an integer >= 1");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("config.timeoutMs must be an integer >= 1");
  return { repos, attempts, timeoutMs, thinking };
}

export function loadConfig(path) {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")));
}
```

- [ ] **Step 3: Write `handoff/sh.mjs`**

```js
import { spawn, spawnSync } from "node:child_process";

export function runSync(cmd, args, { cwd, env, input } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function runAsync(cmd, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    const done = (res) => {
      if (timer) clearTimeout(timer);
      resolve(res);
    };
    child.on("close", (code) => done({ exitCode: code, timedOut, stdout, stderr }));
    child.on("error", (err) =>
      done({ exitCode: null, timedOut, stdout, stderr: `${stderr}${err}` }),
    );
  });
}
```

- [ ] **Step 4: Write `handoff/slug.mjs`**

```js
const MAX = 40;

export function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/g, "");
  return s || "issue";
}

export function branchName(identifier, title) {
  return `${identifier}-${slugify(title)}`;
}
```

- [ ] **Step 5: Write `handoff/test/config.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig, DEFAULTS } from "../config.mjs";

test("validateConfig applies defaults", () => {
  const c = validateConfig({
    repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git" }],
  });
  assert.equal(c.attempts, DEFAULTS.attempts);
  assert.equal(c.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(c.thinking, DEFAULTS.thinking);
});

test("validateConfig rejects empty repos", () => {
  assert.throws(() => validateConfig({ repos: [] }), /non-empty/);
});

test("validateConfig rejects missing fields", () => {
  assert.throws(() => validateConfig({ repos: [{ name: "x" }] }), /name, path, team, remote/);
});

test("loadConfig reads and validates a file", () => {
  const p = join(tmpdir(), "cfg.json");
  writeFileSync(
    p,
    JSON.stringify({
      repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git" }],
      attempts: 3,
    }),
  );
  const c = loadConfig(p);
  assert.equal(c.attempts, 3);
  assert.equal(c.repos.length, 1);
});
```

- [ ] **Step 6: Write `handoff/test/slug.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, branchName } from "../slug.mjs";

test("slugify lowercases and kebab-cases", () => {
  assert.equal(slugify("Fix Step Drag Handles"), "fix-step-drag-handles");
});

test("slugify collapses non-alphanumerics", () => {
  assert.equal(slugify("  Hello,,  World!!  "), "hello-world");
});

test("slugify truncates to 40 chars without trailing dash", () => {
  const s = slugify(`${"a".repeat(60)} b`);
  assert.ok(s.length <= 40);
  assert.ok(!s.endsWith("-"));
});

test("slugify falls back to 'issue' for empty input", () => {
  assert.equal(slugify("!!!"), "issue");
});

test("branchName keeps identifier case and slugs the title", () => {
  assert.equal(branchName("SER-9", "Fix Step Drag Handles"), "SER-9-fix-step-drag-handles");
});
```

- [ ] **Step 7: Write `handoff/test/sh.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync, runAsync } from "../sh.mjs";

test("runSync captures stdout and status", () => {
  const r = runSync("node", ["-e", "process.stdout.write('ok')"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ok");
});

test("runSync captures non-zero status", () => {
  assert.equal(runSync("node", ["-e", "process.exit(7)"]).status, 7);
});

test("runAsync resolves on exit", async () => {
  const r = await runAsync("node", ["-e", "console.log('hi')"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hi/);
});

test("runAsync times out", async () => {
  const r = await runAsync("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 50 });
  assert.equal(r.timedOut, true);
});
```

- [ ] **Step 8: Wire the repo — `package.json` scripts**

Add to the `scripts` object (after `"lint"`):

```json
    "handoff": "node handoff/cli.mjs",
    "handoff:dry": "node handoff/cli.mjs --dry-run",
    "test:handoff": "node --test \"handoff/test/*.test.mjs\""
```

- [ ] **Step 9: Wire the repo — `.gitignore`**

Append a new section:

```gitignore

# handoff
handoff/logs/
handoff/plans/
```

- [ ] **Step 10: Wire the repo — `eslint.config.js`**

Change the `ignores` array:

```js
  {
    ignores: ["dist/*", "handoff/**"],
  }
```

- [ ] **Step 11: Run tests**

Run: `npm run test:handoff`
Expected: all tests pass (sh, config, slug).

- [ ] **Step 12: Verify the app gates are unaffected**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: 49 tests pass, tsc clean, lint clean (handoff is excluded).

- [ ] **Step 13: Commit**

```bash
git add handoff/handoff.config.json handoff/config.mjs handoff/sh.mjs handoff/slug.mjs handoff/test package.json .gitignore eslint.config.js
git commit -m "chore(handoff): scaffold controller config, sh, and slug helpers"
```

---

## Task 2: Linear GraphQL client

**Files:**

- Create: `handoff/linear.mjs`
- Create: `handoff/test/linear.test.mjs`

**Interfaces:**

- Consumes: `fetch` (injected; defaults to global).
- Produces:
  - `getLinearApiKey() → string | undefined` (env `LINEAR_API_KEY`, else `~/.pi/linear.json`)
  - `createLinearClient(apiKey, fetchImpl?) → { listOpenIssues(teamKey), getIssue(identifier), comment(issueId, body), moveState(issueId, stateName) }`

- [ ] **Step 1: Write the failing test `handoff/test/linear.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinearClient } from "../linear.mjs";

function fakeFetch(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      status: 200,
      text: async () => JSON.stringify({ data: handler(body.query, body.variables) }),
    };
  };
}

test("listOpenIssues filters Todo + handoff label", async () => {
  let seen;
  const client = createLinearClient(
    "k",
    fakeFetch((q, vars) => {
      seen = vars;
      return {
        issues: {
          nodes: [{ id: "i1", identifier: "SER-9", title: "t", description: null, url: "u" }],
        },
      };
    }),
  );
  const issues = await client.listOpenIssues("SER");
  assert.equal(issues.length, 1);
  assert.deepEqual(seen.filter.state, { name: { eq: "Todo" } });
  assert.deepEqual(seen.filter.labels, { name: { eq: "handoff" } });
  assert.deepEqual(seen.filter.team, { key: { eq: "SER" } });
});

test("moveState resolves state id then updates", async () => {
  const calls = [];
  const client = createLinearClient(
    "k",
    fakeFetch((q, vars) => {
      calls.push(vars);
      if (q.includes("issue(id: $id)")) return { issue: { team: { id: "t1" } } };
      if (q.includes("states"))
        return { team: { states: { nodes: [{ id: "s1", name: "In Progress" }] } } };
      return { issueUpdate: { success: true } };
    }),
  );
  await client.moveState("i1", "In Progress");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].input.stateId, "s1");
});

test("comment posts body", async () => {
  let seen;
  const client = createLinearClient(
    "k",
    fakeFetch((q, v) => {
      seen = v;
      return { commentCreate: { success: true } };
    }),
  );
  await client.comment("i1", "hello");
  assert.equal(seen.input.issueId, "i1");
  assert.equal(seen.input.body, "hello");
});

test("throws on API error", async () => {
  const client = createLinearClient("k", async () => ({
    status: 200,
    text: async () => JSON.stringify({ errors: [{ message: "boom" }] }),
  }));
  await assert.rejects(() => client.getIssue("SER-9"), /boom/);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:handoff`
Expected: FAIL — `Cannot find module '../linear.mjs'`.

- [ ] **Step 3: Write `handoff/linear.mjs`**

```js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API_URL = "https://api.linear.app/graphql";

export function getLinearApiKey() {
  const env = process.env.LINEAR_API_KEY?.trim();
  if (env) return env;
  const file = join(homedir(), ".pi", "linear.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw.apiKey?.trim()) return raw.apiKey.trim();
    } catch {
      /* ignore malformed config */
    }
  }
  return undefined;
}

export function createLinearClient(apiKey, fetchImpl = fetch) {
  async function gql(query, variables) {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Linear API returned non-JSON (HTTP ${res.status})`);
    }
    if (res.status !== 200 || json.errors?.length) {
      const msgs = (json.errors ?? []).map((e) => e.message).join("; ");
      throw new Error(`Linear API error (HTTP ${res.status}): ${msgs || "unknown"}`);
    }
    return json.data;
  }

  return {
    async listOpenIssues(teamKey) {
      const data = await gql(
        `query($filter: IssueFilter) { issues(filter: $filter, first: 100) { nodes { id identifier title description url } } }`,
        {
          filter: {
            team: { key: { eq: teamKey } },
            state: { name: { eq: "Todo" } },
            labels: { name: { eq: "handoff" } },
          },
        },
      );
      return data.issues.nodes;
    },
    async getIssue(identifier) {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { id identifier title description url } }`,
        { id: identifier },
      );
      if (!data.issue) throw new Error(`Issue "${identifier}" not found`);
      return data.issue;
    },
    async comment(issueId, body) {
      const data = await gql(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId, body } },
      );
      if (!data.commentCreate?.success) throw new Error(`Failed to comment on ${issueId}`);
    },
    async moveState(issueId, stateName) {
      const team = await gql(`query($id: String!) { issue(id: $id) { team { id } } }`, {
        id: issueId,
      });
      const teamId = team.issue?.team?.id;
      if (!teamId) throw new Error(`Could not resolve team for ${issueId}`);
      const states = await gql(
        `query($id: String!) { team(id: $id) { states { nodes { id name } } } }`,
        { id: teamId },
      );
      const state = (states.team?.states?.nodes ?? []).find(
        (s) => s.name.toLowerCase() === stateName.toLowerCase(),
      );
      if (!state) throw new Error(`State "${stateName}" not found`);
      const data = await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issueId, input: { stateId: state.id } },
      );
      if (!data.issueUpdate?.success) throw new Error(`Failed to move ${issueId} to ${stateName}`);
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:handoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add handoff/linear.mjs handoff/test/linear.test.mjs
git commit -m "feat(handoff): add Linear GraphQL client"
```

---

## Task 3: Git plumbing

**Files:**

- Create: `handoff/git.mjs`
- Create: `handoff/test/git.test.mjs`

**Interfaces:**

- Consumes: `runSync` (injected).
- Produces: `createGit(runSync) → { isClean(repoPath), currentBranch(repoPath), checkout(repoPath, ref), createBranch(repoPath, branch), branchPushed(repoPath, branch), pushBranch(repoPath, branch) }` (booleans/void; `checkout`/`createBranch` throw on non-zero).

- [ ] **Step 1: Write the failing test `handoff/test/git.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../git.mjs";

const ok = { status: 0, stdout: "", stderr: "" };

test("isClean is true when status output is empty", () => {
  const git = createGit(() => ok);
  assert.equal(git.isClean("/r"), true);
});

test("isClean is false when status output present", () => {
  const git = createGit(() => ({ ...ok, stdout: " M src/x.ts" }));
  assert.equal(git.isClean("/r"), false);
});

test("branchPushed is true when ls-remote returns a ref", () => {
  let seen;
  const git = createGit((cmd, args) => {
    seen = args;
    return { ...ok, stdout: "abc\trefs/heads/SER-9-x" };
  });
  assert.equal(git.branchPushed("/r", "SER-9-x"), true);
  assert.deepEqual(seen, ["ls-remote", "--heads", "origin", "SER-9-x"]);
});

test("checkout throws on non-zero", () => {
  const git = createGit(() => ({ status: 1, stdout: "", stderr: "nope" }));
  assert.throws(() => git.checkout("/r", "master"), /checkout master failed/);
});

test("pushBranch returns false on non-zero", () => {
  const git = createGit(() => ({ status: 1, stdout: "", stderr: "" }));
  assert.equal(git.pushBranch("/r", "SER-9-x"), false);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:handoff`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `handoff/git.mjs`**

```js
export function createGit(runSync) {
  const git = (repoPath, args) => runSync("git", args, { cwd: repoPath });
  return {
    isClean(repoPath) {
      return git(repoPath, ["status", "--porcelain"]).stdout.trim() === "";
    },
    currentBranch(repoPath) {
      return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    },
    checkout(repoPath, ref) {
      const r = git(repoPath, ["checkout", ref]);
      if (r.status !== 0) throw new Error(`git checkout ${ref} failed: ${r.stderr}`);
    },
    createBranch(repoPath, branch) {
      const r = git(repoPath, ["checkout", "-b", branch]);
      if (r.status !== 0) throw new Error(`git checkout -b ${branch} failed: ${r.stderr}`);
    },
    branchPushed(repoPath, branch) {
      const r = git(repoPath, ["ls-remote", "--heads", "origin", branch]);
      return r.status === 0 && r.stdout.trim() !== "";
    },
    pushBranch(repoPath, branch) {
      return git(repoPath, ["push", "-u", "origin", branch]).status === 0;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:handoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add handoff/git.mjs handoff/test/git.test.mjs
git commit -m "feat(handoff): add git plumbing"
```

---

## Task 4: Quality-gate runner

**Files:**

- Create: `handoff/gates.mjs`
- Create: `handoff/test/gates.test.mjs`

**Interfaces:**

- Consumes: `runSync` (injected).
- Produces: `createGates(runSync) → { runGates(repoPath) → { green, results: [{name, passed, output}] } }` (names are exactly `test`, `tsc`, `lint`).

- [ ] **Step 1: Write the failing test `handoff/test/gates.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGates } from "../gates.mjs";

test("runGates reports green when all three pass", () => {
  const gates = createGates(() => ({ status: 0, stdout: "", stderr: "" }));
  const r = gates.runGates("/r");
  assert.equal(r.green, true);
  assert.deepEqual(
    r.results.map((x) => x.name),
    ["test", "tsc", "lint"],
  );
});

test("runGates reports red when any fails", () => {
  let n = 0;
  const gates = createGates(() => ({ status: n++ === 1 ? 1 : 0, stdout: "", stderr: "" }));
  const r = gates.runGates("/r");
  assert.equal(r.green, false);
  assert.equal(r.results[1].passed, false);
});

test("runGates runs the exact three commands", () => {
  const seen = [];
  const gates = createGates((cmd, args) => {
    seen.push([cmd, args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  gates.runGates("/r");
  assert.deepEqual(seen, [
    ["npm", ["test"]],
    ["npx", ["tsc", "--noEmit"]],
    ["npm", ["run", "lint"]],
  ]);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:handoff`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `handoff/gates.mjs`**

```js
const GATES = [
  { name: "test", cmd: "npm", args: ["test"] },
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
];

export function createGates(runSync) {
  return {
    runGates(repoPath) {
      const results = GATES.map((g) => {
        const r = runSync(g.cmd, g.args, { cwd: repoPath });
        return { name: g.name, passed: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
      });
      return { green: results.every((r) => r.passed), results };
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:handoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add handoff/gates.mjs handoff/test/gates.test.mjs
git commit -m "feat(handoff): add quality-gate runner"
```

---

## Task 5: GitHub PR client

**Files:**

- Create: `handoff/gh.mjs`
- Create: `handoff/test/gh.test.mjs`

**Interfaces:**

- Consumes: `runSync` (injected).
- Produces:
  - `getGhToken(repoPath) → string` (reads `GITHUB_TOKEN=` from `<repoPath>/.env`, unquoted)
  - `createGh(runSync) → { createPR({repoPath, base, head, title, body}) → { url, number } }`

- [ ] **Step 1: Write the failing test `handoff/test/gh.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGh, getGhToken } from "../gh.mjs";

test("getGhToken reads unquoted token from .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=github_pat_abc123\n");
  assert.equal(getGhToken(dir), "github_pat_abc123");
});

test("getGhToken throws when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  assert.throws(() => getGhToken(dir), /GITHUB_TOKEN not found/);
});

test("createPR injects GH_TOKEN and parses json", () => {
  let seenEnv;
  let seenArgs;
  const gh = createGh((cmd, args, opts) => {
    seenArgs = args;
    seenEnv = opts.env;
    return {
      status: 0,
      stdout: JSON.stringify({ url: "https://github.com/x/y/pull/3", number: 3 }),
      stderr: "",
    };
  });
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  const pr = gh.createPR({ repoPath: dir, base: "master", head: "SER-9-x", title: "t", body: "b" });
  assert.equal(pr.number, 3);
  assert.equal(seenEnv.GH_TOKEN, "tok");
  assert.ok(seenArgs.includes("pr"));
});

test("createPR throws on non-zero", () => {
  const gh = createGh(() => ({ status: 1, stdout: "", stderr: "denied" }));
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  assert.throws(
    () => gh.createPR({ repoPath: dir, base: "master", head: "x", title: "t", body: "b" }),
    /gh pr create failed/,
  );
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:handoff`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `handoff/gh.mjs`**

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getGhToken(repoPath) {
  const envPath = join(repoPath, ".env");
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(`GITHUB_TOKEN not found in ${envPath}`);
  }
  const m = text.match(/^GITHUB_TOKEN=(.+)$/m);
  if (!m) throw new Error(`GITHUB_TOKEN not found in ${envPath}`);
  return m[1].trim().replace(/\r$/, "");
}

export function createGh(runSync) {
  return {
    createPR({ repoPath, base, head, title, body }) {
      const token = getGhToken(repoPath);
      const r = runSync(
        "gh",
        [
          "pr",
          "create",
          "--base",
          base,
          "--head",
          head,
          "--title",
          title,
          "--body",
          body,
          "--json",
          "url,number",
        ],
        { cwd: repoPath, env: { ...process.env, GH_TOKEN: token } },
      );
      if (r.status !== 0) throw new Error(`gh pr create failed: ${r.stderr}`);
      return JSON.parse(r.stdout);
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:handoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add handoff/gh.mjs handoff/test/gh.test.mjs
git commit -m "feat(handoff): add gh PR client"
```

---

## Task 6: pi subprocess executor

**Files:**

- Create: `handoff/executor.mjs`
- Create: `handoff/test/executor.test.mjs`

**Interfaces:**

- Consumes: `runAsync` (injected).
- Produces:
  - `createExecutor(runAsync) → { runAgent({repoPath, sessionId, config, skillPath, message}) → Promise<{exitCode, timedOut, stdout, stderr}> }`
  - `readPlan(repoPath, identifier) → string | null` (reads `<repoPath>/handoff/plans/<identifier>.md`)

- [ ] **Step 1: Write the failing test `handoff/test/executor.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor, readPlan } from "../executor.mjs";

test("runAgent strips Linear and GitHub tokens from child env", async () => {
  let seenEnv;
  let seenArgs;
  const executor = createExecutor(async (cmd, args, opts) => {
    seenArgs = args;
    seenEnv = opts.env;
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });
  process.env.GH_TOKEN = "x";
  process.env.LINEAR_API_KEY = "y";
  const r = await executor.runAgent({
    repoPath: "/r",
    sessionId: "s",
    config: { thinking: "medium", timeoutMs: 1000 },
    skillPath: "/sk.md",
    message: "do it",
  });
  assert.equal(r.exitCode, 0);
  assert.equal(seenEnv.GH_TOKEN, undefined);
  assert.equal(seenEnv.GITHUB_TOKEN, undefined);
  assert.equal(seenEnv.LINEAR_API_KEY, undefined);
  assert.ok(seenArgs.includes("--no-extensions"));
  assert.ok(seenArgs.includes("--approve"));
  assert.equal(seenArgs[seenArgs.length - 1], "do it");
  delete process.env.GH_TOKEN;
  delete process.env.LINEAR_API_KEY;
});

test("readPlan returns null when no plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  assert.equal(readPlan(dir, "SER-9"), null);
});

test("readPlan reads the plan file", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  const plans = join(dir, "handoff", "plans");
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, "SER-9.md"), "# plan");
  assert.equal(readPlan(dir, "SER-9"), "# plan");
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:handoff`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `handoff/executor.mjs`**

```js
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export function createExecutor(runAsync) {
  function childEnv() {
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.LINEAR_API_KEY;
    return env;
  }

  return {
    async runAgent({ repoPath, sessionId, config, skillPath, message }) {
      const args = [
        "--print",
        "--mode",
        "json",
        "--session-id",
        sessionId,
        "--approve",
        "--no-extensions",
        "--skill",
        skillPath,
        "--thinking",
        config.thinking,
        "--",
        message,
      ];
      return runAsync("pi", args, { cwd: repoPath, env: childEnv(), timeoutMs: config.timeoutMs });
    },
  };
}

export function readPlan(repoPath, identifier) {
  const p = join(repoPath, "handoff", "plans", `${identifier}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test:handoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add handoff/executor.mjs handoff/test/executor.test.mjs
git commit -m "feat(handoff): add pi subprocess executor"
```

---

## Task 7: The orchestration loop

**Files:**

- Create: `handoff/loop.mjs`
- Create: `handoff/test/loop.test.mjs`

**Interfaces:**

- Consumes: injected `{ config, skillPath, linear, git, gates, gh, executor, log? }`; `branchName` from `slug.mjs`; `readPlan` from `executor.mjs`.
- Produces: `createLoop(deps) → runLoop(dryRun) → Promise<Array<{identifier, outcome}>>` where `outcome ∈ { pr, failed, skipped, pr-failed, dry }`.

- [ ] **Step 1: Write the failing test `handoff/test/loop.test.mjs`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoop } from "../loop.mjs";

function makeDeps(opts = {}) {
  const calls = {
    moveState: [],
    comments: [],
    checkout: [],
    createBranch: [],
    runAgent: [],
    createPR: [],
    pushBranch: [],
  };
  const agentResults = opts.agentResults ?? [
    { exitCode: 0, timedOut: false, stdout: "", stderr: "" },
  ];
  let agentCall = 0;
  const git = {
    isClean: () => true,
    currentBranch: () => "master",
    checkout: (p, r) => calls.checkout.push([p, r]),
    createBranch: (p, b) => calls.createBranch.push([p, b]),
    branchPushed: () => true,
    pushBranch: (p, b) => calls.pushBranch.push([p, b]),
    ...opts.git,
  };
  const gates = {
    runGates: () => ({ green: true, results: [{ name: "test", passed: true, output: "" }] }),
    ...opts.gates,
  };
  const linear = {
    listOpenIssues: async () =>
      opts.issues ?? [
        { id: "i1", identifier: "SER-9", title: "Fix drag", description: "desc", url: "u" },
      ],
    moveState: async (id, s) => calls.moveState.push([id, s]),
    comment: async (id, b) => calls.comments.push([id, b]),
    ...opts.linear,
  };
  const gh = {
    createPR: (a) => {
      calls.createPR.push(a);
      return { url: "https://x/pull/1", number: 1 };
    },
    ...opts.gh,
  };
  const executor = {
    runAgent: async (a) => {
      calls.runAgent.push(a);
      return agentResults[Math.min(agentCall++, agentResults.length - 1)];
    },
  };
  const config = {
    repos: [{ name: "tiktak", path: "/r", team: "SER", remote: "g" }],
    attempts: 2,
    timeoutMs: 1,
    thinking: "medium",
  };
  const loop = createLoop({
    config,
    skillPath: "/sk.md",
    linear,
    git,
    gates,
    gh,
    executor,
    log: () => {},
  });
  return { loop, calls };
}

test("happy path: claim, branch, PR, comment, back to master", async () => {
  const { loop, calls } = makeDeps();
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.deepEqual(calls.moveState[0], ["i1", "In Progress"]);
  assert.deepEqual(calls.createBranch[0], ["/r", "SER-9-fix-drag"]);
  assert.equal(calls.runAgent.length, 1);
  assert.equal(calls.createPR[0].head, "SER-9-fix-drag");
  assert.match(calls.comments[1][1], /PR opened/);
  assert.equal(calls.checkout.length, 2);
});

test("repair pass runs when the first attempt fails", async () => {
  const { loop, calls } = makeDeps({
    agentResults: [
      { exitCode: 1, timedOut: false, stdout: "boom", stderr: "" },
      { exitCode: 0, timedOut: false, stdout: "", stderr: "" },
    ],
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.equal(calls.runAgent.length, 2);
  assert.match(calls.runAgent[1].message, /did not pass verification/);
});

test("failure path after two failures: comment, push, return to Todo", async () => {
  const { loop, calls } = makeDeps({
    agentResults: [
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
    ],
    gates: {
      runGates: () => ({ green: false, results: [{ name: "test", passed: false, output: "" }] }),
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "failed");
  assert.equal(calls.pushBranch.length, 1);
  assert.equal(calls.createPR.length, 0);
  assert.deepEqual(calls.moveState, [
    ["i1", "In Progress"],
    ["i1", "Todo"],
  ]);
});

test("preflight skips a dirty repo", async () => {
  const { loop, calls } = makeDeps({ git: { isClean: () => false } });
  const results = await loop(false);
  assert.equal(results.length, 0);
  assert.equal(calls.runAgent.length, 0);
});

test("dry-run makes no mutations", async () => {
  const { loop, calls } = makeDeps();
  const results = await loop(true);
  assert.equal(results[0].outcome, "dry");
  assert.equal(calls.moveState.length, 0);
  assert.equal(calls.createBranch.length, 0);
  assert.equal(calls.runAgent.length, 0);
  assert.equal(calls.createPR.length, 0);
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm run test:handoff`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `handoff/loop.mjs`**

````js
import { branchName } from "./slug.mjs";
import { readPlan } from "./executor.mjs";

const BASE_BRANCH = "master";

export function createLoop({
  config,
  skillPath,
  linear,
  git,
  gates,
  gh,
  executor,
  log = () => {},
}) {
  const issuePrompt = (issue, branch) =>
    [
      `Implement ${issue.identifier}: ${issue.title}`,
      "",
      issue.description || "(no description)",
      "",
      `Branch: ${branch}`,
    ].join("\n");

  const repairPrompt = (issue, branch, result) => {
    const tail = `${result.stdout}\n${result.stderr}`.slice(-4000);
    return [
      `Your previous attempt for ${issue.identifier} did not pass verification.`,
      "",
      "Output so far:",
      "```",
      tail,
      "```",
      "",
      `Fix it, re-run the three gates (npm test, npx tsc --noEmit, npm run lint), commit, and push branch ${branch}.`,
    ].join("\n");
  };

  const gatesSummary = (r) =>
    r.results.map((x) => `- \`${x.name}\`: ${x.passed ? "passed" : "FAILED"}`).join("\n");

  function verify(repoPath, branch, result) {
    let pushed = false;
    try {
      pushed = git.branchPushed(repoPath, branch);
    } catch {
      /* ignore */
    }
    const gatesResult = gates.runGates(repoPath);
    return {
      ok: result.exitCode === 0 && !result.timedOut && pushed && gatesResult.green,
      pushed,
      gatesResult,
    };
  }

  async function processIssue(repo, issue, dryRun) {
    const branch = branchName(issue.identifier, issue.title);
    const sessionId = `handoff-${repo.name}-${issue.identifier}`;

    if (dryRun) {
      log(`  [dry] would claim ${issue.identifier} → In Progress`);
      log(`  [dry] would branch ${branch} from ${BASE_BRANCH}`);
      log(`  [dry] would run pi (session ${sessionId})`);
      log(`  [dry] would open PR (${BASE_BRANCH} ← ${branch})`);
      return { identifier: issue.identifier, outcome: "dry" };
    }

    try {
      await linear.moveState(issue.id, "In Progress");
      await linear.comment(
        issue.id,
        `🤖 handoff: implementing ${issue.identifier} on branch \`${branch}\``,
      );
    } catch (err) {
      log(`  ⚠️  ${issue.identifier}: claim failed (${err.message}) — skipping`);
      return { identifier: issue.identifier, outcome: "skipped" };
    }

    log(`→ ${issue.identifier}: ${issue.title} (${branch})`);
    git.checkout(repo.path, BASE_BRANCH);
    git.createBranch(repo.path, branch);

    const first = await executor.runAgent({
      repoPath: repo.path,
      sessionId,
      config,
      skillPath,
      message: issuePrompt(issue, branch),
    });
    let v = verify(repo.path, branch, first);

    if (!v.ok && config.attempts > 1) {
      log(
        `  attempt 1 failed (exit=${first.exitCode}, timedOut=${first.timedOut}, pushed=${v.pushed}, green=${v.gatesResult.green})`,
      );
      const second = await executor.runAgent({
        repoPath: repo.path,
        sessionId,
        config,
        skillPath,
        message: repairPrompt(issue, branch, first),
      });
      v = verify(repo.path, branch, second);
    }

    const plan = readPlan(repo.path, issue.identifier);

    if (v.ok) {
      const body = ["## Plan", plan || "(none)", "", "## Gates", gatesSummary(v.gatesResult)].join(
        "\n",
      );
      try {
        const pr = gh.createPR({
          repoPath: repo.path,
          base: BASE_BRANCH,
          head: branch,
          title: issue.title,
          body,
        });
        await linear.comment(issue.id, `✅ PR opened: ${pr.url}\n\n${gatesSummary(v.gatesResult)}`);
        log(`  ✅ ${issue.identifier}: PR ${pr.url} (${branch})`);
        git.checkout(repo.path, BASE_BRANCH);
        return { identifier: issue.identifier, outcome: "pr" };
      } catch (err) {
        log(`  ⚠️  ${issue.identifier}: PR create failed: ${err.message}`);
        await linear.comment(
          issue.id,
          `⚠️ handoff: code done and pushed on \`${branch}\`, but PR creation failed: ${err.message}`,
        );
        git.checkout(repo.path, BASE_BRANCH);
        return { identifier: issue.identifier, outcome: "pr-failed" };
      }
    }

    const note = [
      `❌ handoff could not complete ${issue.identifier} after ${config.attempts} attempt(s).`,
      "",
      "Verification:",
      gatesSummary(v.gatesResult),
      "",
      plan ? `Plan:\n${plan}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      git.pushBranch(repo.path, branch);
    } catch {
      /* ignore */
    }
    await linear.comment(issue.id, note);
    await linear.moveState(issue.id, "Todo");
    log(`  ❌ ${issue.identifier}: failed (branch ${branch} pushed, no PR)`);
    git.checkout(repo.path, BASE_BRANCH);
    return { identifier: issue.identifier, outcome: "failed" };
  }

  async function processRepo(repo, dryRun) {
    if (!dryRun) {
      if (!git.isClean(repo.path)) {
        log(`⚠️  ${repo.name}: working tree not clean — skipping`);
        return [];
      }
      if (git.currentBranch(repo.path) !== BASE_BRANCH) {
        log(`⚠️  ${repo.name}: not on ${BASE_BRANCH} — skipping`);
        return [];
      }
    }
    const issues = await linear.listOpenIssues(repo.team);
    log(`${repo.name}: ${issues.length} open handoff issue(s)`);
    const results = [];
    for (const issue of issues) results.push(await processIssue(repo, issue, dryRun));
    return results;
  }

  return async function runLoop(dryRun) {
    const all = [];
    for (const repo of config.repos) all.push(...(await processRepo(repo, dryRun)));
    return all;
  };
}
````

- [ ] **Step 4: Run tests**

Run: `npm run test:handoff`
Expected: PASS (all 5 loop tests).

- [ ] **Step 5: Commit**

```bash
git add handoff/loop.mjs handoff/test/loop.test.mjs
git commit -m "feat(handoff): add orchestration loop"
```

---

## Task 8: CLI entrypoint and the agent skill

**Files:**

- Create: `handoff/cli.mjs`
- Create: `handoff/implement.md`

**Interfaces:**

- Consumes: `loadConfig`, `getLinearApiKey`/`createLinearClient`, `createGit`, `createGates`, `createGh`, `createExecutor`, `createLoop`, `runSync`/`runAsync` from `sh.mjs`.
- Produces: `node handoff/cli.mjs [--dry-run] [--config path]` (exit 1 on any failure outcome or abort).

- [ ] **Step 1: Write `handoff/cli.mjs`**

```js
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { getLinearApiKey, createLinearClient } from "./linear.mjs";
import { createGit } from "./git.mjs";
import { createGates } from "./gates.mjs";
import { createGh } from "./gh.mjs";
import { createExecutor } from "./executor.mjs";
import { createLoop } from "./loop.mjs";
import { runSync, runAsync } from "./sh.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { dryRun: false, configPath: join(here, "handoff.config.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--config") args.configPath = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node handoff/cli.mjs [--dry-run] [--config path]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const apiKey = getLinearApiKey();
  if (!apiKey) {
    console.error("handoff: LINEAR_API_KEY not set and ~/.pi/linear.json not found.");
    process.exit(1);
  }

  const loop = createLoop({
    config,
    skillPath: join(here, "implement.md"),
    linear: createLinearClient(apiKey),
    git: createGit(runSync),
    gates: createGates(runSync),
    gh: createGh(runSync),
    executor: createExecutor(runAsync),
    log: console.log,
  });

  const results = await loop(args.dryRun);
  if (args.dryRun) {
    console.log(`\nhandoff (dry run): ${results.length} issue(s) would be processed.`);
    return;
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const prs = count("pr");
  const failed = count("failed");
  const other = results.length - prs - failed;
  console.log(
    `\nhandoff complete: ${prs} PR(s), ${failed} failure(s), ${other} skipped/other, ${results.length} total.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("handoff aborted:", err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Write `handoff/implement.md`**

```markdown
# Handoff Implement

You are a coding agent implementing a Linear issue in this repository. A branch
has been checked out for you. **There is no human in the loop** — never ask
questions or wait for approval. Make the call and proceed.

## Inputs

- The issue (title + description) is in the message that invoked you.
- The target branch is also in that message. You are already on it.

## Procedure

1. Read this repo's `AGENTS.md` and follow it.
2. Classify the work:
   - **Trivial** (small, obvious change) → skip to step 4.
   - **Non-trivial** → write a short plan FIRST, before editing code:
     - Think through the key design questions; for each, **accept the
       recommended/default answer** and record the assumption in the plan.
     - Choose the simplest approach that satisfies the issue.
     - Write the plan to `handoff/plans/<ISSUE>.md` (replace `<ISSUE>` with the
       identifier, e.g. `SER-9`). Create the directory if needed.
3. Implement the change. Use test-driven development for any logic: write a
   failing test, make it pass.
4. Run the quality gates until all green:
   - `npm test`
   - `npx tsc --noEmit`
   - `npm run lint`
5. Commit ONLY your source changes (do NOT add `handoff/plans/`,
   `handoff/logs/`, or build artifacts): `git add <specific files>` then
   `git commit -m "<ISSUE>: <title>"`.
6. Push: `git push -u origin <BRANCH>`.

## Hard rules

- Stay on `<BRANCH>`. Never switch branches, merge, or rebase.
- Do NOT open a PR, and do NOT touch Linear (you have no Linear tools).
- Do NOT run `gh` (you have no GitHub token).
- Do NOT modify CI config, dependencies, or the `handoff/` directory itself
  unless the issue requires it.
- If the gates cannot be made green, do the best you can, commit and push, and
  stop — the orchestrator handles the rest.
```

- [ ] **Step 3: Smoke-test the CLI help and dry-run**

Run: `node handoff/cli.mjs --help`
Expected: prints usage and exits 0.

Run: `npm run handoff:dry`
Expected: prints `N open handoff issue(s)` for SER (currently 0) and a dry-run summary; exits 0.

- [ ] **Step 4: Run the full unit suite**

Run: `npm run test:handoff`
Expected: PASS (all modules).

- [ ] **Step 5: Commit**

```bash
git add handoff/cli.mjs handoff/implement.md
git commit -m "feat(handoff): add CLI entrypoint and implement.md skill"
```

---

## Verification (not code — run before trusting it)

- [ ] **App gates still green:** `npm test && npx tsc --noEmit && npm run lint` (49 tests + tsc + lint).
- [ ] **Dry-run against real Linear:** `npm run handoff:dry` lists only `Todo` + `handoff`-labeled issues.
- [ ] **End-to-end throwaway:** create a real issue (e.g. "update a string in `src/constants.ts`"), label it `handoff`, run `npm run handoff`, verify claim → branch `SER-<num>-<slug>` → gates → push → PR → comment; then merge + close manually.
- [ ] **Failure injection:** create a `handoff`-labeled issue with an unsatisfiable requirement; verify 2 attempts → failure comment + partial push + back to `Todo`.
- [ ] **Re-runnability:** run `npm run handoff` twice; second run does nothing (no `Todo`+`handoff` issues remain).
