import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiraClient, getJiraCredentials } from "../src/jira.mjs";
import { markdownToAdf } from "../src/adf.mjs";

const BASE_URL = "https://x.atlassian.net";
const CREDS = { baseUrl: BASE_URL, email: "u@x.com", apiToken: "t" };

/** @param {object} [overrides] */
function jiraRepo(overrides = {}) {
  return {
    name: "company-repo",
    path: "/tmp/company-repo",
    provider: "jira",
    jiraProject: "PROJ",
    remote: "git@github.com:example/company-repo.git",
    gates: [],
    workflow: { open: "To Do", claim: "In Progress" },
    labels: { pick: "task-driver", error: "ai:error" },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return { status, text: async () => JSON.stringify(body) };
}

function emptyResponse(status = 204) {
  return { status, text: async () => "" };
}

function adfDoc(text) {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** A raw search-result issue, shaped like the Jira v3 response. */
function searchIssue(key, { fields = {}, browseUrl } = {}) {
  return {
    id: "10000",
    key,
    self: `${BASE_URL}/rest/api/3/issue/${key}`,
    fields: {
      summary: `${key} summary`,
      description: null,
      labels: [],
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuelinks: [],
      ...fields,
    },
    ...(browseUrl ? { browseUrl } : {}),
  };
}

function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("listOpenIssues builds JQL, authenticates, and maps issues", async () => {
  const requests = [];
  const client = createJiraClient(
    { baseUrl: "https://x.atlassian.net/", email: "u@x.com", apiToken: "t" },
    {
      fetchImpl: async (url, opts) => {
        requests.push({ url, opts });
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            searchIssue("PROJ-12", {
              fields: {
                summary: "Fix bug",
                description: adfDoc("desc"),
                labels: ["task-driver"],
                status: { name: "To Do", statusCategory: { key: "new" } },
                issuelinks: [],
              },
              browseUrl: `${BASE_URL}/browse/PROJ-12`,
            }),
          ],
        });
      },
    },
  );

  const issues = await client.listOpenIssues(jiraRepo());

  const url = new URL(requests[0].url);
  assert.equal(url.origin, BASE_URL);
  assert.equal(url.pathname, "/rest/api/3/search");
  assert.equal(
    url.searchParams.get("jql"),
    'project = "PROJ" AND status = "To Do" AND labels = "task-driver"',
  );
  assert.equal(url.searchParams.get("startAt"), "0");
  assert.equal(url.searchParams.get("maxResults"), "100");
  assert.equal(url.searchParams.get("fields"), "summary,description,labels,status,issuelinks");
  assert.equal(requests[0].opts.headers.Authorization, `Basic ${btoa("u@x.com:t")}`);
  assert.equal(requests[0].opts.headers.Accept, "application/json");
  assert.deepEqual(issues, [
    {
      id: "PROJ-12",
      identifier: "PROJ-12",
      title: "Fix bug",
      description: "desc",
      url: `${BASE_URL}/browse/PROJ-12`,
      labels: ["task-driver"],
    },
  ]);
});

test("listOpenIssues falls back to <baseUrl>/browse/<key> when browseUrl is missing", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async () =>
      jsonResponse({ startAt: 0, maxResults: 100, total: 1, issues: [searchIssue("PROJ-3")] }),
  });
  const issues = await client.listOpenIssues(jiraRepo());
  assert.equal(issues[0].url, `${BASE_URL}/browse/PROJ-3`);
});

test("listOpenIssues uses status in (...) for an array open", async () => {
  /** @type {string | null} */
  let jql = null;
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      jql = new URL(url).searchParams.get("jql");
      return jsonResponse({ startAt: 0, maxResults: 100, total: 0, issues: [] });
    },
  });
  await client.listOpenIssues(
    jiraRepo({ workflow: { open: ["To Do", "In Progress"], claim: "In Progress" } }),
  );
  assert.equal(
    jql,
    'project = "PROJ" AND status in ("To Do", "In Progress") AND labels = "task-driver"',
  );
});

test("listOpenIssues paginates until startAt reaches total", async () => {
  const startAts = [];
  const pages = {
    0: [searchIssue("PROJ-1"), searchIssue("PROJ-2")],
    2: [searchIssue("PROJ-3")],
  };
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const startAt = Number(new URL(url).searchParams.get("startAt"));
      startAts.push(startAt);
      return jsonResponse({
        startAt,
        maxResults: 2,
        total: 3,
        issues: /** @type {Record<number, object[]>} */ (pages)[startAt],
      });
    },
  });
  const issues = await client.listOpenIssues(jiraRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["PROJ-1", "PROJ-2", "PROJ-3"],
  );
  assert.deepEqual(startAts, [0, 2]);
});

