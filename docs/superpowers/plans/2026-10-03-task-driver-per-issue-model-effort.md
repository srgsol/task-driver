# Per-Issue Model & Effort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each Linear issue run the `pi` agent with its own model and thinking effort, chosen by `model-<alias>` / `effort-<alias>` labels decoded through `task-driver.config.json`.

**Architecture:** A new pure resolver (`src/params.mjs`) maps a validated issue's label leaf names to a concrete `{ model?, thinking }` using two optional config maps (`models`, `efforts`). The loop resolves _before_ claiming; an unknown or conflicting alias fails the issue loudly (comment + `ai:error` label + `Backlog`) instead of running the wrong model. The executor gains an optional `--model` flag; the Linear client gains label reads and an `addLabel` write.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test`, TypeScript `checkJs` typechecking via JSDoc, Linear GraphQL, `pi` CLI.

**Spec:** `docs/superpowers/specs/2026-10-03-task-driver-per-issue-model-effort-design.md`

## Global Constraints

- ESM `.mjs` only; **no runtime dependencies** — `node:` built-ins only.
- `tsconfig.json` includes `src/**/*.mjs` with `checkJs: true`, `strict: true`, `noImplicitAny: true`. **Every new/changed function and typedef needs accurate JSDoc or `npx tsc --noEmit` fails.**
- Prettier: `printWidth: 100`. Commits auto-format via husky/lint-staged.
- Config is additive: `models` and `efforts` are **optional** top-level objects. Existing configs must load unchanged.
- Effort values must be one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
- Label leaf names are matched with `^model-(.+)$` / `^effort-(.+)$`; the `ai` group prefix is stripped if present. Aliases are case-sensitive.
- Unknown or conflicting alias ⇒ **never** claim, branch, or run the agent. Comment, add label `ai:error`, move to `Backlog`, outcome `config-error`.
- When no `model-*` label exists, omit `--model` (pi default). When no `effort-*` label exists, use global `config.thinking`. Unlabeled issues behave exactly as today.
- Model IDs are passed through unvalidated; a bad ID is a failed agent run, not a config error.
- Gates that must pass at the end of every task: `npm test`, `npx tsc --noEmit`, `npm run lint`.

## Review Focus

Uncovered inputs the code must not break on, most likely first; each gets a test in the task that owns the code.

1. **`model-` / `effort-` with an empty alias** — must be ignored (treated as no label), not crash the run. (Task 2)
2. **Two `model-*` (or two `effort-*`) labels** — must be a `config-error`, never a silent pick. (Tasks 2, 5)
3. **An alias with no config entry** — must be `config-error` before claiming, not a default-model run. (Tasks 2, 5)
4. **A `model-*` leaf under no group or a different group** — must still resolve; grouping is cosmetic. (Task 2)
5. **Adding a label that already exists** — must reuse it, not create a duplicate. (Task 4)

---

### Task 1: Config — `models` and `efforts` maps

**Files:**

- Modify: `src/config.mjs`
- Test: `test/config.test.mjs`
- Modify: `README.md` (Configuration example + table)

**Interfaces:**

- Consumes: nothing.
- Produces: `Config.models: Record<string, string>` (alias → pi `--model` pattern), `Config.efforts: Record<string, string>` (alias → thinking level), and exported `EFFORT_LEVELS: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.mjs`:

```javascript
test("validateConfig defaults models and efforts to empty objects", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.deepEqual(c.models, {});
  assert.deepEqual(c.efforts, {});
});

test("validateConfig keeps explicit models and efforts", () => {
  const c = validateConfig({
    repos: [repo()],
    models: { fast: "openai/gpt-4o-mini" },
    efforts: { high: "high" },
  });
  assert.deepEqual(c.models, { fast: "openai/gpt-4o-mini" });
  assert.deepEqual(c.efforts, { high: "high" });
});

test("validateConfig rejects a non-string or empty model", () => {
  assert.throws(() => validateConfig({ repos: [repo()], models: { fast: 1 } }), /models\.fast/);
  assert.throws(() => validateConfig({ repos: [repo()], models: { fast: "  " } }), /models\.fast/);
});

test("validateConfig rejects a non-object models map", () => {
  assert.throws(() => validateConfig({ repos: [repo()], models: [] }), /models must be an object/);
});

test("validateConfig rejects an unknown effort level", () => {
  assert.throws(
    () => validateConfig({ repos: [repo()], efforts: { high: "extreme" } }),
    /efforts\.high/,
  );
});

test("validateConfig rejects a non-object efforts map", () => {
  assert.throws(
    () => validateConfig({ repos: [repo()], efforts: ["high"] }),
    /efforts must be an object/,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="models and efforts|explicit models|non-string|non-object|unknown effort"`
