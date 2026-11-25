import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, errorCode, luminalUsage, MODEL, type GitHubUserFixture, type Service } from "./harness.js";
import { allowedReturn, webCors } from "../src/web-signup.js";

/**
 * api.dl.new: its key page signs in with dl.new's web sign-in (returning to api.dl.new itself),
 * manages API keys for other tools through /web/keys with the web session, and shows the week as
 * tool keys see it (/web/me toolAllowance). The API itself is served on that host too (Cloudflare
 * routes api.dl.new/v1/* and /anthropic/* to this Worker).
 */

const API_PAGE = "https://api.dl.new/";
const API_ORIGIN = "https://api.dl.new";
const DL_ORIGIN = "https://dl.new";
const STATE = "api-page-state-0123456789";
const SECRET = "whsec_test_0123456789abcdef";
const VARS = { OPEN_ADMISSION: "true", LUMINAL_API_KEY: "lum-test", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_TOPUP: "price_topup123" };
const ghCode = (user: GitHubUserFixture) => encodeURIComponent(JSON.stringify(user));
const fromApi = { origin: API_ORIGIN };

/** The web sign-in started from api.dl.new: the redirect back there with the one-time code. */
async function signInFromApiPage(service: Service, user: GitHubUserFixture): Promise<Response> {
  const start = await service.request("GET", `/web/signin?return=${encodeURIComponent(API_PAGE)}&state=${STATE}`);
  assert.equal(start.status, 302, await start.clone().text());
  const location = new URL(start.headers.get("location")!);
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const callback = await service.request("GET", `/device/callback?code=${ghCode(user)}&state=${location.searchParams.get("state")}`, { headers: { cookie } });
  const page = await callback.clone().text();
  if (!page.includes('action="/device/details"')) return callback;
  const ticket = /name="ticket" value="([^"]+)"/.exec(page)![1]!;
  return service.request("POST", "/device/details", { form: { ticket, email: `${user.login}@example.com` } });
}

async function webToken(service: Service, user: GitHubUserFixture): Promise<string> {
  const back = await signInFromApiPage(service, user);
  assert.equal(back.status, 303);
  const location = back.headers.get("location")!;
  assert.ok(location.startsWith(`${API_PAGE}#signin=`), location);
  const response = await service.request("POST", "/web/session", { body: { code: location.slice(`${API_PAGE}#signin=`.length), state: STATE }, headers: fromApi });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), API_ORIGIN);
  return ((await response.json()) as { token: string }).token;
}

async function world() {
  const service = await createService(VARS);
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const web = await webToken(service, { id: 100, login: "alice" });
  return { service, admin, web };
}

interface KeyView {
  id: string;
  name: string;
  kind: string;
  key?: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastTool: string | null;
}

async function create(service: Service, web: string, name: string): Promise<KeyView> {
  const response = await service.request("POST", "/web/keys", { token: web, body: { name }, headers: fromApi });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()) as KeyView;
}

async function list(service: Service, web: string): Promise<{ keys: KeyView[]; max: number; toolKeys: boolean }> {
  const response = await service.request("GET", "/web/keys", { token: web, headers: fromApi });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as never;
}

const chat = (service: Service, key: string, headers: Record<string, string>, origin?: string) =>
  service.request("POST", "/v1/chat/completions", { token: key, headers, body: { model: MODEL, messages: [{ role: "user", content: "hi" }] }, ...(origin ? { origin } : {}) });

async function goPro(service: Service, githubId: number): Promise<void> {
  const { signatureHeader } = await import("../src/stripe.js");
  const session = {
    id: `cs_pro_${githubId}`,
    object: "checkout.session",
    mode: "subscription",
    client_reference_id: String(githubId),
    customer: `cus_${githubId}`,
    subscription: `sub_${githubId}`,
    payment_status: "paid",
    amount_subtotal: 399,
    amount_total: 399,
    metadata: { github_id: String(githubId), product: "pro" },
  };
  const body = JSON.stringify({ id: `evt_pro_${githubId}`, object: "event", type: "checkout.session.completed", created: Math.floor(service.clock.now / 1000), data: { object: session } });
  const header = await signatureHeader(SECRET, Math.floor(service.clock.now / 1000), body);
  assert.equal((await service.request("POST", "/v1/billing/webhook", { body, headers: { "stripe-signature": header } })).status, 200);
}

