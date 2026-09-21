export function createGit(runSync) {
  const git = (repoPath, args) => runSync("git", args, { cwd: repoPath });
  return {
    isClean(repoPath) {
      return git(repoPath, ["status", "--porcelain"]).stdout.trim() === "";
    },
    currentBranch(repoPath) {
      return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    },
    checkout(repoPath, ref) {
      const r = git(repoPath, ["checkout", ref]);
      if (r.status !== 0) throw new Error(`git checkout ${ref} failed: ${r.stderr}`);
    },
    createBranch(repoPath, branch) {
      const created = git(repoPath, ["checkout", "-b", branch]);
      if (created.status === 0) return;
      // The branch may already exist (e.g. a re-run after PR creation failed).
      // Reuse it rather than aborting the run.
      const reused = git(repoPath, ["checkout", branch]);
      if (reused.status !== 0) {
        throw new Error(`git checkout ${branch} failed: ${(created.stderr || reused.stderr).trim()}`);
      }
    },
    branchPushed(repoPath, branch) {
      const r = git(repoPath, ["ls-remote", "--heads", "origin", branch]);
      return r.status === 0 && r.stdout.trim() !== "";
    },
    pushBranch(repoPath, branch) {
      return git(repoPath, ["push", "-u", "origin", branch]).status === 0;
    },
  };
}
