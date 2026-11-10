import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

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
  /** The primary verified email /user/emails reports (default `<login>@example.com`; null: none). */
  email?: string | null;
  createdAt?: string;
  /** `public_repos` on GitHub's /user (default 3: a Full account). */
  publicRepos?: number;
  /** Followers on the GraphQL viewer (default 0). */
  followers?: number;
  /** Private contributions the person shows (default 0). */
  restrictedContributions?: number;
  /**
   * What GitHub's GraphQL API answers for the last year's contributions (default 0):
   * a count, "error" (HTTP 502) or "throw" (the fetch itself fails).
   */
  contributions?: number | "error" | "throw";
  /** Weeks of the contribution calendar with a contribution (default 0). */
  activeWeeks?: number;
  /** Pull requests opened in the last year, counted as contributions to others' work (default 0). */
  pullRequests?: number;
  /** Commits to repositories other accounts own (default 0). */
  outsideCommits?: number;
  /**
   * When the oldest owned repository was created: default the account's creation, when it has
   * public repositories (so an old account passes this check); null for none.
   */
  repoCreatedAt?: string | null;
  /** The oldest owned repository is a fork (default false). */
  repoIsFork?: boolean;
  /** Accounts followed plus repositories starred (default 10). */
  social?: number;
}

export type OpenRouterHandler = (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>;

export interface Service {
  env: Record<string, unknown>;
  clock: { now: number };
  handler: { fetch(request: Request, env: never): Promise<Response> };
  calls: {
    openRouter: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>;
    /** Calls to Luminal's chat completions (a fake: nothing leaves the process). */
    luminal: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>;
    /** Calls to OpenAI's Responses API (a fake: nothing leaves the process). */
    openai: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>;
    githubTokens: Array<{ code: string; redirect_uri?: string }>;
    /** Contribution lookups on GitHub's GraphQL API, by login. */
    githubGraphql: string[];
    /** Unauthenticated profile reads (GET https://api.github.com/users/<login>): login and headers. */
    githubProfiles: Array<{ login: string; headers: Record<string, string> }>;
    /** Posts to ALERT_WEBHOOK_URL (any URL on alerts.test, discord.com, hooks.slack.com or api.telegram.org). */
    webhooks: Array<{ url: string; body: Record<string, unknown> }>;
    /** Messages sent through the fake ALERT_EMAIL binding (with `email: true`). */
    emails: Array<{ from: string; to: string; raw: string }>;
    /** Calls to api.stripe.com: path, form body (decoded) and headers. */
    stripe: Array<{ path: string; form: URLSearchParams; headers: Record<string, string> }>;
    /** Calls to Resend (https://api.resend.com/emails): JSON body and headers. Nothing leaves the process. */
    resend: Array<{ body: Record<string, unknown>; headers: Record<string, string> }>;
    /** Messages sent through the fake USER_EMAIL binding (Cloudflare Email Service, with `userEmail: true`). */
    userEmail: Array<Record<string, unknown>>;
  };
  /** Answers sends through the fake USER_EMAIL binding (default: `{messageId}`); throw to refuse one. */
  setUserEmail(handler: (message: Record<string, unknown>) => { messageId: string } | Promise<{ messageId: string }>): void;
  /** Answers calls to Resend (default: 200 with an id). */
  setResend(handler: (body: Record<string, unknown>) => Response | Promise<Response>): void;
  /** Answers calls to api.stripe.com (default: a Checkout or portal session with a URL). */
  setStripe(handler: (path: string, form: URLSearchParams) => Response | Promise<Response>): void;
  setOpenRouter(handler: OpenRouterHandler): void;
  /** Answers GET https://api.github.com/users/<login> (default: a profile with no public email). */
  setGithubProfile(handler: (login: string) => Response | Promise<Response>): void;
  /** Answers calls to Luminal (default: a completion with Luminal-shaped usage, no cost). */
  setLuminal(handler: OpenRouterHandler): void;
  /** Answers calls to OpenAI's Responses API (default: a "hi" response, streamed when asked, with Responses usage). */
  setOpenAI(handler: OpenRouterHandler): void;
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

/** A usage object the way Luminal reports it: cached tokens, but no cost. */
export function luminalUsage(prompt: number, completion: number, cached = 0): Record<string, unknown> {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

/** A usage object the way OpenAI's Responses API reports it: cached and reasoning tokens, no cost. */
export function responsesUsage(input: number, output: number, cached = 0, reasoning = 0): Record<string, unknown> {
  return {
    input_tokens: input,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoning },
    total_tokens: input + output,
  };
}

/** A Responses `response` object; `output` defaults to one "hi" message. */
export function responseObject(usageObject: Record<string, unknown> | undefined, options: { output?: unknown[]; status?: string; incompleteReason?: string; model?: string } = {}): Record<string, unknown> {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1_790_000_000,
    status: options.status ?? "completed",
    error: null,
    incomplete_details: options.incompleteReason ? { reason: options.incompleteReason } : null,
    model: options.model ?? "gpt-6-luna",
    output: options.output ?? [messageItem("hi")],
    ...(usageObject ? { usage: usageObject } : {}),
  };
}

/** A Responses output message with one output_text part. */
export function messageItem(text: string): Record<string, unknown> {
  return { type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] };
}

