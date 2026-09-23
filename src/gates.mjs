/**
 * Gate running: executes each repo's configured verification commands and
 * reports whether every gate passed.
 */

/**
 * @typedef {{ name: string, cmd: string, args: string[] }} GateConfig
 * @typedef {{ name: string, passed: boolean, output: string }} GateResult
 * @typedef {{ green: boolean, results: GateResult[] }} GatesRun
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string, env?: NodeJS.ProcessEnv, input?: string }) => { status: number, stdout: string, stderr: string }} RunSync
 */

/**
 * Build a gate runner bound to a `runSync` implementation.
 * @param {RunSync} runSync
 * @returns {{ runGates(repo: { path: string, gates: GateConfig[] }): GatesRun }}
 */
export function createGates(runSync) {
  return {
    runGates(repo) {
      const results = repo.gates.map((g) => {
        const r = runSync(g.cmd, g.args, { cwd: repo.path });
        return { name: g.name, passed: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
      });
      return { green: results.every((r) => r.passed), results };
    },
  };
}
