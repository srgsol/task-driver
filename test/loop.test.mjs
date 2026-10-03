import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoop, upsertPlanSection } from "../src/loop.mjs";

function makeDeps(opts = {}) {
  const calls = {
    listOpenIssues: [],
    moveState: [],
    comments: [],
    updateDescription: [],
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
    listOpenIssues: async (...args) => {
      calls.listOpenIssues = args;
      return (
        opts.issues ?? [
          { id: "i1", identifier: "SER-9", title: "Fix drag", description: "desc", url: "u" },
        ]
      );
    },
    moveState: async (id, s) => calls.moveState.push([id, s]),
    comment: async (id, b) => calls.comments.push([id, b]),
    updateDescription: async (id, d) => calls.updateDescription.push([id, d]),
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
    repos: [
      {
        name: "tiktak",
        path: "/r",
        team: "SER",
        project: "tik-tak",
        remote: "g",
        gates: [
          { name: "test", cmd: "npm", args: ["test"] },
          { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
          { name: "lint", cmd: "npm", args: ["run", "lint"] },
        ],
      },
    ],
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
    workRoot: "/w",
    readPlan: opts.readPlan ?? (() => null),
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

test("processRepo passes repo.project to listOpenIssues", async () => {
  const { loop, calls } = makeDeps();
  await loop(false);
  assert.deepEqual(calls.listOpenIssues, ["SER", "tik-tak"]);
});

test("PR body links to the Linear issue", async () => {
  const { loop, calls } = makeDeps();
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.match(calls.createPR[0].body, /## Linear/);
  assert.match(calls.createPR[0].body, /\[SER-9\]\(u\)/);
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

test("writes the plan into the issue description on success", async () => {
  const { loop, calls } = makeDeps({ readPlan: () => "# plan" });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.equal(calls.updateDescription.length, 1);
  assert.equal(calls.updateDescription[0][0], "i1");
  assert.match(calls.updateDescription[0][1], /## Implementation Plan/);
  assert.match(calls.updateDescription[0][1], /# plan/);
});

test("writes the plan into the issue description on failure too", async () => {
  const { loop, calls } = makeDeps({
    readPlan: () => "# plan",
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
  assert.equal(calls.updateDescription.length, 1);
});

test("skips the write-back when no plan was produced", async () => {
  const { loop, calls } = makeDeps({ readPlan: () => null });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.equal(calls.updateDescription.length, 0);
});

test("upsertPlanSection appends and is idempotent", () => {
  const once = upsertPlanSection("", "# plan");
  assert.match(once, /## Implementation Plan/);
  assert.match(once, /# plan/);
  const twice = upsertPlanSection(once, "# new plan");
  assert.equal((twice.match(/## Implementation Plan/g) ?? []).length, 1);
  assert.match(twice, /# new plan/);
  assert.doesNotMatch(twice, /# plan\n/);
  assert.match(upsertPlanSection("Original text", "# plan"), /Original text/);
});

test("agent message includes the plan path and gates", async () => {
  const { loop, calls } = makeDeps();
  await loop(false);
  const msg = calls.runAgent[0].message;
  assert.match(msg, /## Configuration/);
  assert.match(msg, /Plan path: \/w\/tiktak\/plans\/SER-9\.md/);
  assert.match(msg, /- npm test/);
  assert.match(msg, /- npx tsc --noEmit/);
  assert.match(msg, /- npm run lint/);
});

test("repair message uses injected gates, not the old literal list", async () => {
  const { loop, calls } = makeDeps({
    agentResults: [
      { exitCode: 1, timedOut: false, stdout: "boom", stderr: "" },
      { exitCode: 0, timedOut: false, stdout: "", stderr: "" },
    ],
  });
  await loop(false);
  const msg = calls.runAgent[1].message;
  assert.doesNotMatch(msg, /npm test, npx tsc --noEmit, npm run lint/);
  assert.match(msg, /## Configuration/);
  assert.match(msg, /- npm test/);
});

test("branch setup failure is caught and the next issue still runs", async () => {
  const { loop, calls } = makeDeps({
    issues: [
      { id: "i1", identifier: "SER-1", title: "One", description: "", url: "u1" },
      { id: "i2", identifier: "SER-2", title: "Two", description: "", url: "u2" },
    ],
    git: {
      createBranch: (p, b) => {
        if (b.startsWith("SER-1")) throw new Error("dirty tree");
        calls.createBranch.push([p, b]);
      },
    },
  });
  const results = await loop(false);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["skipped", "pr"],
  );
  assert.equal(calls.runAgent.length, 1);
});

test("checkout failure during branch setup skips the issue", async () => {
  const { loop, calls } = makeDeps({
    git: {
      checkout: () => {
        throw new Error("boom");
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "skipped");
  assert.equal(calls.runAgent.length, 0);
});

test("failure-path comment error does not abort the run", async () => {
  const { loop, calls } = makeDeps({
    agentResults: [
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
    ],
    gates: {
      runGates: () => ({ green: false, results: [{ name: "test", passed: false, output: "" }] }),
    },
    linear: {
      comment: async (id, b) => {
        if (/could not complete/.test(b)) throw new Error("linear down");
        calls.comments.push([id, b]);
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "failed");
  assert.deepEqual(calls.moveState, [
    ["i1", "In Progress"],
    ["i1", "Todo"],
  ]);
});

test("failure-path moveState error does not abort the run", async () => {
  const { loop, calls } = makeDeps({
    agentResults: [
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
    ],
    gates: {
      runGates: () => ({ green: false, results: [{ name: "test", passed: false, output: "" }] }),
    },
    linear: {
      moveState: async (id, s) => {
        calls.moveState.push([id, s]);
        if (s === "Todo") throw new Error("linear down");
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "failed");
});

test("cleanup checkout error after PR does not abort the run", async () => {
  let checkouts = 0;
  const { loop, calls } = makeDeps({
    git: {
      checkout: (p, r) => {
        checkouts += 1;
        calls.checkout.push([p, r]);
        if (checkouts > 1) throw new Error("checkout failed");
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
});
