import { test } from "node:test";
import assert from "node:assert/strict";
import { createGit } from "../src/git.mjs";

const ok = { status: 0, stdout: "", stderr: "" };

test("isClean is true when status output is empty", () => {
  const git = createGit(() => ok);
  assert.equal(git.isClean("/r"), true);
});

test("isClean is false when status output present", () => {
  const git = createGit(() => ({ ...ok, stdout: " M src/x.ts" }));
  assert.equal(git.isClean("/r"), false);
});

test("branchPushed is true when ls-remote returns a ref", () => {
  let seen;
  const git = createGit((cmd, args) => {
    seen = args;
    return { ...ok, stdout: "abc\trefs/heads/SER-9-x" };
  });
  assert.equal(git.branchPushed("/r", "SER-9-x"), true);
  assert.deepEqual(seen, ["ls-remote", "--heads", "origin", "SER-9-x"]);
});

test("checkout throws on non-zero", () => {
  const git = createGit(() => ({ status: 1, stdout: "", stderr: "nope" }));
  assert.throws(() => git.checkout("/r", "master"), /checkout master failed/);
});

test("createBranch reuses an existing branch instead of aborting", () => {
  const seen = [];
  const git = createGit((cmd, args) => {
    seen.push(args.join(" "));
    if (args.includes("-b")) return { status: 128, stdout: "", stderr: "fatal: a branch named 'SER-9-x' already exists" };
    return { status: 0, stdout: "", stderr: "" };
  });
  assert.doesNotThrow(() => git.createBranch("/r", "SER-9-x"));
  assert.deepEqual(seen, ["checkout -b SER-9-x", "checkout SER-9-x"]);
});

test("pushBranch returns false on non-zero", () => {
  const git = createGit(() => ({ status: 1, stdout: "", stderr: "" }));
  assert.equal(git.pushBranch("/r", "SER-9-x"), false);
});
