import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLinearClient, getLinearApiKey } from "../src/linear.mjs";

/**
 * Run `fn` with `vars` applied to `process.env`, restoring every touched key afterwards.
 *
 * @param {Record<string, string | undefined>} vars
 * @param {() => void} fn
 */
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fakeFetch(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      status: 200,
      text: async () => JSON.stringify({ data: handler(body.query, body.variables) }),
    };
  };
}

/** A normalized repo config, shaped like `validateConfig` produces for the Linear provider. */
function linearRepo(overrides = {}) {
  return {
    name: "company-repo",
    path: "/tmp/company-repo",
    provider: "linear",
    team: "SER",
    project: "tik-tak",
    remote: "git@github.com:example/company-repo.git",
    gates: [],
    workflow: { open: "Todo", claim: "In Progress", reopen: "Todo", park: "Backlog" },
    labels: { pick: "task-driver", error: "ai:error" },
    ...overrides,
  };
}

function jsonResponse(data, status = 200) {
  return { status, text: async () => JSON.stringify({ data }) };
}

function graphqlErrorResponse(status, message) {
  return { status, text: async () => JSON.stringify({ errors: [{ message }] }) };
}

test("listOpenIssues requests relation fields", async () => {
  let seenQuery;
  const client = createLinearClient(
    "k",
    fakeFetch((q) => {
      seenQuery = q;
      return { issues: { nodes: [] } };
    }),
  );
  await client.listOpenIssues(linearRepo());
  assert.match(seenQuery, /relations/);
  assert.match(seenQuery, /inverseRelations/);
});

test("listOpenIssues requests and maps issue comments", async () => {
  let seenQuery;
  const comments = {
    nodes: [
      {
        body: "Please keep the API stable",
        createdAt: "2025-01-02T03:04:05Z",
        user: { name: "Alice" },
      },
    ],
  };
  const client = createLinearClient(
    "k",
    fakeFetch((q) => {
      seenQuery = q;
      return {
        issues: {
          nodes: [
            {
              id: "i1",
              identifier: "SER-1",
              title: "t",
              description: null,
              url: "u1",
              comments,
            },
          ],
        },
      };
    }),
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.match(seenQuery, /comments\s*\{\s*nodes\s*\{\s*body\s+createdAt\s+user\s*\{\s*name\s*\}/);
  assert.deepEqual(issues[0].comments, [
    {
      body: "Please keep the API stable",
      createdAt: "2025-01-02T03:04:05Z",
      user: { name: "Alice" },
    },
  ]);
});

test("getIssue requests and maps comments", async () => {
  let seenQuery;
  const comments = {
    nodes: [
      {
        body: "Re-opened: the fix missed the edge case",
        createdAt: "2025-02-03T04:05:06Z",
        user: { name: "Bob" },
      },
    ],
  };
  const client = createLinearClient(
    "k",
    fakeFetch((q) => {
      seenQuery = q;
      return {
        issue: {
          id: "i1",
          identifier: "SER-1",
          title: "t",
          description: null,
          url: "u1",
          comments,
        },
      };
    }),
  );
  const issue = await client.getIssue("SER-1");
  assert.match(seenQuery, /comments\s*\{\s*nodes\s*\{\s*body\s+createdAt\s+user\s*\{\s*name\s*\}/);
  assert.deepEqual(issue.comments, [
    {
      body: "Re-opened: the fix missed the edge case",
      createdAt: "2025-02-03T04:05:06Z",
      user: { name: "Bob" },
    },
  ]);
});

test("listOpenIssues skips issues blocked by an unresolved issue", async () => {
  const nodes = [
    {
      id: "i1",
      identifier: "SER-1",
      title: "blocked",
      description: null,
      url: "u1",
      relations: { nodes: [] },
      inverseRelations: { nodes: [{ type: "blocks", issue: { state: { name: "Todo" } } }] },
    },
    {
      id: "i2",
      identifier: "SER-2",
      title: "free",
      description: null,
      url: "u2",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
    },
  ];
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issues: { nodes } })),
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["SER-2"],
  );
});

test("listOpenIssues keeps issues whose blocker is Done or Canceled", async () => {
  const nodes = [
    {
      id: "i1",
      identifier: "SER-1",
      title: "t",
      description: null,
      url: "u1",
      relations: { nodes: [] },
      inverseRelations: { nodes: [{ type: "blocks", issue: { state: { name: "Done" } } }] },
    },
    {
      id: "i2",
      identifier: "SER-2",
      title: "t",
      description: null,
      url: "u2",
      relations: { nodes: [] },
      inverseRelations: { nodes: [{ type: "blocks", issue: { state: { name: "Canceled" } } }] },
    },
  ];
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issues: { nodes } })),
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["SER-1", "SER-2"],
  );
});

