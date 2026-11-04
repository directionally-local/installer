import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";

/**
 * A small in-process stand-in for the Workers runtime, enough to drive the free tier end to
 * end under node:test: Durable Objects get a real SQLite database (node:sqlite) behind
 * `ctx.storage.sql`, alarms are recorded rather than fired, and `cloudflare:workers` resolves
 * to a stub base class. GitHub and OpenRouter are fetch mocks.
 *
 * This file is test-only; it is not part of the Worker and is not under the portability gate.
 */

const STUB = `data:text/javascript,${encodeURIComponent(`
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export const env = {};
`)}`;

/** `cloudflare:email`'s EmailMessage, keeping what it was given so a fake binding can read it. */
const EMAIL_STUB = `data:text/javascript,${encodeURIComponent(`
export class EmailMessage { constructor(from, to, raw) { this.from = from; this.to = to; this.raw = raw; } }
`)}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return { url: STUB, format: "module", shortCircuit: true };
    if (specifier === "cloudflare:email") return { url: EMAIL_STUB, format: "module", shortCircuit: true };
    return next(specifier, context);
  },
});

type Row = Record<string, unknown>;

class FakeSql {
  constructor(private readonly db: DatabaseSync) {}

  exec<T = Row>(query: string, ...bindings: unknown[]) {
    const rows = this.db.prepare(query).all(...(bindings.map((value) => (value === undefined ? null : value)) as never[])) as T[];
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
        return rows[0]!;
      },
      rowsRead: rows.length,
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  }
}

export class FakeState {
  readonly db = new DatabaseSync(":memory:");
  alarm: number | null = null;
  readonly storage;

  constructor(readonly name: string) {
    const db = this.db;
    const sql = new FakeSql(db);
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const state = this;
    this.storage = {
      sql,
      async getAlarm() {
        return state.alarm;
      },
      async setAlarm(at: number | Date) {
        state.alarm = typeof at === "number" ? at : at.getTime();
      },
      async deleteAlarm() {
        state.alarm = null;
      },
      transactionSync<T>(callback: () => T): T {
        db.exec("BEGIN");
        try {
          const result = callback();
          db.exec("COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    };
  }

  get id() {
    return { toString: () => this.name, name: this.name };
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }
}

export class FakeNamespace<T> {
  readonly instances = new Map<string, { object: T; state: FakeState }>();

  constructor(
    private readonly Class: new (ctx: never, env: never) => T,
    private readonly envRef: { env: unknown },
  ) {}

  getByName(name: string): T {
    let entry = this.instances.get(name);
    if (!entry) {
      const state = new FakeState(name);
      entry = { object: new this.Class(state as never, this.envRef.env as never), state };
      this.instances.set(name, entry);
    }
    return entry.object;
  }

  idFromName(name: string) {
    return { toString: () => name, name };
  }

  get(id: { name?: string }): T {
    return this.getByName(id.name ?? String(id));
  }
}

export const SIGNING_KEY = "test-signing-key-test-signing-key-0123456789";
export const NOW = Date.parse("2026-11-04T12:00:00.000Z"); // a Wednesday
export const MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const ADMIN_ID = 1;

export interface GitHubUserFixture {
  id: number;
  login: string;
  createdAt?: string;
}

export type OpenRouterHandler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

export interface Service {
  env: Record<string, unknown>;
  clock: { now: number };
  handler: { fetch(request: Request, env: never): Promise<Response> };
  calls: {
    openRouter: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>;
    githubTokens: Array<{ code: string; redirect_uri?: string }>;
    /** Posts to ALERT_WEBHOOK_URL (any URL on alerts.test, discord.com, hooks.slack.com or api.telegram.org). */
    webhooks: Array<{ url: string; body: Record<string, unknown> }>;
    /** Messages sent through the fake ALERT_EMAIL binding (with `email: true`). */
    emails: Array<{ from: string; to: string; raw: string }>;
  };
  setOpenRouter(handler: OpenRouterHandler): void;
  request(method: string, path: string, options?: { body?: unknown; token?: string; headers?: Record<string, string>; form?: Record<string, string>; ip?: string }): Promise<Response>;
  signIn(user: GitHubUserFixture, options?: { invite?: string; deviceId?: string }): Promise<Tokens>;
  directory(): any;
  account(githubId: number): any;
  namespaces: Record<string, FakeNamespace<unknown>>;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** A usage object the way OpenRouter reports it. */
export function usage(prompt: number, completion: number, cached = 0, cost = 0.001): Record<string, unknown> {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cost, prompt_tokens_details: { cached_tokens: cached } };
}

export function completion(usageObject: Record<string, unknown> | undefined): Response {
  return new Response(
    JSON.stringify({ id: "gen-1", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: "hi" } }], ...(usageObject ? { usage: usageObject } : {}) }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function sse(chunks: string[], options: { split?: boolean } = {}): Response {
  const text = chunks.map((chunk) => `data: ${chunk}\n\n`).join("") + "data: [DONE]\n\n";
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.split) {
        // Deliver in awkward 7-byte pieces so lines and UTF-8 straddle chunk boundaries.
        for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      } else {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export async function createService(vars: Record<string, string> = {}, options: { email?: boolean } = {}): Promise<Service> {
  const [{ createHandler }, { AuthObject }, { DirectoryObject }, { AccountObject }, { RateLimiterObject }] = await Promise.all([
    import("../src/app.js"),
    import("../src/auth-object.js"),
    import("../src/directory-object.js"),
    import("../src/account-object.js"),
    import("../src/rate-limit-object.js"),
  ]);
  const envRef: { env: Record<string, unknown> } = { env: {} };
  const namespaces = {
    AUTH: new FakeNamespace(AuthObject as never, envRef),
    DIRECTORY: new FakeNamespace(DirectoryObject as never, envRef),
    ACCOUNT: new FakeNamespace(AccountObject as never, envRef),
    RATE_LIMITER: new FakeNamespace(RateLimiterObject as never, envRef),
  };
  envRef.env = {
    OPENROUTER_API_KEY: "sk-or-test",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    TOKEN_SIGNING_KEY: SIGNING_KEY,
    ADMIN_GITHUB_IDS: String(ADMIN_ID),
    ...vars,
    ...namespaces,
  };
  const clock = { now: NOW };
  const calls: Service["calls"] = { openRouter: [], githubTokens: [], webhooks: [], emails: [] };
  if (options.email) {
    envRef.env.ALERT_EMAIL = {
      async send(message: { from: string; to: string; raw: string }) {
        calls.emails.push({ from: message.from, to: message.to, raw: message.raw });
      },
    };
  }
  let openRouter: OpenRouterHandler = () => completion(usage(100, 10));

  const fetcher = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      const body = JSON.parse(String(init.body)) as { code: string; client_secret: string; redirect_uri?: string };
      calls.githubTokens.push({ code: body.code, ...(body.redirect_uri !== undefined ? { redirect_uri: body.redirect_uri } : {}) });
      if (body.client_secret !== "gh-secret" || body.code === "bad") return Response.json({ error: "bad_verification_code" });
      return Response.json({ access_token: `token-for-${body.code}`, token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer token-for-", "") ?? "";
      const user = JSON.parse(decodeURIComponent(token)) as GitHubUserFixture;
      return Response.json({ id: user.id, login: user.login, created_at: user.createdAt ?? "2015-01-01T00:00:00Z" });
    }
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.openRouter.push({ body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return openRouter(body, init);
    }
    if (/^https:\/\/(alerts\.test|discord\.com|hooks\.slack\.com|api\.telegram\.org)\//.test(url)) {
      calls.webhooks.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("ok");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const handler = createHandler({ now: () => clock.now, fetch: fetcher as never });

  const request: Service["request"] = async (method, path, options = {}) => {
    const headers = new Headers(options.headers);
    headers.set("cf-connecting-ip", options.ip ?? "203.0.113.7");
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    let body: string | undefined;
    if (options.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(options.form).toString();
    } else if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    return handler.fetch(new Request(`https://free.test${path}`, { method, headers, body }), envRef.env as never);
  };

  const signIn: Service["signIn"] = async (user, options = {}) => {
    const flow = await startBrowserFlow(request, user, options.deviceId);
    if (flow.page.includes('name="invite_code"')) {
      if (!options.invite) throw new Error(`${user.login} needs an invite`);
      const ticket = /name="ticket" value="([^"]+)"/.exec(flow.page)![1]!;
      const page = await (await request("POST", "/device/invite", { form: { ticket, invite_code: options.invite } })).text();
      if (!page.includes("signed in")) throw new Error(`invite failed: ${page}`);
    } else if (!flow.page.includes("signed in")) {
      throw new Error(`sign-in failed: ${flow.page}`);
    }
    const response = await request("POST", "/v1/device/token", { body: { device_code: flow.deviceCode } });
    if (response.status !== 200) throw new Error(`token failed: ${await response.text()}`);
    return (await response.json()) as Tokens;
  };

  return {
    env: envRef.env,
    clock,
    handler: handler as never,
    calls,
    setOpenRouter: (next) => {
      openRouter = next;
    },
    request,
    signIn,
    directory: () => namespaces.DIRECTORY.getByName("directory"),
    account: (githubId) => namespaces.ACCOUNT.getByName(`gh:${githubId}`),
    namespaces: namespaces as never,
  };
}

