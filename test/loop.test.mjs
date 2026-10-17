import { test } from "node:test";
import assert from "node:assert/strict";
import { createLoop, formatPlanComment } from "../src/loop.mjs";

const DEFAULT_ISSUE = {
  id: "i1",
  identifier: "SER-9",
  title: "Fix drag",
  description: "desc",
  url: "u",
};

function defaultRepo() {
  return {
    name: "tiktak",
    path: "/r",
    provider: "linear",
    team: "SER",
    project: "tik-tak",
    workflow: { open: "Todo", claim: "In Progress", reopen: "Todo", park: "Backlog" },
    labels: { pick: "ai", error: "ai:error" },
    remote: "g",
    gates: [
      { name: "test", cmd: "npm", args: ["test"] },
      { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
      { name: "lint", cmd: "npm", args: ["run", "lint"] },
    ],
  };
}

function makeDeps(opts = {}) {
  const calls = {
    makeTracker: [],
    listOpen: [],
    transition: [],
    comments: [],
    checkout: [],
    createBranch: [],
    runAgent: [],
    findPR: [],
    createPR: [],
    pushBranch: [],
    addLabel: [],
  };
  const trackers = [];
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
  // Each repo gets its own fake tracker; `opts.tracker` overrides individual methods.
  const makeTracker =
    opts.makeTracker ??
    ((repo) => {
      calls.makeTracker.push(repo);
      const tracker = {
        listOpen: async () => {
          calls.listOpen.push(repo);
          return opts.issues ?? [DEFAULT_ISSUE];
        },
        comment: async (issue, body) => calls.comments.push([issue.id, body]),
        addLabel: async (issue, label) => calls.addLabel.push([issue.id, label]),
        transition: async (issue, step) => calls.transition.push([issue.id, step]),
        getIssue: async () => DEFAULT_ISSUE,
        createIssue: async () => DEFAULT_ISSUE,
        ...opts.tracker,
      };
      trackers.push(tracker);
      return tracker;
    });
  const gh = {
    findPR: (a) => {
      calls.findPR.push(a);
      return opts.existingPR ?? null;
    },
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
  const repo = { ...defaultRepo(), ...opts.repo };
  const config = {
    repos: opts.repos ?? [repo],
    attempts: 2,
    timeoutMs: 1,
    thinking: "medium",
    models: opts.models ?? {},
    efforts: opts.efforts ?? {},
  };
  const loop = createLoop({
    config,
    skillPath: "/sk.md",
    makeTracker,
    git,
    gates,
    gh,
    executor,
    workRoot: "/w",
    readPlan: opts.readPlan ?? (() => null),
    log: opts.log ?? (() => {}),
  });
  return { loop, calls, trackers };
}

test("happy path: claim, branch, PR, comment, back to master", async () => {
  const { loop, calls } = makeDeps({ readPlan: () => "# plan" });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.deepEqual(calls.transition, [["i1", "claim"]]);
  assert.equal(calls.createBranch.length, 1);
  assert.deepEqual(calls.createBranch[0], ["/r", "SER-9-fix-drag"]);
  assert.equal(calls.runAgent.length, 1);
  assert.equal(calls.createPR[0].head, "SER-9-fix-drag");
  const bodies = calls.comments.map(([, b]) => b);
  assert.ok(
    bodies.some((b) => /implementing SER-9/.test(b)),
    "expected a claim comment",
  );
  assert.ok(
    bodies.some((b) => /run parameters/.test(b)),
    "expected a run-parameters comment",
  );
  assert.ok(
    bodies.some((b) => /## Implementation Plan/.test(b)),
    "expected a plan comment",
  );
  assert.ok(
    bodies.some((b) => /PR opened/.test(b)),
    "expected a PR comment",
  );
  assert.deepEqual(calls.addLabel, []);
  assert.equal(calls.checkout.length, 2);
});

test("reuses an existing PR for the branch instead of creating another", async () => {
  const { loop, calls } = makeDeps({
    existingPR: { url: "https://github.com/x/y/pull/7", number: 7 },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.deepEqual(calls.findPR, [{ repoPath: "/r", head: "SER-9-fix-drag" }]);
  assert.equal(calls.createPR.length, 0);
  assert.ok(
    calls.comments.some(([, body]) => body.includes("https://github.com/x/y/pull/7")),
    "expected a comment with the existing PR URL",
  );
  assert.deepEqual(calls.transition, [["i1", "claim"]]);
});

test("processRepo builds a tracker for the repo and lists through it", async () => {
  const { loop, calls } = makeDeps();
  await loop(false);
  assert.equal(calls.makeTracker.length, 1);
  assert.equal(calls.makeTracker[0].team, "SER");
  assert.equal(calls.makeTracker[0].project, "tik-tak");
  assert.equal(calls.listOpen.length, 1);
  assert.equal(calls.listOpen[0], calls.makeTracker[0]);
});

test("PR body links to the Linear issue", async () => {
  const { loop, calls } = makeDeps();
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.match(calls.createPR[0].body, /## Linear/);
  assert.match(calls.createPR[0].body, /\[SER-9\]\(u\)/);
});

test("PR body uses the Jira header for a jira repo", async () => {
  const logs = [];
  const { loop, calls } = makeDeps({
    repo: { provider: "jira", jiraProject: "PROJ", project: undefined },
    log: (m) => logs.push(m),
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.match(calls.createPR[0].body, /## Jira/);
  assert.doesNotMatch(calls.createPR[0].body, /## Linear/);
  assert.ok(
    logs.some((l) => /project PROJ/.test(l)),
    `expected the jira project in the log, got: ${logs.join(" | ")}`,
  );
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

test("failure path after two failures: comment, push, reopen", async () => {
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
  assert.deepEqual(calls.transition, [
    ["i1", "claim"],
    ["i1", "reopen"],
  ]);
  assert.equal(calls.addLabel.length, 0);
});

test("PR creation failure moves the issue back to Todo", async () => {
  const { loop, calls } = makeDeps({
    gh: {
      createPR: () => {
        throw new Error("a pull request for branch SER-9-fix-drag already exists");
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr-failed");
  assert.deepEqual(calls.transition, [
    ["i1", "claim"],
    ["i1", "reopen"],
  ]);
  assert.ok(
    calls.comments.some(([, body]) => /PR creation failed/.test(body)),
    "expected a PR-failure note",
  );
});

test("preflight skips a dirty repo", async () => {
  const { loop, calls } = makeDeps({ git: { isClean: () => false } });
  const results = await loop(false);
  assert.equal(results.length, 0);
  assert.equal(calls.runAgent.length, 0);
});

test("dry-run makes no mutations", async () => {
  const logs = [];
  const { loop, calls } = makeDeps({ log: (m) => logs.push(m) });
  const results = await loop(true);
  assert.equal(results[0].outcome, "dry");
  assert.equal(calls.transition.length, 0);
  assert.equal(calls.createBranch.length, 0);
  assert.equal(calls.runAgent.length, 0);
  assert.equal(calls.createPR.length, 0);
  assert.ok(
    logs.some((l) => /→ In Progress/.test(l)),
    `expected the configured claim target in dry-run logs, got: ${logs.join(" | ")}`,
  );
});

test("posts the plan as a comment on success", async () => {
  const { loop, calls } = makeDeps({ readPlan: () => "# plan" });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  const planComment = calls.comments
    .map(([, b]) => b)
    .find((b) => /## Implementation Plan/.test(b));
  assert.ok(planComment, "expected a plan comment");
  assert.match(planComment, /# plan/);
});

test("posts the plan as a comment on failure too", async () => {
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
  const planComment = calls.comments
    .map(([, b]) => b)
    .find((b) => /## Implementation Plan/.test(b));
  assert.ok(planComment, "expected a plan comment");
  assert.match(planComment, /# plan/);
});

test("skips the plan comment when no plan was produced", async () => {
  const { loop, calls } = makeDeps({ readPlan: () => null });
  const results = await loop(false);
  assert.equal(results[0].outcome, "pr");
  assert.ok(!calls.comments.some(([, b]) => /## Implementation Plan/.test(b)));
});

test("formatPlanComment puts the plan under an Implementation Plan heading", () => {
  assert.equal(formatPlanComment("# plan\n"), "## Implementation Plan\n\n# plan");
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

test("agent message includes human comments and hides task-driver's own comments", async () => {
  const human = {
    body: "Re-opened because the drag handle still jumps on touch",
    createdAt: "2025-01-02T03:04:05Z",
    user: { name: "Alice" },
  };
  const automated = [
    { body: "🤖 task-driver: implementing SER-9 on branch `x`", user: { name: "bot" } },
    { body: "⚙️ task-driver run parameters — model `x`", user: { name: "bot" } },
    { body: "## Implementation Plan\n\n# plan", user: { name: "bot" } },
    { body: "✅ PR opened: https://x/pull/1", user: { name: "bot" } },
    { body: "⚠️ task-driver: PR creation failed", user: { name: "bot" } },
    { body: "❌ task-driver could not complete SER-9", user: { name: "bot" } },
  ];
  const { loop, calls } = makeDeps({
    issues: [{ ...DEFAULT_ISSUE, comments: [human, ...automated] }],
  });
  await loop(false);
  const msg = calls.runAgent[0].message;
  assert.match(msg, /## Comments/);
  assert.match(msg, /Re-opened because the drag handle still jumps on touch/);
  assert.match(msg, /Alice/);
  for (const comment of automated) {
    assert.ok(
      !msg.includes(comment.body.split("\n")[0]),
      `automated comment leaked: ${comment.body}`,
    );
  }
  assert.ok(msg.indexOf(human.body) > msg.indexOf("desc"), "comments follow the description");
  assert.ok(msg.indexOf(human.body) < msg.indexOf("Branch:"), "comments precede the branch");
});

test("agent message reads comments from a raw Linear connection", async () => {
  const { loop, calls } = makeDeps({
    issues: [
      {
        ...DEFAULT_ISSUE,
        comments: {
          nodes: [{ body: "Please address the regression", user: { name: "Bob" } }],
        },
      },
    ],
  });
  await loop(false);
  assert.match(calls.runAgent[0].message, /Please address the regression/);
});

test("agent message omits the comments section when only automated comments exist", async () => {
  const { loop, calls } = makeDeps({
    issues: [
      {
        ...DEFAULT_ISSUE,
        comments: [{ body: "🤖 task-driver: implementing SER-9", user: { name: "bot" } }],
      },
    ],
  });
  await loop(false);
  assert.doesNotMatch(calls.runAgent[0].message, /## Comments/);
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
    tracker: {
      comment: async (issue, body) => {
        if (/could not complete/.test(body)) throw new Error("tracker down");
        calls.comments.push([issue.id, body]);
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "failed");
  assert.deepEqual(calls.transition, [
    ["i1", "claim"],
    ["i1", "reopen"],
  ]);
});

test("failure-path reopen error does not abort the run", async () => {
  const { loop, calls } = makeDeps({
    agentResults: [
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
      { exitCode: 1, timedOut: false, stdout: "", stderr: "" },
    ],
    gates: {
      runGates: () => ({ green: false, results: [{ name: "test", passed: false, output: "" }] }),
    },
    tracker: {
      transition: async (issue, step) => {
        calls.transition.push([issue.id, step]);
        if (step === "reopen") throw new Error("tracker down");
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "failed");
});

test("claim transition failure skips the issue without running the agent", async () => {
  const { loop, calls } = makeDeps({
    tracker: {
      transition: async (issue, step) => {
        calls.transition.push([issue.id, step]);
        if (step === "claim") throw new Error("jira down");
      },
    },
  });
  const results = await loop(false);
  assert.equal(results[0].outcome, "skipped");
  assert.deepEqual(calls.transition, [["i1", "claim"]]);
  assert.equal(calls.runAgent.length, 0);
  assert.equal(calls.createPR.length, 0);
  assert.equal(calls.createBranch.length, 0);
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
  assert.deepEqual(calls.transition, [["i1", "park"]]);
  assert.deepEqual(calls.addLabel, [["i1", "ai:error"]]);
  assert.match(calls.comments[0][1], /unknown model alias/);
  assert.equal(calls.runAgent.length, 0);
  assert.equal(calls.createBranch.length, 0);
});

test("config error uses the repo's error label and parks the issue", async () => {
  const { loop, calls } = makeDeps({
    repo: { labels: { pick: "ai", error: "broken" } },
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
  assert.deepEqual(calls.addLabel, [["i1", "broken"]]);
  assert.deepEqual(calls.transition, [["i1", "park"]]);
  assert.match(calls.comments[0][1], /unknown model alias/);
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
  assert.deepEqual(calls.transition, [["i1", "park"]]);
  assert.equal(calls.runAgent.length, 0);
});

test("dry-run reports resolved params without mutating", async () => {
  const logs = [];
  const { loop, calls } = makeDeps({
    models: { fast: "openai/x" },
    log: (m) => logs.push(m),
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
  assert.ok(
    logs.some((l) => /openai\/x/.test(l)),
    `expected the resolved model in dry-run logs, got: ${logs.join(" | ")}`,
  );
  assert.equal(calls.transition.length, 0);
  assert.equal(calls.addLabel.length, 0);
  assert.equal(calls.runAgent.length, 0);
});

test("dry-run flags a config-error without mutating", async () => {
  const logs = [];
  const { loop, calls } = makeDeps({
    log: (m) => logs.push(m),
    repo: {
      labels: { pick: "ai", error: "broken" },
      workflow: { open: "Todo", claim: "In Progress", reopen: "Todo" },
    },
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
  assert.equal(calls.transition.length, 0);
  assert.equal(calls.addLabel.length, 0);
  assert.ok(
    logs.some((l) => /broken/.test(l)),
    `expected the repo's error label in dry-run logs, got: ${logs.join(" | ")}`,
  );
  assert.ok(!logs.some((l) => /Backlog/.test(l)), "no park target is configured");
});

test("mixed config: linear and jira repos are each driven by their own tracker", async () => {
  const linearRepo = { ...defaultRepo(), name: "lin", path: "/r1" };
  const jiraRepo = {
    ...defaultRepo(),
    name: "jir",
    path: "/r2",
    provider: "jira",
    jiraProject: "PROJ",
    team: undefined,
    project: undefined,
  };
  const { loop, calls, trackers } = makeDeps({ repos: [linearRepo, jiraRepo] });
  const results = await loop(false);
  assert.equal(trackers.length, 2);
  assert.notEqual(trackers[0], trackers[1]);
  assert.deepEqual(
    calls.listOpen.map((r) => r.name),
    ["lin", "jir"],
  );
  assert.deepEqual(
    results.map((r) => r.identifier),
    ["SER-9", "SER-9"],
  );
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["pr", "pr"],
  );
  const bodies = calls.createPR.map((p) => p.body);
  assert.equal(bodies.filter((b) => /## Linear/.test(b)).length, 1);
  assert.equal(bodies.filter((b) => /## Jira/.test(b)).length, 1);
});

test("posts a run-parameters comment with the resolved model and effort", async () => {
  const { loop, calls } = makeDeps({
    models: { fast: "openai/gpt-4o-mini" },
    efforts: { high: "high" },
    issues: [
      {
        id: "i1",
        identifier: "SER-9",
        title: "t",
        description: "",
        url: "u",
        labels: ["model-fast", "effort-high"],
      },
    ],
  });
  await loop(false);
  const runParams = calls.comments.map(([, body]) => body).find((b) => /run parameters/.test(b));
  assert.ok(runParams, "expected a run-parameters comment");
  assert.match(runParams, /openai\/gpt-4o-mini/);
  assert.match(runParams, /model-fast/);
  assert.match(runParams, /`high`/);
  assert.match(runParams, /effort-high/);
});

test("run-parameters comment records defaults when no labels are set", async () => {
  const { loop, calls } = makeDeps();
  await loop(false);
  const runParams = calls.comments.map(([, body]) => body).find((b) => /run parameters/.test(b));
  assert.ok(runParams, "expected a run-parameters comment");
  assert.match(runParams, /pi default/);
  assert.match(runParams, /medium/);
  assert.match(runParams, /global default/);
});
