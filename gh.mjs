import { readFileSync } from "node:fs";
import { join } from "node:path";

export function getGhToken(repoPath) {
  const envPath = join(repoPath, ".env");
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    throw new Error(`GITHUB_TOKEN not found in ${envPath}`);
  }
  const m = text.match(/^GITHUB_TOKEN=(.+)$/m);
  if (!m) throw new Error(`GITHUB_TOKEN not found in ${envPath}`);
  return m[1].trim().replace(/\r$/, "");
}

export function createGh(runSync) {
  return {
    createPR({ repoPath, base, head, title, body }) {
      const token = getGhToken(repoPath);
      const r = runSync("gh", [
        "pr", "create",
        "--base", base,
        "--head", head,
        "--title", title,
        "--body", body,
      ], { cwd: repoPath, env: { ...process.env, GH_TOKEN: token } });
      const output = `${r.stdout}${r.stderr}`;
      if (r.status !== 0) throw new Error(`gh pr create failed: ${output.trim()}`);
      // `gh pr create` has no --json flag; it prints the new PR URL to stdout.
      const m = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      if (!m) throw new Error(`could not parse PR URL from gh output: ${output.trim()}`);
      return { url: m[0], number: Number(m[1]) };
    },
  };
}
