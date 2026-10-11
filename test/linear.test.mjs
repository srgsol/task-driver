import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinearClient } from "../src/linear.mjs";

function fakeFetch(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      status: 200,
      text: async () => JSON.stringify({ data: handler(body.query, body.variables) }),
    };
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
  await client.listOpenIssues("SER", "tik-tak");
  assert.match(seenQuery, /relations/);
  assert.match(seenQuery, /inverseRelations/);
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
  const issues = await client.listOpenIssues("SER", "tik-tak");
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
  const issues = await client.listOpenIssues("SER", "tik-tak");
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
  const issues = await client.listOpenIssues("SER", "tik-tak");
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
  const issues = await client.listOpenIssues("SER", "tik-tak");
  assert.equal(issues.length, 1);
  assert.deepEqual(seen.filter.state, { name: { eq: "Todo" } });
  assert.deepEqual(seen.filter.labels, { name: { eq: "task-driver" } });
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
  await client.listOpenIssues("SER", "tik-tak");
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
  const issues = await client.listOpenIssues("SER", "tik-tak");
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
  await assert.rejects(() => client.listOpenIssues("SER", "tik-tak"), /endCursor/);
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
  const issues = await client.listOpenIssues("SER", "tik-tak");
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
