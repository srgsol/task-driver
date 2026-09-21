import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export function createExecutor(runAsync) {
  function childEnv() {
    const env = { ...process.env };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    delete env.LINEAR_API_KEY;
    return env;
  }

  return {
    async runAgent({ repoPath, sessionId, config, skillPath, message }) {
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
      //   tail -f handoff/logs/<sessionId>.jsonl
      let logPath;
      try {
        const logDir = join(repoPath, "handoff", "logs");
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

export function readPlan(repoPath, identifier) {
  const p = join(repoPath, "handoff", "plans", `${identifier}.md`);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}
