import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, validateConfig, DEFAULTS, DEFAULT_GATES } from "../config.mjs";

test("validateConfig applies defaults", () => {
  const c = validateConfig({ repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git" }] });
  assert.equal(c.attempts, DEFAULTS.attempts);
  assert.equal(c.timeoutMs, DEFAULTS.timeoutMs);
  assert.equal(c.thinking, DEFAULTS.thinking);
});

test("validateConfig rejects empty repos", () => {
  assert.throws(() => validateConfig({ repos: [] }), /non-empty/);
});

test("validateConfig rejects missing fields", () => {
  assert.throws(() => validateConfig({ repos: [{ name: "x" }] }), /name, path, team, remote/);
});

test("loadConfig reads and validates a file", () => {
  const p = join(tmpdir(), "cfg.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git" }], attempts: 3 }));
  const c = loadConfig(p);
  assert.equal(c.attempts, 3);
  assert.equal(c.repos.length, 1);
});

test("validateConfig attaches default gates when omitted", () => {
  const c = validateConfig({ repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git" }] });
  assert.equal(c.repos[0].gates, DEFAULT_GATES);
});

test("validateConfig keeps explicit gates", () => {
  const gates = [{ name: "build", cmd: "npm", args: ["run", "build"] }];
  const c = validateConfig({ repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git", gates }] });
  assert.equal(c.repos[0].gates, gates);
});

test("validateConfig rejects empty gates", () => {
  assert.throws(
    () => validateConfig({ repos: [{ name: "tiktak", path: ".", team: "SER", remote: "git@github.com:x/y.git", gates: [] }] }),
    /gates must be a non-empty array/,
  );
});

test("loadConfig resolves repo paths relative to the config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfgdir-"));
  const p = join(dir, "task-driver.config.json");
  writeFileSync(p, JSON.stringify({ repos: [{ name: "tiktak", path: "../tiktak", team: "SER", remote: "git@github.com:x/y.git" }] }));
  const c = loadConfig(p);
  assert.equal(c.repos[0].path, resolve(dir, "../tiktak"));
});
