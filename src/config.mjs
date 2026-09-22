import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULTS = { attempts: 2, timeoutMs: 900000, thinking: "medium" };
export const DEFAULT_GATES = [
  { name: "test", cmd: "npm", args: ["test"] },
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
];

export function validateConfig(raw) {
  if (!raw || typeof raw !== "object") throw new Error("config must be an object");
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error("config.repos must be a non-empty array");
  }
  const repos = raw.repos.map((r, i) => {
    if (!r.name || !r.path || !r.team || !r.project || !r.remote) {
      throw new Error(`config.repos[${i}] must define name, path, team, project, remote`);
    }
    const gates = r.gates ?? DEFAULT_GATES;
    if (!Array.isArray(gates) || gates.length === 0) {
      throw new Error(`config.repos[${i}].gates must be a non-empty array`);
    }
    return { name: r.name, path: r.path, team: r.team, project: r.project, remote: r.remote, gates };
  });
  const attempts = raw.attempts ?? DEFAULTS.attempts;
  const timeoutMs = raw.timeoutMs ?? DEFAULTS.timeoutMs;
  const thinking = raw.thinking ?? DEFAULTS.thinking;
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("config.attempts must be an integer >= 1");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("config.timeoutMs must be an integer >= 1");
  return { repos, attempts, timeoutMs, thinking };
}

export function loadConfig(path) {
  const config = validateConfig(JSON.parse(readFileSync(path, "utf8")));
  const base = dirname(path);
  return { ...config, repos: config.repos.map((r) => ({ ...r, path: resolve(base, r.path) })) };
}
