import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Config loading and validation for `task-driver.config.json`. */

/** Accepted `pi --thinking` levels for `config.efforts`. */
export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Defaults applied when the config file omits top-level tunables. */
export const DEFAULTS = {
  attempts: 2,
  timeoutMs: 900000,
  gateTimeoutMs: 300000,
  thinking: "medium",
};

/**
 * Linear workflow defaults; they preserve today's behavior for existing configs. `reopen` defaults
 * to the configured `open` state, not to a separate constant.
 */
const LINEAR_WORKFLOW = { open: "Todo", claim: "In Progress", park: "Backlog" };

/** Label defaults applied to every repo unless the config overrides them. */
const LABEL_DEFAULTS = { pick: "task-driver", error: "ai:error" };

/**
 * @typedef {{ name: string; cmd: string; args: string[] }} GateConfig
 *
 * @typedef {{
 *   open: string | string[];
 *   claim: string;
 *   reopen?: string;
 *   park?: string;
 * }} WorkflowConfig
 *
 *
 * @typedef {{ pick: string; error: string }} LabelConfig
 *
 * @typedef {{
 *   name: string;
 *   path: string;
 *   provider: "linear" | "jira";
 *   team: string;
 *   project: string;
 *   jiraProject?: string;
 *   jiraIssueType?: string;
 *   jiraBlockingLinkTypes?: string[];
 *   remote: string;
 *   gates: GateConfig[];
 *   workflow: WorkflowConfig;
 *   labels: LabelConfig;
 * }} RepoConfig
 *
 *
 * @typedef {{
 *   repos: RepoConfig[];
 *   jiraBaseUrl?: string;
 *   attempts: number;
 *   timeoutMs: number;
 *   gateTimeoutMs: number;
 *   thinking: string;
 *   models: Record<string, string>;
 *   efforts: Record<string, string>;
 * }} Config
 */

