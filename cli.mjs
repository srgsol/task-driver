import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { getLinearApiKey, createLinearClient } from "./linear.mjs";
import { createGit } from "./git.mjs";
import { createGates } from "./gates.mjs";
import { createGh } from "./gh.mjs";
import { createExecutor } from "./executor.mjs";
import { createLoop } from "./loop.mjs";
import { runSync, runAsync } from "./sh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workRoot = join(here, "work");

function parseArgs(argv) {
  const args = { dryRun: false, configPath: join(here, "handoff.config.json") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--config") args.configPath = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node cli.mjs [--dry-run] [--config path]");
      process.exit(0);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig(args.configPath);
  const apiKey = getLinearApiKey();
  if (!apiKey) {
    console.error("handoff: LINEAR_API_KEY not set and ~/.pi/linear.json not found.");
    process.exit(1);
  }

  const loop = createLoop({
    config,
    skillPath: join(here, "implement.md"),
    linear: createLinearClient(apiKey),
    git: createGit(runSync),
    gates: createGates(runSync),
    gh: createGh(runSync),
    executor: createExecutor(runAsync),
    workRoot,
    log: console.log,
  });

  const results = await loop(args.dryRun);
  if (args.dryRun) {
    console.log(`\nhandoff (dry run): ${results.length} issue(s) would be processed.`);
    return;
  }
  const count = (o) => results.filter((r) => r.outcome === o).length;
  const prs = count("pr");
  const failed = count("failed");
  const other = results.length - prs - failed;
  console.log(`\nhandoff complete: ${prs} PR(s), ${failed} failure(s), ${other} skipped/other, ${results.length} total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("handoff aborted:", err.message);
  process.exit(1);
});
