import { test } from "node:test";
import assert from "node:assert/strict";
import { createTracker } from "../src/tracker.mjs";

/** @param {object} [overrides] */
function linearRepo(overrides = {}) {
  return {
    name: "tiktak",
    provider: "linear",
    team: "SER",
    project: "tik-tak",
    workflow: { open: "Todo", claim: "In Progress", reopen: "Todo", park: "Backlog" },
    labels: { pick: "task-driver", error: "ai:error" },
    ...overrides,
  };
}

/** @param {object} [overrides] */
function jiraRepo(overrides = {}) {
  return {
    name: "company-repo",
    provider: "jira",
    jiraProject: "PROJ",
    workflow: { open: "To Do", claim: "In Progress" },
    labels: { pick: "task-driver", error: "ai:error" },
    ...overrides,
  };
}

const issue = {
  id: "ISS-1",
  identifier: "SER-1",
  title: "T",
  description: "d",
  url: "https://example.test/SER-1",
  labels: [],
};

/** Fake Linear client recording every call. */
function fakeLinear() {
  /** @type {any[][]} */
  const calls = [];
  return {
    calls,
    listOpenIssues: async (/** @type {any} */ repo) => {
      calls.push(["listOpenIssues", repo]);
      return [issue];
    },
    comment: async (/** @type {string} */ id, /** @type {string} */ body) => {
      calls.push(["comment", id, body]);
    },
    addLabel: async (/** @type {string} */ id, /** @type {string} */ label) => {
      calls.push(["addLabel", id, label]);
    },
    moveState: async (/** @type {string} */ id, /** @type {string} */ state) => {
      calls.push(["moveState", id, state]);
    },
    getIssue: async (/** @type {string} */ identifier) => {
      calls.push(["getIssue", identifier]);
      return issue;
    },
    createIssue: async (/** @type {any} */ input) => {
      calls.push(["createIssue", input]);
      return issue;
    },
  };
}

/** Fake Jira client recording every call. */
function fakeJira() {
  /** @type {any[][]} */
  const calls = [];
  return {
    calls,
    listOpenIssues: async (/** @type {any} */ repo) => {
      calls.push(["listOpenIssues", repo]);
      return [issue];
    },
    comment: async (/** @type {string} */ id, /** @type {string} */ body) => {
      calls.push(["comment", id, body]);
    },
    addLabel: async (/** @type {string} */ id, /** @type {string} */ label) => {
      calls.push(["addLabel", id, label]);
    },
    transition: async (/** @type {string} */ id, /** @type {string} */ status) => {
      calls.push(["transition", id, status]);
    },
    getIssue: async (/** @type {string} */ identifier) => {
      calls.push(["getIssue", identifier]);
      return issue;
    },
    createIssue: async (/** @type {any} */ input) => {
      calls.push(["createIssue", input]);
      return issue;
    },
  };
}

test("linear: listOpen delegates to the linear client with the repo", async () => {
  const repo = linearRepo();
  const linear = fakeLinear();
  const jira = fakeJira();
  const tracker = createTracker(repo, { linear, jira });

  assert.deepEqual(await tracker.listOpen(), [issue]);
  assert.deepEqual(linear.calls, [["listOpenIssues", repo]]);
  assert.deepEqual(jira.calls, []);
});

test("linear: comment delegates to the linear client", async () => {
  const linear = fakeLinear();
  const tracker = createTracker(linearRepo(), { linear });

  await tracker.comment(issue, "hello");
  assert.deepEqual(linear.calls, [["comment", "ISS-1", "hello"]]);
});

test("linear: addLabel delegates to the linear client", async () => {
  const linear = fakeLinear();
  const tracker = createTracker(linearRepo(), { linear });

  await tracker.addLabel(issue, "ai:error");
  assert.deepEqual(linear.calls, [["addLabel", "ISS-1", "ai:error"]]);
});

test("linear: transition claim moves to the configured claim state", async () => {
  const linear = fakeLinear();
  const tracker = createTracker(linearRepo(), { linear });

  await tracker.transition(issue, "claim");
  assert.deepEqual(linear.calls, [["moveState", "ISS-1", "In Progress"]]);
});

