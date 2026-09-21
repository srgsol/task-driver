import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, branchName } from "../src/slug.mjs";

test("slugify lowercases and kebab-cases", () => {
  assert.equal(slugify("Fix Step Drag Handles"), "fix-step-drag-handles");
});

test("slugify collapses non-alphanumerics", () => {
  assert.equal(slugify("  Hello,,  World!!  "), "hello-world");
});

test("slugify truncates to 40 chars without trailing dash", () => {
  const s = slugify(`${"a".repeat(60)} b`);
  assert.ok(s.length <= 40);
  assert.ok(!s.endsWith("-"));
});

test("slugify falls back to 'issue' for empty input", () => {
  assert.equal(slugify("!!!"), "issue");
});

test("branchName keeps identifier case and slugs the title", () => {
  assert.equal(branchName("SER-9", "Fix Step Drag Handles"), "SER-9-fix-step-drag-handles");
});