/** Runs the CLI's code request and the browser up to the page after GitHub. */
export async function startBrowserFlow(
  request: Service["request"],
  user: GitHubUserFixture,
  deviceId?: string,
): Promise<{ deviceCode: string; userCode: string; page: string; status: number }> {
  const codeResponse = await request("POST", "/v1/device/code", { body: deviceId ? { device_id: deviceId } : {} });
  const issued = (await codeResponse.json()) as { device_code: string; user_code: string };
  const { state, cookie } = await authorize(request, issued.user_code);
  const callback = await request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify(user))}&state=${encodeURIComponent(state)}`, {
    headers: { cookie },
  });
  return { deviceCode: issued.device_code, userCode: issued.user_code, page: await callback.text(), status: callback.status };
}

export async function authorize(request: Service["request"], userCode: string): Promise<{ state: string; cookie: string; location: string }> {
  const response = await request("GET", `/device/authorize?user_code=${userCode}`);
  if (response.status !== 302) throw new Error(`authorize: ${response.status} ${await response.text()}`);
  const location = response.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  return { state, cookie, location };
}

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? "";
}

/** An invite code from the admin API, signing the admin in first if needed. */
export async function createInvite(service: Service, adminToken?: string): Promise<string> {
  const token = adminToken ?? (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const response = await service.request("POST", "/admin/invites", { token, body: { count: 1 } });
  const body = (await response.json()) as { invites: Array<{ code: string }> };
  return body.invites[0]!.code;
}