describe("api.dl.new: sign-in and CORS", () => {
  it("returns a web sign-in to api.dl.new's page, and still only to the configured pages", async () => {
    const service = await createService(VARS);
    await webToken(service, { id: 101, login: "bob" });
    for (const target of ["https://api.dl.new", "https://api.dl.new/x", "https://api.dl.new.evil.example/", "https://evil.example/"]) {
      const response = await service.request("GET", `/web/signin?return=${encodeURIComponent(target)}&state=${STATE}`);
      assert.equal(response.status, 400, target);
    }
    // WEB_API_URL moves it, and then only there.
    const staging = await createService({ ...VARS, WEB_API_URL: "https://api.staging.dl.new/" });
    assert.equal((await staging.request("GET", `/web/signin?return=${encodeURIComponent(API_PAGE)}&state=${STATE}`)).status, 400);
    assert.equal((await staging.request("GET", `/web/signin?return=${encodeURIComponent("https://api.staging.dl.new/")}&state=${STATE}`)).status, 302);
  });

  it("answers CORS for api.dl.new and dl.new, DELETE included, and refuses other sites", async () => {
    const { service, web } = await world();
    for (const origin of [API_ORIGIN, DL_ORIGIN]) {
      const preflight = await service.request("OPTIONS", "/web/keys", { headers: { origin, "access-control-request-method": "DELETE" } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
      assert.match(preflight.headers.get("access-control-allow-methods")!, /DELETE/);
      assert.equal((await service.request("GET", "/web/me", { token: web, headers: { origin } })).status, 200);
    }
    const evil = await service.request("GET", "/web/keys", { token: web, headers: { origin: "https://api.dl.new.evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal(await errorCode(evil), "forbidden_origin");
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  it("picks the return page and CORS origins by exact match", () => {
    const pages = ["https://dl.new/start", API_PAGE] as const;
    assert.equal(allowedReturn(null, [...pages]), "https://dl.new/start");
    assert.equal(allowedReturn("", [...pages]), "https://dl.new/start");
    assert.equal(allowedReturn(API_PAGE, [...pages]), API_PAGE);
    assert.equal(allowedReturn("https://api.dl.new/?x", [...pages]), undefined);
    assert.equal(webCors(null, [DL_ORIGIN, API_ORIGIN])["access-control-allow-origin"], undefined);
    assert.equal(webCors(API_ORIGIN, [DL_ORIGIN, API_ORIGIN])["access-control-allow-origin"], API_ORIGIN);
  });
});

describe("/web/keys", () => {
  it("makes a tool key with the web session, shown once, listed without its secret", async () => {
    const { service, web } = await world();
    const made = await create(service, web, "cursor");
    assert.equal(made.kind, "tool");
    assert.match(made.key!, /^dlk_100_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    assert.equal(made.lastTool, null);
    const listed = await list(service, web);
    assert.equal(listed.max, 3);
    assert.equal(listed.toolKeys, true);
    assert.deepEqual(listed.keys.map((key) => [key.id, key.name, key.kind, "key" in key]), [[made.id, "cursor", "tool", false]]);
    // The same key /v1/keys lists for dl api-key.
    assert.equal((await chat(service, made.key!, { "user-agent": "Cursor/1.9" })).status, 200);
  });

  it("is always kind tool, whatever is sent", async () => {
    const { service, web } = await world();
    const response = await service.request("POST", "/web/keys", { token: web, body: { name: "box", kind: "server" }, headers: fromApi });
    assert.equal(response.status, 201);
    assert.equal(((await response.json()) as KeyView).kind, "tool");
  });

  it("has the same checks and limits as tool-key creation", async () => {
    const { service, admin, web } = await world();
    const bad = await service.request("POST", "/web/keys", { token: web, body: { name: "" }, headers: fromApi });
    assert.equal(bad.status, 400);
    for (const name of ["a", "b", "c"]) await create(service, web, name);
    const fourth = await service.request("POST", "/web/keys", { token: web, body: { name: "d" }, headers: fromApi });
    assert.equal(fourth.status, 409);
    assert.equal(await errorCode(fourth), "key_limit_reached");
    const taken = await service.request("POST", "/web/keys", { token: web, body: { name: "a" }, headers: fromApi });
    assert.equal(await errorCode(taken), "key_limit_reached");
    // The toolKeys switch off: none made.
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { toolKeys: false, toolKeysMax: 5 } })).status, 200);
    const off = await service.request("POST", "/web/keys", { token: web, body: { name: "e" }, headers: fromApi });
    assert.equal(off.status, 403);
    assert.equal(await errorCode(off), "tool_keys_off");
  });

  it("refuses a name already taken", async () => {
    const { service, web } = await world();
    await create(service, web, "zed");
    const again = await service.request("POST", "/web/keys", { token: web, body: { name: "zed" }, headers: fromApi });
    assert.equal(again.status, 409);
    assert.equal(await errorCode(again), "key_name_taken");
  });

  it("refuses an account below the bar with no free tokens, as POST /v1/keys does", async () => {
    const service = await createService({ ...VARS, STARTER_WEEKLY_TOKENS: "0", FULL_MIN_ACCOUNT_AGE_DAYS: "365", FULL_MIN_CONTRIBUTIONS: "100", FULL_MIN_PUBLIC_REPOS: "100000" });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const web = await webToken(service, { id: 200, login: "newbie", createdAt: "2026-10-01T00:00:00Z", publicRepos: 0, contributions: 3 });
    const refused = await service.request("POST", "/web/keys", { token: web, body: { name: "cursor" }, headers: fromApi });
    assert.equal(refused.status, 403);
    assert.equal(await errorCode(refused), "tool_keys_unavailable");
  });

  it("revokes only the account's own tool keys", async () => {
    const { service, admin, web } = await world();
    const mine = await create(service, web, "cursor");
    const other = await webToken(service, { id: 102, login: "carol" });
    const theirs = await create(service, other, "cursor");
    // Another account's key: not found, and it keeps working.
    const wrong = await service.request("DELETE", `/web/keys/${theirs.id}`, { token: web, headers: fromApi });
    assert.equal(wrong.status, 404);
    assert.equal(await errorCode(wrong), "key_not_found");
    assert.equal((await chat(service, theirs.key!, { "user-agent": "Cursor/1.9" })).status, 200);
    // A server key isn't revoked here (nor listed).
    const server = await service.account(100).createKey({ name: "box", now: service.clock.now, kind: "server" });
    assert.ok(server.ok);
    assert.equal((await service.request("DELETE", `/web/keys/${server.view.id}`, { token: web, headers: fromApi })).status, 404);
    assert.deepEqual((await list(service, web)).keys.map((key) => key.name), ["cursor"]);
    // Its own tool key: revoked, and it stops working at once.
    const revoked = await service.request("DELETE", `/web/keys/${mine.id}`, { token: web, headers: fromApi });
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), { id: mine.id, revoked: true });
    assert.equal((await chat(service, mine.key!, { "user-agent": "Cursor/1.9" })).status, 401);
    assert.deepEqual((await list(service, web)).keys, []);
  });

  it("takes only a web session: not an access token, not a key", async () => {
    const { service } = await world();
    const access = (await service.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await service.request("GET", "/web/keys", { token: access, headers: fromApi })).status, 401);
    assert.equal((await service.request("GET", "/web/keys", { headers: fromApi })).status, 401);
    const { key } = (await (await service.request("POST", "/v1/keys", { token: access, body: { name: "k", kind: "tool" } })).json()) as { key: string };
    assert.equal((await service.request("POST", "/web/keys", { token: key, body: { name: "x" }, headers: fromApi })).status, 401);
  });

  it("refuses a blocked account", async () => {
    const { service, admin, web } = await world();
    assert.equal((await service.request("POST", "/admin/people/100/block", { token: admin })).status, 200);
    assert.equal((await service.request("GET", "/web/keys", { token: web, headers: fromApi })).status, 403);
    assert.equal((await service.request("POST", "/web/keys", { token: web, body: { name: "x" }, headers: fromApi })).status, 403);
  });

  it("answers only its methods", async () => {
    const { service, web } = await world();
    assert.equal((await service.request("PUT", "/web/keys", { token: web, headers: fromApi })).status, 405);
    assert.equal((await service.request("GET", "/web/keys/abcdefabcdef", { token: web, headers: fromApi })).status, 405);
    assert.equal((await service.request("DELETE", "/web/keys/not-an-id", { token: web, headers: fromApi })).status, 404);
  });
});

describe("lastTool", () => {
  it("keeps the tool a key was last used from, by name only, in /web/keys and /v1/keys", async () => {
    const { service, web } = await world();
    const made = await create(service, web, "mine");
    assert.equal((await chat(service, made.key!, { "user-agent": "Cursor/1.9 (darwin arm64)" })).status, 200);
    let [key] = (await list(service, web)).keys;
    assert.equal(key!.lastTool, "cursor");
    assert.ok(key!.lastUsedAt);
    // A minute later from another tool (within the last-used write interval): the tool still changes.
    service.clock.now += 1_000;
    assert.equal((await chat(service, made.key!, { "user-agent": "opencode/0.9 ai-sdk" })).status, 200);
    [key] = (await list(service, web)).keys;
    assert.equal(key!.lastTool, "opencode");
    const access = (await service.signIn({ id: 100, login: "alice" })).access_token;
    const v1 = (await (await service.request("GET", "/v1/keys", { token: access })).json()) as { keys: KeyView[] };
    assert.equal(v1.keys.find((entry) => entry.id === made.id)!.lastTool, "opencode");
    const stored = service.account(100).ctx.storage.sql.exec("SELECT last_tool FROM server_keys WHERE id = ?", made.id).toArray()[0];
    assert.equal(stored.last_tool, "opencode");
  });

  it("counts the Anthropic endpoint too", async () => {
    const { service, web } = await world();
    const made = await create(service, web, "claude");
    const response = await service.request("POST", "/anthropic/v1/messages", {
      headers: { "x-api-key": made.key!, "user-agent": "claude-cli/2.0 (external, cli)", "anthropic-version": "2023-06-01" },
      body: { model: "claude-sonnet-4-5", max_tokens: 50, messages: [{ role: "user", content: "hi" }] },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await list(service, web)).keys[0]!.lastTool, "claude-code");
  });
});

describe("/web/me toolAllowance", () => {
  it("is the week as tool keys see it: the other agents' share applied", async () => {
    const { service, web } = await world();
    const me = (await (await service.request("GET", "/web/me", { token: web, headers: fromApi })).json()) as {
      weeklyTokens: number;
      toolAllowance: { share: number; tokensPerWeek: number | null; usedThisWeek: number; resetsAt: string };
    };
    assert.equal(me.toolAllowance.share, 0.5);
    assert.equal(me.toolAllowance.usedThisWeek, 0);
    assert.ok(Number.isFinite(Date.parse(me.toolAllowance.resetsAt)));
    assert.ok(Date.parse(me.toolAllowance.resetsAt) > service.clock.now);
    if (me.toolAllowance.tokensPerWeek !== null && me.weeklyTokens > 0) assert.equal(me.toolAllowance.tokensPerWeek, Math.floor(me.weeklyTokens * 0.5), JSON.stringify(me));
    // What a tool key used shows up.
    const made = await create(service, web, "cursor");
    service.setLuminal(() => completion(luminalUsage(1000, 200)));
    assert.equal((await chat(service, made.key!, { "user-agent": "Cursor/1.9" })).status, 200);
    const after = (await (await service.request("GET", "/web/me", { token: web, headers: fromApi })).json()) as { toolAllowance: { usedThisWeek: number } };
    assert.ok(after.toolAllowance.usedThisWeek > 0, JSON.stringify(after.toolAllowance));
  });

  it("is all of it on Pro", async () => {
    const { service, web } = await world();
    await goPro(service, 100);
    const me = (await (await service.request("GET", "/web/me", { token: web, headers: fromApi })).json()) as { plan: string; toolAllowance: { share: number } };
    assert.equal(me.plan, "pro");
    assert.equal(me.toolAllowance.share, 1);
  });
});

describe("the API at api.dl.new", () => {
  it("serves chat completions and models when the host is api.dl.new", async () => {
    const { service, web } = await world();
    const made = await create(service, web, "cursor");
    assert.equal((await chat(service, made.key!, { "user-agent": "Cursor/1.9" }, API_ORIGIN)).status, 200);
    assert.equal((await service.request("GET", "/v1/models", { token: made.key!, origin: API_ORIGIN })).status, 200);
  });

  it("never makes links on api.dl.new: sign-in and device URLs use the service's own address", async () => {
    const service = await createService(VARS);
    const code = await service.request("POST", "/v1/device/code", { body: {}, origin: API_ORIGIN });
    assert.equal(code.status, 200, await code.clone().text());
    const body = (await code.json()) as { verification_uri: string; verification_uri_complete?: string };
    assert.ok(body.verification_uri.startsWith("https://free.directionallylocal.com/"), body.verification_uri);
    // With PUBLIC_URL set, that wins as before.
    const set = await createService({ ...VARS, PUBLIC_URL: "https://free.example" });
    const viaSet = (await (await set.request("POST", "/v1/device/code", { body: {}, origin: API_ORIGIN })).json()) as { verification_uri: string };
    assert.ok(viaSet.verification_uri.startsWith("https://free.example/"), viaSet.verification_uri);
    // Any other host keeps using its own origin (local and test setups).
    const local = (await (await service.request("POST", "/v1/device/code", { body: {} })).json()) as { verification_uri: string };
    assert.ok(local.verification_uri.startsWith("https://free.test/"), local.verification_uri);
  });

  it("routes only /v1/* and /anthropic/* on api.dl.new to this Worker", async () => {
    const { readFile } = await import("node:fs/promises");
    const config = JSON.parse(await readFile(new URL("../wrangler.cloudflare.jsonc", import.meta.url), "utf8")) as { routes: Array<{ pattern: string; zone_name?: string; custom_domain?: boolean }> };
    const api = config.routes.filter((route) => route.pattern.startsWith("api.dl.new"));
    assert.deepEqual(api, [
      { pattern: "api.dl.new/v1/*", zone_name: "dl.new" },
      { pattern: "api.dl.new/anthropic/*", zone_name: "dl.new" },
    ]);
    assert.ok(config.routes.some((route) => route.pattern === "free.directionallylocal.com" && route.custom_domain === true));
  });
});
