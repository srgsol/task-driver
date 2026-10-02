import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Config loading and validation for `task-driver.config.json`. */

/** Defaults applied when the config file omits top-level tunables. */
export const DEFAULTS = { attempts: 2, timeoutMs: 900000, thinking: "medium" };

/**
 * @typedef {{ name: string; cmd: string; args: string[] }} GateConfig
 *
 * @typedef {{
 *   name: string;
 *   path: string;
 *   team: string;
 *   project: string;
 *   remote: string;
 *   gates: GateConfig[];
 * }} RepoConfig
 *
 * @typedef {{ repos: RepoConfig[]; attempts: number; timeoutMs: number; thinking: string }} Config
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
  const repos = raw.repos.map((/** @type {RepoConfig} */ r, /** @type {number} */ i) => {
    if (!r.name || !r.path || !r.team || !r.project || !r.remote) {
      throw new Error(`config.repos[${i}] must define name, path, team, project, remote`);
    }
    if (r.gates !== undefined && !Array.isArray(r.gates)) {
      throw new Error(`config.repos[${i}].gates must be an array`);
    }
    return {
      name: r.name,
      path: r.path,
      team: r.team,
      project: r.project,
      remote: r.remote,
      gates: r.gates ?? [],
    };
  });
  const attempts = raw.attempts ?? DEFAULTS.attempts;
  const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs;
  const thinking = raw.thinking ?? DEFAULTS.thinking;
  if (!Number.isInteger(attempts) || attempts < 1)
    throw new Error("config.attempts must be an integer >= 1");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("config.timeoutMs must be an integer >= 1");
  return { repos, attempts, timeoutMs, thinking };
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
