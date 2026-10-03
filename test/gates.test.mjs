import { test } from "node:test";
import assert from "node:assert/strict";
import { createGates } from "../src/gates.mjs";

const gates = [
  { name: "test", cmd: "npm", args: ["test"] },
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
];

test("runGates reports green when all pass", () => {
  const g = createGates(() => ({ status: 0, stdout: "", stderr: "" }));
  const r = g.runGates({ path: "/r", gates });
  assert.equal(r.green, true);
  assert.deepEqual(
    r.results.map((x) => x.name),
    ["test", "tsc", "lint"],
  );
});

test("runGates reports red when any fails", () => {
  let n = 0;
  const g = createGates(() => ({ status: n++ === 1 ? 1 : 0, stdout: "", stderr: "" }));
  const r = g.runGates({ path: "/r", gates });
  assert.equal(r.green, false);
  assert.equal(r.results[1].passed, false);
});

test("runGates runs the repo's configured gates", () => {
  const seen = [];
  const g = createGates((cmd, args) => {
    seen.push([cmd, args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  g.runGates({ path: "/r", gates });
  assert.deepEqual(seen, [
    ["npm", ["test"]],
    ["npx", ["tsc", "--noEmit"]],
    ["npm", ["run", "lint"]],
  ]);
});

test("runGates applies a positive default gate timeout", () => {
  const seen = [];
  const g = createGates((cmd, args, opts) => {
    seen.push(opts.timeoutMs);
    return { status: 0, stdout: "", stderr: "" };
  });
  g.runGates({ path: "/r", gates: [gates[0]] });
  assert.ok(seen[0] > 0, "a positive default timeout is applied");
});

test("runGates passes a custom gate timeout to runSync", () => {
  const seen = [];
  const g = createGates(
    (cmd, args, opts) => {
      seen.push(opts.timeoutMs);
      return { status: 0, stdout: "", stderr: "" };
    },
    { timeoutMs: 1234 },
  );
  g.runGates({ path: "/r", gates: [gates[0]] });
  assert.deepEqual(seen, [1234]);
});

test("runGates marks a timed-out gate failed", () => {
  const g = createGates(() => ({
    status: 1,
    stdout: "partial output",
    stderr: "timed out after 5ms",
    timedOut: true,
  }));
  const r = g.runGates({ path: "/r", gates: [gates[0]] });
  assert.equal(r.green, false);
  assert.equal(r.results[0].passed, false);
  assert.equal(r.results[0].timedOut, true);
  assert.match(r.results[0].output, /timed out/);
});

test("runGates honours a custom gate list", () => {
  const seen = [];
  const g = createGates((cmd, args) => {
    seen.push([cmd, args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  g.runGates({ path: "/r", gates: [{ name: "build", cmd: "npm", args: ["run", "build"] }] });
  assert.deepEqual(seen, [["npm", ["run", "build"]]]);
});
