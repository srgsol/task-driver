/**
 * Loading of the project's `.env` file into the process environment.
 *
 * Credentials (`LINEAR_API_KEY`, `JIRA_EMAIL`, `JIRA_API_TOKEN`) live in a git-ignored `.env` at
 * the project root so every entry point picks them up.
 */

/**
 * Load a `.env` file into `process.env`.
 *
 * Values already present in the environment win over the file (the same rule Node's `--env-file`
 * follows). A missing file is a silent no-op, so projects without a `.env` keep working; any other
 * read failure is reported through `warn` and swallowed, so a broken `.env` cannot abort a run.
 *
 * @param {string} path
 * @param {(message: string) => void} [warn]
 * @returns {boolean} `true` when the file was loaded.
 */
export function loadDotEnv(path, warn = (message) => console.warn(message)) {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === "ENOENT") return false;
    const message = err instanceof Error ? err.message : String(err);
    warn(`task-driver: could not load ${path} (${message})`);
    return false;
  }
}
