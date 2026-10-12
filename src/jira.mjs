import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { markdownToAdf, adfToText } from "./adf.mjs";

/**
 * Minimal Jira Cloud REST v3 client covering the operations task-driver needs: list open issues,
 * fetch one issue, comment, transition, add a label, and create an issue.
 */

/** Retry/backoff defaults for transient Jira API failures. */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;

/** Page size for the `startAt`/`maxResults` search pagination. */
const SEARCH_PAGE_SIZE = 100;

/** Field list requested for pickable issues. */
const LIST_FIELDS = "summary,description,labels,status,issuelinks";

/** Field list requested for a single issue (no `issuelinks` needed). */
const GET_FIELDS = "summary,description,labels,status";

/**
 * Failure worth retrying (network error, 429, or 5xx). Retried by `call`; when attempts are
 * exhausted it propagates like any other error.
 */
class RetryableJiraError extends Error {}

/**
 * @typedef {object} JiraCredentials
 * @property {string} baseUrl Site root, e.g. `https://example.atlassian.net` (trailing `/` ok).
 * @property {string} email
 * @property {string} apiToken
 */

/**
 * @typedef {object} JiraRetryOptions
 * @property {number} [attempts] Maximum attempts including the first (default 3).
 * @property {number} [baseDelayMs] First backoff delay in ms; doubles each retry (default 250).
 * @property {(ms: number) => Promise<void>} [sleep] Delay implementation, injectable for tests.
 */

/**
 * @typedef {object} JiraWorkflow
 * @property {string | string[]} open One status name, or several for `status in (...)`.
 * @property {string} claim
 * @property {string} [reopen]
 * @property {string} [park]
 */

/**
 * @typedef {object} JiraLabelConfig
 * @property {string} pick
 * @property {string} error
 */

/**
 * @typedef {object} JiraRepo
 * @property {string} jiraProject
 * @property {JiraWorkflow} workflow
 * @property {JiraLabelConfig} labels
 * @property {string} [jiraIssueType]
 * @property {string[]} [jiraBlockingLinkTypes]
 */

/**
 * @typedef {object} JiraIssue
 * @property {string} id
 * @property {string} identifier
 * @property {string} title
 * @property {string} description
 * @property {string} url
 * @property {string[]} labels
 */

/**
 * @typedef {object} JiraClientOptions
 * @property {typeof fetch} [fetchImpl] Injectable fetch, for tests.
 * @property {JiraRetryOptions} [retry]
 */

/**
 * @typedef {object} JiraRequestInit
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
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

/**
 * Render a Jira error response body into a short message.
 *
 * @param {string} text
 * @returns {string}
 */
function errorDetail(text) {
  try {
    const json = JSON.parse(text);
    /** @type {string[]} */
    const messages = [];
    if (Array.isArray(json.errorMessages)) messages.push(...json.errorMessages);
    if (json.errors && typeof json.errors === "object") {
      for (const [field, message] of Object.entries(json.errors))
        messages.push(`${field}: ${message}`);
    }
    if (messages.length) return messages.join("; ");
  } catch {
    /* not JSON */
  }
  return text.trim() || "unknown";
}

/**
 * Resolve Jira credentials from `JIRA_EMAIL`/`JIRA_API_TOKEN`, else `~/.pi/jira.json`.
 *
 * @returns {{ email: string; apiToken: string } | null}
 */
export function getJiraCredentials() {
  const email = process.env.JIRA_EMAIL?.trim();
  const apiToken = process.env.JIRA_API_TOKEN?.trim();
  if (email && apiToken) return { email, apiToken };

  const file = join(homedir(), ".pi", "jira.json");
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const fileEmail = typeof raw.email === "string" ? raw.email.trim() : "";
      const fileToken = typeof raw.apiToken === "string" ? raw.apiToken.trim() : "";
      if (fileEmail && fileToken) return { email: fileEmail, apiToken: fileToken };
    } catch {
      /* ignore malformed config */
    }
  }
  return null;
}

/**
 * Build the pick JQL from config. Values are config-controlled, wrapped in double quotes with no
 * escaping.
 *
 * @param {JiraRepo} repo
 * @returns {string}
 */
function buildJql(repo) {
  const open = repo.workflow.open;
  const status = Array.isArray(open)
    ? `status in (${open.map((s) => `"${s}"`).join(", ")})`
    : `status = "${open}"`;
  return `project = "${repo.jiraProject}" AND ${status} AND labels = "${repo.labels.pick}"`;
}

/**
 * True when a blocker issue is resolved: it has any resolution, or its status category is `done`.
 *
 * @param {any} issue
 * @returns {boolean}
 */
