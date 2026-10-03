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

test("updateDescription posts the description", async () => {
  let seen;
  const client = createLinearClient(
    "k",
    fakeFetch((q, v) => {
      seen = v;
      return { issueUpdate: { success: true } };
    }),
  );
  await client.updateDescription("i1", "## Implementation Plan\n\n# plan");
  assert.equal(seen.input.description, "## Implementation Plan\n\n# plan");
  assert.equal(seen.input.stateId, undefined);
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