/** A Responses function_call output item. */
export function functionCallItem(callId: string, name: string, args: string): Record<string, unknown> {
  return { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args, status: "completed" };
}

/** A non-streaming Responses answer. */
export function openaiResponse(usageObject: Record<string, unknown> | undefined, options: Parameters<typeof responseObject>[1] = {}): Response {
  return Response.json(responseObject(usageObject, options));
}

/** A Responses event stream (`event:` and `data:` lines, no `[DONE]`), as OpenAI sends it. */
export function responsesSse(events: Array<Record<string, unknown>>, options: { split?: boolean } = {}): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (options.split) for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      else controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

/** The events of a streamed response that says `text`, then finishes with `usageObject`. */
export function responsesTextEvents(text: string, usageObject: Record<string, unknown> | undefined, options: { status?: string; incompleteReason?: string } = {}): Array<Record<string, unknown>> {
  const done = responseObject(usageObject, { output: [messageItem(text)], ...options });
  return [
    { type: "response.created", response: { ...done, status: "in_progress", output: [], usage: null } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
    ...[...text].map((character) => ({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: character })),
    { type: "response.output_item.done", output_index: 0, item: messageItem(text) },
    { type: options.status === "incomplete" ? "response.incomplete" : "response.completed", response: done },
  ];
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

export async function createService(vars: Record<string, string> = {}, options: { email?: boolean; userEmail?: boolean } = {}): Promise<Service> {
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
    // Tests sign many accounts up from @example.com; the per-domain daily cap has its own tests.
    DOMAIN_SIGNUPS_PER_DAY: "100000",
    ...vars,
    ...namespaces,
  };
  const clock = { now: NOW };
  const calls: Service["calls"] = { openRouter: [], luminal: [], openai: [], githubTokens: [], githubGraphql: [], githubProfiles: [], webhooks: [], emails: [], stripe: [], resend: [], userEmail: [] };
  let resend = (_body: Record<string, unknown>): Response | Promise<Response> => Response.json({ id: `email-${calls.resend.length}` });
  let stripe = (path: string, _form?: URLSearchParams): Response | Promise<Response> =>
    path === "/v1/checkout/sessions"
      ? Response.json({ id: `cs_test_${calls.stripe.length}`, url: `https://checkout.stripe.com/c/pay/cs_test_${calls.stripe.length}` })
      : Response.json({ id: "bps_test_1", url: "https://billing.stripe.com/p/session/test_1" });
  let userEmail = (_message: Record<string, unknown>): { messageId: string } | Promise<{ messageId: string }> => ({ messageId: `cf-${calls.userEmail.length}` });
  if (options.userEmail) {
    envRef.env.USER_EMAIL = {
      async send(message: Record<string, unknown>) {
        calls.userEmail.push(structuredClone(message));
        return userEmail(message);
      },
    };
  }
  if (options.email) {
    envRef.env.ALERT_EMAIL = {
      async send(message: { from: string; to: string; raw: string }) {
        calls.emails.push({ from: message.from, to: message.to, raw: message.raw });
      },
    };
  }
  let openRouter: OpenRouterHandler = () => completion(usage(100, 10));
  let githubProfile = (login: string): Response | Promise<Response> => Response.json({ login, email: null });
  let luminal: OpenRouterHandler = () => completion(luminalUsage(100, 10));
  let openai: OpenRouterHandler = (body) => (body.stream ? responsesSse(responsesTextEvents("hi", responsesUsage(100, 10))) : openaiResponse(responsesUsage(100, 10)));

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
      return Response.json({ id: user.id, login: user.login, created_at: user.createdAt ?? "2015-01-01T00:00:00Z", public_repos: user.publicRepos ?? 3, followers: 0 });
    }
    if (url === "https://api.github.com/user/emails") {
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer token-for-", "") ?? "";
      const user = JSON.parse(decodeURIComponent(token)) as GitHubUserFixture;
      // One inbox per test account (the sign-up refuses a second account on the same inbox).
      const email = user.email === undefined ? `${user.login.toLowerCase()}.${user.id}@example.com` : user.email;
      return Response.json(email === null ? [] : [{ email, primary: true, verified: true, visibility: "private" }]);
    }
    if (url.startsWith("https://api.github.com/users/")) {
      const login = decodeURIComponent(url.slice("https://api.github.com/users/".length));
      calls.githubProfiles.push({ login, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return githubProfile(login);
    }
    if (url === "https://api.github.com/graphql") {
      const token = new Headers(init.headers).get("authorization")?.replace("Bearer token-for-", "") ?? "";
      const user = JSON.parse(decodeURIComponent(token)) as GitHubUserFixture;
      calls.githubGraphql.push(user.login);
      assert.match(String(init.body), /viewer \{ login followers \{ totalCount \} following \{ totalCount \} starredRepositories \{ totalCount \}/);
      assert.match(String(init.body), /repositories\(ownerAffiliations: OWNER, first: 5, orderBy: \{ field: CREATED_AT, direction: ASC \}\)/);
      assert.match(String(init.body), /commitContributionsByRepository\(maxRepositories: 25\)/);
      assert.match(String(init.body), /contributionCalendar \{ totalContributions weeks \{ contributionDays \{ contributionCount/);
      if (user.contributions === "throw") throw new TypeError("fetch failed");
      if (user.contributions === "error") return Response.json({ message: "Server Error" }, { status: 502 });
      const repoAt = user.repoCreatedAt !== undefined ? user.repoCreatedAt : (user.publicRepos ?? 3) > 0 ? (user.createdAt ?? "2015-01-01T00:00:00Z") : null;
      const social = user.social ?? 10;
      return Response.json({
        data: {
          viewer: {
            login: user.login,
            followers: { totalCount: user.followers ?? 0 },
            following: { totalCount: Math.floor(social / 2) },
            starredRepositories: { totalCount: social - Math.floor(social / 2) },
            repositories: { nodes: repoAt === null ? [] : [{ createdAt: repoAt, isFork: user.repoIsFork ?? false }] },
            contributionsCollection: {
              restrictedContributionsCount: user.restrictedContributions ?? 0,
              totalPullRequestContributions: user.pullRequests ?? 0,
              totalIssueContributions: 0,
              totalPullRequestReviewContributions: 0,
              commitContributionsByRepository: [
                { repository: { owner: { login: user.login } }, contributions: { totalCount: 40 } },
                ...((user.outsideCommits ?? 0) > 0 ? [{ repository: { owner: { login: "someone-else" } }, contributions: { totalCount: user.outsideCommits } }] : []),
              ],
              contributionCalendar: {
                totalContributions: user.contributions ?? 0,
                weeks: Array.from({ length: 53 }, (_, week) => ({ contributionDays: Array.from({ length: 7 }, (_, d) => ({ contributionCount: week < (user.activeWeeks ?? 0) && d === 0 ? 1 : 0 })) })),
              },
            },
          },
        },
      });
    }
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.openRouter.push({ body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return openRouter(body, init);
    }
    if (url === "https://flash.luminal.cloud/v1/chat/completions") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.luminal.push({ body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return luminal(body, init);
    }
    if (url === "https://api.openai.com/v1/responses") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.openai.push({ body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return openai(body, init);
    }
    if (url === "https://api.resend.com/emails") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.resend.push({ body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return resend(body);
    }
    if (url.startsWith("https://api.stripe.com/")) {
      const path = new URL(url).pathname;
      const form = new URLSearchParams(String(init.body));
      calls.stripe.push({ path, form, headers: Object.fromEntries(new Headers(init.headers).entries()) });
      return stripe(path, form);
    }
    if (/^https:\/\/(alerts\.test|discord\.com|hooks\.slack\.com|api\.telegram\.org)\//.test(url)) {
      calls.webhooks.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("ok");
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const handler = createHandler({ now: () => clock.now, fetch: fetcher as never, emailGapMs: 0 });

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
    const flow = await startBrowserFlow(request, user, options.deviceId, options.invite ? { invite: options.invite } : {});
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
    setGithubProfile: (next) => {
      githubProfile = next;
    },
    setLuminal: (next) => {
      luminal = next;
    },
    setOpenAI: (next) => {
      openai = next;
    },
    setStripe: (next) => {
      stripe = next as never;
    },
    setResend: (next) => {
      resend = next;
    },
    setUserEmail: (next) => {
      userEmail = next;
    },
    request,
    signIn,
    directory: () => namespaces.DIRECTORY.getByName("directory"),
    account: (githubId) => namespaces.ACCOUNT.getByName(`gh:${githubId}`),
    namespaces: namespaces as never,
  };
}

/**
 * Runs the CLI's code request and the browser up to the page after GitHub. The details step
 * (email, and an invite code for Starter) is filled in and sent unless `stopAtDetails`: the
 * prefilled email, the updates box as given, and `invite` when the page has an invite field.
 */
export async function startBrowserFlow(
  request: Service["request"],
  user: GitHubUserFixture,
  deviceId?: string,
  options: { stopAtDetails?: boolean; invite?: string; email?: string; updates?: boolean } = {},
): Promise<{ deviceCode: string; userCode: string; page: string; status: number }> {
  const codeResponse = await request("POST", "/v1/device/code", { body: deviceId ? { device_id: deviceId } : {} });
  const issued = (await codeResponse.json()) as { device_code: string; user_code: string };
  const { state, cookie } = await authorize(request, issued.user_code);
  const callback = await request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify(user))}&state=${encodeURIComponent(state)}`, {
    headers: { cookie },
  });
  let page = await callback.text();
  let status = callback.status;
  if (!options.stopAtDetails && page.includes('action="/device/details"')) {
    const done = await submitDetails(request, page, options);
    page = done.page;
    status = done.status;
  }
  return { deviceCode: issued.device_code, userCode: issued.user_code, page, status };
}

/** Sends the details step's form from its page: the prefilled email unless `email` is given. */
export async function submitDetails(
  request: Service["request"],
  page: string,
  options: { invite?: string; email?: string; updates?: boolean } = {},
): Promise<{ page: string; status: number }> {
  const ticket = /name="ticket" value="([^"]+)"/.exec(page)![1]!;
  const prefilled = /name="email"[^>]*value="([^"]*)"/.exec(page)?.[1] ?? "";
  const form: Record<string, string> = { ticket, email: options.email ?? (prefilled || "someone@example.com") };
  if (options.updates) form.updates = "1";
  if (options.invite && page.includes('name="invite_code"')) form.invite_code = options.invite;
  const response = await request("POST", "/device/details", { form });
  return { page: await response.text(), status: response.status };
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
