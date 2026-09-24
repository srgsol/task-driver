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

test("runGates honours a custom gate list", () => {
  const seen = [];
  const g = createGates((cmd, args) => {
    seen.push([cmd, args]);
    return { status: 0, stdout: "", stderr: "" };
  });
  g.runGates({ path: "/r", gates: [{ name: "build", cmd: "npm", args: ["run", "build"] }] });
  assert.deepEqual(seen, [["npm", ["run", "build"]]]);
});
