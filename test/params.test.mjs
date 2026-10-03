import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentParams } from "../src/params.mjs";

const config = {
  models: { fast: "openai/gpt-4o-mini", "sonnet-4.5": "anthropic/claude-sonnet-4.5" },
  efforts: { low: "low", high: "high" },
  thinking: "medium",
};

test("no labels: no model, global thinking", () => {
  const r = resolveAgentParams([], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("undefined labels behave like none", () => {
  const r = resolveAgentParams(undefined, config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("model alias resolves the configured model and keeps global thinking", () => {
  const r = resolveAgentParams(["model-fast"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, "openai/gpt-4o-mini");
  assert.equal(r.thinking, "medium");
  assert.equal(r.modelAlias, "fast");
});

test("effort alias resolves the level and leaves the model unset", () => {
  const r = resolveAgentParams(["effort-high"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "high");
  assert.equal(r.effortAlias, "high");
});

test("both aliases resolve together", () => {
  const r = resolveAgentParams(["model-sonnet-4.5", "effort-low"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, "anthropic/claude-sonnet-4.5");
  assert.equal(r.thinking, "low");
});

test("unknown model alias is an error naming the alias", () => {
  const r = resolveAgentParams(["model-sonet-4.5"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown model alias "sonet-4\.5"/);
});

test("unknown effort alias is an error naming the alias", () => {
  const r = resolveAgentParams(["effort-max"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown effort alias "max"/);
});

test("multiple model labels are an error", () => {
  const r = resolveAgentParams(["model-fast", "model-sonnet-4.5"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /multiple model labels/);
});

test("multiple effort labels are an error", () => {
  const r = resolveAgentParams(["effort-low", "effort-high"], config);
  assert.equal(r.ok, false);
  assert.match(r.error, /multiple effort labels/);
});

test("empty alias is ignored, not an error", () => {
  const r = resolveAgentParams(["model-", "effort-"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("group prefix is cosmetic: full ai:model-fast and a foreign group still match", () => {
  assert.equal(resolveAgentParams(["ai:model-fast"], config).model, "openai/gpt-4o-mini");
  assert.equal(resolveAgentParams(["ai/model-fast"], config).model, "openai/gpt-4o-mini");
});

test("unrelated labels are ignored", () => {
  const r = resolveAgentParams(["task-driver", "Bug", "error"], config);
  assert.equal(r.ok, true);
  assert.equal(r.model, undefined);
  assert.equal(r.thinking, "medium");
});

test("an alias naming an inherited Object property is an unknown alias, not a match", () => {
  for (const alias of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const m = resolveAgentParams([`model-${alias}`], config);
    assert.equal(m.ok, false);
    assert.match(m.error, /unknown model alias/);
    const e = resolveAgentParams([`effort-${alias}`], config);
    assert.equal(e.ok, false);
    assert.match(e.error, /unknown effort alias/);
  }
});
