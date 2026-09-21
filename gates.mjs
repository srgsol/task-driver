const GATES = [
  { name: "test", cmd: "npm", args: ["test"] },
  { name: "tsc", cmd: "npx", args: ["tsc", "--noEmit"] },
  { name: "lint", cmd: "npm", args: ["run", "lint"] },
];

export function createGates(runSync) {
  return {
    runGates(repoPath) {
      const results = GATES.map((g) => {
        const r = runSync(g.cmd, g.args, { cwd: repoPath });
        return { name: g.name, passed: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
      });
      return { green: results.every((r) => r.passed), results };
    },
  };
}