test("listOpenIssues stops when a page returns no issues", async () => {
  let calls = 0;
  const client = createJiraClient(CREDS, {
    fetchImpl: async () => {
      calls++;
      // A malformed `total` must not cause an infinite loop.
      return jsonResponse({ startAt: 0, maxResults: 100, total: 99, issues: [] });
    },
  });
  const issues = await client.listOpenIssues(jiraRepo());
  assert.deepEqual(issues, []);
  assert.equal(calls, 1);
});

test("listOpenIssues drops issues carrying the error label", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async () =>
      jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [searchIssue("PROJ-12", { fields: { labels: ["task-driver", "ai:error"] } })],
      }),
  });
  assert.deepEqual(await client.listOpenIssues(jiraRepo()), []);
});

test("listOpenIssues drops candidates whose blocker is unresolved", async () => {
  const requests = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const jql = new URL(url).searchParams.get("jql");
      requests.push({ jql, url });
      if (jql.startsWith("issuekey in")) {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            {
              key: "PROJ-99",
              fields: {
                resolution: null,
                status: { name: "To Do", statusCategory: { key: "new" } },
              },
            },
          ],
        });
      }
      return jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [
          searchIssue("PROJ-12", {
            fields: {
              labels: ["task-driver"],
              issuelinks: [
                {
                  type: { name: "Blocks" },
                  outwardIssue: { key: "PROJ-99" },
                  inwardIssue: { key: "PROJ-12" },
                },
              ],
            },
          }),
        ],
      });
    },
  });

  assert.deepEqual(await client.listOpenIssues(jiraRepo()), []);

  const batch = requests.find((r) => r.jql.startsWith("issuekey in"));
  assert.ok(batch, "expected a blocker batch search");
  assert.equal(batch.jql, 'issuekey in ("PROJ-99")');
  assert.equal(new URL(batch.url).searchParams.get("fields"), "resolution,status");
});

test("listOpenIssues keeps candidates whose blocker has a resolution", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const jql = new URL(url).searchParams.get("jql");
      if (jql.startsWith("issuekey in")) {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [{ key: "PROJ-99", fields: { resolution: { id: "2", name: "Won't Fix" } } }],
        });
      }
      return jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [
          searchIssue("PROJ-12", {
            fields: {
              labels: ["task-driver"],
              issuelinks: [{ type: { name: "blocks" }, outwardIssue: { key: "PROJ-99" } }],
            },
          }),
        ],
      });
    },
  });

  const issues = await client.listOpenIssues(jiraRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["PROJ-12"],
  );
});

test("listOpenIssues treats a done status category as a resolved blocker", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const jql = new URL(url).searchParams.get("jql");
      if (jql.startsWith("issuekey in")) {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            {
              key: "PROJ-99",
              fields: { resolution: null, status: { statusCategory: { key: "done" } } },
            },
          ],
        });
      }
      return jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [
          searchIssue("PROJ-12", {
            fields: {
              issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "PROJ-99" } }],
            },
          }),
        ],
      });
    },
  });

  const issues = await client.listOpenIssues(jiraRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["PROJ-12"],
  );
});

test("listOpenIssues treats a blocker missing from the batch as unresolved", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const jql = new URL(url).searchParams.get("jql");
      if (jql.startsWith("issuekey in")) {
        return jsonResponse({ startAt: 0, maxResults: 100, total: 0, issues: [] });
      }
      return jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [
          searchIssue("PROJ-12", {
            fields: {
              issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "PROJ-99" } }],
            },
          }),
        ],
      });
    },
  });
  assert.deepEqual(await client.listOpenIssues(jiraRepo()), []);
});

test("listOpenIssues honors a custom jiraBlockingLinkTypes", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const jql = new URL(url).searchParams.get("jql");
      if (jql.startsWith("issuekey in")) {
        return jsonResponse({
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [{ key: "PROJ-99", fields: { resolution: null } }],
        });
      }
      return jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [
          searchIssue("PROJ-12", {
            fields: {
              issuelinks: [{ type: { name: "Depends On" }, outwardIssue: { key: "PROJ-99" } }],
            },
          }),
        ],
      });
    },
  });
  const repo = jiraRepo({ jiraBlockingLinkTypes: ["depends on"] });
  assert.deepEqual(await client.listOpenIssues(repo), []);
});

