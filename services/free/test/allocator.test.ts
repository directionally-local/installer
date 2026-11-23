import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, completion, createService, MODEL, usage, type Service } from "./harness.js";
import { readFileSync } from "node:fs";
import { allocatedLimits, ALLOCATOR_IDLE_MS, ALLOCATOR_MODEL, anthropicSessionHint, finalStage, logSessions, parseAllocation, sessionKeyOf, type AllocatorFacts, type AllocatorSettings } from "../src/allocator.js";
import { dailyDigestAlert } from "../src/alerts.js";
import type { Limits } from "../src/account-object.js";
import { readFreeConfig } from "../src/config.js";

/**
 * The token allocator (allocator.ts): a 1M start grant for every account that isn't blocked, a
 * gpt-oss decision when 80% of the allowance is used, hard rules over it, and never a stuck
 * person when the allocator is down.
 */

const DAY = 86_400_000;

/** Below the bar, Basic off: every new account here is Starter. */
const BAR = {
  ALLOCATOR: "on",
  DL_ONLY: "false",
  OPEN_ADMISSION: "true",
  BASIC_WEEKLY_TOKENS: "0",
  STARTER_WEEKLY_TOKENS: "500000",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
};
const NEWBIE = { id: 300, login: "newbie", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 };

const isAllocator = (body: Record<string, unknown>) => body.model === ALLOCATOR_MODEL;
const allocatorCalls = (service: Service) => service.calls.openRouter.filter((call) => isAllocator(call.body));
const decide = (decision: string, reason = "Several multi-turn coding sessions over days") => JSON.stringify({ decision, reason });
function answer(text: string): Response {
  return Response.json({ id: "gen-a", object: "chat.completion", model: ALLOCATOR_MODEL, choices: [{ index: 0, message: { role: "assistant", content: text } }], usage: usage(900, 80, 0, 0.0001) });
}

type Allocate = (body: Record<string, unknown>) => Response | Promise<Response>;

/** A service where each chat request charges `charge.tokens` (prompt tokens) and the allocator answers with `allocate`. */
async function setup(vars: Record<string, string> = {}, allocate: Allocate = () => answer(decide("10m"))) {
  const service = await createService({ ...BAR, ...vars });
  const charge = { tokens: 1000 };
  service.setOpenRouter((body) => (isAllocator(body) ? allocate(body) : completion(usage(charge.tokens, 0))));
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn(NEWBIE)).access_token;
  return { service, admin, token, charge };
}

async function chat(service: Service, token: string): Promise<Response> {
  const response = await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "fix the failing test" }], max_tokens: 300 } });
  await response.text();
  return response;
}

async function weekly(service: Service, token: string): Promise<number | null> {
  const me = (await (await service.request("GET", "/v1/me", { token })).json()) as { pools: { deepseek: { tokensPerWeek: number | null } } };
  return me.pools.deepseek.tokensPerWeek;
}

function db(service: Service): DatabaseSync {
  service.directory();
  return (service.namespaces.DIRECTORY!.instances.get("directory")!.state as unknown as { db: DatabaseSync }).db;
}
const rows = (service: Service) => db(service).prepare("SELECT * FROM allocator_decisions ORDER BY id").all() as Array<Record<string, unknown>>;

