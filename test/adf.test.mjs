import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToAdf, adfToText } from "../src/adf.mjs";

test("markdownToAdf converts headings, lists, fences and paragraphs", () => {
  const doc = markdownToAdf("# Plan\n\n- a\n- b\n\n``` \npipe x\n```\nplain");
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.content, [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }],
        },
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }],
        },
      ],
    },
    { type: "codeBlock", content: [{ type: "text", text: "pipe x" }] },
    { type: "paragraph", content: [{ type: "text", text: "plain" }] },
  ]);
});

test("adfToText renders a document to plain text", () => {
  const text = adfToText({
    type: "doc",
    version: 1,
    content: [
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Gates" }] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "test" }] }],
          },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "done" }] },
    ],
  });
  assert.equal(text, "## Gates\n- test\ndone");
});

test("markdownToAdf only treats 1-6 hashes followed by whitespace as headings", () => {
  assert.deepEqual(markdownToAdf("####### foo").content, [
    { type: "paragraph", content: [{ type: "text", text: "####### foo" }] },
  ]);
  assert.deepEqual(markdownToAdf("#foo").content, [
    { type: "paragraph", content: [{ type: "text", text: "#foo" }] },
  ]);
  assert.deepEqual(markdownToAdf("# Plan").content, [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Plan" }] },
  ]);
});

test("adfToText handles null and shorthand/real code and rule nodes", () => {
  assert.equal(adfToText(null), "");
  assert.equal(adfToText({ type: "code", text: "x\ny" }), "x\ny");
  assert.equal(adfToText({ type: "codeBlock", content: [{ type: "text", text: "x\ny" }] }), "x\ny");
  assert.equal(adfToText({ type: "rule" }), "---");
});