test("listOpenIssues ignores non-blocking links", async () => {
  let batchCalls = 0;
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url) => {
      const jql = new URL(url).searchParams.get("jql");
      if (jql.startsWith("issuekey in")) {
        batchCalls++;
        return jsonResponse({ startAt: 0, maxResults: 100, total: 0, issues: [] });
      }
      return jsonResponse({
        startAt: 0,
        maxResults: 100,
        total: 1,
        issues: [
          searchIssue("PROJ-12", {
            fields: {
              issuelinks: [{ type: { name: "Relates" }, outwardIssue: { key: "PROJ-99" } }],
            },
          }),
        ],
      });
    },
  });
  const issues = await client.listOpenIssues(jiraRepo());
  assert.deepEqual(
    issues.map((i) => i.identifier),
    ["PROJ-12"],
  );
  assert.equal(batchCalls, 0);
});

test("getIssue requests fields and maps the issue", async () => {
  const requests = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      return jsonResponse({
        id: "10001",
        key: "PROJ-12",
        self: `${BASE_URL}/rest/api/3/issue/PROJ-12`,
        fields: {
          summary: "Fix bug",
          description: adfDoc("hello"),
          labels: ["task-driver"],
          status: { name: "To Do" },
        },
      });
    },
  });

  const issue = await client.getIssue("PROJ-12");

  assert.equal(
    requests[0].url,
    `${BASE_URL}/rest/api/3/issue/PROJ-12?fields=summary,description,labels,status`,
  );
  assert.equal(requests[0].opts.method, "GET");
  assert.deepEqual(issue, {
    id: "PROJ-12",
    identifier: "PROJ-12",
    title: "Fix bug",
    description: "hello",
    url: `${BASE_URL}/browse/PROJ-12`,
    labels: ["task-driver"],
  });
});

test("getIssue throws on HTTP 404", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async () => jsonResponse({ errorMessages: ["Issue does not exist"] }, 404),
  });
  await assert.rejects(() => client.getIssue("PROJ-404"), /HTTP 404/);
});

test("comment posts an ADF body", async () => {
  const requests = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      return jsonResponse({ id: "c1" }, 201);
    },
  });

  await client.comment("PROJ-12", "# Title\n\nhello");

  assert.equal(requests[0].url, `${BASE_URL}/rest/api/3/issue/PROJ-12/comment`);
  assert.equal(requests[0].opts.method, "POST");
  assert.equal(requests[0].opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].opts.body), {
    body: markdownToAdf("# Title\n\nhello"),
  });
});

const TRANSITIONS = [
  { id: "1000", name: "Start Progress", to: { name: "In Progress" } },
  { id: "1001", name: "Done", to: { name: "Done" } },
];