describe("the start grant", () => {
  it("raises a smaller allowance to 1M, and gives 1M to accounts that had none", async () => {
    const { service, token } = await setup();
    assert.equal(await weekly(service, token), 1_000_000);
    const none = await setup({ STARTER_WEEKLY_TOKENS: "0" });
    assert.equal(await weekly(none.service, none.token), 1_000_000);
    assert.equal((await chat(none.service, none.token)).status, 200, "no below_bar refusal any more");
  });

  it("gives 1M to a batch-flagged account too, with Starter's dollar budget", async () => {
    const { service, token } = await setup();
    db(service).prepare("UPDATE people SET batch_flag = 1 WHERE github_id = ?").run(NEWBIE.id);
    assert.equal(await weekly(service, token), 1_000_000);
    assert.equal((await chat(service, token)).status, 200);
  });

  it("shows the start grant in GET /admin/people for a batch-flagged account (as production is set)", async () => {
    // Production's Starter: 1M tokens, $0 GPT-6, $8 DeepSeek. The batch flag alone gives 0 and $0.
    const { service, admin, token } = await setup({ STARTER_WEEKLY_TOKENS: "1000000", STARTER_WEEKLY_USD_CAP: "0", STARTER_DEEPSEEK_WEEKLY_USD_CAP: "8" });
    db(service).prepare("UPDATE people SET batch_flag = 1 WHERE github_id = ?").run(NEWBIE.id);
    type Allowance = { tokensPerWeek: number; budgets: { gpt6: { usdPerWeek: number | null }; deepseek: { usdPerWeek: number | null } } };
    const listed = async () => {
      const people = ((await (await service.request("GET", "/v1/admin/people", { token: admin })).json()) as { people: Array<{ githubId: number; allowance: Allowance }> }).people;
      return people.find((person) => person.githubId === NEWBIE.id)!.allowance;
    };
    const detail = async () => ((await (await service.request("GET", `/v1/admin/people/${NEWBIE.id}`, { token: admin })).json()) as { allowance: Allowance }).allowance;
    for (const view of [await listed(), await detail()]) {
      assert.equal(view.tokensPerWeek, 1_000_000);
      assert.equal(view.budgets.deepseek.usdPerWeek, 8);
      assert.equal(view.budgets.gpt6.usdPerWeek, 0);
    }
    // What the person gets: DeepSeek works on the start grant.
    assert.equal(await weekly(service, token), 1_000_000);
    assert.equal((await chat(service, token)).status, 200);
    // With the allocator off, the list says 0 again, as the requests do.
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { allocator: "off" } })).status, 200);
    assert.equal((await listed()).tokensPerWeek, 0);
    assert.equal((await chat(service, token)).status, 403);
  });

  it("follows allocatorStartTokens, and is off with allocator \"off\"", async () => {
    const { service, admin, token } = await setup();
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { allocatorStartTokens: 2_000_000 } })).status, 200);
    assert.equal(await weekly(service, token), 2_000_000);
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { allocator: "off" } })).status, 200);
    assert.equal(await weekly(service, token), 500_000);
    assert.equal((await service.request("POST", "/v1/admin/config", { token: admin, body: { allocator: "maybe" } })).status, 400);
  });

  it("never lowers a higher allowance", async () => {
    const { service } = await setup({ STARTER_WEEKLY_TOKENS: "20000000" });
    const token = (await service.signIn({ id: 301, login: "other", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 })).access_token;
    assert.equal(await weekly(service, token), 20_000_000);
    // A Full account keeps Full (DeepSeek has no token cap there).
    const full = (await service.signIn({ id: 302, login: "veteran", createdAt: "2015-01-01T00:00:00Z", publicRepos: 0, contributions: 400, activeWeeks: 40 })).access_token;
    assert.equal(await weekly(service, full), null);
  });

  it("is on by default", () => {
    const config = readFreeConfig({ TOKEN_SIGNING_KEY: "x".repeat(40), GITHUB_CLIENT_ID: "a", GITHUB_CLIENT_SECRET: "b" });
    assert.equal(config.allocator, "on");
    assert.equal(config.allocatorStartTokens, 1_000_000);
  });
});

