import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig, DEFAULTS } from "../src/config.mjs";

const gates = [{ name: "test", cmd: "npm", args: ["test"] }];

const repo = (overrides = {}) => ({
  name: "tiktak",
  path: ".",
  team: "SER",
  project: "tik-tak",
  remote: "git@github.com:x/y.git",
  gates,
  ...overrides,
});

test("validateConfig applies defaults", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.equal(c.attempts, DEFAULTS.attempts);
  assert.equal(c.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(c.thinking, DEFAULTS.thinking);
  assert.equal(c.repos[0].project, "tik-tak");
});

test("validateConfig defaults gateTimeoutMs to a positive integer", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.ok(Number.isInteger(c.gateTimeoutMs) && c.gateTimeoutMs > 0);
});

test("validateConfig rejects an invalid gateTimeoutMs", () => {
  assert.throws(
    () => validateConfig({ repos: [repo()], gateTimeoutMs: 0 }),
    /gateTimeoutMs must be an integer >= 1/,
  );
  assert.throws(
    () => validateConfig({ repos: [repo()], gateTimeoutMs: 1.5 }),
    /gateTimeoutMs must be an integer >= 1/,
  );
});

test("validateConfig rejects empty repos", () => {
  assert.throws(() => validateConfig({ repos: [] }), /non-empty/);
});

test("validateConfig rejects missing fields", () => {
  assert.throws(
    () => validateConfig({ repos: [{ name: "x" }] }),
    /name, path, team, project, remote/,
  );
});

test("validateConfig requires project", () => {
  assert.throws(() => validateConfig({ repos: [repo({ project: undefined })] }), /project/);
});

test("loadConfig reads and validates a file", () => {
  const p = join(tmpdir(), "cfg.json");
  writeFileSync(p, JSON.stringify({ repos: [repo()], attempts: 3 }));
  const c = loadConfig(p);
  assert.equal(c.attempts, 3);
  assert.equal(c.repos.length, 1);
  assert.equal(c.repos[0].project, "tik-tak");
});

test("validateConfig defaults omitted gates to an empty array", () => {
  const c = validateConfig({ repos: [repo({ gates: undefined })] });
  assert.deepEqual(c.repos[0].gates, []);
});

test("validateConfig keeps explicit gates", () => {
  const gates = [{ name: "build", cmd: "npm", args: ["run", "build"] }];
  const c = validateConfig({ repos: [repo({ gates })] });
  assert.equal(c.repos[0].gates, gates);
});

test("validateConfig allows empty gates", () => {
  const c = validateConfig({ repos: [repo({ gates: [] })] });
  assert.deepEqual(c.repos[0].gates, []);
});

test("validateConfig rejects non-array gates", () => {
  assert.throws(
    () => validateConfig({ repos: [repo({ gates: "npm test" })] }),
    /gates must be an array/,
  );
});

test("loadConfig resolves repo paths relative to the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgdir-"));
  const p = join(dir, "task-driver.config.json");
  writeFileSync(p, JSON.stringify({ repos: [repo({ path: "../tiktak" })] }));
  const c = loadConfig(p);
  assert.equal(c.repos[0].path, resolve(dir, "../tiktak"));
});

test("task-driver repo declares test, tsc, and lint gates", () => {
  const p = fileURLToPath(new URL("../task-driver.config.json", import.meta.url));
  const c = loadConfig(p);
  const td = c.repos.find((r) => r.name === "task-driver");
  assert.ok(td, "task-driver repo is configured");
  assert.deepEqual(
    td.gates.map((g) => g.name),
    ["test", "tsc", "lint"],
  );
  assert.deepEqual(td.gates, [
    { name: "test", cmd: "npm", args: ["test"] },
    { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
    { name: "lint", cmd: "npm", args: ["run", "lint"] },
  ]);
});

test("validateConfig defaults models and efforts to empty objects", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.deepEqual(c.models, {});
  assert.deepEqual(c.efforts, {});
});

test("validateConfig keeps explicit models and efforts", () => {
  const c = validateConfig({
    repos: [repo()],
    models: { fast: "openai/gpt-4o-mini" },
    efforts: { high: "high" },
  });
  assert.deepEqual(c.models, { fast: "openai/gpt-4o-mini" });
  assert.deepEqual(c.efforts, { high: "high" });
});

test("validateConfig rejects a non-string or empty model", () => {
  assert.throws(() => validateConfig({ repos: [repo()], models: { fast: 1 } }), /models\.fast/);
  assert.throws(() => validateConfig({ repos: [repo()], models: { fast: "  " } }), /models\.fast/);
});

test("validateConfig rejects a non-object models map", () => {
  assert.throws(() => validateConfig({ repos: [repo()], models: [] }), /models must be an object/);
});

test("validateConfig rejects an unknown effort level", () => {
  assert.throws(
    () => validateConfig({ repos: [repo()], efforts: { high: "extreme" } }),
    /efforts\.high/,
  );
});

test("validateConfig rejects a non-object efforts map", () => {
  assert.throws(
    () => validateConfig({ repos: [repo()], efforts: ["high"] }),
    /efforts must be an object/,
  );
});