/**
 * Validate and normalize the raw parsed config JSON.
 *
 * @param {any} raw
 * @returns {Config}
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error("config.repos must be a non-empty array");
  }
  /** @type {RepoConfig[]} */
  const repos = raw.repos.map((/** @type {RepoConfig} */ r, /** @type {number} */ i) => {
    const provider = r.provider ?? "linear";
    if (provider !== "linear" && provider !== "jira") {
      throw new Error(`config.repos[${i}].provider must be 'linear' or 'jira'`);
    }
    // `team` and `project` are used only by the Linear provider; Jira repos omit them.
    if (provider === "linear") {
      if (!r.name || !r.path || !r.team || !r.project || !r.remote) {
        throw new Error(`config.repos[${i}] must define name, path, team, project, remote`);
      }
    } else if (!r.name || !r.path || !r.remote) {
      throw new Error(`config.repos[${i}] must define name, path, remote`);
    }
    if (r.gates !== undefined && !Array.isArray(r.gates)) {
      throw new Error(`config.repos[${i}].gates must be an array`);
    }
    if (provider === "jira") {
      if (typeof r.jiraProject !== "string" || r.jiraProject.trim() === "") {
        throw new Error(`config.repos[${i}] requires jiraProject when provider is jira`);
      }
    }
    if (r.jiraBlockingLinkTypes !== undefined) {
      const linkTypes = r.jiraBlockingLinkTypes;
      if (
        !Array.isArray(linkTypes) ||
        linkTypes.length === 0 ||
        linkTypes.some((t) => typeof t !== "string" || t.trim() === "")
      ) {
        throw new Error(
          `config.repos[${i}].jiraBlockingLinkTypes must be a non-empty array of strings`,
        );
      }
    }
    const workflow = /** @type {Partial<WorkflowConfig>} */ (r.workflow ?? {});
    /** @type {WorkflowConfig} */
    let normalizedWorkflow;
    if (provider === "linear") {
      const open = workflow.open ?? LINEAR_WORKFLOW.open;
      if (typeof open !== "string" || open.trim() === "") {
        throw new Error(`config.repos[${i}].workflow.open must be a non-empty string`);
      }
      const claim = workflow.claim ?? LINEAR_WORKFLOW.claim;
      if (typeof claim !== "string" || claim.trim() === "") {
        throw new Error(`config.repos[${i}].workflow.claim must be a non-empty string`);
      }
      normalizedWorkflow = {
        open,
        claim,
        reopen: workflow.reopen ?? open,
        park: workflow.park ?? LINEAR_WORKFLOW.park,
      };
    } else {
      const open = workflow.open;
      if (typeof open === "string") {
        if (open.trim() === "") {
          throw new Error(
            `config.repos[${i}].workflow.open must be a non-empty string or array of strings`,
          );
        }
      } else if (
        !Array.isArray(open) ||
        open.length === 0 ||
        open.some((s) => typeof s !== "string" || s.trim() === "")
      ) {
        throw new Error(
          `config.repos[${i}].workflow.open must be a non-empty string or array of strings`,
        );
      }
      const claim = workflow.claim;
      if (typeof claim !== "string" || claim.trim() === "") {
        throw new Error(`config.repos[${i}].workflow.claim must be a non-empty string`);
      }
      normalizedWorkflow = { open, claim };
      if (workflow.reopen !== undefined) normalizedWorkflow.reopen = workflow.reopen;
      if (workflow.park !== undefined) normalizedWorkflow.park = workflow.park;
    }
    const labels = /** @type {LabelConfig} */ ({ ...LABEL_DEFAULTS, ...(r.labels ?? {}) });
    if (typeof labels.pick !== "string" || labels.pick.trim() === "") {
      throw new Error(`config.repos[${i}].labels.pick must be a non-empty string`);
    }
    if (typeof labels.error !== "string" || labels.error.trim() === "") {
      throw new Error(`config.repos[${i}].labels.error must be a non-empty string`);
    }
    return /** @type {RepoConfig} */ ({
      name: r.name,
      path: r.path,
      provider,
      ...(provider === "linear" ? { team: r.team, project: r.project } : {}),
      ...(provider === "jira" ? { jiraProject: r.jiraProject } : {}),
      ...(r.jiraIssueType !== undefined ? { jiraIssueType: r.jiraIssueType } : {}),
      ...(r.jiraBlockingLinkTypes !== undefined
        ? { jiraBlockingLinkTypes: r.jiraBlockingLinkTypes }
        : {}),
      remote: r.remote,
      gates: r.gates ?? [],
      workflow: normalizedWorkflow,
      labels,
    });
  });
  const attempts = raw.attempts ?? DEFAULTS.attempts;
  const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs;
  const gateTimeoutMs = raw.gateTimeoutMs ?? DEFAULTS.gateTimeoutMs;
  const thinking = raw.thinking ?? DEFAULTS.thinking;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error("config.attempts must be an integer >= 1");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("config.timeoutMs must be an integer >= 1");
  if (!Number.isInteger(gateTimeoutMs) || gateTimeoutMs < 1)
    throw new Error("config.gateTimeoutMs must be an integer >= 1");
  const models = raw.models ?? {};
  if (typeof models !== "object" || models === null || Array.isArray(models)) {
    throw new Error("config.models must be an object");
  }
  for (const [alias, id] of Object.entries(models)) {
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`config.models.${alias} must be a non-empty string`);
    }
  }
  const efforts = raw.efforts ?? {};
  if (typeof efforts !== "object" || efforts === null || Array.isArray(efforts)) {
    throw new Error("config.efforts must be an object");
  }
  for (const [alias, level] of Object.entries(efforts)) {
    if (typeof level !== "string" || !EFFORT_LEVELS.includes(level)) {
      throw new Error(`config.efforts.${alias} must be one of ${EFFORT_LEVELS.join("|")}`);
    }
  }
  const jiraBaseUrl = raw.jiraBaseUrl;
  if (
    repos.some((r) => r.provider === "jira") &&
    (typeof jiraBaseUrl !== "string" || jiraBaseUrl.trim() === "")
  ) {
    throw new Error("config.jiraBaseUrl is required when any repo uses provider jira");
  }
  if (
    jiraBaseUrl !== undefined &&
    (typeof jiraBaseUrl !== "string" || !/^https?:\/\//.test(jiraBaseUrl))
  ) {
    throw new Error("config.jiraBaseUrl must be a valid http(s) URL");
  }
  return {
    repos,
    ...(jiraBaseUrl !== undefined ? { jiraBaseUrl } : {}),
    attempts,
    timeoutMs,
    gateTimeoutMs,
    thinking,
    models,
    efforts,
  };
}

/**
 * Read, validate, and resolve a config file from disk.
 *
 * @param {string} path
 * @returns {Config}
 */
export function loadConfig(path) {
  const config = validateConfig(JSON.parse(readFileSync(path, "utf8")));
  const base = dirname(path);
  return { ...config, repos: config.repos.map((r) => ({ ...r, path: resolve(base, r.path) })) };
}
