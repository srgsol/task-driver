/** Atlassian Document Format helpers shared by the Jira provider. */

/**
 * @typedef {object} AdfNode
 * @property {string} type
 * @property {string} [text]
 * @property {AdfNode[]} [content]
 */

/**
 * @typedef {object} AdfDoc
 * @property {"doc"} type
 * @property {1} version
 * @property {AdfNode[]} content
 */

/**
 * True when `line` is a fence delimiter: the trimmed line begins with three backticks. A trailing
 * language tag or extra whitespace is ignored.
 *
 * @param {string} line
 * @returns {boolean}
 */
function isFence(line) {
  return line.trim().startsWith("```");
}

/**
 * @param {string} text
 * @returns {AdfNode}
 */
function textNode(text) {
  return { type: "text", text };
}

/**
 * Parse an ATX heading (`#`–`######`).
 *
 * @param {string} line
 * @returns {{ level: number; text: string } | null}
 */
function heading(line) {
  const match = /^(#{1,6})\s*(.*)$/.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2] };
}

/**
 * Join the rendered text of inline children without separators.
 *
 * @param {AdfNode[] | undefined} content
 * @returns {string}
 */
function inlineText(content) {
  return (content ?? []).map(renderNode).join("");
}

/**
 * Join the rendered text of block children with newlines.
 *
 * @param {AdfNode[] | undefined} content
 * @returns {string}
 */
function blockText(content) {
  return (content ?? []).map(renderNode).join("\n");
}

/**
 * Render a single ADF node to plain text. Unknown node types fall back to their `text` or their
 * rendered `content`, which keeps nested inline formatting readable.
 *
 * @param {AdfNode} node
 * @returns {string}
 */
function renderNode(node) {
  const type = node.type;
  if (type === "text" || type === "code") return node.text ?? "";
  if (type === "hr") return "---";
  if (/^h[1-6]$/.test(type)) return `${"#".repeat(Number(type[1]))} ${inlineText(node.content)}`;
  if (type === "paragraph" || type === "li") return inlineText(node.content);
  if (type === "ul") {
    return (node.content ?? []).map((item) => `- ${renderNode(item)}`).join("\n");
  }
  if (type === "doc" || Array.isArray(node.content)) return blockText(node.content);
  return node.text ?? "";
}

/**
 * Convert a markdown string into an ADF `doc`, for Jira comment bodies.
 *
 * Supported block syntax is deliberately minimal: ATX headings, a run of consecutive `- ` lines
 * (one `ul`), fenced code blocks (one `code` node whose `text` is the interior lines), blank-line
 * separated blocks, and every other non-empty line as a `paragraph`. Richer markdown falls through
 * as a paragraph of its raw line.
 *
 * @param {string} markdown
 * @returns {AdfDoc}
 */
export function markdownToAdf(markdown) {
  const lines = String(markdown ?? "").split("\n");
  /** @type {AdfNode[]} */
  const content = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    if (isFence(line)) {
      /** @type {string[]} */
      const code = [];
      i++;
      while (i < lines.length && !isFence(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      content.push({ type: "code", text: code.join("\n") });
      continue;
    }

    const head = heading(line);
    if (head) {
      content.push({ type: `h${head.level}`, content: [textNode(head.text)] });
      continue;
    }

    if (line.startsWith("- ")) {
      /** @type {AdfNode[]} */
      const items = [];
      while (i < lines.length && lines[i].startsWith("- ")) {
        items.push({ type: "li", content: [textNode(lines[i].slice(2))] });
        i++;
      }
      i--;
      content.push({ type: "ul", content: items });
      continue;
    }

    content.push({ type: "paragraph", content: [textNode(line)] });
  }

  return { type: "doc", version: 1, content };
}

/**
 * Render ADF (e.g. a Jira description) to plain text for the agent prompt.
 *
 * @param {object | null | undefined} adf
 * @returns {string}
 */
export function adfToText(adf) {
  if (adf == null) return "";
  return renderNode(/** @type {AdfNode} */ (adf));
}
