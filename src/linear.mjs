/**
 * Minimal Linear GraphQL client covering the operations task-driver needs: list open issues, fetch
 * one issue, comment, move state, update description.
 */
const API_URL = "https://api.linear.app/graphql";

/** Retry/backoff defaults for transient Linear API failures. */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

/**
 * Failure worth retrying (network error, 429, or 5xx). Retried by `gql`; when attempts are
 * exhausted it propagates like any other error.
 */
class RetryableLinearError extends Error {}

/**
 * @typedef {object} LinearRetryOptions
 * @property {number} [attempts] Maximum attempts including the first (default 3).
 * @property {number} [baseDelayMs] First backoff delay in ms; doubles each retry (default 250).
 * @property {(ms: number) => Promise<void>} [sleep] Delay implementation, injectable for tests.
 */

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * HTTP statuses safe to retry: rate limiting and server errors.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

const RESOLVED_STATES = new Set(["Done", "Canceled"]);

/**
 * @typedef {object} LinearIssue
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string | null} description
 * @property {string} url
 * @property {{ nodes?: { type: string; relatedIssue?: { state?: { name?: string } } }[] }} [relations]
 * @property {{ nodes?: { type: string; issue?: { state?: { name?: string } } }[] }} [inverseRelations]
 * @property {string[]} [labels]
 * @property {LinearComment[]} [comments]
 */

/**
 * @typedef {object} LinearComment
 * @property {string} body
 * @property {string | null} createdAt
 * @property {{ name: string | null } | null} user
 */

/**
 * Normalize Linear's comment connection into the flat list the loop consumes.
 *
 * @param {any} issue
 * @returns {LinearComment[]}
 */
function mapComments(issue) {
  return (issue.comments?.nodes ?? []).map((/** @type {any} */ comment) => ({
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? null,
    user: comment.user ? { name: comment.user.name ?? null } : null,
  }));
}

/**
 * True when `issue` is blocked by an issue that has not reached a terminal state.
 *
 * Linear stores a `blocks` relation on the blocker and exposes it as an `inverseRelations` entry on
 * the blocked issue (the relation's `issue` is the blocker and its `type` is `blocks`).
 *
 * @param {any} issue
 * @returns {boolean}
 */
function hasUnresolvedBlocker(issue) {
  return (issue.inverseRelations?.nodes ?? []).some(
    (/** @type {{ type: string; issue?: { state?: { name?: string } } }} */ relation) =>
      relation.type === "blocks" && !RESOLVED_STATES.has(relation.issue?.state?.name ?? ""),
  );
}

/**
 * @typedef {object} LinearRepo
 * @property {string} team Linear team key, e.g. `SER`.
 * @property {string} project Linear project name.
 * @property {{ open: string | string[] }} workflow Workflow states; Linear uses `open` as the pick
 *   state.
 * @property {{ pick: string; error: string }} labels Pick and re-pick guard labels.
 *
 * @typedef {object} LinearClient
 * @property {(repo: LinearRepo) => Promise<LinearIssue[]>} listOpenIssues
 * @property {(identifier: string) => Promise<LinearIssue>} getIssue
 * @property {(input: {
 *   teamId: string;
 *   projectId: string;
 *   title: string;
 *   description?: string;
 * }) => Promise<LinearIssue>} createIssue
 * @property {(issueId: string, body: string) => Promise<void>} comment
 * @property {(issueId: string, stateName: string) => Promise<void>} moveState
 * @property {(issueId: string, labelName: string) => Promise<void>} addLabel
 */

/**
 * Resolve the Linear API key from `LINEAR_API_KEY`.
 *
 * @returns {string | undefined}
 */
export function getLinearApiKey() {
  return process.env.LINEAR_API_KEY?.trim() || undefined;
}

/**
 * Build a minimal Linear GraphQL client.
 *
 * @param {string} apiKey
 * @param {typeof fetch} [fetchImpl]
 * @param {LinearRetryOptions} [retry]
 * @returns {LinearClient}
 */
