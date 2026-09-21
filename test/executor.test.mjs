import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutor, readPlan } from "../executor.mjs";

test("runAgent strips Linear and GitHub tokens from child env", async () => {
  let seenEnv;
  let seenArgs;
  const executor = createExecutor(async (cmd, args, opts) => {
    seenArgs = args;
    seenEnv = opts.env;
    return { exitCode: 0, timedOut: false, stdout: "", stderr: "" };
  });
  process.env.GH_TOKEN = "x";
  process.env.LINEAR_API_KEY = "y";
  const r = await executor.runAgent({
    repoPath: "/r", sessionId: "s", config: { thinking: "medium", timeoutMs: 1000 },
    skillPath: "/sk.md", message: "do it",
  });
  assert.equal(r.exitCode, 0);
  assert.equal(seenEnv.GH_TOKEN, undefined);
  assert.equal(seenEnv.GITHUB_TOKEN, undefined);
  assert.equal(seenEnv.LINEAR_API_KEY, undefined);
  assert.ok(seenArgs.includes("--no-extensions"));
  assert.ok(seenArgs.includes("--approve"));
  assert.equal(seenArgs[seenArgs.length - 1], "do it");
  delete process.env.GH_TOKEN;
  delete process.env.LINEAR_API_KEY;
});

test("runAgent streams output to handoff/logs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "log-"));
  const executor = createExecutor(async (cmd, args, opts) => {
    opts.onChunk("stdout", "hello-log");
    return { exitCode: 0, timedOut: false, stdout: "hello-log", stderr: "" };
  });
  await executor.runAgent({
    repoPath: dir, sessionId: "handoff-tiktak-SER-9", config: { thinking: "medium", timeoutMs: 1000 },
    skillPath: "/sk.md", message: "m",
  });
  const log = readFileSync(join(dir, "handoff", "logs", "handoff-tiktak-SER-9.jsonl"), "utf8");
  assert.match(log, /hello-log/);
});

test("readPlan returns null when no plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  assert.equal(readPlan(dir, "SER-9"), null);
});

test("readPlan reads the plan file", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-"));
  const plans = join(dir, "handoff", "plans");
  mkdirSync(plans, { recursive: true });
  writeFileSync(join(plans, "SER-9.md"), "# plan");
  assert.equal(readPlan(dir, "SER-9"), "# plan");
});