describe("decisions", () => {
  it("runs once when 80% is used, and a \"10m\" answer raises the allowance", async () => {
    const { service, token, charge } = await setup();
    charge.tokens = 700_000;
    await chat(service, token);
    await service.settle();
    assert.equal(allocatorCalls(service).length, 0, "70% doesn't trigger");
    charge.tokens = 150_000;
    await chat(service, token);
    await service.settle();
    assert.equal(allocatorCalls(service).length, 1);
    const call = allocatorCalls(service)[0]!.body;
    assert.equal(call.temperature, 0);
    assert.deepEqual(call.reasoning, { effort: "low" });
    assert.equal(call.max_tokens, 600);
    assert.match(String(call.user), /^dl-[0-9a-f]{32}$/, "a safety identifier, never the GitHub id");
    const [row] = rows(service);
    assert.equal(row!.outcome, "10m");
    assert.equal(row!.from_tokens, 1_000_000);
    assert.equal(row!.to_tokens, 10_000_000);
    assert.equal(row!.error, null);
    assert.ok(JSON.parse(String(row!.inputs)).requests >= 2);
    assert.equal(await weekly(service, token), 10_000_000);
  });

  it("decides once per step in 24 hours", async () => {
    const { service, token, charge } = await setup({}, () => answer(decide("stay", "Too little history")));
    charge.tokens = 850_000;
    await chat(service, token);
    await service.settle();
    charge.tokens = 10_000;
    await chat(service, token);
    await service.settle();
    assert.equal(allocatorCalls(service).length, 1);
    assert.equal(rows(service)[0]!.outcome, "stay");
    assert.equal(await weekly(service, token), 1_000_000);
    service.clock.now += DAY + 1;
    const fresh = (await service.signIn(NEWBIE)).access_token;
    await chat(service, fresh);
    await service.settle();
    assert.equal(allocatorCalls(service).length, 2, "a day later it may decide again");
  });

  it("can't raise past a high-risk label", async () => {
    const { service, token, charge } = await setup();
    db(service)
      .prepare("INSERT INTO use_descriptions (github_id, session_id, day, use, risk, category, model, created_at) VALUES (?, 's', ?, 'x', 'high', 'malware', 'm', ?)")
      .run(NEWBIE.id, Math.floor(service.clock.now / DAY), service.clock.now - 1000);
    charge.tokens = 900_000;
    await chat(service, token);
    await service.settle();
    const [row] = rows(service);
    assert.equal(row!.decision, "10m");
    assert.equal(row!.outcome, "stay");
    assert.equal(row!.rule, "risk");
    assert.equal(await weekly(service, token), 1_000_000);
  });

  it("changes nothing on a malformed answer", async () => {
    const { service, token, charge } = await setup({}, () => answer("I think they deserve more"));
    charge.tokens = 900_000;
    await chat(service, token);
    await service.settle();
    const [row] = rows(service);
    assert.equal(row!.outcome, "error");
    assert.equal(row!.error, "unparsable");
    assert.equal(await weekly(service, token), 1_000_000);
  });

  it("lists decisions and daily counts for admins", async () => {
    const { service, admin, token, charge } = await setup();
    charge.tokens = 900_000;
    await chat(service, token);
    await service.settle();
    assert.equal((await service.request("GET", "/v1/admin/allocator?days=1", { token })).status, 403);
    assert.equal((await service.request("GET", "/v1/admin/allocator?days=0", { token: admin })).status, 400);
    const body = (await (await service.request("GET", "/v1/admin/allocator?days=1", { token: admin })).json()) as {
      decisions: Array<Record<string, unknown>>;
      daily: Array<Record<string, unknown>>;
    };
    assert.equal(body.decisions.length, 1);
    assert.equal(body.decisions[0]!.login, "newbie");
    assert.equal(body.decisions[0]!.outcome, "10m");
    assert.equal(body.decisions[0]!.model, ALLOCATOR_MODEL);
    assert.equal(body.daily[0]!.raised10m, 1);
  });
});

describe("never stuck on our system", () => {
  it("waits for a pending decision when the allowance runs out", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, token, charge } = await setup({}, async () => {
      await gate;
      return answer(decide("10m"));
    });
    charge.tokens = 999_900;
    await chat(service, token);
    for (let i = 0; i < 100 && rows(service).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(rows(service)[0]!.outcome, "pending");
    setTimeout(release, 300);
    charge.tokens = 1000;
    const response = await chat(service, token);
    assert.equal(response.status, 200, "served once the raise landed");
    assert.equal(rows(service)[0]!.outcome, "10m");
    await service.settle();
  });

  it("gives a 20% grace once a week when the allocator is down", async () => {
    const { service, token, charge } = await setup({}, () => new Response("upstream down", { status: 500 }));
    charge.tokens = 999_900;
    await chat(service, token);
    await service.settle();
    assert.equal(rows(service)[0]!.error, "http_500");
    charge.tokens = 150_000;
    assert.equal((await chat(service, token)).status, 200, "the grace serves it");
    assert.equal(await weekly(service, token), 1_200_000);
    charge.tokens = 60_000;
    assert.equal((await chat(service, token)).status, 200, "the last request may run over");
    const refused = await chat(service, token);
    assert.equal(refused.status, 402, "one grace a week");
    assert.equal(rows(service).filter((row) => row.outcome === "grace").length, 1);
    await service.settle();
  });

  it("gives the grace when the allocator is too slow", async () => {
    const { service, token, charge } = await setup({ ALLOCATOR_TIMEOUT_MS: "50" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return answer(decide("10m"));
    });
    charge.tokens = 999_900;
    await chat(service, token);
    await service.settle();
    assert.equal(rows(service)[0]!.error, "timeout");
    charge.tokens = 1000;
    assert.equal((await chat(service, token)).status, 200);
    assert.equal(rows(service).filter((row) => row.outcome === "grace").length, 1);
  });

  it("serves nothing to a blocked account", async () => {
    const { service, admin, token } = await setup();
    assert.equal((await service.request("POST", `/v1/admin/people/${NEWBIE.id}/block`, { token: admin })).status, 200);
    assert.notEqual((await chat(service, token)).status, 200);
    assert.equal(allocatorCalls(service).length, 0);
  });
});

