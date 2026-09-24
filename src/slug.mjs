/** Branch-name slugs derived from Linear issue identifiers and titles. */

/** Maximum length kept when truncating a slug. */
const MAX = 40;

/**
 * Turn an arbitrary title into a lowercase kebab-case slug for branch names.
 *
 * @param {string} title
 * @returns {string}
 */
export function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/g, "");
  return s || "issue";
}

/**
 * Build a git branch name from a Linear identifier and issue title.
 *
 * @param {string} identifier
 * @param {string} title
 * @returns {string}
 */
export function branchName(identifier, title) {
  return `${identifier}-${slugify(title)}`;
}
