import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { loadDotEnv } from "./env.mjs";
import { getLinearApiKey, createLinearClient } from "./linear.mjs";
import { getJiraCredentials, createJiraClient } from "./jira.mjs";
import { createTracker } from "./tracker.mjs";
import { createGit } from "./git.mjs";
import { createGates } from "./gates.mjs";
import { createGh } from "./gh.mjs";
import { createExecutor } from "./executor.mjs";
import { createLoop } from "./loop.mjs";
import { runSync, runAsync } from "./sh.mjs";

/**
 * Task-driver CLI entrypoint: wires config, Linear, git, gates, gh, executor, and the processing
 * loop together, then runs it.
 */

// `here` is src/; the project root is one level up.
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const workRoot = join(root, "work");

/**
 * Parse CLI arguments into a normalized options object.
 *
 * @param {string[]} argv
 * @returns {{ dryRun: boolean; configPath: string }}
 */
function parseArgs(argv) {
  const args = { dryRun: false, configPath: join(root, "task-driver.config.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--config") args.configPath = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node src/cli.mjs [--dry-run] [--config path]");
      process.exit(0);
    }
  }
  return args;
}

/**
 * Build the loop from config + dependencies and run it for all repos.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Credentials live in the git-ignored `.env`; load it before anything reads the environment.
  loadDotEnv(join(root, ".env"));
  const config = loadConfig(args.configPath);

  // Resolve credentials only for the providers actually in use, so a Jira-only config needs no
  // Linear key (and vice versa).
  const usesLinear = config.repos.some((repo) => repo.provider !== "jira");
  const usesJira = config.repos.some((repo) => repo.provider === "jira");

  /** @type {import("./linear.mjs").LinearClient | undefined} */
  let linear;
  if (usesLinear) {
    const apiKey = getLinearApiKey();
    if (!apiKey) {
      console.error("task-driver: LINEAR_API_KEY is not set. Add it to .env or the environment.");
      process.exit(1);
    }
    linear = createLinearClient(apiKey);
  }

  /** @type {import("./jira.mjs").JiraClient | undefined} */
  let jira;
  if (usesJira) {
    const creds = getJiraCredentials();
    if (!creds) {
      console.error(
        "task-driver: JIRA_EMAIL/JIRA_API_TOKEN are not set. Add them to .env or the environment.",
      );
      process.exit(1);
    }
    // `jiraBaseUrl` is required by config validation whenever a Jira repo exists.
    jira = createJiraClient({ ...creds, baseUrl: /** @type {string} */ (config.jiraBaseUrl) });
  }

  const loop = createLoop({
    config,
    skillPath: join(root, "implement.md"),
    // Provider clients type `listOpenIssues` with their provider-specific repo shape (required
    // `team`/`project` or `jiraProject`), while the tracker's provider typedefs use the generic
    // `TrackerRepo`; that mismatch is rejected under parameter contravariance. Config-normalized
    // repos always carry the fields their provider needs, so the runtime contract holds — the casts
    // below state it to tsc without resorting to `any`.
    makeTracker: (repo) =>
      createTracker(repo, {
        linear: /** @type {import("./tracker.mjs").LinearClient | undefined} */ (linear),
        jira: /** @type {import("./tracker.mjs").JiraClient | undefined} */ (jira),
      }),
    git: createGit(runSync),
    gates: createGates(runSync, { timeoutMs: config.gateTimeoutMs }),
    gh: createGh(runSync),
    executor: createExecutor(runAsync),
    workRoot,
    log: console.log,
  });

  const results = await loop(args.dryRun);
  if (args.dryRun) {
    console.log(`\ntask-driver (dry run): ${results.length} issue(s) would be processed.`);
    return;
  }
  const count = (/** @type {string} */ o) => results.filter((r) => r.outcome === o).length;
  const prs = count("pr");
  const failed = count("failed");
  const other = results.length - prs - failed;
  console.log(
    `\ntask-driver complete: ${prs} PR(s), ${failed} failure(s), ${other} skipped/other, ${results.length} total.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("task-driver aborted:", err.message);
  process.exit(1);
});