Expected: FAIL (defaults are `undefined`, validation absent).

- [ ] **Step 3: Implement the config changes**

In `src/config.mjs`, add above `DEFAULTS`:

```javascript
/** Accepted `pi --thinking` levels for `config.efforts`. */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
```

Extend the `Config` typedef with:

```javascript
 * @property {Record<string, string>} models
 * @property {Record<string, string>} efforts
```

In `validateConfig`, before the `return`, validate both maps and include them in the returned object. The exact validation rules: `models` must be a non-array object whose every value is a non-empty string (error text contains `config.models.<alias>`); `efforts` must be a non-array object whose every value is in `EFFORT_LEVELS` (error text contains `config.efforts.<alias>`). Non-object maps throw `config.models must be an object` / `config.efforts must be an object`. Default each to `{}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS (all previous + 6 new).

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: exit 0.

- [ ] **Step 6: Document the config keys**

In `README.md`, add `models` and `efforts` to the `task-driver.config.json` example and the Configuration table:

```markdown
| `models` | Optional alias → `pi --model` pattern map, e.g. `{ "fast": "openai/gpt-4o-mini" }`. Referenced by `model-<alias>` labels. |
| `efforts` | Optional alias → `pi --thinking` level map (`off`…`max`). Referenced by `effort-<alias>` labels. |
```

- [ ] **Step 7: Commit**

```bash
git add src/config.mjs test/config.test.mjs README.md
git commit -m "feat: add models and efforts alias maps to config"
```

---

### Task 2: `resolveAgentParams` resolver

**Files:**

- Create: `src/params.mjs`
- Test: `test/params.test.mjs`

**Interfaces:**

- Consumes: `config.models`, `config.efforts`, `config.thinking` (Task 1 shape).
- Produces: `resolveAgentParams(labels, config)` returning either
  `{ ok: true, model?: string, thinking: string, modelAlias?: string, effortAlias?: string }`
  or `{ ok: false, error: string }`.

- [ ] **Step 1: Write the failing tests**

Create `test/params.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentParams } from "../src/params.mjs";

const config = {
  models: { fast: "openai/gpt-4o-mini", "sonnet-4.5": "anthropic/claude-sonnet-4.5" },
  efforts: { low: "low", high: "high" },
  thinking: "medium",
};