const FACTS: AllocatorFacts = {
  githubId: 1,
  status: "active",
  level: "starter",
  levelReason: "account_too_new",
  batchFlagged: false,
  sharedDevice: false,
  networks: 1,
  github: { accountAgeDays: 30, publicRepos: 0, contributions: 3, followers: 0, activeWeeks: 1 },
  descriptions: [],
  descriptionCount: 10,
  highRisk: 0,
  sessions: 5,
  turns: 40,
  oneTurnSessions: 0,
  activeDays: 4,
  activeWeeks: 2,
  requestLog: { sessions: 5, keyedSessions: 5, requests: 200, oneShotSessions: 0, clients: { autopilot: 200, claudeCode: 0, opencode: 0 } },
  timing: { requests: 200, burstShare: 0.1, hoursOfDay: 8 },
  moderation: { block: 0, watch: 0, pass: 0 },
};

describe("hard rules", () => {
  it("raise one step at a time unless the account is old and used the service for weeks", () => {
    assert.deepEqual(finalStage("full", FACTS, "start"), { stage: "10m", rule: "one_step" });
    assert.deepEqual(finalStage("full", { ...FACTS, github: { ...FACTS.github, accountAgeDays: 800 } }, "start"), { stage: "full", rule: null });
    assert.deepEqual(finalStage("full", FACTS, "10m"), { stage: "full", rule: null });
  });

  it("cap farm signals at 10M", () => {
    const old = { ...FACTS, github: { ...FACTS.github, accountAgeDays: 800 } };
    assert.deepEqual(finalStage("full", { ...old, batchFlagged: true }, "start"), { stage: "10m", rule: "farm_cap" });
    assert.deepEqual(finalStage("full", { ...FACTS, sharedDevice: true }, "10m"), { stage: "10m", rule: "farm_cap" });
    assert.deepEqual(finalStage("full", { ...FACTS, levelReason: "network_limit" }, "10m"), { stage: "10m", rule: "farm_cap" });
    assert.deepEqual(finalStage("10m", { ...FACTS, batchFlagged: true }, "start"), { stage: "10m", rule: null });
  });

  it("can't raise after a moderation block or watch, and never for a blocked account", () => {
    assert.deepEqual(finalStage("10m", { ...FACTS, moderation: { block: 0, watch: 1, pass: 0 } }, "start"), { stage: "start", rule: "risk" });
    assert.deepEqual(finalStage("10m", { ...FACTS, status: "blocked" }, "start"), { stage: "start", rule: "blocked" });
  });

  it("never lower", () => {
    assert.deepEqual(finalStage("stay", FACTS, "10m"), { stage: "10m", rule: null });
    assert.deepEqual(finalStage("10m", FACTS, "10m"), { stage: "10m", rule: null });
  });
});