function isResolved(issue) {
  const fields = issue?.fields ?? {};
  if (fields.resolution != null) return true;
  const category = fields.status?.statusCategory ?? fields.statusCategory;
  return category?.key === "done";
}

/**
 * Blocker keys referenced by a candidate's outbound blocking links.
 *
 * @param {any} issue
 * @param {string[]} linkTypes
 * @returns {string[]}
 */
function blockerKeys(issue, linkTypes) {
  /** @type {string[]} */
  const keys = [];
  for (const link of issue?.fields?.issuelinks ?? []) {
    const name = link?.type?.name;
    const outward = link?.outwardIssue?.key;
    if (typeof name !== "string" || typeof outward !== "string") continue;
    if (outward === issue.key) continue;
    if (!linkTypes.some((type) => type.toLowerCase() === name.toLowerCase())) continue;
    keys.push(outward);
  }
  return keys;
}

/**
 * Map a raw Jira issue into the shared `Issue` shape.
 *
 * @param {any} issue
 * @param {string} baseUrl Site root without a trailing slash.
 * @returns {JiraIssue}
 */
function toIssue(issue, baseUrl) {
  const fields = issue?.fields ?? {};
  return {
    id: issue.key,
    identifier: issue.key,
    title: fields.summary,
    description: adfToText(fields.description),
    url: issue.browseUrl ?? `${baseUrl}/browse/${issue.key}`,
    labels: fields.labels ?? [],
  };
}

/**
 * @typedef {object} JiraCreateInput
 * @property {string} project
 * @property {string} issueType
 * @property {string} title
 * @property {string} [description]
 */

/**
 * @typedef {object} JiraClient
 * @property {(repo: JiraRepo) => Promise<JiraIssue[]>} listOpenIssues
 * @property {(identifier: string) => Promise<JiraIssue>} getIssue
 * @property {(issueId: string, body: string) => Promise<void>} comment
 * @property {(issueId: string, statusName: string) => Promise<void>} transition
 * @property {(issueId: string, label: string) => Promise<void>} addLabel
 * @property {(input: JiraCreateInput) => Promise<JiraIssue>} createIssue
 */

/**
 * Build a minimal Jira Cloud REST v3 client.
 *
 * @param {JiraCredentials} creds
 * @param {JiraClientOptions} [options]
 * @returns {JiraClient}
 */
