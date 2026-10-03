import { spawn, spawnSync } from "node:child_process";

/**
 * Child-process helpers. `runSync` is used for quick verification commands (gates, git, gh);
 * `runAsync` is used for the long-running, streaming `pi` agent process.
 */

/**
 * @typedef {{ status: number; stdout: string; stderr: string; timedOut: boolean }} SyncRunResult
 *
 * @typedef {{
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   input?: string;
 *   timeoutMs?: number;
 * }} SyncRunOptions
 *
 *
 * @typedef {{
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   timeoutMs?: number;
 *   onChunk?: (stream: "stdout" | "stderr", text: string) => void;
 * }} AsyncRunOptions
 *
 *
 * @typedef {{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }} AsyncRunResult
 */

/**
 * Run a command synchronously and capture its status and output.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {SyncRunOptions} [opts]
 * @returns {SyncRunResult}
 */
export function runSync(cmd, args, { cwd, env, input, timeoutMs } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    input,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  // `spawnSync` kills the child and sets `error.code = "ETIMEDOUT"` when the
  // timeout elapses, leaving `status` null. Surface that explicitly so callers
  // (gates) can report *why* a command failed instead of a bare exit code.
  const spawnErr = /** @type {NodeJS.ErrnoException | undefined} */ (res.error);
  const timedOut = spawnErr?.code === "ETIMEDOUT";
  const errMsg = res.error ? (timedOut ? `timed out after ${timeoutMs}ms` : res.error.message) : "";
  const stderr = [res.stderr ?? "", errMsg].filter(Boolean).join("\n");
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr, timedOut };
}

/**
 * Run a command asynchronously, streaming stdout/stderr and enforcing a timeout.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {AsyncRunOptions} [opts]
 * @returns {Promise<AsyncRunResult>}
 */
export function runAsync(cmd, args, { cwd, env, timeoutMs, onChunk } = {}) {
  return new Promise((resolve) => {
    // stdin MUST be closed ("ignore" -> /dev/null): pi treats an open, non-TTY
    // stdin as piped input and waits forever for EOF that never arrives.
    // `detached: true` makes the child a process-group leader on POSIX so the
    // timeout below can signal the whole group (pi's grandchildren included).
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    child.stdout.on("data", (d) => {
      stdout += d;
      if (onChunk) onChunk("stdout", String(d));
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (onChunk) onChunk("stderr", String(d));
    });
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        const pid = child.pid;
        if (pid !== undefined) {
          try {
            // Negative pid targets the whole process group, so pi's
            // grandchildren (npm, git, tsc, the agent work) die too rather
            // than being orphaned and running on after the timeout.
            process.kill(-pid, "SIGKILL");
            return;
          } catch {
            // The group may already be gone; fall back to the direct child.
          }
        }
        child.kill("SIGKILL");
      }, timeoutMs);
    }
    const done = (/** @type {AsyncRunResult} */ res) => {
      if (timer) clearTimeout(timer);
      resolve(res);
    };
    child.on("close", (code) => done({ exitCode: code, timedOut, stdout, stderr }));
    child.on("error", (err) =>
      done({ exitCode: null, timedOut, stdout, stderr: `${stderr}${err}` }),
    );
  });
}
