import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Minimal Linear GraphQL client covering the operations task-driver needs: list open issues, fetch
 * one issue, comment, move state, update description.
 */
const API_URL = "https://api.linear.app/graphql";

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
 */

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
 * @typedef {object} LinearClient
 * @property {(teamKey: string, projectName: string) => Promise<LinearIssue[]>} listOpenIssues
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
 * Resolve the Linear API key from the environment or `~/.pi/linear.json`.
 *
 * @returns {string | undefined}
 */
export function getLinearApiKey() {
  const env = process.env.LINEAR_API_KEY?.trim();
  if (env) return env;
  const file = join(homedir(), ".pi", "linear.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw.apiKey?.trim()) return raw.apiKey.trim();
    } catch {
      /* ignore malformed config */
    }
  }
  return undefined;
}

/**
 * Build a minimal Linear GraphQL client.
 *
 * @param {string} apiKey
 * @param {typeof fetch} [fetchImpl]
 * @returns {LinearClient}
 */
export function createLinearClient(apiKey, fetchImpl = fetch) {
  /**
   * Execute one GraphQL request and return its `data` payload.
   *
   * @param {string} query
   * @param {Record<string, any>} variables
   * @returns {Promise<any>}
   */
  async function gql(query, variables) {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Linear API returned non-JSON (HTTP ${res.status})`);
    }
    if (res.status !== 200 || json.errors?.length) {
      const msgs = (json.errors ?? [])
        .map((/** @type {{ message: string }} */ e) => e.message)
        .join("; ");
      throw new Error(`Linear API error (HTTP ${res.status}): ${msgs || "unknown"}`);
    }
    return json.data;
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
     * @param {string} teamKey
     * @param {string} projectName
     * @returns {Promise<LinearIssue[]>}
     */
    async listOpenIssues(teamKey, projectName) {
      const data = await gql(
        `query($filter: IssueFilter) {
          issues(filter: $filter, first: 100) {
            nodes {
              id identifier title description url
              relations { nodes { type relatedIssue { state { name } } } }
              inverseRelations { nodes { type issue { state { name } } } }
              labels { nodes { name } }
            }
          }
        }`,
        {
          filter: {
            team: { key: { eq: teamKey } },
            project: { name: { eq: projectName } },
            state: { name: { eq: "Todo" } },
            labels: { name: { eq: "task-driver" } },
          },
        },
      );
      return (data.issues.nodes ?? [])
        .filter((/** @type {any} */ issue) => !hasUnresolvedBlocker(issue))
        .map((/** @type {any} */ issue) => ({
          ...issue,
          labels: (issue.labels?.nodes ?? []).map((/** @type {{ name: string }} */ n) => n.name),
        }));
    },
    /**
     * @param {string} identifier
     * @returns {Promise<LinearIssue>}
     */
    async getIssue(identifier) {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { id identifier title description url } }`,
        { id: identifier },
      );
      if (!data.issue) throw new Error(`Issue "${identifier}" not found`);
      return data.issue;
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