export function createJiraClient(creds, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retry = options.retry ?? {};
  const attempts = Math.max(1, retry.attempts ?? DEFAULT_ATTEMPTS);
  const baseDelayMs = retry.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep =
    retry.sleep ?? ((/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms)));
  const baseUrl = String(creds.baseUrl ?? "").replace(/\/+$/, "");
  const authorization = `Basic ${btoa(`${creds.email}:${creds.apiToken}`)}`;

  /**
   * Perform a single HTTP request, throwing `RetryableJiraError` for transient failures and a plain
   * `Error` otherwise.
   *
   * @param {string} url
   * @param {JiraRequestInit} [init]
   * @returns {Promise<any>}
   */
  async function request(url, init = {}) {
    let res;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: {
          Authorization: authorization,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      throw new RetryableJiraError(`Jira API request failed: ${errorMessage(err)}`);
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      throw new RetryableJiraError(`Jira API request failed: ${errorMessage(err)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      const message = `Jira API error (HTTP ${res.status}): ${errorDetail(text)}`;
      if (isRetryableStatus(res.status)) throw new RetryableJiraError(message);
      throw new Error(message);
    }
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Jira API returned non-JSON (HTTP ${res.status})`);
    }
  }

  /**
   * Execute one request, retrying transient failures with exponential backoff.
   *
   * @param {string} url
   * @param {JiraRequestInit} [init]
   * @returns {Promise<any>}
   */
  async function call(url, init) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(url, init);
      } catch (err) {
        if (attempt >= attempts || !(err instanceof RetryableJiraError)) throw err;
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  /**
   * Fetch one page of `GET /rest/api/3/search`.
   *
   * @param {string} jql
   * @param {number} startAt
   * @param {string} fields
   * @returns {Promise<any>}
   */
  async function searchPage(jql, startAt, fields) {
    const url = `${baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${SEARCH_PAGE_SIZE}&fields=${fields}`;
    return call(url, { method: "GET" });
  }

  /**
   * Follow `startAt`/`maxResults` pagination until `startAt >= total`.
   *
   * @param {string} jql
   * @param {string} fields
   * @returns {Promise<any[]>}
   */
  async function searchAll(jql, fields) {
    /** @type {any[]} */
    const issues = [];
    let startAt = 0;
    for (;;) {
      const page = await searchPage(jql, startAt, fields);
      const batch = Array.isArray(page?.issues) ? page.issues : [];
      issues.push(...batch);
      if (batch.length === 0) break;
      startAt += batch.length;
      const total = Number(page?.total);
      if (Number.isFinite(total) && startAt >= total) break;
    }
    return issues;
  }

  /**
   * Batch-resolve blocker keys, chunked at the page size.
   *
   * @param {string[]} keys
   * @returns {Promise<Map<string, boolean>>}
   */
  async function blockerStatuses(keys) {
    /** @type {Map<string, boolean>} */
    const statuses = new Map();
    for (let i = 0; i < keys.length; i += SEARCH_PAGE_SIZE) {
      const chunk = keys.slice(i, i + SEARCH_PAGE_SIZE);
      const jql = `issuekey in (${chunk.map((key) => `"${key}"`).join(", ")})`;
      for (const issue of await searchAll(jql, "resolution,status")) {
        statuses.set(issue.key, isResolved(issue));
      }
    }
    return statuses;
  }

  return {
    /**
     * Pickable issues: open status + pick label, minus error-labeled and blocked issues.
     *
     * @param {JiraRepo} repo
     * @returns {Promise<JiraIssue[]>}
     */
    async listOpenIssues(repo) {
      const candidates = (await searchAll(buildJql(repo), LIST_FIELDS)).filter(
        (/** @type {any} */ issue) => !(issue?.fields?.labels ?? []).includes(repo.labels.error),
      );

      const linkTypes = repo.jiraBlockingLinkTypes ?? ["blocks"];
      /** @type {Map<string, string[]>} */
      const byCandidate = new Map();
      /** @type {Set<string>} */
      const blockers = new Set();
      for (const issue of candidates) {
        const keys = blockerKeys(issue, linkTypes);
        if (keys.length === 0) continue;
        byCandidate.set(issue.key, keys);
        for (const key of keys) blockers.add(key);
      }
      const statuses = blockers.size ? await blockerStatuses([...blockers]) : new Map();

      return candidates
        .filter(
          (/** @type {any} */ issue) =>
            !(byCandidate.get(issue.key) ?? []).some((key) => statuses.get(key) !== true),
        )
        .map((/** @type {any} */ issue) => toIssue(issue, baseUrl));
    },
    /**
     * Fetch a single issue by its key.
     *
     * @param {string} identifier
     * @returns {Promise<JiraIssue>}
     */
    async getIssue(identifier) {
      const issue = await call(
        `${baseUrl}/rest/api/3/issue/${encodeURIComponent(identifier)}?fields=${GET_FIELDS}`,
        { method: "GET" },
      );
      if (!issue?.key) throw new Error(`Issue "${identifier}" not found`);
      return toIssue(issue, baseUrl);
    },
    /**
     * Post a markdown body as an ADF comment.
     *
     * @param {string} issueId
     * @param {string} body
     * @returns {Promise<void>}
     */
    async comment(issueId, body) {
      await call(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: markdownToAdf(body) }),
      });
    },
    /**
     * Move an issue to `statusName`. The transition is matched by numeric id, then exact `name`,
     * then destination `to.name`. No match is a logged no-op.
     *
     * @param {string} issueId
     * @param {string} statusName
     * @returns {Promise<void>}
     */
    async transition(issueId, statusName) {
      const url = `${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}/transitions`;
      const { transitions = [] } = (await call(url, { method: "GET" })) ?? {};
      const wanted = String(statusName);
      const match =
        (/^\d+$/.test(wanted)
          ? transitions.find((/** @type {any} */ t) => String(t.id) === wanted)
          : undefined) ??
        transitions.find((/** @type {any} */ t) => t.name === wanted) ??
        transitions.find((/** @type {any} */ t) => t.to?.name === wanted);
      if (!match) {
        console.error(`Jira: no transition to "${statusName}" available for ${issueId}`);
        return;
      }
      await call(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transition: { id: String(match.id) } }),
      });
    },
    /**
     * Add a free-form label to an issue (add-only; existing labels survive, nothing is created).
     *
     * @param {string} issueId
     * @param {string} label
     * @returns {Promise<void>}
     */
    async addLabel(issueId, label) {
      await call(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update: { labels: [{ add: label }] } }),
      });
    },
    /**
     * Create an issue with an ADF description.
     *
     * @param {JiraCreateInput} input
     * @returns {Promise<JiraIssue>}
     */
    async createIssue({ project, issueType, title, description = "" }) {
      const created = await call(`${baseUrl}/rest/api/3/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            project: { key: project },
            issuetype: { name: issueType },
            summary: title,
            description: markdownToAdf(description),
          },
        }),
      });
      return {
        id: created.key,
        identifier: created.key,
        title,
        description,
        url: created.browseUrl ?? `${baseUrl}/browse/${created.key}`,
        labels: created.fields?.labels ?? [],
      };
    },
  };
}
