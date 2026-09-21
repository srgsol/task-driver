const MAX = 40;

export function slugify(title) {
  const s = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX)
    .replace(/-+$/g, "");
  return s || "issue";
}

export function branchName(identifier, title) {
  return `${identifier}-${slugify(title)}`;
}