test("listOpenIssues keeps blockers and non-blocking relations", async () => {
  const nodes = [
    {
      id: "i1",
      identifier: "SER-1",
      title: "blocker",
      description: null,
      url: "u1",
      relations: { nodes: [{ type: "blocks", relatedIssue: { state: { name: "Todo" } } }] },
      inverseRelations: { nodes: [] },
    },
    {
      id: "i2",
      identifier: "SER-2",
      title: "related",
      description: null,
      url: "u2",
      relations: { nodes: [{ type: "related", relatedIssue: { state: { name: "Todo" } } }] },
      inverseRelations: { nodes: [{ type: "related", issue: { state: { name: "Todo" } } }] },
    },
  ];
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issues: { nodes } })),
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["SER-1", "SER-2"],
  );
});

test("listOpenIssues filters Todo + task-driver label + project", async () => {
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
  const issues = await client.listOpenIssues(linearRepo());
  assert.equal(issues.length, 1);
  assert.deepEqual(seen.filter.state, { name: { eq: "Todo" } });
  assert.deepEqual(seen.filter.labels, { name: { eq: "task-driver" } });
  assert.deepEqual(seen.filter.team, { key: { eq: "SER" } });
  assert.deepEqual(seen.filter.project, { name: { eq: "tik-tak" } });
});

test("listOpenIssues filters on the repo's workflow.open and labels.pick", async () => {
  let seen;
  const client = createLinearClient(
    "k",
    fakeFetch((q, vars) => {
      seen = vars;
      return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    }),
  );
  await client.listOpenIssues(
    linearRepo({
      workflow: { open: "WIP", claim: "In Progress" },
      labels: { pick: "auto", error: "ai:error" },
    }),
  );
  assert.deepEqual(seen.filter.state, { name: { eq: "WIP" } });
  assert.deepEqual(seen.filter.labels, { name: { eq: "auto" } });
  assert.deepEqual(seen.filter.team, { key: { eq: "SER" } });
  assert.deepEqual(seen.filter.project, { name: { eq: "tik-tak" } });
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

test("createIssue posts input and returns the created issue", async () => {
  let seen;
  const client = createLinearClient(
    "k",
    fakeFetch((q, v) => {
      seen = v;
      return {
        issueCreate: {
          success: true,
          issue: { id: "i2", identifier: "SER-30", title: "Add createIssue", url: "u" },
        },
      };
    }),
  );
  const issue = await client.createIssue({
    teamId: "team-1",
    projectId: "proj-1",
    title: "Add createIssue",
    description: "desc",
  });
  assert.equal(seen.input.teamId, "team-1");
  assert.equal(seen.input.projectId, "proj-1");
  assert.equal(seen.input.title, "Add createIssue");
  assert.equal(seen.input.description, "desc");
  assert.equal(issue.identifier, "SER-30");
  assert.equal(issue.id, "i2");
});

test("createIssue throws when issueCreate is not successful", async () => {
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issueCreate: { success: false } })),
  );
  await assert.rejects(
    () => client.createIssue({ teamId: "t", projectId: "p", title: "x", description: "" }),
    /Failed to create issue/,
  );
});

test("throws on API error", async () => {
  const client = createLinearClient("k", async () => ({
    status: 200,
    text: async () => JSON.stringify({ errors: [{ message: "boom" }] }),
  }));
  await assert.rejects(() => client.getIssue("SER-9"), /boom/);
});

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
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(issues[0].labels, ["task-driver", "model-fast"]);
});

test("listOpenIssues maps grouped labels to group:leaf", async () => {
  const nodes = [
    {
      id: "i1",
      identifier: "SER-1",
      title: "t",
      description: null,
      url: "u1",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      labels: {
        nodes: [
          { name: "error", parent: { name: "ai" } },
          { name: "task-driver", parent: null },
        ],
      },
    },
  ];
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issues: { nodes } })),
  );
  // A non-matching error label keeps this issue past the re-pick guard so the mapping is visible.
  const issues = await client.listOpenIssues(
    linearRepo({ labels: { pick: "task-driver", error: "ai:failed" } }),
  );
  assert.deepEqual(issues[0].labels, ["ai:error", "task-driver"]);
});

test("listOpenIssues drops issues already carrying the error label", async () => {
  const nodes = [
    {
      id: "i1",
      identifier: "SER-1",
      title: "errored",
      description: null,
      url: "u1",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      labels: {
        nodes: [
          { name: "error", parent: { name: "ai" } },
          { name: "task-driver", parent: null },
        ],
      },
    },
    {
      id: "i2",
      identifier: "SER-2",
      title: "fresh",
      description: null,
      url: "u2",
      relations: { nodes: [] },
      inverseRelations: { nodes: [] },
      labels: { nodes: [{ name: "task-driver", parent: null }] },
    },
  ];
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({ issues: { nodes } })),
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["SER-2"],
  );
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
  await client.listOpenIssues(linearRepo());
  assert.match(q, /labels\s*\{\s*nodes\s*\{\s*name/);
  assert.match(q, /parent\s*\{\s*name\s*\}/);
});

test("listOpenIssues requests page info and passes the after cursor", async () => {
  let query;
  let after;
  const client = createLinearClient(
    "k",
    fakeFetch((q, vars) => {
      query = q;
      after = vars.after;
      return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    }),
  );
  await client.listOpenIssues(linearRepo());
  assert.match(query, /pageInfo\s*\{\s*hasNextPage\s+endCursor\s*\}/);
  assert.equal(after, undefined);
});

