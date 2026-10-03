/**
 * Gate running: executes each repo's configured verification commands and reports whether every
 * gate passed.
 */

/**
 * @typedef {{ name: string; cmd: string; args: string[] }} GateConfig
 *
 * @typedef {{ name: string; passed: boolean; output: string; timedOut: boolean }} GateResult
 *
 * @typedef {{ green: boolean; results: GateResult[] }} GatesRun
 *
 * @typedef {(
 *   cmd: string,
 *   args: string[],
 *   opts?: {
 *     cwd?: string;
 *     env?: NodeJS.ProcessEnv;
 *     input?: string;
 *     timeoutMs?: number;
 *   },
 * ) => { status: number; stdout: string; stderr: string; timedOut?: boolean }} RunSync
 */

/**
 * Sensible per-gate wall-clock cap (5 min) so a hung gate cannot block the controller forever.
 * Override per run via `createGates(runSync, { timeoutMs })`.
 */
export const DEFAULT_GATE_TIMEOUT_MS = 300000;

/**
 * Build a gate runner bound to a `runSync` implementation.
 *
 * @param {RunSync} runSync
 * @param {{ timeoutMs?: number }} [options]
 * @returns {{ runGates(repo: { path: string; gates: GateConfig[] }): GatesRun }}
 */
export function createGates(runSync, { timeoutMs = DEFAULT_GATE_TIMEOUT_MS } = {}) {
  return {
    runGates(repo) {
      const results = repo.gates.map((g) => {
        const r = runSync(g.cmd, g.args, { cwd: repo.path, timeoutMs });
        return {
          name: g.name,
          passed: r.status === 0,
          output: `${r.stdout}${r.stderr}`.trim(),
          timedOut: r.timedOut ?? false,
        };
      });
      return { green: results.every((r) => r.passed), results };
    },
  };
}
