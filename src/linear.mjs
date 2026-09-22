import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API_URL = "https://api.linear.app/graphql";

export function getLinearApiKey() {
  const env = process.env.LINEAR_API_KEY?.trim();
  if (env) return env;
  const file = join(homedir(), ".pi", "linear.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw.apiKey?.trim()) return raw.apiKey.trim();
    } catch { /* ignore malformed config */ }
  }
  return undefined;
}

export function createLinearClient(apiKey, fetchImpl = fetch) {
  async function gql(query, variables) {
    const res = await fetchImpl(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      throw new Error(`Linear API returned non-JSON (HTTP ${res.status})`);
    }
    if (res.status !== 200 || json.errors?.length) {
      const msgs = (json.errors ?? []).map((e) => e.message).join("; ");
      throw new Error(`Linear API error (HTTP ${res.status}): ${msgs || "unknown"}`);
    }
    return json.data;
  }

  return {
    async listOpenIssues(teamKey, projectName) {
      const data = await gql(
        `query($filter: IssueFilter) { issues(filter: $filter, first: 100) { nodes { id identifier title description url } } }`,
        { filter: { team: { key: { eq: teamKey } }, project: { name: { eq: projectName } }, state: { name: { eq: "Todo" } }, labels: { name: { eq: "task-driver" } } } },
      );
      return data.issues.nodes;
    },
    async getIssue(identifier) {
      const data = await gql(
        `query($id: String!) { issue(id: $id) { id identifier title description url } }`,
        { id: identifier },
      );
      if (!data.issue) throw new Error(`Issue "${identifier}" not found`);
      return data.issue;
    },
    async comment(issueId, body) {
      const data = await gql(
        `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId, body } },
      );
      if (!data.commentCreate?.success) throw new Error(`Failed to comment on ${issueId}`);
    },
    async moveState(issueId, stateName) {
      const team = await gql(
        `query($id: String!) { issue(id: $id) { team { id } } }`,
        { id: issueId },
      );
      const teamId = team.issue?.team?.id;
      if (!teamId) throw new Error(`Could not resolve team for ${issueId}`);
      const states = await gql(
        `query($id: String!) { team(id: $id) { states { nodes { id name } } } }`,
        { id: teamId },
      );
      const state = (states.team?.states?.nodes ?? []).find(
        (s) => s.name.toLowerCase() === stateName.toLowerCase(),
      );
      if (!state) throw new Error(`State "${stateName}" not found`);
      const data = await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issueId, input: { stateId: state.id } },
      );
      if (!data.issueUpdate?.success) throw new Error(`Failed to move ${issueId} to ${stateName}`);
    },
    async updateDescription(issueId, description) {
      const data = await gql(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issueId, input: { description } },
      );
      if (!data.issueUpdate?.success) throw new Error(`Failed to update description of ${issueId}`);
    },
  };
}
