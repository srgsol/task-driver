import { readFileSync } from "node:fs";
import { join } from "node:path";

/** GitHub helpers: reads a per-repo token and opens pull requests via `gh`. */

/**
 * @typedef {{ url: string; number: number }} PrResult
 *
 * @typedef {(
 *   cmd: string,
 *   args: string[],
 *   opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
 * ) => { status: number; stdout: string; stderr: string }} RunSync
 */

/**
 * Read the GitHub token from a repository's `.env` file.
 *
 * @param {string} repoPath
 * @returns {string}
 */
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

/**
 * Build a `gh pr create` runner bound to a `runSync` implementation.
 *
 * @param {RunSync} runSync
 * @returns {{
 *   findPR(opts: { repoPath: string; head: string }): PrResult | null;
 *   createPR(opts: {
 *     repoPath: string;
 *     base: string;
 *     head: string;
 *     title: string;
 *     body: string;
 *   }): PrResult;
 * }}
 */
export function createGh(runSync) {
  return {
    /**
     * Find an open PR whose head is `head`, so a re-run can reuse it instead of failing on `gh pr
     * create`.
     *
     * @param {{ repoPath: string; head: string }} opts
     * @returns {PrResult | null}
     */
    findPR({ repoPath, head }) {
      const token = getGhToken(repoPath);
      const r = runSync("gh", ["pr", "list", "--head", head, "--json", "url", "--jq", ".[0].url"], {
        cwd: repoPath,
        env: { ...process.env, GH_TOKEN: token },
      });
      const output = `${r.stdout}${r.stderr}`.trim();
      if (r.status !== 0) throw new Error(`gh pr list failed: ${output}`);
      if (output === "" || output === "null") return null;
      const m = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      if (!m) throw new Error(`could not parse PR URL from gh output: ${output}`);
      return { url: m[0], number: Number(m[1]) };
    },
    /**
     * Create a GitHub pull request and parse the new PR URL from `gh` output.
     *
     * @param {{ repoPath: string; base: string; head: string; title: string; body: string }} opts
     * @returns {PrResult}
     */
    createPR({ repoPath, base, head, title, body }) {
      const token = getGhToken(repoPath);
      const r = runSync(
        "gh",
        ["pr", "create", "--base", base, "--head", head, "--title", title, "--body", body],
        { cwd: repoPath, env: { ...process.env, GH_TOKEN: token } },
      );
      const output = `${r.stdout}${r.stderr}`;
      if (r.status !== 0) throw new Error(`gh pr create failed: ${output.trim()}`);
      // `gh pr create` has no --json flag; it prints the new PR URL to stdout.
      const m = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
      if (!m) throw new Error(`could not parse PR URL from gh output: ${output.trim()}`);
      return { url: m[0], number: Number(m[1]) };
    },
  };
}
