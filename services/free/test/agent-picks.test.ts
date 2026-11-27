import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, errorCode, MODEL, NOW, type Service } from "./harness.js";
import { buy, DL, emailSignIn, FakeStripe, PAID_VARS } from "./paid-fixtures.js";
import { parseAccountId } from "../src/accounts.js";
import { agentsCard, parseAgentPick, requestAgent, type AgentsReport } from "../src/agent-picks.js";

/**
 * Router tracking (agent-picks.ts): POST /v1/agent-pick from dl's router, the agent every chat
 * request counts under (agent_daily), and GET /admin/agents with its admin home card.
 */

const DAY = 86_400_000;
const VARS = { OPEN_ADMISSION: "true" };

const pick = (s: Service, token: string, body: unknown) => s.request("POST", "/v1/agent-pick", { token, body });
const chat = (s: Service, token: string, headers: Record<string, string> = {}) =>
  s.request("POST", "/v1/chat/completions", { token, headers, body: { model: MODEL, messages: [{ role: "user", content: "hello" }] } });
const sql = (s: Service) => s.directory().ctx.storage.sql;

async function toolKey(s: Service, token: string): Promise<string> {
  const response = await s.request("POST", "/v1/keys", { token, body: { name: "box", kind: "tool" } });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { key: string }).key;
}

async function report(s: Service, admin: string, days = 30): Promise<AgentsReport> {
  const response = await s.request("GET", `/admin/agents?days=${days}`, { token: admin });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as AgentsReport;
}

describe("parseAgentPick", () => {
  it("keeps an agent id, firstRun, the found ids and a version; drops malformed found entries", () => {
    const parsed = parseAgentPick({ agent: "claude-code", firstRun: true, found: ["cursor", "Bad Name", 3, "cursor", "zed"], dlVersion: "0.49.1", extra: "x" });
    assert.deepEqual(parsed, { ok: true, value: { agent: "claude-code", firstRun: true, found: ["cursor", "zed"], dlVersion: "0.49.1" } });
    assert.deepEqual(parseAgentPick({ agent: "pi" }), { ok: true, value: { agent: "pi", firstRun: false, found: null, dlVersion: null } });
  });

  it("refuses a missing or malformed agent, a non-boolean firstRun and a found that isn't a list", () => {
    assert.equal(parseAgentPick({}).ok, false);
    assert.equal(parseAgentPick({ agent: "Claude Code" }).ok, false);
    assert.equal(parseAgentPick({ agent: "x".repeat(40) }).ok, false);
    assert.equal(parseAgentPick({ agent: "pi", firstRun: "yes" }).ok, false);
    assert.equal(parseAgentPick({ agent: "pi", found: "cursor" }).ok, false);
    assert.equal(parseAgentPick([]).ok, false);
  });
});

describe("requestAgent", () => {
  const agent = (headers: Record<string, string>, tool = true, harness?: string) => requestAgent({ harness, tool, headers: new Headers(headers) });
  it("names the agent from the harness key, dl's hint, the sign-in, or the client's headers", () => {
    assert.equal(agent({}, false, "opencode"), "opencode");
    assert.equal(agent({}, false), "autopilot");
    assert.equal(agent({ "x-dl-harness": "pi", "user-agent": "OpenAI/JS 5.0" }), "pi");
    assert.equal(agent({ "user-agent": "autopilot/3.40.0 (+https://github.com/directionally-local/autopilot)" }), "autopilot");
    assert.equal(agent({ "user-agent": "OpenAI/JS 5.0", "x-title": "Autopilot" }), "autopilot");
    assert.equal(agent({ "user-agent": "claude-cli/2.1 (external, cli)" }), "claude-code");
    assert.equal(agent({ "user-agent": "opencode/1.2" }), "opencode");
    assert.equal(agent({ "user-agent": "crush/0.9" }), "crush");
    assert.equal(agent({ "user-agent": "t3code/0.3" }), "t3");
    assert.equal(agent({ "user-agent": "Cursor/1.9" }), "cursor");
    assert.equal(agent({ "user-agent": "OpenAI/Python 1.99.0" }), "other");
    assert.equal(agent({ "user-agent": "curl/8.0" }), "other");
    assert.equal(agent({}), "other");
    // A hint that isn't one of dl's agents is ignored.
    assert.equal(agent({ "x-dl-harness": "evil", "user-agent": "aider/0.9" }), "aider");
  });
});