test("linear: transition reopen moves to the configured reopen state", async () => {
  const linear = fakeLinear();
  const tracker = createTracker(linearRepo(), { linear });

  await tracker.transition(issue, "reopen");
  assert.deepEqual(linear.calls, [["moveState", "ISS-1", "Todo"]]);
});

test("linear: transition park moves to the configured park state", async () => {
  const linear = fakeLinear();
  const tracker = createTracker(linearRepo(), { linear });

  await tracker.transition(issue, "park");
  assert.deepEqual(linear.calls, [["moveState", "ISS-1", "Backlog"]]);
});

test("jira: transition claim uses the claim transition", async () => {
  const jira = fakeJira();
  const tracker = createTracker(jiraRepo(), { jira });

  await tracker.transition(issue, "claim");
  assert.deepEqual(jira.calls, [["transition", "ISS-1", "In Progress"]]);
});

test("jira: transition reopen falls back to the open status", async () => {
  const jira = fakeJira();
  const tracker = createTracker(jiraRepo(), { jira });

  await tracker.transition(issue, "reopen");
  assert.deepEqual(jira.calls, [["transition", "ISS-1", "To Do"]]);
});

test("jira: transition park is a no-op when park is unset", async () => {
  const jira = fakeJira();
  const tracker = createTracker(jiraRepo(), { jira });

  assert.equal(await tracker.transition(issue, "park"), undefined);
  assert.deepEqual(jira.calls, []);
});

test("jira: reopen targets the first element when open is an array", async () => {
  const jira = fakeJira();
  const repo = jiraRepo({ workflow: { open: ["To Do", "In Review"], claim: "In Progress" } });
  const tracker = createTracker(repo, { jira });

  await tracker.transition(issue, "reopen");
  assert.deepEqual(jira.calls, [["transition", "ISS-1", "To Do"]]);
});

test("jira: an explicit reopen wins over the open status", async () => {
  const jira = fakeJira();
  const repo = jiraRepo({
    workflow: { open: ["To Do", "In Review"], claim: "In Progress", reopen: "Reopened" },
  });
  const tracker = createTracker(repo, { jira });

  await tracker.transition(issue, "reopen");
  assert.deepEqual(jira.calls, [["transition", "ISS-1", "Reopened"]]);
});

test("jira: transition park uses the configured park transition", async () => {
  const jira = fakeJira();
  const repo = jiraRepo({
    workflow: { open: "To Do", claim: "In Progress", park: "Backlog" },
  });
  const tracker = createTracker(repo, { jira });

  await tracker.transition(issue, "park");
  assert.deepEqual(jira.calls, [["transition", "ISS-1", "Backlog"]]);
});

test("linear: getIssue and createIssue delegate to the linear client", async () => {
  const linear = fakeLinear();
  const jira = fakeJira();
  const tracker = createTracker(linearRepo(), { linear, jira });

  assert.deepEqual(await tracker.getIssue("SER-1"), issue);
  assert.deepEqual(await tracker.createIssue({ teamId: "t", projectId: "p", title: "T" }), issue);
  assert.deepEqual(linear.calls, [
    ["getIssue", "SER-1"],
    ["createIssue", { teamId: "t", projectId: "p", title: "T" }],
  ]);
  assert.deepEqual(jira.calls, []);
});

test("jira: getIssue and createIssue delegate to the jira client", async () => {
  const linear = fakeLinear();
  const jira = fakeJira();
  const tracker = createTracker(jiraRepo(), { linear, jira });

  assert.deepEqual(await tracker.getIssue("PROJ-1"), issue);
  assert.deepEqual(
    await tracker.createIssue({ project: "PROJ", issueType: "Task", title: "T" }),
    issue,
  );
  assert.deepEqual(jira.calls, [
    ["getIssue", "PROJ-1"],
    ["createIssue", { project: "PROJ", issueType: "Task", title: "T" }],
  ]);
  assert.deepEqual(linear.calls, []);
});

test("jira repo without a jira client throws, naming the repo", () => {
  assert.throws(() => createTracker(jiraRepo(), { linear: fakeLinear() }), /company-repo/);
});

test("linear repo without a linear client throws, naming the repo", () => {
  assert.throws(() => createTracker(linearRepo(), { jira: fakeJira() }), /tiktak/);
});
