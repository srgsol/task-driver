import { join } from "node:path";
import { branchName } from "./slug.mjs";
import { readPlan as readPlanFromDisk } from "./executor.mjs";
import { resolveAgentParams } from "./params.mjs";

/**
 * The processing loop: for each repo it lists open task-driver issues and, per issue, claims it,
 * drives the agent, re-verifies gates, opens a PR, and posts the implementation plan as a comment.
 */

const BASE_BRANCH = "master";

/**
 * @typedef {object} GateConfig
 * @property {string} name
 * @property {string} cmd
 * @property {string[]} args
 *
 * @typedef {object} RepoConfig
 * @property {string} name
 * @property {string} path
 * @property {"linear" | "jira"} [provider] Defaults to "linear" (normalized by config).
 * @property {string} [team] Linear only.
 * @property {string} [project] Linear only.
 * @property {string} [jiraProject] Jira only.
 * @property {{ open: string | string[]; claim: string; reopen?: string; park?: string }} workflow
 * @property {{ pick: string; error: string }} labels
 * @property {string} remote
 * @property {GateConfig[]} gates
 *
 * @typedef {object} Config
 * @property {RepoConfig[]} repos
 * @property {number} attempts
 * @property {number} timeoutMs
 * @property {number} gateTimeoutMs
 * @property {string} thinking
 * @property {Record<string, string>} [models]
 * @property {Record<string, string>} [efforts]
 *
 * @typedef {object} Issue
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string | null} [description]
 * @property {string} url
 * @property {string[]} [labels]
 *
 * @typedef {object} GateResult
 * @property {string} name
 * @property {boolean} passed
 * @property {string} output
 * @property {boolean} timedOut
 *
 * @typedef {object} GatesRun
 * @property {boolean} green
 * @property {GateResult[]} results
 *
 * @typedef {object} RunResult
 * @property {number | null} exitCode
 * @property {boolean} timedOut
 * @property {string} stdout
 * @property {string} stderr
 *
 * @typedef {object} Tracker
 * @property {() => Promise<Issue[]>} listOpen
 * @property {(issue: Issue, body: string) => Promise<void>} comment
 * @property {(issue: Issue, label: string) => Promise<void>} addLabel
 * @property {(issue: Issue, step: "claim" | "reopen" | "park") => Promise<void>} transition
 * @property {(identifier: string) => Promise<Issue>} getIssue
 * @property {(input: any) => Promise<Issue>} createIssue
 *
 * @typedef {object} Git
 * @property {(repoPath: string) => boolean} isClean
 * @property {(repoPath: string) => string} currentBranch
 * @property {(repoPath: string, ref: string) => void} checkout
 * @property {(repoPath: string, branch: string) => void} createBranch
 * @property {(repoPath: string, branch: string) => boolean} branchPushed
 * @property {(repoPath: string, branch: string) => boolean} pushBranch
 *
 * @typedef {object} Gates
 * @property {(repo: { path: string; gates: GateConfig[] }) => GatesRun} runGates
 *
 * @typedef {object} Gh
 * @property {(opts: {
 *   repoPath: string;
 *   base: string;
 *   head: string;
 *   title: string;
 *   body: string;
 * }) => { url: string; number: number }} createPR
 *
 *
 * @typedef {object} Executor
 * @property {(opts: {
 *   repoPath: string;
 *   sessionId: string;
 *   config: Config;
 *   skillPath: string;
 *   message: string;
 *   workRoot: string;
 *   repoName: string;
 *   model?: string;
 *   thinking?: string;
 * }) => Promise<RunResult>} runAgent
 *
 *
 * @typedef {object} LoopDeps
 * @property {Config} config
 * @property {string} skillPath
 * @property {(repo: RepoConfig) => Tracker} makeTracker
 * @property {Git} git
 * @property {Gates} gates
 * @property {Gh} gh
 * @property {Executor} executor
 * @property {string} workRoot
 * @property {(workRoot: string, repoName: string, identifier: string) => string | null} [readPlan]
 * @property {(msg: string) => void} [log]
 */

