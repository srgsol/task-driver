import { test } from "node:test";
import assert from "node:assert/strict";
import { createGates } from "../gates.mjs";

test("runGates reports green when all three pass", () => {
  const gates = createGates(() => ({ status: 0, stdout: "", stderr: "" }));
  const r = gates.runGates("/r");
  assert.equal(r.green, true);
  assert.deepEqual(r.results.map((x) => x.name), ["test", "tsc", "lint"]);
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
  const gates = createGates((cmd, args) => { seen.push([cmd, args]); return { status: 0, stdout: "", stderr: "" }; });
  gates.runGates("/r");
  assert.deepEqual(seen, [
    ["npm", ["test"]],
    ["npx", ["tsc", "--noEmit"]],
    ["npm", ["run", "lint"]],
  ]);
});
