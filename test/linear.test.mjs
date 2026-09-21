import { test } from "node:test";
import assert from "node:assert/strict";
import { createLinearClient } from "../src/linear.mjs";

function fakeFetch(handler) {
  return async (url, opts) => {
    const body = JSON.parse(opts.body);
    return { status: 200, text: async () => JSON.stringify({ data: handler(body.query, body.variables) }) };
  };
}

test("listOpenIssues filters Todo + task-driver label", async () => {
  let seen;
  const client = createLinearClient("k", fakeFetch((q, vars) => {
    seen = vars;
    return { issues: { nodes: [{ id: "i1", identifier: "SER-9", title: "t", description: null, url: "u" }] } };
  }));
  const issues = await client.listOpenIssues("SER");
  assert.equal(issues.length, 1);
  assert.deepEqual(seen.filter.state, { name: { eq: "Todo" } });
  assert.deepEqual(seen.filter.labels, { name: { eq: "task-driver" } });
  assert.deepEqual(seen.filter.team, { key: { eq: "SER" } });
});

test("moveState resolves state id then updates", async () => {
  const calls = [];
  const client = createLinearClient("k", fakeFetch((q, vars) => {
    calls.push(vars);
    if (q.includes("issue(id: $id)")) return { issue: { team: { id: "t1" } } };
    if (q.includes("states")) return { team: { states: { nodes: [{ id: "s1", name: "In Progress" }] } } };
    return { issueUpdate: { success: true } };
  }));
  await client.moveState("i1", "In Progress");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].input.stateId, "s1");
});

test("comment posts body", async () => {
  let seen;
  const client = createLinearClient("k", fakeFetch((q, v) => { seen = v; return { commentCreate: { success: true } }; }));
  await client.comment("i1", "hello");
  assert.equal(seen.input.issueId, "i1");
  assert.equal(seen.input.body, "hello");
});

test("updateDescription posts the description", async () => {
  let seen;
  const client = createLinearClient("k", fakeFetch((q, v) => { seen = v; return { issueUpdate: { success: true } }; }));
  await client.updateDescription("i1", "## Implementation Plan\n\n# plan");
  assert.equal(seen.input.description, "## Implementation Plan\n\n# plan");
  assert.equal(seen.input.stateId, undefined);
});

test("throws on API error", async () => {
  const client = createLinearClient("k", async () => ({ status: 200, text: async () => JSON.stringify({ errors: [{ message: "boom" }] }) }));
  await assert.rejects(() => client.getIssue("SER-9"), /boom/);
});