test("listOpenIssues pages until hasNextPage is false", async () => {
  const pages = [
    {
      nodes: [{ id: "i1", identifier: "SER-1", title: "t", description: null, url: "u1" }],
      pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
    },
    {
      nodes: [{ id: "i2", identifier: "SER-2", title: "t", description: null, url: "u2" }],
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
    },
    {
      nodes: [{ id: "i3", identifier: "SER-3", title: "t", description: null, url: "u3" }],
      pageInfo: { hasNextPage: false, endCursor: "cursor-3" },
    },
  ];
  const afterArgs = [];
  const client = createLinearClient(
    "k",
    fakeFetch((q, vars) => {
      afterArgs.push(vars.after);
      return { issues: pages[afterArgs.length - 1] };
    }),
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["SER-1", "SER-2", "SER-3"],
  );
  assert.deepEqual(afterArgs, [undefined, "cursor-1", "cursor-2"]);
});

test("listOpenIssues throws rather than looping when a page has no end cursor", async () => {
  const client = createLinearClient(
    "k",
    fakeFetch(() => ({
      issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
    })),
  );
  await assert.rejects(() => client.listOpenIssues(linearRepo()), /endCursor/);
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

test("gql retries a transient network error then succeeds", async () => {
  let calls = 0;
  const delays = [];
  const client = createLinearClient(
    "k",
    async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return jsonResponse({
        issue: { id: "i1", identifier: "SER-1", title: "t", description: null, url: "u" },
      });
    },
    {
      attempts: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );
  const issue = await client.getIssue("SER-1");
  assert.equal(issue.identifier, "SER-1");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("gql retries a 5xx then succeeds", async () => {
  let calls = 0;
  const client = createLinearClient(
    "k",
    async () => {
      calls++;
      if (calls === 1) return graphqlErrorResponse(503, "service unavailable");
      return jsonResponse({ issues: { nodes: [] } });
    },
    { attempts: 3, sleep: async () => {} },
  );
  const issues = await client.listOpenIssues(linearRepo());
  assert.deepEqual(issues, []);
  assert.equal(calls, 2);
});

test("gql retries 429 rate limits", async () => {
  let calls = 0;
  const client = createLinearClient(
    "k",
    async () => {
      calls++;
      if (calls === 1) return graphqlErrorResponse(429, "rate limited");
      return jsonResponse({
        issue: { id: "i1", identifier: "SER-1", title: "t", description: null, url: "u" },
      });
    },
    { attempts: 3, sleep: async () => {} },
  );
  const issue = await client.getIssue("SER-1");
  assert.equal(issue.id, "i1");
  assert.equal(calls, 2);
});

test("gql does not retry a 4xx and preserves the error message", async () => {
  let calls = 0;
  const delays = [];
  const client = createLinearClient(
    "k",
    async () => {
      calls++;
      return graphqlErrorResponse(400, "bad request");
    },
    {
      attempts: 3,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );
  await assert.rejects(
    () => client.getIssue("SER-1"),
    /Linear API error \(HTTP 400\): bad request/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("gql gives up after the configured attempts", async () => {
  let calls = 0;
  const client = createLinearClient(
    "k",
    async () => {
      calls++;
      return graphqlErrorResponse(502, "bad gateway");
    },
    { attempts: 3, sleep: async () => {} },
  );
  await assert.rejects(
    () => client.getIssue("SER-1"),
    /Linear API error \(HTTP 502\): bad gateway/,
  );
  assert.equal(calls, 3);
});

test("gql backs off exponentially between retries", async () => {
  const delays = [];
  const client = createLinearClient(
    "k",
    async () => {
      throw new Error("network down");
    },
    {
      attempts: 4,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  );
  await assert.rejects(() => client.getIssue("SER-1"), /network down/);
  assert.deepEqual(delays, [100, 200, 400]);
});

test("gql retries mutations too", async () => {
  let calls = 0;
  const client = createLinearClient(
    "k",
    async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return jsonResponse({ commentCreate: { success: true } });
    },
    { attempts: 3, sleep: async () => {} },
  );
  await client.comment("i1", "hello");
  assert.equal(calls, 2);
});

test("getLinearApiKey reads and trims LINEAR_API_KEY", () => {
  withEnv({ LINEAR_API_KEY: " key-from-env " }, () => {
    assert.equal(getLinearApiKey(), "key-from-env");
  });
});

test("getLinearApiKey ignores ~/.pi/linear.json", () => {
  const home = mkdtempSync(join(tmpdir(), "task-driver-linear-"));
  try {
    withEnv({ LINEAR_API_KEY: undefined, HOME: home }, () => {
      mkdirSync(join(home, ".pi"), { recursive: true });
      writeFileSync(join(home, ".pi", "linear.json"), JSON.stringify({ apiKey: "from-file" }));

      assert.equal(getLinearApiKey(), undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
