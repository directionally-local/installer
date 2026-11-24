import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, errorCode, luminalUsage, MODEL, type Service } from "./harness.js";
import { forTool, toolName } from "../src/tool-keys.js";
import { AUTOPILOT_ONLY_REASON } from "../src/gpt6-clients.js";

/**
 * API keys for any tool (tool-keys.ts): a `dlk_` key of kind "tool" that an account in good
 * standing makes and pastes into Cursor, Cline, Zed, Aider… It draws from the same weekly
 * allowance (on the other agents' share), is never refused as dl_only, and keeps every other
 * guard: GPT-6 stays in Autopilot, account-pooling routers are refused, blocks hold.
 */

const LUNA = "gpt-6-luna";
const BOTH = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test" };
const CURSOR = { "user-agent": "Cursor/1.9 (darwin arm64)" };

async function world(vars: Record<string, string> = {}) {
  const service = await createService({ OPEN_ADMISSION: "true", ...BOTH, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token };
}

async function makeKey(service: Service, token: string, name = "cursor"): Promise<{ id: string; key: string; kind: string }> {
  const response = await service.request("POST", "/v1/keys", { token, body: { name, kind: "tool" } });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as never;
}

const chat = (service: Service, key: string, body: Record<string, unknown> = {}, headers: Record<string, string> = CURSOR) =>
  service.request("POST", "/v1/chat/completions", { token: key, headers, body: { model: MODEL, messages: [{ role: "user", content: "hello" }], ...body } });

async function errorOf(response: Response): Promise<{ code: string; message: string; reason?: string }> {
  return ((await response.json()) as { error: { code: string; message: string; reason?: string } }).error;
}

describe("tool keys: making and managing them", () => {
  it("lets an account in good standing make one without a grant, shown once, listed with its kind", async () => {
    const { service, token } = await world();
    const made = await makeKey(service, token);
    assert.equal(made.kind, "tool");
    assert.match(made.key, /^dlk_100_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    const list = (await (await service.request("GET", "/v1/keys", { token })).json()) as { keys: Array<Record<string, unknown>>; maxToolKeys: number; toolKeys: boolean };
    assert.equal(list.maxToolKeys, 3);
    assert.equal(list.toolKeys, true);
    assert.deepEqual(list.keys.map((key) => [key.name, key.kind, "key" in key]), [["cursor", "tool", false]]);
  });

  it("still needs a grant for a server key", async () => {
    const { service, token } = await world();
    const refused = await service.request("POST", "/v1/keys", { token, body: { name: "box" } });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "server_keys_unavailable");
  });

  it("allows at most toolKeysMax (3) per account, apart from server keys", async () => {
    const { service, admin, token } = await world();
    for (const name of ["a", "b", "c"]) await makeKey(service, token, name);
    const fourth = await service.request("POST", "/v1/keys", { token, body: { name: "d", kind: "tool" } });
    assert.equal(fourth.status, 409);
    assert.match((await errorOf(fourth)).message, /already has 3 API keys for other tools/);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { toolKeysMax: 4 } })).status, 200);
    assert.equal((await service.request("POST", "/v1/keys", { token, body: { name: "d", kind: "tool" } })).status, 201);
  });

  it("revokes a key: it stops working at once", async () => {
    const { service, token } = await world();
    const { id, key } = await makeKey(service, token);
    assert.equal((await chat(service, key)).status, 200);
    assert.equal((await service.request("DELETE", `/v1/keys/${id}`, { token })).status, 200);
    const after = await chat(service, key);
    assert.equal(after.status, 401);
    assert.equal(await errorCode(after), "invalid_key");
  });

  it("can't make, list or revoke keys itself", async () => {
    const { service, token } = await world();
    const { key } = await makeKey(service, token);
    assert.equal((await service.request("GET", "/v1/keys", { token: key })).status, 401);
    assert.equal((await service.request("POST", "/v1/keys", { token: key, body: { name: "x", kind: "tool" } })).status, 401);
  });

  it("refuses accounts below the bar with no free tokens", async () => {
    const service = await createService({ OPENAI_API_KEY: "sk-test", OPEN_ADMISSION: "true", STARTER_WEEKLY_TOKENS: "0", FULL_MIN_ACCOUNT_AGE_DAYS: "365", FULL_MIN_CONTRIBUTIONS: "100", FULL_MIN_PUBLIC_REPOS: "100000" });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const tokens = await service.signIn({ id: 200, login: "newbie", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 });
    const refused = await service.request("POST", "/v1/keys", { token: tokens.access_token, body: { name: "cursor", kind: "tool" } });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "tool_keys_unavailable");
  });

  it("refuses blocked accounts, and their existing keys stop working", async () => {
    const { service, admin, token } = await world();
    const { key } = await makeKey(service, token);
    assert.equal((await service.request("POST", "/admin/people/100/block", { token: admin })).status, 200);
    const used = await chat(service, key);
    assert.equal(used.status, 403);
    assert.equal(await errorCode(used), "blocked");
  });

  it("is turned off by the toolKeys setting: none made, existing ones refused but kept", async () => {
    const { service, admin, token } = await world();
    const { key } = await makeKey(service, token);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { toolKeys: false } })).status, 200);
    const made = await service.request("POST", "/v1/keys", { token, body: { name: "zed", kind: "tool" } });
    assert.equal(made.status, 403);
    assert.equal(await errorCode(made), "tool_keys_off");
    assert.equal(await errorCode(await chat(service, key)), "tool_keys_off");
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { toolKeys: null } })).status, 200);
    assert.equal((await chat(service, key)).status, 200);
  });

  it("refuses an unknown kind", async () => {
    const { service, token } = await world();
    const response = await service.request("POST", "/v1/keys", { token, body: { name: "x", kind: "admin" } });
    assert.equal(response.status, 400);
  });
});

