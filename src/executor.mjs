import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent execution: runs the headless `pi` process for one issue and reads the
 * implementation plan it wrote back to disk.
 */

/**
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, onChunk?: (stream: "stdout" | "stderr", text: string) => void }) => Promise<{ exitCode: number | null, timedOut: boolean, stdout: string, stderr: string }>} RunAsync
 * @typedef {object} RunAgentOptions
 * @property {string} repoPath
 * @property {string} sessionId
 * @property {{ thinking: string, timeoutMs: number }} config
 * @property {string} skillPath
 * @property {string} message
 * @property {string} workRoot
 * @property {string} repoName
 */

/**
 * Build an agent runner bound to a `runAsync` implementation.
 * @param {RunAsync} runAsync
 * @returns {{ runAgent(opts: RunAgentOptions): Promise<{ exitCode: number | null, timedOut: boolean, stdout: string, stderr: string }> }}
 */
export function createExecutor(runAsync) {
  function childEnv() {
    // The pi agent must not inherit task-driver's Linear/GitHub credentials;
    // it should only touch the target repo, never Linear or the GitHub API.
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.LINEAR_API_KEY;
    return env;
  }

  return {
    /**
     * Run one headless `pi` agent invocation for an issue.
     * @param {RunAgentOptions} opts
     * @returns {Promise<{ exitCode: number | null, timedOut: boolean, stdout: string, stderr: string }>}
     */
    async runAgent({ repoPath, sessionId, config, skillPath, message, workRoot, repoName }) {
      const args = [
        "--print", "--mode", "json",
        "--session-id", sessionId,
        "--approve",
        "--no-extensions",
        "--skill", skillPath,
        "--thinking", config.thinking,
        "--", message,
      ];

      // Persist the streamed transcript so a run can be watched live:
      //   tail -f work/<repo>/logs/<sessionId>.jsonl
      let logPath;
      try {
        const logDir = join(workRoot, repoName, "logs");
        mkdirSync(logDir, { recursive: true });
        logPath = join(logDir, `${sessionId}.jsonl`);
        appendFileSync(logPath, `\n===== ${new Date().toISOString()} =====\n`);
      } catch { logPath = undefined; }
      const onChunk = logPath
        ? (_stream, text) => { try { appendFileSync(logPath, text); } catch { /* ignore */ } }
        : undefined;

      return runAsync("pi", args, { cwd: repoPath, env: childEnv(), timeoutMs: config.timeoutMs, onChunk });
    },
  };
}

/**
 * Read the implementation plan an agent produced for an issue, if any.
 * @param {string} workRoot
 * @param {string} repoName
 * @param {string} identifier
 * @returns {string | null}
 */
export function readPlan(workRoot, repoName, identifier) {
  const p = join(workRoot, repoName, "plans", `${identifier}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
