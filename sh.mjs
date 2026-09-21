import { spawn, spawnSync } from "node:child_process";

export function runSync(cmd, args, { cwd, env, input } = {}) {
  const res = spawnSync(cmd, args, { cwd, env: env ?? process.env, input, encoding: "utf8" });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

export function runAsync(cmd, args, { cwd, env, timeoutMs, onChunk } = {}) {
  return new Promise((resolve) => {
    // stdin MUST be closed ("ignore" -> /dev/null): pi treats an open, non-TTY
    // stdin as piped input and waits forever for EOF that never arrives.
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer;
    child.stdout.on("data", (d) => { stdout += d; if (onChunk) onChunk("stdout", String(d)); });
    child.stderr.on("data", (d) => { stderr += d; if (onChunk) onChunk("stderr", String(d)); });
    if (timeoutMs) {
      timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    }
    const done = (res) => { if (timer) clearTimeout(timer); resolve(res); };
    child.on("close", (code) => done({ exitCode: code, timedOut, stdout, stderr }));
    child.on("error", (err) => done({ exitCode: null, timedOut, stdout, stderr: `${stderr}${err}` }));
  });
}