describe("tool keys: using them", () => {
  it("is never refused as dl_only, and doesn't push the person's sign-in over it", async () => {
    const { service, token } = await world();
    const { key } = await makeKey(service, token);
    for (let index = 0; index < 25; index++) {
      assert.equal((await chat(service, key)).status, 200, `request ${index + 1}`);
      service.clock.now += 2_500;
    }
    // The person's own sign-in still has its whole dl_only grace.
    for (let index = 0; index < 20; index++) {
      assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 200);
      service.clock.now += 2_500;
    }
  });

  it("serves DeepSeek but holds GPT-6 back (Autopilot only), and doesn't list it", async () => {
    const { service, token } = await world();
    const { key } = await makeKey(service, token);
    const refused = await chat(service, key, { model: LUNA });
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "provider_limit");
    assert.equal(error.reason, AUTOPILOT_ONLY_REASON);
    const models = (await (await service.request("GET", "/v1/models", { token: key })).json()) as { data: Array<{ id: string }> };
    assert.ok(models.data.some((model) => model.id === MODEL));
    assert.ok(!models.data.some((model) => model.id.startsWith("gpt-6")), "no GPT-6 listed");
    // The same person's sign-in (Autopilot) still gets GPT-6.
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: LUNA, messages: [{ role: "user", content: "x" }] } })).status, 200);
  });

  it("refuses account-pooling routers", async () => {
    const { service, token } = await world();
    const { key } = await makeKey(service, token);
    const refused = await chat(service, key, {}, { "user-agent": "9Router/1.2" });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "proxy_not_allowed");
  });

  it("works on /v1/me but not on /v1/events", async () => {
    const { service, token } = await world();
    const { key } = await makeKey(service, token);
    assert.equal((await service.request("GET", "/v1/me", { token: key })).status, 200);
    const events = await service.request("POST", "/v1/events", { token: key, body: { events: [] } });
    assert.equal(events.status, 403);
    assert.equal(await errorCode(events), "tool_key_not_allowed");
  });

  it("works on the Anthropic endpoint, as x-api-key, served by DeepSeek", async () => {
    const { service, token } = await world();
    const { key } = await makeKey(service, token);
    const response = await service.request("POST", "/anthropic/v1/messages", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": "Zed/0.200" },
      body: { model: "claude-sonnet-4-5", max_tokens: 100, messages: [{ role: "user", content: "hello" }] },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(((await response.json()) as { type: string }).type, "message");
    assert.equal(service.calls.luminal.at(-1)?.body.model !== undefined, true);
  });

  it("has its own per-minute rate limit under the person's", async () => {
    const { service, admin, token } = await world();
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { toolKeyRequestsPerMinute: 2 } })).status, 200);
    const { key } = await makeKey(service, token);
    assert.equal((await chat(service, key)).status, 200);
    assert.equal((await chat(service, key)).status, 200);
    const limited = await chat(service, key);
    assert.equal(limited.status, 429);
    assert.equal(await errorCode(limited), "rate_limited");
    // Another key of the same person isn't held by it.
    const other = await makeKey(service, token, "zed");
    assert.equal((await chat(service, other.key)).status, 200);
  });

  it("gets the other agents' share of the week, in words for a tool, while Autopilot keeps the rest", async () => {
    const { service, token } = await world({ DEEPSEEK_WEEKLY_USD_CAP: "1" });
    const { key } = await makeKey(service, token);
    service.setLuminal(() => completion(luminalUsage(10_000_000, 0)));
    assert.equal((await chat(service, key)).status, 200);
    assert.equal((await chat(service, key)).status, 200);
    const refused = await chat(service, key);
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "harness_limit");
    assert.match(error.message, /^Other tools on a dl API key get half of your free allowance, and that part is used up\./);
    assert.equal((await service.request("POST", "/v1/chat/completions", { token, body: { model: MODEL, messages: [{ role: "user", content: "x" }] } })).status, 200);
  });

  it("records which tool sent each request, and shows admins per-tool usage", async () => {
    const { service, admin, token } = await world();
    const { key } = await makeKey(service, token);
    await chat(service, key);
    await chat(service, key, {}, { "user-agent": "OpenAI/Python 1.99.0", "x-title": "Cline" });
    await chat(service, key, {}, { "user-agent": "aider/0.90" });
    const rows = service.directory().ctx.storage.sql.exec("SELECT harness FROM requests WHERE github_id = 100 ORDER BY id").toArray().map((row: { harness: string }) => row.harness);
    assert.deepEqual(rows, ["tool:cursor", "tool:cline", "tool:aider"]);
    const usage = (await (await service.request("GET", "/admin/tool-usage", { token: admin })).json()) as { tools: Array<{ tool: string; requests: number; people: number }> };
    assert.deepEqual(usage.tools.map((row) => [row.tool, row.requests, row.people]).sort(), [["aider", 1, 1], ["cline", 1, 1], ["cursor", 1, 1]]);
  });
});

describe("tool-keys.ts", () => {
  it("names tools from the User-Agent and OpenRouter-style headers", () => {
    const name = (headers: Record<string, string>) => toolName(new Headers(headers));
    assert.equal(name({ "user-agent": "Cursor/1.9" }), "cursor");
    assert.equal(name({ "x-title": "Roo Code", "user-agent": "OpenAI/JS 5.0" }), "roo");
    assert.equal(name({ "x-title": "Kilo Code" }), "kilo");
    assert.equal(name({ "http-referer": "https://cline.bot" }), "cline");
    assert.equal(name({ "user-agent": "OpenAI/JS 5.0" }), "openai-sdk");
    assert.equal(name({ "user-agent": "Anthropic/JS 0.60" }), "anthropic-sdk");
    assert.equal(name({}), "other");
  });

  it("rewords Autopilot's refusals for a tool", () => {
    assert.equal(forTool("Out of GLM, switch with /model."), "Out of GLM, pick it in the tool's model setting.");
    assert.equal(forTool("Try later, or use your own key: /provider."), "Try later, or use your own provider key in the tool.");
  });
});