test("transition POSTs the matched id by destination name", async () => {
  const requests = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      if ((opts.method ?? "GET") === "GET") return jsonResponse({ transitions: TRANSITIONS });
      return emptyResponse(204);
    },
  });

  await client.transition("PROJ-12", "In Progress");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${BASE_URL}/rest/api/3/issue/PROJ-12/transitions`);
  assert.equal(requests[1].opts.method, "POST");
  assert.equal(requests[1].url, `${BASE_URL}/rest/api/3/issue/PROJ-12/transitions`);
  assert.deepEqual(JSON.parse(requests[1].opts.body), { transition: { id: "1000" } });
});

test("transition prefers an exact name match and accepts a numeric id", async () => {
  const posts = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      if ((opts.method ?? "GET") === "GET") return jsonResponse({ transitions: TRANSITIONS });
      posts.push(JSON.parse(opts.body));
      return emptyResponse(204);
    },
  });

  await client.transition("PROJ-12", "Done");
  await client.transition("PROJ-12", "1000");

  assert.deepEqual(posts, [{ transition: { id: "1001" } }, { transition: { id: "1000" } }]);
});

test("transition no-ops with a warning when nothing matches", async (t) => {
  const requests = [];
  const error = t.mock.method(console, "error");
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      if ((opts.method ?? "GET") === "GET") return jsonResponse({ transitions: TRANSITIONS });
      throw new Error("must not POST");
    },
  });

  await client.transition("PROJ-12", "Does Not Exist");

  assert.equal(requests.length, 1);
  assert.ok(error.mock.callCount() >= 1, "expected a console.error warning");
});

test("addLabel PUTs an add-only label operation", async () => {
  const requests = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      return emptyResponse(204);
    },
  });

  await client.addLabel("PROJ-12", "ai:error");

  assert.equal(requests[0].url, `${BASE_URL}/rest/api/3/issue/PROJ-12`);
  assert.equal(requests[0].opts.method, "PUT");
  assert.equal(requests[0].opts.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].opts.body), {
    update: { labels: [{ add: "ai:error" }] },
  });
});

test("createIssue posts ADF fields and maps the response", async () => {
  const requests = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async (url, opts) => {
      requests.push({ url, opts });
      return jsonResponse(
        { id: "10002", key: "PROJ-20", self: `${BASE_URL}/rest/api/3/issue/10002` },
        201,
      );
    },
  });

  const issue = await client.createIssue({
    project: "PROJ",
    issueType: "Task",
    title: "T",
    description: "d",
  });

  assert.equal(requests[0].url, `${BASE_URL}/rest/api/3/issue`);
  assert.equal(requests[0].opts.method, "POST");
  const sent = JSON.parse(requests[0].opts.body);
  assert.deepEqual(sent, {
    fields: {
      project: { key: "PROJ" },
      issuetype: { name: "Task" },
      summary: "T",
      description: markdownToAdf("d"),
    },
  });
  assert.deepEqual(issue, {
    id: "PROJ-20",
    identifier: "PROJ-20",
    title: "T",
    description: "d",
    url: `${BASE_URL}/browse/PROJ-20`,
    labels: [],
  });
});

test("createIssue uses the response browseUrl and labels when present", async () => {
  const client = createJiraClient(CREDS, {
    fetchImpl: async () =>
      jsonResponse(
        {
          id: "10002",
          key: "PROJ-20",
          browseUrl: "https://custom/browse/PROJ-20",
          fields: { labels: ["x"] },
        },
        201,
      ),
  });
  const issue = await client.createIssue({ project: "PROJ", issueType: "Task", title: "T" });
  assert.equal(issue.url, "https://custom/browse/PROJ-20");
  assert.deepEqual(issue.labels, ["x"]);
});

test("retries a 429 and then succeeds", async () => {
  let calls = 0;
  const delays = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return jsonResponse({ errorMessages: ["rate limited"] }, 429);
      return jsonResponse({
        id: "10001",
        key: "PROJ-12",
        fields: { summary: "s", description: null, labels: [], status: { name: "To Do" } },
      });
    },
    retry: {
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  });

  const issue = await client.getIssue("PROJ-12");
  assert.equal(issue.identifier, "PROJ-12");
  assert.equal(calls, 2);
  assert.deepEqual(delays, [250]);
});

test("retries a network error with exponential backoff then gives up", async () => {
  let calls = 0;
  const delays = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async () => {
      calls++;
      throw new Error("ECONNRESET");
    },
    retry: {
      attempts: 4,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  });

  await assert.rejects(() => client.getIssue("PROJ-12"), /ECONNRESET/);
  assert.equal(calls, 4);
  assert.deepEqual(delays, [100, 200, 400]);
});

test("gives up after three 500s", async () => {
  let calls = 0;
  const client = createJiraClient(CREDS, {
    fetchImpl: async () => {
      calls++;
      return jsonResponse({ errorMessages: ["boom"] }, 500);
    },
    retry: { sleep: async () => {} },
  });

  await assert.rejects(() => client.getIssue("PROJ-12"), /HTTP 500/);
  assert.equal(calls, 3);
});

test("does not retry a 4xx", async () => {
  let calls = 0;
  const delays = [];
  const client = createJiraClient(CREDS, {
    fetchImpl: async () => {
      calls++;
      return jsonResponse({ errorMessages: ["bad request"] }, 400);
    },
    retry: {
      sleep: async (ms) => {
        delays.push(ms);
      },
    },
  });

  await assert.rejects(() => client.getIssue("PROJ-12"), /HTTP 400.*bad request/);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test("getJiraCredentials prefers the environment variables", () => {
  withEnv({ JIRA_EMAIL: " env@x.com ", JIRA_API_TOKEN: " tok " }, () => {
    assert.deepEqual(getJiraCredentials(), { email: "env@x.com", apiToken: "tok" });
  });
});

test("getJiraCredentials reads ~/.pi/jira.json and returns null when unresolved", () => {
  const home = mkdtempSync(join(tmpdir(), "task-driver-jira-"));
  try {
    withEnv({ JIRA_EMAIL: undefined, JIRA_API_TOKEN: undefined, HOME: home }, () => {
      assert.equal(getJiraCredentials(), null);
      mkdirSync(join(home, ".pi"), { recursive: true });
      writeFileSync(
        join(home, ".pi", "jira.json"),
        JSON.stringify({ email: " file@x.com ", apiToken: " ftok " }),
      );
      assert.deepEqual(getJiraCredentials(), { email: "file@x.com", apiToken: "ftok" });
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