/**
 * Format the implementation plan as the body of a tracker comment.
 *
 * @param {string} plan
 * @returns {string}
 */
export function formatPlanComment(plan) {
  return `## Implementation Plan\n\n${plan.trim()}`;
}

/**
 * Build the per-repo issue processing loop.
 *
 * @param {LoopDeps} deps
 * @returns {(dryRun: boolean) => Promise<{ identifier: string; outcome: string }[]>}
 */
export function createLoop({
  config,
  skillPath,
  makeTracker,
  git,
  gates,
  gh,
  executor,
  workRoot,
  readPlan = readPlanFromDisk,
  log = (/** @type {string} */ _msg) => {
    void _msg;
  },
}) {
  const gatesList = (/** @type {RepoConfig} */ repo) =>
    repo.gates.map((/** @type {GateConfig} */ g) => `- ${g.cmd} ${g.args.join(" ")}`).join("\n");
  const configBlock = (/** @type {string} */ planPath, /** @type {RepoConfig} */ repo) =>
    [
      "## Configuration",
      `Plan path: ${planPath}`,
      "Gates (run until all green):",
      gatesList(repo),
    ].join("\n");

  const issuePrompt = (
    /** @type {Issue} */ issue,
    /** @type {string} */ branch,
    /** @type {string} */ planPath,
    /** @type {RepoConfig} */ repo,
  ) =>
    [
      `Implement ${issue.identifier}: ${issue.title}`,
      "",
      issue.description || "(no description)",
      "",
      `Branch: ${branch}`,
      "",
      configBlock(planPath, repo),
    ].join("\n");

  const repairPrompt = (
    /** @type {Issue} */ issue,
    /** @type {string} */ branch,
    /** @type {RunResult} */ result,
    /** @type {string} */ planPath,
    /** @type {RepoConfig} */ repo,
  ) => {
    // Keep the repair prompt bounded: the agent only needs the tail of the output.
    const tail = `${result.stdout}\n${result.stderr}`.slice(-4000);
    return [
      `Your previous attempt for ${issue.identifier} did not pass verification.`,
      "",
      "Output so far:",
      "```",
      tail,
      "```",
      "",
      `Fix it, re-run the gates listed under \`Gates\` below, commit, and push branch ${branch}.`,
      "",
      configBlock(planPath, repo),
    ].join("\n");
  };

  const gatesSummary = (/** @type {GatesRun} */ r) =>
    r.results
      .map((/** @type {GateResult} */ x) => {
        const status = x.passed ? "passed" : x.timedOut ? "FAILED (timed out)" : "FAILED";
        return `- \`${x.name}\`: ${status}`;
      })
      .join("\n");

  // Re-check independently of the agent: exit code, branch pushed, gates green.
  /**
   * @param {RepoConfig} repo
   * @param {string} branch
   * @param {RunResult} result
   */
  function verify(repo, branch, result) {
    let pushed = false;
    try {
      pushed = git.branchPushed(repo.path, branch);
    } catch {
      /* ignore */
    }
    const gatesResult = gates.runGates(repo);
    return {
      ok: result.exitCode === 0 && !result.timedOut && pushed && gatesResult.green,
      pushed,
      gatesResult,
    };
  }

  /**
   * Run a cleanup/notification step, logging (but not propagating) failures so that a single
   * git/tracker hiccup can't abort the rest of the run.
   *
   * @param {string} label
   * @param {() => void | Promise<void>} action
   */
  async function bestEffort(label, action) {
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  ⚠️  ${label} (${message})`);
    }
  }

  /**
   * @param {RepoConfig} repo
   * @param {Tracker} tracker
   * @param {Issue} issue
   * @param {boolean} dryRun
   */
  async function processIssue(repo, tracker, issue, dryRun) {
    const branch = branchName(issue.identifier, issue.title);
    const sessionId = `task-driver-${repo.name}-${issue.identifier}`;
    const logPath = join(workRoot, repo.name, "logs", `${sessionId}.jsonl`);
    const planPath = join(workRoot, repo.name, "plans", `${issue.identifier}.md`);
    const params = resolveAgentParams(issue.labels, config);

    if (!params.ok) {
      if (dryRun) {
        log(
          `  [dry] would flag ${issue.identifier}: ${params.error} (${repo.labels.error}${
            repo.workflow.park ? ` + ${repo.workflow.park}` : ""
          })`,
        );
        return { identifier: issue.identifier, outcome: "config-error" };
      }
      log(`→ ${issue.identifier}: config error — ${params.error}`);
      await bestEffort(`${issue.identifier}: could not post config-error note`, () =>
        tracker.comment(
          issue,
          `❌ task-driver: ${params.error}. Fix the label or add the alias to task-driver.config.json.`,
        ),
      );
      await bestEffort(`${issue.identifier}: could not add the error label`, () =>
        tracker.addLabel(issue, repo.labels.error),
      );
      await bestEffort(`${issue.identifier}: could not park the issue`, () =>
        tracker.transition(issue, "park"),
      );
      return { identifier: issue.identifier, outcome: "config-error" };
    }

    if (dryRun) {
      log(`  [dry] would claim ${issue.identifier} → ${repo.workflow.claim}`);
      log(`  [dry] would branch ${branch} from ${BASE_BRANCH}`);
      log(
        `  [dry] would run pi (session ${sessionId}) with model ${params.model ?? "(default)"}, thinking ${params.thinking}`,
      );
      log(`  [dry] would open PR (${BASE_BRANCH} ← ${branch})`);
      return { identifier: issue.identifier, outcome: "dry" };
    }

    const detail = [
      params.modelAlias ? `model ${params.modelAlias}` : null,
      params.effortAlias ? `effort ${params.effortAlias}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    try {
      await tracker.transition(issue, "claim");
      await tracker.comment(
        issue,
        `🤖 task-driver: implementing ${issue.identifier} on branch \`${branch}\`${detail ? ` (${detail})` : ""}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  ⚠️  ${issue.identifier}: claim failed (${message}) — skipping`);
      return { identifier: issue.identifier, outcome: "skipped" };
    }

    // Persist the resolved model/effort on the issue itself, so the record survives later label removal.
    const paramSummary = [
      `model \`${params.model ?? "pi default"}\`${
        params.modelAlias ? ` (label \`model-${params.modelAlias}\`)` : ""
      }`,
      `effort \`${params.thinking}\`${
        params.effortAlias ? ` (label \`effort-${params.effortAlias}\`)` : " (global default)"
      }`,
    ].join(", ");
    await bestEffort(`${issue.identifier}: could not post run-parameters comment`, () =>
      tracker.comment(issue, `⚙️ task-driver run parameters — ${paramSummary}`),
    );

    log(`→ ${issue.identifier}: ${issue.title} (${branch})`);
    try {
      git.checkout(repo.path, BASE_BRANCH);
      git.createBranch(repo.path, branch);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`  ⚠️  ${issue.identifier}: could not set up branch (${message}) — skipping`);
      return { identifier: issue.identifier, outcome: "skipped" };
    }
    log(`  watch: tail -f ${logPath}`);

    const first = await executor.runAgent({
      repoPath: repo.path,
      sessionId,
      config,
      skillPath,
      message: issuePrompt(issue, branch, planPath, repo),
      workRoot,
      repoName: repo.name,
      model: params.model,
      thinking: params.thinking,
    });
    let v = verify(repo, branch, first);

    if (!v.ok && config.attempts > 1) {
      log(
        `  attempt 1 failed (exit=${first.exitCode}, timedOut=${first.timedOut}, pushed=${v.pushed}, green=${v.gatesResult.green})`,
      );
      const second = await executor.runAgent({
        repoPath: repo.path,
        sessionId,
        config,
        skillPath,
        message: repairPrompt(issue, branch, first, planPath, repo),
        workRoot,
        repoName: repo.name,
        model: params.model,
        thinking: params.thinking,
      });
      v = verify(repo, branch, second);
    }

    const plan = readPlan(workRoot, repo.name, issue.identifier);

    if (plan) {
      try {
        await tracker.comment(issue, formatPlanComment(plan));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`  ⚠️  ${issue.identifier}: could not post plan comment (${message})`);
      }
    } else {
      log(`  ⚠️  ${issue.identifier}: no implementation plan produced — skipping plan comment`);
    }

    if (v.ok) {
      const issueLink = issue.url ? `[${issue.identifier}](${issue.url})` : issue.identifier;
      const body = [
        `## ${repo.provider === "jira" ? "Jira" : "Linear"}`,
        issueLink,
        "",
        "## Plan",
        plan || "(none)",
        "",
        "## Gates",
        gatesSummary(v.gatesResult),
      ].join("\n");
      try {
        const pr = gh.createPR({
          repoPath: repo.path,
          base: BASE_BRANCH,
          head: branch,
          title: issue.title,
          body,
        });
        await tracker.comment(issue, `✅ PR opened: ${pr.url}\n\n${gatesSummary(v.gatesResult)}`);
        log(`  ✅ ${issue.identifier}: PR ${pr.url} (${branch})`);
        await bestEffort(`${issue.identifier}: could not return to ${BASE_BRANCH}`, () =>
          git.checkout(repo.path, BASE_BRANCH),
        );
        return { identifier: issue.identifier, outcome: "pr" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`  ⚠️  ${issue.identifier}: PR create failed: ${message}`);
        await bestEffort(`${issue.identifier}: could not post PR-failure note`, () =>
          tracker.comment(
            issue,
            `⚠️ task-driver: code done and pushed on \`${branch}\`, but PR creation failed: ${message}`,
          ),
        );
        await bestEffort(`${issue.identifier}: could not return to ${BASE_BRANCH}`, () =>
          git.checkout(repo.path, BASE_BRANCH),
        );
        return { identifier: issue.identifier, outcome: "pr-failed" };
      }
    }

    const note = [
      `❌ task-driver could not complete ${issue.identifier} after ${config.attempts} attempt(s).`,
      "",
      "Verification:",
      gatesSummary(v.gatesResult),
      "",
      plan ? `Plan:\n${plan}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    try {
      git.pushBranch(repo.path, branch);
    } catch {
      /* ignore */
    }
    await bestEffort(`${issue.identifier}: could not post failure note`, () =>
      tracker.comment(issue, note),
    );
    await bestEffort(`${issue.identifier}: could not reopen the issue`, () =>
      tracker.transition(issue, "reopen"),
    );
    log(`  ❌ ${issue.identifier}: failed (branch ${branch} pushed, no PR)`);
    await bestEffort(`${issue.identifier}: could not return to ${BASE_BRANCH}`, () =>
      git.checkout(repo.path, BASE_BRANCH),
    );
    return { identifier: issue.identifier, outcome: "failed" };
  }

  /**
   * @param {RepoConfig} repo
   * @param {boolean} dryRun
   */
  async function processRepo(repo, dryRun) {
    if (!dryRun) {
      // Preflight: a dirty tree or a non-master checkout would derail the run.
      if (!git.isClean(repo.path)) {
        log(`⚠️  ${repo.name}: working tree not clean — skipping`);
        return [];
      }
      if (git.currentBranch(repo.path) !== BASE_BRANCH) {
        log(`⚠️  ${repo.name}: not on ${BASE_BRANCH} — skipping`);
        return [];
      }
    }
    const tracker = makeTracker(repo);
    const issues = await tracker.listOpen();
    log(
      `${repo.name} (project ${repo.project ?? repo.jiraProject}): ${issues.length} open task-driver issue(s)`,
    );
    const results = [];
    for (const issue of issues) results.push(await processIssue(repo, tracker, issue, dryRun));
    return results;
  }

  return async function runLoop(dryRun) {
    const all = [];
    for (const repo of config.repos) all.push(...(await processRepo(repo, dryRun)));
    return all;
  };
}
