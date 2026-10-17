import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGh, getGhToken } from "../src/gh.mjs";

test("getGhToken reads unquoted token from .env", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=github_pat_abc123\n");
  assert.equal(getGhToken(dir), "github_pat_abc123");
});

test("getGhToken throws when missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  assert.throws(() => getGhToken(dir), /GITHUB_TOKEN not found/);
});

test("createPR injects GH_TOKEN, omits --json, and parses the PR url", () => {
  let seenEnv;
  let seenArgs;
  const gh = createGh((cmd, args, opts) => {
    seenArgs = args;
    seenEnv = opts.env;
    return {
      status: 0,
      stdout:
        "Creating pull request for SER-9-x into master in x/y\n\nhttps://github.com/x/y/pull/3\n",
      stderr: "",
    };
  });
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  const pr = gh.createPR({ repoPath: dir, base: "master", head: "SER-9-x", title: "t", body: "b" });
  assert.equal(pr.number, 3);
  assert.equal(pr.url, "https://github.com/x/y/pull/3");
  assert.equal(seenEnv.GH_TOKEN, "tok");
  assert.ok(seenArgs.includes("pr"));
  assert.ok(!seenArgs.includes("--json"), "gh pr create does not support --json");
});

test("createPR throws on non-zero", () => {
  const gh = createGh(() => ({ status: 1, stdout: "", stderr: "denied" }));
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  assert.throws(
    () => gh.createPR({ repoPath: dir, base: "master", head: "x", title: "t", body: "b" }),
    /gh pr create failed/,
  );
});

test("findPR returns the open PR for a branch", () => {
  let seenArgs;
  let seenEnv;
  const gh = createGh((cmd, args, opts) => {
    seenArgs = args;
    seenEnv = opts.env;
    return { status: 0, stdout: "https://github.com/x/y/pull/7\n", stderr: "" };
  });
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  const pr = gh.findPR({ repoPath: dir, head: "SER-9-x" });
  assert.deepEqual(seenArgs, [
    "pr",
    "list",
    "--head",
    "SER-9-x",
    "--json",
    "url",
    "--jq",
    ".[0].url",
  ]);
  assert.equal(seenEnv.GH_TOKEN, "tok");
  assert.deepEqual(pr, { url: "https://github.com/x/y/pull/7", number: 7 });
});

test("findPR returns null when the branch has no open PR", () => {
  const gh = createGh(() => ({ status: 0, stdout: "null\n", stderr: "" }));
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  assert.equal(gh.findPR({ repoPath: dir, head: "SER-9-x" }), null);
});

test("findPR throws on non-zero", () => {
  const gh = createGh(() => ({ status: 1, stdout: "", stderr: "denied" }));
  const dir = mkdtempSync(join(tmpdir(), "gh-"));
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=tok\n");
  assert.throws(() => gh.findPR({ repoPath: dir, head: "x" }), /gh pr list failed/);
});