test("no labels: no model, global thinking", () => {
  const r = resolveAgentParams([], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("undefined labels behave like none", () => {
  const r = resolveAgentParams(undefined, config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("model alias resolves the configured model and keeps global thinking", () => {
  const r = resolveAgentParams(["model-fast"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, "openai/gpt-4o-mini");
  assert.equal(r.thinking, "medium");
  assert.equal(r.modelAlias, "fast");
});

test("effort alias resolves the level and leaves the model unset", () => {
  const r = resolveAgentParams(["effort-high"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "high");
  assert.equal(r.effortAlias, "high");
});

test("both aliases resolve together", () => {
  const r = resolveAgentParams(["model-sonnet-4.5", "effort-low"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, "anthropic/claude-sonnet-4.5");
  assert.equal(r.thinking, "low");
});

test("unknown model alias is an error naming the alias", () => {
  const r = resolveAgentParams(["model-sonet-4.5"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown model alias "sonet-4\.5"/);
});

test("unknown effort alias is an error naming the alias", () => {
  const r = resolveAgentParams(["effort-max"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown effort alias "max"/);
});

test("multiple model labels are an error", () => {
  const r = resolveAgentParams(["model-fast", "model-sonnet-4.5"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /multiple model labels/);
});

test("multiple effort labels are an error", () => {
  const r = resolveAgentParams(["effort-low", "effort-high"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /multiple effort labels/);
});

test("empty alias is ignored, not an error", () => {
  const r = resolveAgentParams(["model-", "effort-"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("group prefix is cosmetic: full ai:model-fast and a foreign group still match", () => {
  assert.equal(resolveAgentParams(["ai:model-fast"], config).model, "openai/gpt-4o-mini");
  assert.equal(resolveAgentParams(["ai/model-fast"], config).model, "openai/gpt-4o-mini");
});

test("unrelated labels are ignored", () => {
  const r = resolveAgentParams(["task-driver", "Bug", "error"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/params.test.mjs`
Expected: FAIL — cannot find module `../src/params.mjs`.

- [ ] **Step 3: Implement `src/params.mjs`**

Export `resolveAgentParams(labels, config)`. It filters the label leaves into model and effort aliases after stripping a leading `ai:`/`ai/`, returns the multiple-labels error first, then the unknown-alias errors (model before effort), then the success object (always carrying `thinking`, carrying `model` only when a model alias was present, and carrying both alias fields when present). Add a `@typedef` for the config input and the return union so `checkJs` is satisfied. Regexes: `/^model-(.+)$/` and `/^effort-(.+)$/`, applied after `String.replace(/^ai[:/]/, "")`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/params.test.mjs`
Expected: PASS (12 tests).

- [ ] **Step 5: Full gates**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/params.mjs test/params.test.mjs
git commit -m "feat: resolve per-issue model and effort from label aliases"
```

---

### Task 3: Executor passes `--model`

**Files:**

- Modify: `src/executor.mjs`
- Test: `test/executor.test.mjs`

**Interfaces:**

- Consumes: nothing new.
- Produces: `runAgent({ repoPath, sessionId, config, skillPath, message, workRoot, repoName, model?, thinking? })`. `--model <model>` appears only when `model` is set; `--thinking <level>` uses `thinking ?? config.thinking`.

- [ ] **Step 1: Write the failing tests**

Append to `test/executor.test.mjs`:

```javascript
test("runAgent passes --model and an explicit thinking level", async () => {
  let args;
  const executor = createExecutor(async (_cmd, a) => {
    args = a;
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });
  await executor.runAgent({
    repoPath: "/r",
    sessionId: "s",
    config: { thinking: "medium", timeoutMs: 1000 },
    skillPath: "/sk.md",
    message: "m",
    workRoot: "/w",
    repoName: "tiktak",
    model: "anthropic/claude-sonnet-4.5",
    thinking: "high",
  });
  const i = args.indexOf("--model");
  assert.equal(args[i + 1], "anthropic/claude-sonnet-4.5");
  assert.equal(args[args.indexOf("--thinking") + 1], "high");
});

test("runAgent omits --model and falls back to config.thinking", async () => {
  let args;
  const executor = createExecutor(async (_cmd, a) => {
    args = a;
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });
  await executor.runAgent({
    repoPath: "/r",
    sessionId: "s",
    config: { thinking: "medium", timeoutMs: 1000 },
    skillPath: "/sk.md",
    message: "m",
    workRoot: "/w",
    repoName: "tiktak",
  });
  assert.equal(args.includes("--model"), false);
  assert.equal(args[args.indexOf("--thinking") + 1], "medium");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/executor.test.mjs`
Expected: FAIL — `--model` is never emitted.

- [ ] **Step 3: Implement the executor change**

In `src/executor.mjs`: add `@property {string} [model]` and `@property {string} [thinking]` to the `RunAgentOptions` typedef; destructure `model, thinking` in `runAgent`; build the args array without `--thinking`, then push `"--model", model` only when `model` is truthy, then push `"--thinking", thinking ?? config.thinking`, then `"--", message`. Leave env stripping, log streaming, and timeout untouched.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/executor.test.mjs`
Expected: PASS (previous + 2 new).

- [ ] **Step 5: Full gates**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/executor.mjs test/executor.test.mjs
git commit -m "feat: pass an optional --model to the pi agent"
```

---

### Task 4: Linear — read labels and add labels

**Files:**

- Modify: `src/linear.mjs`
- Test: `test/linear.test.mjs`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `listOpenIssues` results now carry `labels: string[]` (leaf names).
  - `addLabel(issueId: string, labelName: string): Promise<void>` — resolves `labelName` (`group:leaf`) to a label id, creating the group and/or leaf if absent, then adds it with `addedLabelIds`.

- [ ] **Step 1: Write the failing tests**

Append to `test/linear.test.mjs`:

```javascript
test("listOpenIssues exposes label leaf names", async () => {
  const nodes = [
    {
      id: "i1",
      identifier: "SER-1",
      title: "t",
      description: null,
      url: "u1",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      labels: { nodes: [{ name: "task-driver" }, { name: "model-fast" }] },
    },
  ];
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issues: { nodes } })),
  );
  const issues = await client.listOpenIssues("SER", "tik-tak");
  assert.deepEqual(issues[0].labels, ["task-driver", "model-fast"]);
});

test("listOpenIssues requests the labels field", async () => {
  let q;
  const client = createLinearClient(
    "k",
    fakeFetch((query) => {
      q = query;
      return { issues: { nodes: [] } };
    }),
  );
  await client.listOpenIssues("SER", "tik-tak");
  assert.match(q, /labels\s*\{\s*nodes\s*\{\s*name/);
});

test("addLabel reuses an existing grouped label", async () => {
  let added;
  const client = createLinearClient(
    "k",
    fakeFetch((query, vars) => {
      if (query.includes("issueLabels")) {
        return {
          issueLabels: {
            nodes: [{ id: "L1", name: "error", isGroup: false, parent: { id: "G1", name: "ai" } }],
          },
        };
      }
      if (query.includes("issueLabelCreate")) throw new Error("should not create");
      added = vars.input.addedLabelIds;
      return { issueUpdate: { success: true } };
    }),
  );
  await client.addLabel("i1", "ai:error");
  assert.deepEqual(added, ["L1"]);
});

test("addLabel creates the group and leaf when missing", async () => {
  const creates = [];
  let added;
  const client = createLinearClient(
    "k",
    fakeFetch((query, vars) => {
      if (query.includes("issueLabels")) return { issueLabels: { nodes: [] } };
      if (query.includes("issueLabelCreate")) {
        creates.push(vars.input);
        return {
          issueLabelCreate: {
            success: true,
            issueLabel: { id: vars.input.isGroup ? "G1" : "L2" },
          },
        };
      }
      added = vars.input.addedLabelIds;
      return { issueUpdate: { success: true } };
    }),
  );
  await client.addLabel("i1", "ai:error");
  assert.deepEqual(creates, [
    { name: "ai", isGroup: true },
    { name: "error", parentId: "G1" },
  ]);
  assert.deepEqual(added, ["L2"]);
});

test("addLabel resolves an ungrouped label", async () => {
  let added;
  const client = createLinearClient(
    "k",
    fakeFetch((query, vars) => {
      if (query.includes("issueLabels")) {
        return {
          issueLabels: { nodes: [{ id: "L3", name: "flaky", isGroup: false, parent: null }] },
        };
      }
      added = vars.input.addedLabelIds;
      return { issueUpdate: { success: true } };
    }),
  );
  await client.addLabel("i1", "flaky");
  assert.deepEqual(added, ["L3"]);
});

test("addLabel throws when the label cannot be created", async () => {
  const client = createLinearClient(
    "k",
    fakeFetch((query) => {
      if (query.includes("issueLabels")) return { issueLabels: { nodes: [] } };
      return { issueLabelCreate: { success: false } };
    }),
  );
  await assert.rejects(() => client.addLabel("i1", "flaky"), /Failed to create label/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/linear.test.mjs`
Expected: FAIL — `labels` is undefined and `client.addLabel` is not a function.

- [ ] **Step 3: Implement the Linear changes**

In `src/linear.mjs`:

1. Add `labels { nodes { name } }` to the `listOpenIssues` selection set; after `.filter(hasUnresolvedBlocker)`, map each node to `{ ...node, labels: (node.labels?.nodes ?? []).map((n) => n.name) }`. Add `@property {string[]} [labels]` to the `LinearIssue` typedef.
2. Add `addLabel` to the `LinearClient` typedef: `@property {(issueId: string, labelName: string) => Promise<void>} addLabel`.
3. Implement `addLabel(issueId, labelName)` on the returned client with these exact GraphQL operations (verified against the live schema — `IssueUpdateInput.addedLabelIds` avoids clobbering existing labels):

```graphql
query ($filter: IssueLabelFilter) {
  issueLabels(filter: $filter, first: 50) {
    nodes {
      id
      name
      isGroup
      parent {
        id
        name
      }
    }
  }
}
```

```graphql
mutation ($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel {
      id
    }
  }
}
```

```graphql
mutation ($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
  }
}
```

Behavior: split `labelName` on the first `:` or `/` into `{ group, leaf }` (no separator ⇒ `group` is `null`). Query labels by `{ name: { eq: leaf } }` and pick the node whose `parent?.name ?? null` equals `group`. If none, resolve the group id (query by `{ name: { eq: group } }` for an `isGroup` node; create it with `{ name: group, isGroup: true }` if absent), then create the leaf with `{ name: leaf, parentId }`. Finally `issueUpdate(issueId, { addedLabelIds: [labelId] })`. Throw `Failed to create label group "<group>"` / `Failed to create label "<leaf>"` on a non-successful create.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/linear.test.mjs`
Expected: PASS (previous + 6 new).

- [ ] **Step 5: Full gates**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/linear.mjs test/linear.test.mjs
git commit -m "feat: read issue labels and add labels via the Linear client"
```

---

### Task 5: Loop wiring + docs

**Files:**

- Modify: `src/loop.mjs`
- Test: `test/loop.test.mjs`
- Modify: `README.md` (new "Per-issue model & effort" section)

**Interfaces:**

- Consumes: `resolveAgentParams(labels, config)` (Task 2); `executor.runAgent({ …, model, thinking })` (Task 3); `issue.labels` and `linear.addLabel(issueId, labelName)` (Task 4).
- Produces: `processIssue` returns outcome `"config-error"` for alias failures; both agent attempts receive the resolved `model`/`thinking`.

- [ ] **Step 1: Extend the test harness and write the failing tests**

In `test/loop.test.mjs`: add `addLabel: []` to the `calls` object; add `addLabel: async (id, name) => calls.addLabel.push([id, name]),` to the fake `linear` (before `...opts.linear`); add `models: opts.models ?? {}` and `efforts: opts.efforts ?? {}` to the fake `config`. Then append:

```javascript
test("resolves label aliases and passes model and effort to the agent", async () => {
  const { loop, calls } = makeDeps({
    models: { fast: "openai/gpt-4o-mini" },
    efforts: { high: "high" },
    issues: [
      {
        id: "i1",
        identifier: "SER-9",
        title: "Fix drag",
        description: "d",
        url: "u",
        labels: ["model-fast", "effort-high"],
      },
    ],
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.equal(calls.runAgent[0].model, "openai/gpt-4o-mini");
  assert.equal(calls.runAgent[0].thinking, "high");
  assert.match(calls.comments[0][1], /model fast/);
  assert.match(calls.comments[0][1], /effort high/);
});

test("unknown model alias fails before claiming or branching", async () => {
  const { loop, calls } = makeDeps({
    issues: [
      {
        id: "i1",
        identifier: "SER-9",
        title: "t",
        description: "",
        url: "u",
        labels: ["model-nope"],
      },
    ],
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "config-error");
  assert.deepEqual(calls.moveState, [["i1", "Backlog"]]);
  assert.deepEqual(calls.addLabel, [["i1", "ai:error"]]);
  assert.match(calls.comments[0][1], /unknown model alias/);
  assert.equal(calls.runAgent.length, 0);
  assert.equal(calls.createBranch.length, 0);
});

test("conflicting effort labels fail with a config-error", async () => {
  const { loop, calls } = makeDeps({
    efforts: { low: "low", high: "high" },
    issues: [
      {
        id: "i1",
        identifier: "SER-9",
        title: "t",
        description: "",
        url: "u",
        labels: ["effort-low", "effort-high"],
      },
    ],
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "config-error");
  assert.deepEqual(calls.moveState, [["i1", "Backlog"]]);
  assert.equal(calls.runAgent.length, 0);
});

test("dry-run reports resolved params without mutating", async () => {
  const { loop, calls } = makeDeps({
    models: { fast: "openai/x" },
    issues: [
      {
        id: "i1",
        identifier: "SER-9",
        title: "t",
        description: "",
        url: "u",
        labels: ["model-fast"],
      },
    ],
  });
  const results = await loop(true);
  assert.equal(results[0].outcome, "dry");
  assert.equal(calls.moveState.length, 0);
  assert.equal(calls.addLabel.length, 0);
  assert.equal(calls.runAgent.length, 0);
});

test("dry-run flags a config-error without mutating", async () => {
  const { loop, calls } = makeDeps({
    issues: [
      {
        id: "i1",
        identifier: "SER-9",
        title: "t",
        description: "",
        url: "u",
        labels: ["model-nope"],
      },
    ],
  });
  const results = await loop(true);
  assert.equal(results[0].outcome, "config-error");
  assert.equal(calls.moveState.length, 0);
  assert.equal(calls.addLabel.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/loop.test.mjs`
Expected: FAIL — outcomes are `pr`/`dry`, and `model`/`thinking` are not passed.

- [ ] **Step 3: Implement the loop changes**

In `src/loop.mjs`:

1. Import `resolveAgentParams` from `./params.mjs`.
2. Add `@property {string[]} [labels]` to the `Issue` typedef; add `models`/`efforts` to the loop `Config` typedef; add `addLabel` to the `LinearClient` typedef.
3. In `processIssue`, immediately after computing `branch`/`sessionId`/`logPath`/`planPath`, call `const params = resolveAgentParams(issue.labels, config);`.
4. If `!params.ok`:
   - `dryRun` ⇒ `log(\` [dry] would flag ${issue.identifier}: ${params.error} (ai:error + Backlog)\`)`; return `{ identifier: issue.identifier, outcome: "config-error" }`.
   - else ⇒ `await bestEffort(...)` for each of: comment `` `❌ task-driver: ${params.error}. Fix the label or add the alias to task-driver.config.json.` ``, `linear.addLabel(issue.id, "ai:error")`, `linear.moveState(issue.id, "Backlog")`; `log` the failure; return `{ identifier: issue.identifier, outcome: "config-error" }`. Nothing else runs — no `In Progress` claim, no branch, no executor.
5. In the `dryRun` success block, add a line logging the resolved model (`params.model ?? "(default)"`) and `params.thinking`.
6. Append to the claim comment only what is set: `` ` (model ${params.modelAlias}, effort ${params.effortAlias})` `` filtered for absent aliases.
7. Pass `model: params.model, thinking: params.thinking` to both `executor.runAgent` calls (first attempt and repair attempt).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/loop.test.mjs`
Expected: PASS (all previous + 5 new).

- [ ] **Step 5: Full gates**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: exit 0.

- [ ] **Step 6: Document the label convention**

Add a `### Per-issue model & effort` section to `README.md` under Configuration: label leaf `model-<alias>` maps to `models[<alias>]`; `effort-<alias>` maps to `efforts[<alias>]`; the `ai` group is optional; unlabeled issues keep the global `thinking` and pi's default model; an unknown or duplicate alias comments on the issue, adds the `ai:error` label, and moves it to `Backlog` without running the agent.

- [ ] **Step 7: Commit**

```bash
git add src/loop.mjs test/loop.test.mjs README.md
git commit -m "feat: run each issue with its own model and effort"
```

---

## Self-Review

**Spec coverage:** Config maps → Task 1. `resolveAgentParams` → Task 2. `--model`/`--thinking` executor → Task 3. `labels` in query + `addLabel` resolve-or-create + `addedLabelIds` → Task 4. Resolve-before-claim, `config-error` (comment + `ai:error` + `Backlog`), claim-comment aliases, dry-run reporting, both attempts share params → Task 5. Failure re-pick guard relies on the existing `Todo`-only pick filter — no code needed. Tests table in the spec maps 1:1 onto the five tasks.

**Review Focus coverage:** (1) empty alias → Task 2 test; (2) duplicate labels → Task 2 + Task 5 tests; (3) unknown alias → Task 2 + Task 5 tests; (4) cosmetic group → Task 2 test; (5) existing label reuse → Task 4 test.

**Type consistency:** `models`/`efforts` (Record<string,string>) originate in Task 1 and are consumed by name in Tasks 2/5. `resolveAgentParams` returns `ok/model/thinking/modelAlias/effortAlias` in Task 2 and is read with those exact names in Task 5. `runAgent` gains `model`/`thinking` in Task 3 and is called with those names in Task 5. `addLabel(issueId, labelName)` and `issue.labels: string[]` are defined in Task 4 and consumed with those names in Task 5.

**Proportion:** Each task holds one responsibility and one test cycle; code steps give signatures and the exact GraphQL copy, not bodies.
