import { join } from "node:path";
import { branchName } from "./slug.mjs";
import { readPlan as readPlanFromDisk } from "./executor.mjs";

const BASE_BRANCH = "master";

const PLAN_START = "<!-- task-driver:plan:start -->";
const PLAN_END = "<!-- task-driver:plan:end -->";

export function upsertPlanSection(description, plan) {
  const current = (description ?? "").trimEnd();
  const stripped = current.replace(/<!-- task-driver:plan:start -->[\s\S]*?<!-- task-driver:plan:end -->/g, "").trimEnd();
  const block = `${PLAN_START}\n## Implementation Plan\n\n${plan.trim()}\n${PLAN_END}`;
  return [stripped, block].filter((s) => s.length > 0).join("\n\n");
}

export function createLoop({ config, skillPath, linear, git, gates, gh, executor, workRoot, readPlan = readPlanFromDisk, log = () => {} }) {
  const gatesList = (repo) => repo.gates.map((g) => `- ${g.cmd} ${g.args.join(" ")}`).join("\n");
  const configBlock = (planPath, repo) =>
    ["## Configuration", `Plan path: ${planPath}`, "Gates (run until all green):", gatesList(repo)].join("\n");

  const issuePrompt = (issue, branch, planPath, repo) =>
    [`Implement ${issue.identifier}: ${issue.title}`, "", issue.description || "(no description)", "", `Branch: ${branch}`, "", configBlock(planPath, repo)].join("\n");

  const repairPrompt = (issue, branch, result, planPath, repo) => {
    const tail = `${result.stdout}\n${result.stderr}`.slice(-4000);
    return [
      `Your previous attempt for ${issue.identifier} did not pass verification.`,
      "", "Output so far:", "```", tail, "```", "",
      `Fix it, re-run the gates listed under \`Gates\` below, commit, and push branch ${branch}.`,
      "", configBlock(planPath, repo),
    ].join("\n");
  };

  const gatesSummary = (r) => r.results.map((x) => `- \`${x.name}\`: ${x.passed ? "passed" : "FAILED"}`).join("\n");

  function verify(repo, branch, result) {
    let pushed = false;
    try { pushed = git.branchPushed(repo.path, branch); } catch { /* ignore */ }
    const gatesResult = gates.runGates(repo);
    return { ok: result.exitCode === 0 && !result.timedOut && pushed && gatesResult.green, pushed, gatesResult };
  }

  async function processIssue(repo, issue, dryRun) {
    const branch = branchName(issue.identifier, issue.title);
    const sessionId = `task-driver-${repo.name}-${issue.identifier}`;
    const logPath = join(workRoot, repo.name, "logs", `${sessionId}.jsonl`);
    const planPath = join(workRoot, repo.name, "plans", `${issue.identifier}.md`);

    if (dryRun) {
      log(`  [dry] would claim ${issue.identifier} → In Progress`);
      log(`  [dry] would branch ${branch} from ${BASE_BRANCH}`);
      log(`  [dry] would run pi (session ${sessionId})`);
      log(`  [dry] would open PR (${BASE_BRANCH} ← ${branch})`);
      return { identifier: issue.identifier, outcome: "dry" };
    }

    try {
      await linear.moveState(issue.id, "In Progress");
      await linear.comment(issue.id, `🤖 task-driver: implementing ${issue.identifier} on branch \`${branch}\``);
    } catch (err) {
      log(`  ⚠️  ${issue.identifier}: claim failed (${err.message}) — skipping`);
      return { identifier: issue.identifier, outcome: "skipped" };
    }

    log(`→ ${issue.identifier}: ${issue.title} (${branch})`);
    git.checkout(repo.path, BASE_BRANCH);
    git.createBranch(repo.path, branch);
    log(`  watch: tail -f ${logPath}`);

    const first = await executor.runAgent({ repoPath: repo.path, sessionId, config, skillPath, message: issuePrompt(issue, branch, planPath, repo), workRoot, repoName: repo.name });
    let v = verify(repo, branch, first);

    if (!v.ok && config.attempts > 1) {
      log(`  attempt 1 failed (exit=${first.exitCode}, timedOut=${first.timedOut}, pushed=${v.pushed}, green=${v.gatesResult.green})`);
      const second = await executor.runAgent({ repoPath: repo.path, sessionId, config, skillPath, message: repairPrompt(issue, branch, first, planPath, repo), workRoot, repoName: repo.name });
      v = verify(repo, branch, second);
    }

    const plan = readPlan(workRoot, repo.name, issue.identifier);

    if (plan) {
      try {
        await linear.updateDescription(issue.id, upsertPlanSection(issue.description, plan));
      } catch (err) {
        log(`  ⚠️  ${issue.identifier}: could not save plan to issue (${err.message})`);
      }
    } else {
      log(`  ⚠️  ${issue.identifier}: no implementation plan produced — skipping issue write-back`);
    }

    if (v.ok) {
      const linearLink = issue.url ? `[${issue.identifier}](${issue.url})` : issue.identifier;
      const body = ["## Linear", linearLink, "", "## Plan", plan || "(none)", "", "## Gates", gatesSummary(v.gatesResult)].join("\n");
      try {
        const pr = gh.createPR({ repoPath: repo.path, base: BASE_BRANCH, head: branch, title: issue.title, body });
        await linear.comment(issue.id, `✅ PR opened: ${pr.url}\n\n${gatesSummary(v.gatesResult)}`);
        log(`  ✅ ${issue.identifier}: PR ${pr.url} (${branch})`);
        git.checkout(repo.path, BASE_BRANCH);
        return { identifier: issue.identifier, outcome: "pr" };
      } catch (err) {
        log(`  ⚠️  ${issue.identifier}: PR create failed: ${err.message}`);
        await linear.comment(issue.id, `⚠️ task-driver: code done and pushed on \`${branch}\`, but PR creation failed: ${err.message}`);
        git.checkout(repo.path, BASE_BRANCH);
        return { identifier: issue.identifier, outcome: "pr-failed" };
      }
    }

    const note = [
      `❌ task-driver could not complete ${issue.identifier} after ${config.attempts} attempt(s).`,
      "", "Verification:", gatesSummary(v.gatesResult), "",
      plan ? `Plan:\n${plan}` : "",
    ].filter(Boolean).join("\n");

    try { git.pushBranch(repo.path, branch); } catch { /* ignore */ }
    await linear.comment(issue.id, note);
    await linear.moveState(issue.id, "Todo");
    log(`  ❌ ${issue.identifier}: failed (branch ${branch} pushed, no PR)`);
    git.checkout(repo.path, BASE_BRANCH);
    return { identifier: issue.identifier, outcome: "failed" };
  }

  async function processRepo(repo, dryRun) {
    if (!dryRun) {
      if (!git.isClean(repo.path)) {
        log(`⚠️  ${repo.name}: working tree not clean — skipping`);
        return [];
      }
      if (git.currentBranch(repo.path) !== BASE_BRANCH) {
        log(`⚠️  ${repo.name}: not on ${BASE_BRANCH} — skipping`);
        return [];
      }
    }
    const issues = await linear.listOpenIssues(repo.team, repo.project);
    log(`${repo.name} (project ${repo.project}): ${issues.length} open task-driver issue(s)`);
    const results = [];
    for (const issue of issues) results.push(await processIssue(repo, issue, dryRun));
    return results;
  }

  return async function runLoop(dryRun) {
    const all = [];
    for (const repo of config.repos) all.push(...await processRepo(repo, dryRun));
    return all;
  };
}