describe("pieces", () => {
  it("parses answers defensively", () => {
    assert.deepEqual(parseAllocation('```json\n{"decision":"10m","reason":"real work"}\n```'), { decision: "10m", reason: "real work" });
    assert.deepEqual(parseAllocation('{"decision":"FULL"}'), { decision: "full", reason: "(no reason given)" });
    assert.equal(parseAllocation('{"decision":"100m","reason":"x"}'), undefined);
    assert.equal(parseAllocation("{not json"), undefined);
    assert.equal(parseAllocation(undefined), undefined);
    assert.equal(parseAllocation(JSON.stringify({ decision: "stay", reason: "x".repeat(400) }))!.reason.length, 160);
  });

  it("applies the step, the start grant and the grace without ever lowering", () => {
    const settings: AllocatorSettings = { allocator: "on", allocatorStartTokens: 1_000_000, allocatorTriggerShare: 0.8, allocatorTimeoutMs: 5000, allocatorGraceShare: 0.2 };
    const base: Limits = { weeklyTokens: 50_000_000, weeklyUsd: 0, deepseekWeeklyUsd: 8, level: "starter", levelTokens: 500_000 };
    const steps = { starter: base, basic: { ...base, level: "basic" as const, levelTokens: 10_000_000 }, full: { weeklyTokens: 50_000_000, weeklyUsd: 2, deepseekWeeklyUsd: 8, level: "full" as const } };
    const week = 0;
    assert.equal(allocatedLimits(base, { settings, state: null, week, steps }).levelTokens, 1_000_000);
    assert.equal(allocatedLimits({ ...base, levelTokens: 20_000_000 }, { settings, state: null, week, steps }).levelTokens, 20_000_000);
    assert.equal(allocatedLimits(base, { settings, state: { stage: "10m", graceWeek: null, graceTokens: 0 }, week, steps }).levelTokens, 10_000_000);
    assert.equal(allocatedLimits(base, { settings, state: { stage: "full", graceWeek: null, graceTokens: 0 }, week, steps }).level, "full");
    assert.equal(allocatedLimits(base, { settings, state: { stage: "start", graceWeek: week, graceTokens: 200_000 }, week, steps }).levelTokens, 1_200_000);
    assert.equal(allocatedLimits(base, { settings, state: { stage: "start", graceWeek: week - 1, graceTokens: 200_000 }, week, steps }).levelTokens, 1_000_000, "last week's grace is gone");
    const zero = allocatedLimits({ ...base, levelTokens: 0, weeklyUsd: 0, deepseekWeeklyUsd: 0 }, { settings, state: null, week, steps });
    assert.equal(zero.levelTokens, 1_000_000);
    assert.equal(zero.deepseekWeeklyUsd, 8, "Starter's dollar budget with the grant");
    assert.deepEqual(allocatedLimits(base, { settings: { ...settings, allocator: "off" }, state: null, week, steps }), base);
  });

  it("adds one line to the daily digest", () => {
    const zero = { requests: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, freeCreditUsd: 0, openRouterUsd: 0 };
    const digest = dailyDigestAlert({
      date: "2026-11-04",
      signups: { count: 0, people: [] },
      active: 0,
      usage: zero,
      payments: { count: 0, usd: 0 },
      installs: { ok: 0, failed: 0, platforms: [], failedSteps: [] },
      week: { start: "2026-11-02", signups: 0, active: 0, usage: zero, payments: { count: 0, usd: 0 }, creditBudgetUsd: undefined },
      credit: { balanceUsd: 0, leftUsd: 0 },
      queueWaiting: 0,
      paused: false,
      allocator: { raised10m: 3, raisedFull: 1, stayed: 5, errors: 0, graces: 2 },
    });
    assert.match(digest.text, /^Allocator: 3 raised to 10M, 1 to full, 5 stayed, 2 graces\. /m);
  });
});

// ─── Every coding agent ───────────────────────────────────────────────────

