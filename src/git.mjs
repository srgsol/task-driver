/**
 * Git helpers: thin wrappers over `git` used by the processing loop to manage branches, verify
 * pushes, and check the working tree.
 */

/**
 * @typedef {(
 *   cmd: string,
 *   args: string[],
 *   opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
 * ) => { status: number; stdout: string; stderr: string }} RunSync
 *
 *
 * @typedef {object} Git
 * @property {(repoPath: string) => boolean} isClean
 * @property {(repoPath: string) => string} currentBranch
 * @property {(repoPath: string, ref: string) => void} checkout
 * @property {(repoPath: string, branch: string) => void} createBranch
 * @property {(repoPath: string, branch: string) => boolean} branchPushed
 * @property {(repoPath: string, branch: string) => boolean} pushBranch
 */

/**
 * Build a git command runner bound to a `runSync` implementation.
 *
 * @param {RunSync} runSync
 * @returns {Git}
 */
export function createGit(runSync) {
  /**
   * @type {(
   *   repoPath: string,
   *   args: string[],
   * ) => { status: number; stdout: string; stderr: string }}
   */
  const git = (repoPath, args) => runSync("git", args, { cwd: repoPath });
  return {
    /**
     * @param {string} repoPath
     * @returns {boolean}
     */
    isClean(repoPath) {
      return git(repoPath, ["status", "--porcelain"]).stdout.trim() === "";
    },
    /**
     * @param {string} repoPath
     * @returns {string}
     */
    currentBranch(repoPath) {
      return git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    },
    /**
     * @param {string} repoPath
     * @param {string} ref
     * @returns {void}
     */
    checkout(repoPath, ref) {
      const r = git(repoPath, ["checkout", ref]);
      if (r.status !== 0) throw new Error(`git checkout ${ref} failed: ${r.stderr}`);
    },
    /**
     * Create the given branch, reusing it if it already exists.
     *
     * @param {string} repoPath
     * @param {string} branch
     * @returns {void}
     */
    createBranch(repoPath, branch) {
      const created = git(repoPath, ["checkout", "-b", branch]);
      if (created.status === 0) return;
      // The branch may already exist (e.g. a re-run after PR creation failed).
      // Reuse it rather than aborting the run.
      const reused = git(repoPath, ["checkout", branch]);
      if (reused.status !== 0) {
        throw new Error(
          `git checkout ${branch} failed: ${(created.stderr || reused.stderr).trim()}`,
        );
      }
    },
    /**
     * @param {string} repoPath
     * @param {string} branch
     * @returns {boolean}
     */
    branchPushed(repoPath, branch) {
      const r = git(repoPath, ["ls-remote", "--heads", "origin", branch]);
      return r.status === 0 && r.stdout.trim() !== "";
    },
    /**
     * @param {string} repoPath
     * @param {string} branch
     * @returns {boolean}
     */
    pushBranch(repoPath, branch) {
      return git(repoPath, ["push", "-u", "origin", branch]).status === 0;
    },
  };
}
