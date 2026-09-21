import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig, DEFAULTS } from "../config.mjs";

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
