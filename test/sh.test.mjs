import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("runAsync timeout kills the whole process group, not just the direct child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runasync-group-"));
  const heartbeat = join(dir, "heartbeat");
  const pidFile = join(dir, "grandchild.pid");
  // The grandchild keeps appending to the heartbeat file; if it survives the
  // timeout, the file keeps growing after runAsync has resolved.
  const grandchild = [
    `const fs = require("node:fs");`,
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    `setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, "x"), 25);`,
  ].join("\n");
  const parent = [
    `const { spawn } = require("node:child_process");`,
    `spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
    `setTimeout(() => {}, 10000);`,
  ].join("\n");

  let grandchildPid;
  try {
    const r = await runAsync("node", ["-e", parent], { timeoutMs: 600 });
    assert.equal(r.timedOut, true);
    assert.ok(existsSync(pidFile), "grandchild should have recorded its pid");
    grandchildPid = Number(readFileSync(pidFile, "utf8"));

    const before = readFileSync(heartbeat, "utf8");
    await new Promise((res) => setTimeout(res, 250));
    const after = readFileSync(heartbeat, "utf8");
    assert.equal(after, before, "grandchild kept running after the timeout");
  } finally {
    if (grandchildPid && Number.isFinite(grandchildPid)) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
