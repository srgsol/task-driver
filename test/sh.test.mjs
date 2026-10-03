import { test } from "node:test";
import assert from "node:assert/strict";
import { runSync, runAsync } from "../src/sh.mjs";

test("runSync captures stdout and status", () => {
  const r = runSync("node", ["-e", "process.stdout.write('ok')"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "ok");
});

test("runSync captures non-zero status", () => {
  assert.equal(runSync("node", ["-e", "process.exit(7)"]).status, 7);
});

test("runSync reports timedOut false for a normal command", () => {
  assert.equal(runSync("node", ["-e", "process.stdout.write('ok')"]).timedOut, false);
});

test("runSync times out a hung command", () => {
  const r = runSync("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /timed out after 50ms/);
});

test("runAsync resolves on exit", async () => {
  const r = await runAsync("node", ["-e", "console.log('hi')"]);
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /hi/);
});

test("runAsync times out", async () => {
  const r = await runAsync("node", ["-e", "setTimeout(()=>{}, 10000)"], { timeoutMs: 50 });
  assert.equal(r.timedOut, true);
});

test("runAsync gives the child EOF on stdin (does not hang)", async () => {
  const r = await runAsync(
    "node",
    ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('eof'));"],
    { timeoutMs: 4000 },
  );
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /eof/);
});
