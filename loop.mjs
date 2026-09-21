import { branchName } from "./slug.mjs";
import { readPlan as readPlanFromDisk } from "./executor.mjs";

const BASE_BRANCH = "master";

const PLAN_START = "<!-- handoff:plan:start -->";
const PLAN_END = "<!-- handoff:plan:end -->";

export function upsertPlanSection(description, plan) {
  const current = (description ?? "").trimEnd();
  const stripped = current.replace(/<!-- handoff:plan:start -->[\s\S]*?<!-- handoff:plan:end -->/g, "").trimEnd();
  const block = `${PLAN_START}\n## Implementation Plan\n\n${plan.trim()}\n${PLAN_END}`;
  return [stripped, block].filter((s) => s.length > 0).join("\n\n");
}

export function createLoop({ config, skillPath, linear, git, gates, gh, executor, readPlan = readPlanFromDisk, log = () => {} }) {
  const issuePrompt = (issue, branch) =>
    [`Implement ${issue.identifier}: ${issue.title}`, "", issue.description || "(no description)", "", `Branch: ${branch}`].join("\n");

  const repairPrompt = (issue, branch, result) => {
    const tail = `${result.stdout}\n${result.stderr}`.slice(-4000);
    return [
      `Your previous attempt for ${issue.identifier} did not pass verification.`,
      "", "Output so far:", "```", tail, "```", "",
      `Fix it, re-run the three gates (npm test, npx tsc --noEmit, npm run lint), commit, and push branch ${branch}.`,
    ].join("\n");
  };

  const gatesSummary = (r) => r.results.map((x) => `- \`${x.name}\`: ${x.passed ? "passed" : "FAILED"}`).join("\n");

  function verify(repoPath, branch, result) {
    let pushed = false;
    try { pushed = git.branchPushed(repoPath, branch); } catch { /* ignore */ }
    const gatesResult = gates.runGates(repoPath);
    return { ok: result.exitCode === 0 && !result.timedOut && pushed && gatesResult.green, pushed, gatesResult };
  }

  async function processIssue(repo, issue, dryRun) {
    const branch = branchName(issue.identifier, issue.title);
    const sessionId = `handoff-${repo.name}-${issue.identifier}`;

    if (dryRun) {
      log(`  [dry] would claim ${issue.identifier} → In Progress`);
      log(`  [dry] would branch ${branch} from ${BASE_BRANCH}`);
      log(`  [dry] would run pi (session ${sessionId})`);
      log(`  [dry] would open PR (${BASE_BRANCH} ← ${branch})`);
      return { identifier: issue.identifier, outcome: "dry" };
    }

    try {
      await linear.moveState(issue.id, "In Progress");
      await linear.comment(issue.id, `🤖 handoff: implementing ${issue.identifier} on branch \`${branch}\``);
    } catch (err) {
      log(`  ⚠️  ${issue.identifier}: claim failed (${err.message}) — skipping`);
      return { identifier: issue.identifier, outcome: "skipped" };
    }

    log(`→ ${issue.identifier}: ${issue.title} (${branch})`);
    git.checkout(repo.path, BASE_BRANCH);
    git.createBranch(repo.path, branch);
    log(`  watch: tail -f ${repo.path}/handoff/logs/${sessionId}.jsonl`);

    const first = await executor.runAgent({ repoPath: repo.path, sessionId, config, skillPath, message: issuePrompt(issue, branch) });
    let v = verify(repo.path, branch, first);

    if (!v.ok && config.attempts > 1) {
      log(`  attempt 1 failed (exit=${first.exitCode}, timedOut=${first.timedOut}, pushed=${v.pushed}, green=${v.gatesResult.green})`);
      const second = await executor.runAgent({ repoPath: repo.path, sessionId, config, skillPath, message: repairPrompt(issue, branch, first) });
      v = verify(repo.path, branch, second);
    }

    const plan = readPlan(repo.path, issue.identifier);

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
        await linear.comment(issue.id, `⚠️ handoff: code done and pushed on \`${branch}\`, but PR creation failed: ${err.message}`);
        git.checkout(repo.path, BASE_BRANCH);
        return { identifier: issue.identifier, outcome: "pr-failed" };
      }
    }

    const note = [
      `❌ handoff could not complete ${issue.identifier} after ${config.attempts} attempt(s).`,
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
    const issues = await linear.listOpenIssues(repo.team);
    log(`${repo.name}: ${issues.length} open handoff issue(s)`);
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
