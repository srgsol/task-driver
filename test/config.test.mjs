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

const JIRA_BASE_URL = "https://x.atlassian.net";

const jiraRepo = (overrides = {}) => ({
  name: "company-repo",
  path: "../company-repo",
  provider: "jira",
  jiraProject: "PROJ",
  remote: "git@github.com:example/company-repo.git",
  gates: [],
  workflow: { open: ["To Do"], claim: "In Progress" },
  labels: { pick: "task-driver", error: "ai:error" },
  ...overrides,
});

test("validateConfig normalizes provider, workflow, and labels per repo", () => {
  const c = validateConfig({ repos: [repo(), jiraRepo()], jiraBaseUrl: JIRA_BASE_URL });
  const [linear, jira] = c.repos;
  assert.equal(linear.provider, "linear");
  assert.deepEqual(linear.workflow, {
    open: "Todo",
    claim: "In Progress",
    reopen: "Todo",
    park: "Backlog",
  });
  assert.deepEqual(linear.labels, { pick: "task-driver", error: "ai:error" });
  assert.equal(jira.provider, "jira");
  assert.equal(jira.jiraProject, "PROJ");
  assert.deepEqual(jira.workflow, { open: ["To Do"], claim: "In Progress" });
  assert.deepEqual(jira.labels, { pick: "task-driver", error: "ai:error" });
  assert.ok(!("team" in jira));
  assert.equal(c.jiraBaseUrl, JIRA_BASE_URL);
});

test("validateConfig merges linear workflow overrides over the defaults", () => {
  const c = validateConfig({ repos: [repo({ workflow: { open: "Ready" } })] });
  assert.deepEqual(c.repos[0].workflow, {
    open: "Ready",
    claim: "In Progress",
    reopen: "Todo",
    park: "Backlog",
  });
});

test("validateConfig does not require jiraBaseUrl without jira repos", () => {
  const c = validateConfig({ repos: [repo()] });
  assert.equal(c.jiraBaseUrl, undefined);
});

test("validateConfig requires jiraProject for jira repos", () => {
  assert.throws(
    () =>
      validateConfig({ repos: [jiraRepo({ jiraProject: undefined })], jiraBaseUrl: JIRA_BASE_URL }),
    /requires jiraProject when provider is jira/,
  );
});

test("validateConfig requires jiraBaseUrl when any repo is jira", () => {
  assert.throws(
    () => validateConfig({ repos: [jiraRepo()] }),
    /jiraBaseUrl is required when any repo uses provider jira/,
  );
});

test("validateConfig rejects a non-http(s) jiraBaseUrl", () => {
  assert.throws(
    () => validateConfig({ repos: [jiraRepo()], jiraBaseUrl: "atlassian.net" }),
    /jiraBaseUrl must be a valid http\(s\) URL/,
  );
});

test("validateConfig rejects a linear workflow.open that is an array", () => {
  assert.throws(
    () => validateConfig({ repos: [repo({ workflow: { open: ["To Do"] } })] }),
    /workflow\.open must be a non-empty string$/,
  );
});

test("validateConfig rejects a jira workflow without open", () => {
  assert.throws(
    () => validateConfig({ repos: [jiraRepo({ workflow: {} })], jiraBaseUrl: JIRA_BASE_URL }),
    /workflow\.open must be a non-empty string or array of strings/,
  );
});

test("validateConfig rejects a jira workflow without claim", () => {
  assert.throws(
    () =>
      validateConfig({
        repos: [jiraRepo({ workflow: { open: "To Do" } })],
        jiraBaseUrl: JIRA_BASE_URL,
      }),
    /workflow\.claim must be a non-empty string/,
  );
});

test("validateConfig rejects an unknown provider", () => {
  assert.throws(
    () => validateConfig({ repos: [repo({ provider: "jiras" })] }),
    /provider must be 'linear' or 'jira'/,
  );
});

test("validateConfig passes jiraIssueType and jiraBlockingLinkTypes through", () => {
  const c = validateConfig({
    repos: [jiraRepo({ jiraIssueType: "Bug", jiraBlockingLinkTypes: ["is blocked by"] })],
    jiraBaseUrl: JIRA_BASE_URL,
  });
  assert.equal(c.repos[0].jiraIssueType, "Bug");
  assert.deepEqual(c.repos[0].jiraBlockingLinkTypes, ["is blocked by"]);
  assert.equal(c.repos[0].workflow.reopen, undefined);
  assert.equal(c.repos[0].workflow.park, undefined);
});

test("validateConfig rejects an invalid jiraBlockingLinkTypes", () => {
  const bad = (jiraBlockingLinkTypes) =>
    validateConfig({ repos: [jiraRepo({ jiraBlockingLinkTypes })], jiraBaseUrl: JIRA_BASE_URL });
  assert.throws(() => bad([]), /jiraBlockingLinkTypes must be a non-empty array of strings/);
  assert.throws(
    () => bad(["ok", ""]),
    /jiraBlockingLinkTypes must be a non-empty array of strings/,
  );
  assert.throws(() => bad("blocks"), /jiraBlockingLinkTypes must be a non-empty array of strings/);
  assert.throws(
    () => validateConfig({ repos: [repo({ jiraBlockingLinkTypes: [] })] }),
    /jiraBlockingLinkTypes must be a non-empty array of strings/,
  );
});