export function createLinearClient(apiKey, fetchImpl = fetch, retry = {}) {
  const attempts = Math.max(1, retry.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep =
    retry.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));

  /**
   * Perform a single GraphQL request. Throws `RetryableLinearError` for transient failures and a
   * plain `Error` otherwise (preserving the original message formats).
   *
   * @param {string} query
   * @param {Record<string, any>} variables
   * @returns {Promise<any>}
   */
  async function request(query, variables) {
    let res;
    try {
      res = await fetchImpl(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      throw new RetryableLinearError(`Linear API request failed: ${errorMessage(err)}`);
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw new RetryableLinearError(`Linear API request failed: ${errorMessage(err)}`);
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      const message = `Linear API returned non-JSON (HTTP ${res.status})`;
      if (isRetryableStatus(res.status)) throw new RetryableLinearError(message);
      throw new Error(message);
    }
    if (res.status !== 200 || json.errors?.length) {
      const msgs = (json.errors ?? [])
        .map((/** @type {{ message: string }} */ e) => e.message)
        .join("; ");
      const message = `Linear API error (HTTP ${res.status}): ${msgs || "unknown"}`;
      if (isRetryableStatus(res.status)) throw new RetryableLinearError(message);
      throw new Error(message);
    }
    return json.data;
  }

  /**
   * Execute one GraphQL request, retrying transient failures with exponential backoff.
   *
   * @param {string} query
   * @param {Record<string, any>} variables
   * @returns {Promise<any>}
   */
  async function gql(query, variables) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(query, variables);
      } catch (err) {
        if (attempt >= attempts || !(err instanceof RetryableLinearError)) throw err;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Find issue labels by their exact leaf name.
   *
   * @param {string} name
   * @returns {Promise<any[]>}
   */
  async function findLabelsByName(name) {
    const data = await gql(
      `query($filter: IssueLabelFilter) {
        issueLabels(filter: $filter, first: 50) {
          nodes { id name isGroup parent { id name } }
        }
      }`,
      { filter: { name: { eq: name } } },
    );
    return data.issueLabels?.nodes ?? [];
  }

  /**
   * Resolve a label id by leaf name under an optional group, creating the group and/or leaf when
   * they do not exist yet.
   *
   * @param {string | null} group
   * @param {string} leaf
   * @returns {Promise<string>}
   */
  async function resolveOrCreateLabel(group, leaf) {
    const candidates = await findLabelsByName(leaf);
    const existing = candidates.find(
      (/** @type {{ parent?: { name?: string } | null }} */ n) =>
        (n.parent?.name ?? null) === group,
    );
    if (existing) return existing.id;

    /** @type {string | undefined} */
    let parentId;
    if (group) {
      const groups = (await findLabelsByName(group)).filter(
        (/** @type {{ isGroup?: boolean }} */ n) => n.isGroup,
      );
      parentId = groups[0]?.id;
      if (!parentId) {
        const createdGroup = await gql(
          `mutation($input: IssueLabelCreateInput!) {
            issueLabelCreate(input: $input) { success issueLabel { id } }
          }`,
          { input: { name: group, isGroup: true } },
        );
        if (!createdGroup.issueLabelCreate?.success) {
          throw new Error(`Failed to create label group "${group}"`);
        }
        parentId = createdGroup.issueLabelCreate.issueLabel.id;
      }
    }

    const created = await gql(
      `mutation($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) { success issueLabel { id } }
      }`,
      { input: parentId ? { name: leaf, parentId } : { name: leaf } },
    );
    if (!created.issueLabelCreate?.success) {
      throw new Error(`Failed to create label "${leaf}"`);
    }
    return created.issueLabelCreate.issueLabel.id;
  }

  return {
    /**
     * Pickable issues: open workflow state + pick label, minus error-labeled and blocked issues.
     *
     * @param {LinearRepo} repo
     * @returns {Promise<LinearIssue[]>}
     */
    async listOpenIssues(repo) {
      const filter = {
        team: { key: { eq: repo.team } },
        project: { name: { eq: repo.project } },
        state: { name: { eq: repo.workflow.open } },
        labels: { name: { eq: repo.labels.pick } },
      };

      /** @type {any[]} */
      const nodes = [];
      /** @type {string | undefined} */
      let after;
      for (;;) {
        const data = await gql(
          `query($filter: IssueFilter, $after: String) {
            issues(filter: $filter, first: 100, after: $after) {
              nodes {
                id identifier title description url
                relations { nodes { type relatedIssue { state { name } } } }
                inverseRelations { nodes { type issue { state { name } } } }
                labels { nodes { name parent { name } } }
                comments { nodes { body createdAt user { name } } }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { filter, after },
        );
        const page = data.issues ?? {};
        nodes.push(...(page.nodes ?? []));
        if (!page.pageInfo?.hasNextPage) break;
        if (!page.pageInfo.endCursor) {
          throw new Error("Linear returned hasNextPage without an endCursor");
        }
        after = page.pageInfo.endCursor;
      }

      return nodes
        .filter((/** @type {any} */ issue) => !hasUnresolvedBlocker(issue))
        .map((/** @type {any} */ issue) => ({
          ...issue,
          labels: (issue.labels?.nodes ?? []).map(
            (/** @type {{ name: string; parent?: { name?: string } | null }} */ n) =>
              n.parent ? `${n.parent.name}:${n.name}` : n.name,
          ),
          comments: mapComments(issue),
        }))
        .filter(
          (/** @type {LinearIssue} */ issue) => !(issue.labels ?? []).includes(repo.labels.error),
        );
    },
    /**
     * @param {string} identifier
     * @returns {Promise<LinearIssue>}
     */
    async getIssue(identifier) {
      const data = await gql(
        `query($id: String!) {
          issue(id: $id) {
            id identifier title description url
            comments { nodes { body createdAt user { name } } }
          }
        }`,
        { id: identifier },
      );
      if (!data.issue) throw new Error(`Issue "${identifier}" not found`);
      return { ...data.issue, comments: mapComments(data.issue) };
    },
    /**
     * @param {{ teamId: string; projectId: string; title: string; description?: string }} input
     * @returns {Promise<LinearIssue>}
     */
    async createIssue({ teamId, projectId, title, description }) {
      const data = await gql(
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title url } } }`,
        { input: { teamId, projectId, title, description } },
      );
      if (!data.issueCreate?.success) throw new Error("Failed to create issue");
      return data.issueCreate.issue;
    },
    /**
     * @param {string} issueId
     * @param {string} body
     * @returns {Promise<void>}
     */
    async comment(issueId, body) {
      const data = await gql(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId, body } },
      );
      if (!data.commentCreate?.success) throw new Error(`Failed to comment on ${issueId}`);
    },
    /**
     * @param {string} issueId
     * @param {string} stateName
     * @returns {Promise<void>}
     */
    async moveState(issueId, stateName) {
      const team = await gql(`query($id: String!) { issue(id: $id) { team { id } } }`, {
        id: issueId,
      });
      const teamId = team.issue?.team?.id;
      if (!teamId) throw new Error(`Could not resolve team for ${issueId}`);
      const states = await gql(
        `query($id: String!) { team(id: $id) { states { nodes { id name } } } }`,
        { id: teamId },
      );
      const state = (states.team?.states?.nodes ?? []).find(
        (/** @type {{ name: string }} */ s) => s.name.toLowerCase() === stateName.toLowerCase(),
      );
      if (!state) throw new Error(`State "${stateName}" not found`);
      const data = await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issueId, input: { stateId: state.id } },
      );
      if (!data.issueUpdate?.success) throw new Error(`Failed to move ${issueId} to ${stateName}`);
    },
    /**
     * Add a label (given as `group:leaf` or a bare leaf) to an issue, creating the label if needed.
     *
     * @param {string} issueId
     * @param {string} labelName
     * @returns {Promise<void>}
     */
    async addLabel(issueId, labelName) {
      const sep = labelName.search(/[:/]/);
      const group = sep === -1 ? null : labelName.slice(0, sep);
      const leaf = sep === -1 ? labelName : labelName.slice(sep + 1);
      const labelId = await resolveOrCreateLabel(group, leaf);
      const data = await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }`,
        { id: issueId, input: { addedLabelIds: [labelId] } },
      );
      if (!data.issueUpdate?.success) throw new Error(`Failed to add label "${labelName}"`);
    },
  };
}
