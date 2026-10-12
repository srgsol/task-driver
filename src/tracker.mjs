/**
 * Provider-neutral tracker: the surface the loop and CLI use so neither ever branches on
 * `repo.provider`. Every operation is pure delegation to the selected provider client, except
 * `transition`, which resolves a logical step (`claim`/`reopen`/`park`) through the repo's workflow
 * map before calling the provider.
 */

/**
 * @typedef {object} WorkflowConfig
 * @property {string | string[]} open Pick state/status (an array means `status in (...)` on Jira).
 * @property {string} claim Claim target.
 * @property {string} [reopen] Return-to-open target; defaults to `open`.
 * @property {string} [park] Optional error target; no move when omitted.
 *
 * @typedef {object} TrackerRepo
 * @property {string} name Repo name, used in error messages.
 * @property {"linear" | "jira"} [provider] Defaults to `"linear"` (already normalized by config).
 * @property {WorkflowConfig} workflow
 *
 * @typedef {object} Issue
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string | null} [description]
 * @property {string} url
 * @property {string[]} [labels]
 *
 * @typedef {object} ProviderClient
 * @property {(repo: TrackerRepo) => Promise<Issue[]>} listOpenIssues
 * @property {(issueId: string, body: string) => Promise<void>} comment
 * @property {(issueId: string, label: string) => Promise<void>} addLabel
 * @property {(identifier: string) => Promise<Issue>} getIssue
 * @property {(input: any) => Promise<Issue>} createIssue
 *
 * @typedef {ProviderClient & {
 *   moveState: (issueId: string, stateName: string) => Promise<void>;
 * }} LinearClient
 *
 *
 * @typedef {ProviderClient & {
 *   transition: (issueId: string, statusName: string) => Promise<void>;
 * }} JiraClient
 *
 *
 * @typedef {object} Tracker
 * @property {() => Promise<Issue[]>} listOpen
 * @property {(issue: Issue, body: string) => Promise<void>} comment
 * @property {(issue: Issue, label: string) => Promise<void>} addLabel
 * @property {(issue: Issue, step: "claim" | "reopen" | "park") => Promise<void>} transition
 * @property {(identifier: string) => Promise<Issue>} getIssue
 * @property {(input: any) => Promise<Issue>} createIssue
 */

/**
 * Resolve a logical transition step to a concrete state/status name. `reopen` falls back to `open`,
 * taking the first element when `open` is an array (Jira status lists).
 *
 * @param {TrackerRepo} repo
 * @param {"claim" | "reopen" | "park"} step
 * @returns {string | undefined} `undefined` when the step has no configured target.
 */
function transitionTarget(repo, step) {
  if (step === "claim") return repo.workflow.claim;
  if (step === "reopen") {
    const value = repo.workflow.reopen ?? repo.workflow.open;
    return Array.isArray(value) ? value[0] : value;
  }
  if (step === "park") return repo.workflow.park;
  throw new Error(`Unknown transition step "${step}" for repo "${repo.name}"`);
}

/**
 * Build the provider-neutral tracker for one repo. `repo.provider` selects the client; the
 * corresponding provider must be supplied, otherwise this throws.
 *
 * @param {TrackerRepo} repo
 * @param {{ linear?: LinearClient; jira?: JiraClient }} providers
 * @returns {Tracker}
 */
export function createTracker(repo, { linear, jira } = {}) {
  const isJira = repo.provider === "jira";
  const client = isJira ? jira : linear;
  if (!client) {
    throw new Error(`No ${isJira ? "jira" : "linear"} client configured for repo "${repo.name}"`);
  }

  return {
    /** @returns {Promise<Issue[]>} */
    listOpen() {
      return client.listOpenIssues(repo);
    },
    /**
     * @param {Issue} issue
     * @param {string} body
     * @returns {Promise<void>}
     */
    comment(issue, body) {
      return client.comment(issue.id, body);
    },
    /**
     * @param {Issue} issue
     * @param {string} label
     * @returns {Promise<void>}
     */
    addLabel(issue, label) {
      return client.addLabel(issue.id, label);
    },
    /**
     * Move `issue` through a logical workflow step. A step whose resolved target is unset is a
     * no-op (notably `park` on a Jira repo that omits it).
     *
     * @param {Issue} issue
     * @param {"claim" | "reopen" | "park"} step
     * @returns {Promise<void>}
     */
    async transition(issue, step) {
      const target = transitionTarget(repo, step);
      if (!target) return;
      if (isJira) {
        await /** @type {JiraClient} */ (client).transition(issue.id, target);
        return;
      }
      await /** @type {LinearClient} */ (client).moveState(issue.id, target);
    },
    /**
     * @param {string} identifier
     * @returns {Promise<Issue>}
     */
    getIssue(identifier) {
      return client.getIssue(identifier);
    },
    /**
     * @param {any} input Provider-shaped create input (Linear uses ids, Jira uses project keys).
     * @returns {Promise<Issue>}
     */
    createIssue(input) {
      return client.createIssue(input);
    },
  };
}