interface Fixture {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Fixture;

/** How each agent reaches the service: Autopilot with its access token, OpenCode and Claude Code with dl's harness keys. */
const CLIENTS = [
  { name: "Autopilot", harness: null, path: "/v1/chat/completions", fixture: fixture("allocator-autopilot-chat.json") },
  { name: "OpenCode", harness: "opencode", path: "/v1/chat/completions", fixture: fixture("allocator-opencode-chat.json") },
  { name: "Claude Code", harness: "claude-code", path: "/anthropic/v1/messages?beta=true", fixture: fixture("allocator-claude-code-messages.json") },
] as const;

async function clientSetup(client: (typeof CLIENTS)[number], allocate: Allocate = () => answer(decide("10m"))) {
  const world = await setup({ OTHER_HARNESS_SHARE: "1" }, allocate);
  let key = world.token;
  if (client.harness) {
    const minted = await world.service.request("POST", "/v1/harness-keys", { token: world.token, body: { harness: client.harness } });
    assert.equal(minted.status, 201, await minted.clone().text());
    key = ((await minted.json()) as { key: string }).key;
  }
  const send = async () => {
    const response = await world.service.request("POST", client.path, { token: key, headers: client.fixture.headers, body: client.fixture.body });
    await response.text();
    return response;
  };
  return { ...world, send };
}

for (const client of CLIENTS) {
  describe(`every agent: ${client.name}`, () => {
    it("triggers at 80% and a raise lands, with sessions read from the request log", async () => {
      const { service, token, charge, send } = await clientSetup(client);
      charge.tokens = 850_000;
      assert.equal((await send()).status, 200);
      await service.settle();
      assert.equal(allocatorCalls(service).length, 1);
      const [row] = rows(service);
      assert.equal(row!.outcome, "10m");
      const inputs = JSON.parse(String(row!.inputs)) as Record<string, number>;
      assert.equal(inputs.logSessions, 1);
      const counted = client.harness === "claude-code" ? inputs.claudeCodeRequests : client.harness === "opencode" ? inputs.opencodeRequests : inputs.autopilotRequests;
      assert.equal(counted, 1);
      const prompt = String((allocatorCalls(service)[0]!.body.messages as Array<{ content: string }>)[1]!.content);
      assert.match(prompt, /Sessions from the request log/);
      assert.equal(await weekly(service, token), 10_000_000);
      const keys = db(service).prepare("SELECT session_key FROM requests WHERE github_id = ?").all(NEWBIE.id) as Array<{ session_key: string | null }>;
      const expected = client.harness === "claude-code" ? "7c9e6679-7425-40de-944b-e07fc1f90ae7" : client.harness === "opencode" ? null : "ap-3f1c2a7e-0b9d-4c55-9f0e-1d2b3c4d5e6f";
      assert.deepEqual(keys.map((k) => k.session_key), [expected]);
    });

    it("waits for a pending raise when the allowance runs out", async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { service, charge, send } = await clientSetup(client, async () => {
        await gate;
        return answer(decide("10m"));
      });
      charge.tokens = 999_900;
      assert.equal((await send()).status, 200);
      for (let i = 0; i < 100 && rows(service).length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      setTimeout(release, 200);
      charge.tokens = 1000;
      assert.equal((await send()).status, 200);
      assert.equal(rows(service)[0]!.outcome, "10m");
      await service.settle();
    });

    it("gets the grace when the allocator is down", async () => {
      const { service, charge, send } = await clientSetup(client, () => new Response("down", { status: 502 }));
      charge.tokens = 999_900;
      assert.equal((await send()).status, 200);
      await service.settle();
      charge.tokens = 1000;
      assert.equal((await send()).status, 200, "served on the grace");
      assert.equal(rows(service).filter((row) => row.outcome === "grace").length, 1);
    });
  });
}

describe("session keys", () => {
  it("come from each agent's own session id", () => {
    assert.equal(sessionKeyOf(new Headers({ "x-session-id": "a" }), {}), "a");
    assert.equal(sessionKeyOf(new Headers(), { session_id: "b" }), "b");
    assert.equal(sessionKeyOf(new Headers({ "x-claude-code-session-id": "c" }), {}), "c");
    assert.equal(sessionKeyOf(new Headers(), {}, "d"), "d");
    assert.equal(sessionKeyOf(new Headers(), {}), null);
    assert.equal(anthropicSessionHint({ metadata: { user_id: "user_ab_account__session_7c9e6679-7425-40de-944b-e07fc1f90ae7" } }), "7c9e6679-7425-40de-944b-e07fc1f90ae7");
    assert.equal(anthropicSessionHint({ metadata: { user_id: "someone" } }), undefined);
  });

  it("split requests without one by idle time", () => {
    const at = (minutes: number) => minutes * 60_000;
    const log = logSessions([
      { at: at(0), sessionKey: null, harness: "opencode" },
      { at: at(5), sessionKey: null, harness: "opencode" },
      { at: at(10), sessionKey: null, harness: "opencode" },
      { at: at(10) + ALLOCATOR_IDLE_MS + 1, sessionKey: null, harness: "opencode" },
      { at: at(200), sessionKey: "s1", harness: null },
      { at: at(201), sessionKey: "s1", harness: null },
      { at: at(202), sessionKey: "s1", harness: "claude-code" },
    ]);
    assert.deepEqual(log, { sessions: 3, keyedSessions: 1, requests: 7, oneShotSessions: 1, clients: { autopilot: 2, claudeCode: 1, opencode: 4 } });
  });
});
