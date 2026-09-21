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