describe("POST /v1/agent-pick", () => {
  it("keeps the first pick, the latest pick, per-agent counts and the latest found list", async () => {
    const s = await createService(VARS);
    const alice = (await s.signIn({ id: 100, login: "alice" })).access_token;
    const first = await pick(s, alice, { agent: "claude-code", firstRun: true, found: ["claude-code", "cursor"], dlVersion: "0.49.1" });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { ok: true });
    s.clock.now += 60_000;
    assert.equal((await pick(s, alice, { agent: "opencode", firstRun: false })).status, 202);
    assert.equal((await pick(s, alice, { agent: "opencode", firstRun: false })).status, 202);
    const person = sql(s).exec("SELECT * FROM agent_pick_people WHERE github_id = 100").toArray()[0];
    assert.equal(person.first_agent, "claude-code");
    assert.equal(person.first_run, 1);
    assert.equal(person.first_at, NOW);
    assert.equal(person.last_agent, "opencode");
    assert.equal(person.last_at, NOW + 60_000);
    // `dl opencode` doesn't look for agents: the found list from the router stays.
    assert.equal(person.found, JSON.stringify(["claude-code", "cursor"]));
    const rows = sql(s).exec("SELECT agent, n FROM agent_picks WHERE github_id = 100 ORDER BY agent").toArray().map((row: { agent: string; n: number }) => [row.agent, row.n]);
    assert.deepEqual(rows, [["claude-code", 1], ["opencode", 2]]);
  });

  it("takes a dl_sk_ key, even with the free tier's tool keys switch off", async () => {
    const s = await createService({ ...PAID_VARS, TOOL_KEYS: "false" }, { userEmail: true, email: true });
    const stripe = new FakeStripe(s);
    const session = await buy(s, stripe, "starter", "pat@example.com");
    const signedIn = await emailSignIn(s, "pat@example.com", session.id);
    const made = await s.request("POST", "/web/api-keys", { token: signedIn.token, body: {}, headers: DL });
    const { key } = (await made.json()) as { key: string };
    assert.match(key, /^dl_sk_/);
    assert.equal((await pick(s, key, { agent: "autopilot", firstRun: true, found: [] })).status, 202);
    const account = parseAccountId(signedIn.account.accountId)!;
    assert.equal(sql(s).exec("SELECT first_agent FROM agent_pick_people WHERE github_id = ?", account).toArray()[0]?.first_agent, "autopilot");
  });

  it("needs a key or sign-in, and a well-formed body", async () => {
    const s = await createService(VARS);
    const alice = (await s.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await s.request("POST", "/v1/agent-pick", { body: { agent: "pi" } })).status, 401);
    const bad = await pick(s, alice, { agent: "Not An Id" });
    assert.equal(bad.status, 400);
    assert.equal(await errorCode(bad), "invalid_request");
    assert.equal(sql(s).exec("SELECT COUNT(*) AS n FROM agent_picks").toArray()[0].n, 0);
  });
});

describe("usage by agent", () => {
  it("records every chat request under its agent in the per-person daily rollup", async () => {
    const s = await createService(VARS);
    const alice = (await s.signIn({ id: 100, login: "alice" })).access_token;
    const key = await toolKey(s, alice);
    assert.equal((await chat(s, alice)).status, 200);
    assert.equal((await chat(s, key, { "user-agent": "claude-cli/2.1 (external, cli)" })).status, 200);
    assert.equal((await chat(s, key, { "user-agent": "claude-cli/2.1 (external, cli)" })).status, 200);
    assert.equal((await chat(s, key, { "user-agent": "autopilot/3.40.0" })).status, 200);
    assert.equal((await chat(s, key, { "user-agent": "OpenAI/Python 1.99.0" })).status, 200);
    const rows = sql(s)
      .exec("SELECT agent, requests, tokens FROM agent_daily WHERE github_id = 100 AND day = ? ORDER BY agent", Math.floor(NOW / DAY))
      .toArray()
      .map((row: { agent: string; requests: number; tokens: number }) => [row.agent, row.requests, row.tokens > 0]);
    assert.deepEqual(rows, [["autopilot", 2, true], ["claude-code", 2, true], ["other", 1, true]]);
  });

  it("leaves admins out of the rollup", async () => {
    const s = await createService(VARS);
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await chat(s, admin)).status, 200);
    assert.equal(sql(s).exec("SELECT COUNT(*) AS n FROM agent_daily").toArray()[0].n, 0);
  });
});

