import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, validateConfig, DEFAULTS, DEFAULT_GATES } from "../src/config.mjs";

const repo = (overrides = {}) => ({
  name: "tiktak",
  path: ".",
  team: "SER",
  project: "tik-tak",
  remote: "git@github.com:x/y.git",
  ...overrides,
});

test("validateConfig applies defaults", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.equal(c.attempts, DEFAULTS.attempts);
  assert.equal(c.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(c.thinking, DEFAULTS.thinking);
  assert.equal(c.repos[0].project, "tik-tak");
});

test("validateConfig rejects empty repos", () => {
  assert.throws(() => validateConfig({ repos: [] }), /non-empty/);
});

test("validateConfig rejects missing fields", () => {
  assert.throws(() => validateConfig({ repos: [{ name: "x" }] }), /name, path, team, project, remote/);
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

test("validateConfig attaches default gates when omitted", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.equal(c.repos[0].gates, DEFAULT_GATES);
});

test("validateConfig keeps explicit gates", () => {
  const gates = [{ name: "build", cmd: "npm", args: ["run", "build"] }];
  const c = validateConfig({ repos: [repo({ gates })] });
  assert.equal(c.repos[0].gates, gates);
});

test("validateConfig rejects empty gates", () => {
  assert.throws(
    () => validateConfig({ repos: [repo({ gates: [] })] }),
    /gates must be a non-empty array/,
  );
});

test("loadConfig resolves repo paths relative to the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgdir-"));
  const p = join(dir, "task-driver.config.json");
  writeFileSync(p, JSON.stringify({ repos: [repo({ path: "../tiktak" })] }));
  const c = loadConfig(p);
  assert.equal(c.repos[0].path, resolve(dir, "../tiktak"));
});
