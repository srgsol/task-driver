import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToAdf, adfToText } from "../src/adf.mjs";

test("markdownToAdf converts headings, lists, fences and paragraphs", () => {
  const doc = markdownToAdf("# Plan\n\n- a\n- b\n\n``` \npipe x\n```\nplain");
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.content, [
    { type: "h1", content: [{ type: "text", text: "Plan" }] },
    {
      type: "ul",
      content: [
        { type: "li", content: [{ type: "text", text: "a" }] },
        { type: "li", content: [{ type: "text", text: "b" }] },
      ],
    },
    { type: "code", text: "pipe x" },
    { type: "paragraph", content: [{ type: "text", text: "plain" }] },
  ]);
});

test("adfToText renders a document to plain text", () => {
  const text = adfToText({
    type: "doc",
    version: 1,
    content: [
      { type: "h2", content: [{ type: "text", text: "Gates" }] },
      { type: "ul", content: [{ type: "li", content: [{ type: "text", text: "test" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "done" }] },
    ],
  });
  assert.equal(text, "## Gates\n- test\ndone");
});

test("adfToText handles null and a bare code node", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText({ type: "code", text: "x\ny" }), "x\ny");
});