describe("GET /admin/agents", () => {
  it("shows first-run picks, weekly actives, week-2 retention by first pick, paying people by primary agent, tokens and what dl found", async () => {
    const s = await createService(VARS);
    let admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const alice = (await s.signIn({ id: 100, login: "alice" })).access_token;
    const bob = (await s.signIn({ id: 101, login: "bob" })).access_token;
    const aliceKey = await toolKey(s, alice);
    assert.equal((await pick(s, alice, { agent: "claude-code", firstRun: true, found: ["claude-code", "cursor"] })).status, 202);
    assert.equal((await pick(s, bob, { agent: "autopilot", firstRun: true, found: ["cursor"] })).status, 202);
    // The admin's own pick isn't counted.
    assert.equal((await pick(s, admin, { agent: "zed", firstRun: true, found: ["zed"] })).status, 202);
    // Alice comes back in week 2 with Claude Code; Bob only on day one, with Autopilot.
    assert.equal((await chat(s, bob)).status, 200);
    s.clock.now = NOW + 8 * DAY;
    assert.equal((await chat(s, aliceKey, { "user-agent": "claude-cli/2.1 (external, cli)" })).status, 200);
    // Alice pays; her primary agent is Claude Code.
    sql(s).exec("INSERT INTO subscriptions (github_id, state, period_end, state_at) VALUES (100, 'active', NULL, ?)", s.clock.now);
    s.clock.now = NOW + 15 * DAY;
    // Access tokens are short-lived: the admin signs in again.
    admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;

    const data = await report(s, admin);
    assert.equal(data.days, 30);
    const byAgent = Object.fromEntries(data.agents.map((row) => [row.agent, row]));
    assert.equal(byAgent.zed, undefined);
    assert.equal(byAgent["claude-code"]!.firstRunPicks, 1);
    assert.equal(byAgent.autopilot!.firstRunPicks, 1);
    assert.deepEqual(byAgent["claude-code"]!.retention, { signups: 1, eligible: 1, retained: 1, rate: 1 });
    assert.deepEqual(byAgent.autopilot!.retention, { signups: 1, eligible: 1, retained: 0, rate: 0 });
    assert.equal(byAgent["claude-code"]!.payingPrimary, 1);
    assert.equal(byAgent.autopilot!.payingPrimary, 0);
    assert.deepEqual(data.paying, { total: 1, noUsage: 0 });
    assert.ok(byAgent["claude-code"]!.tokens > 0);
    assert.equal(byAgent["claude-code"]!.activeInWindow, 1);
    assert.equal(byAgent.autopilot!.activeInWindow, 1);
    // NOW + 15 days is a Thursday; nobody made a request since Monday.
    assert.equal(byAgent["claude-code"]!.activeThisWeek, 0);
    assert.deepEqual(data.found, { reported: 2, agents: [{ agent: "cursor", people: 2 }, { agent: "claude-code", people: 1 }] });
    assert.deepEqual(
      data.cohorts.map((c) => [c.week, c.agent, c.signups, c.eligible, c.retained]),
      [
        ["2026-11-02", "autopilot", 1, 1, 0],
        ["2026-11-02", "claude-code", 1, 1, 1],
      ],
    );

    // This week: Alice again.
    assert.equal((await chat(s, aliceKey, { "user-agent": "claude-cli/2.1 (external, cli)" })).status, 200);
    assert.equal((await report(s, admin)).agents.find((row) => row.agent === "claude-code")!.activeThisWeek, 1);
    // A 7-day window leaves out picks and signups from before it.
    const week = await report(s, admin, 7);
    assert.equal(week.agents.find((row) => row.agent === "claude-code")!.firstRunPicks, 0);
    assert.equal(week.cohorts.length, 0);
  });

  it("is for admins only and checks ?days", async () => {
    const s = await createService(VARS);
    const admin = (await s.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const alice = (await s.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await s.request("GET", "/admin/agents", { token: alice })).status, 403);
    assert.equal((await s.request("GET", "/admin/agents?days=0", { token: admin })).status, 400);
    assert.equal((await s.request("GET", "/v1/admin/agents?days=7", { token: admin })).status, 200);
  });
});

describe("agentsCard", () => {
  it("renders the agents, cohorts and found tables, escaped", () => {
    const html = agentsCard({
      days: 30,
      from: "2026-10-29",
      agents: [{ agent: "<b>", firstRunPicks: 3, firstPicks: 4, pickers: 5, picks: 9, current: 4, activeThisWeek: 2, activeInWindow: 3, requests: 40, tokens: 1_500_000, payingPrimary: 1, retention: { signups: 3, eligible: 2, retained: 1, rate: 0.5 } }],
      cohorts: [{ week: "2026-11-02", agent: "claude-code", signups: 3, eligible: 2, retained: 1 }],
      paying: { total: 2, noUsage: 1 },
      found: { reported: 4, agents: [{ agent: "claude-code", people: 3 }] },
    });
    assert.match(html, /id="agents"/);
    assert.match(html, /&lt;b&gt;/);
    assert.doesNotMatch(html, /<td class="l"><b>/);
    assert.match(html, /50% <span class="count">\(1\/2\)<\/span>/);
    assert.match(html, /1\.5M/);
    assert.match(html, /Found on their computers/);
    assert.match(html, /75%/);
    assert.match(agentsCard({ days: 30, from: "x", agents: [], cohorts: [], paying: { total: 0, noUsage: 0 }, found: { reported: 0, agents: [] } }), /No picks or agent usage/);
  });
});
