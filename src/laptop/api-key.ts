import { palette } from "../ui.js";
import { freeTierAccessToken, type FreeTierToken } from "./free-tier-token.js";
import { autopilotSignIn, type LaunchIO } from "./harness-launch.js";
import { PROXY_MODEL } from "./proxy.js";

/**
 * `dl api-key`: dl's free tokens in any OpenAI- or Anthropic-compatible tool (Cursor, Cline, Roo,
 * Kilo, Continue, Zed, Aider, OpenCode…), with no dl running. It makes an API key for the free
 * tier sign-in's account (POST /v1/keys {name, kind: "tool"}, services/free/src/tool-keys.ts)
 * and prints it once, with the base URLs to paste into the tool. The key draws from the same
 * weekly allowance as Autopilot, on the share other tools get; GPT-6 stays in Autopilot.
 *
 *   dl api-key [NAME]        make a key (NAME: what it's for, e.g. "cursor"; default "tools")
 *   dl api-key list          the account's keys (never their secrets)
 *   dl api-key revoke ID     delete one; it stops working at once
 *
 * Making and managing keys uses Autopilot's free tier sign-in, as `dl claude` does; a key
 * itself can't make or revoke keys. Not to be confused with `dl keys`, the server's provider
 * and GitHub keys.
 */

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiKeyDeps {
  env?: Env;
  token?: () => Promise<FreeTierToken>;
  signIn?: () => Promise<boolean>;
  fetch?: Fetch;
  terminal?: boolean;
}

interface KeyRow {
  id: string;
  name: string;
  kind?: string;
  createdAt: string;
  lastUsedAt: string | null;
}

const REQUEST_TIMEOUT_MS = 15_000;
const NAME_RE = /^[\x20-\x7e]{1,64}$/;

export const API_KEY_USAGE = `  Usage: dl api-key [NAME] | dl api-key list | dl api-key revoke ID

  dl api-key [NAME]      make an API key for another tool (Cursor, Cline, Zed, Aider…) and
                         print it once, with the base URLs to use (NAME: e.g. cursor)
  dl api-key list        your API keys (never their secrets)
  dl api-key revoke ID   delete one; it stops working at once
`;

/** The base URLs a tool needs, from the free tier's origin. */
export function toolUrls(origin: string): { openai: string; anthropic: string } {
  return { openai: `${origin}/v1`, anthropic: `${origin}/anthropic` };
}

/** What `dl api-key` prints once a key is made. */
export function apiKeyText(input: { origin: string; key: string; name: string; max?: number | undefined; color: ReturnType<typeof palette> }): string {
  const { key, name, color } = input;
  const urls = toolUrls(input.origin);
  return `
  ${color.bold(`API key for other tools: ${name}`)}

    ${key}

  ${color.dim("Shown once: copy it now. It works in any tool until you revoke it (dl api-key revoke).")}

  ${color.bold("OpenAI-compatible tools")} (Cursor, Cline, Roo Code, Kilo Code, Continue, Zed, Aider, OpenCode…)
    base URL  ${urls.openai}
    API key   the key above
    model     ${PROXY_MODEL}   (GET ${urls.openai}/models lists the others)

  ${color.bold("Anthropic-compatible tools")}
    base URL  ${urls.anthropic}
    API key   the key above (as x-api-key or a Bearer token); DeepSeek answers whatever model is named

  Try it:
    curl ${urls.openai}/chat/completions -H "Authorization: Bearer ${key}" -H "content-type: application/json" -d '{"model":"${PROXY_MODEL}","messages":[{"role":"user","content":"hi"}]}'

  ${color.dim(`It uses your free weekly allowance, on the share other tools get; Autopilot (dl) keeps the rest. GPT-6 is in Autopilot only.${input.max ? ` At most ${input.max} keys; dl api-key list shows them.` : ""}`)}

`;
}

async function signedIn(io: LaunchIO, deps: ApiKeyDeps, env: Env): Promise<{ origin: string; accessToken: string } | undefined> {
  const getToken = deps.token ?? (() => freeTierAccessToken({ env }));
  let token = await getToken();
  if (!token.ok && token.reason === "signed_out") {
    if (!(deps.terminal ?? process.stdin.isTTY === true)) {
      io.err("  dl api-key uses your free tier sign-in, and you aren't signed in. Run dl once to sign in, then dl api-key again.\n");
      return undefined;
    }
    io.out("  dl api-key uses your free tier sign-in. Signing in first.\n");
    if (!(await (deps.signIn ?? (() => autopilotSignIn(io, "dl api-key")))())) {
      io.err("  Not signed in to the free tier, so no API key was made.\n");
      return undefined;
    }
    token = await getToken();
  }
  if (!token.ok) {
    io.err(`  ${token.reason === "signed_out" ? "Not signed in to the free tier. Run dl once to sign in." : token.message}\n`);
    return undefined;
  }
  return { origin: token.origin, accessToken: token.accessToken };
}

async function call(deps: ApiKeyDeps, url: string, accessToken: string, init: { method: string; body?: unknown }): Promise<{ status: number; body: Record<string, any> | undefined } | { error: string }> {
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      method: init.method,
      headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, body: (await response.json().catch(() => undefined)) as Record<string, any> | undefined };
  } catch (error) {
    return { error: `Couldn't reach the free tier (${error instanceof Error ? error.message : String(error)}).` };
  }
}

function refusal(result: { status: number; body: Record<string, any> | undefined }): string {
  const message = result.body?.error?.message;
  return typeof message === "string" ? message : `The free tier answered HTTP ${result.status}.`;
}

/** A name no key of the account has yet: `base`, else `base-2`, `base-3`… */
export function freeName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
}

function since(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "never";
}

export async function apiKeyCommand(args: string[], io: LaunchIO, deps: ApiKeyDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const color = palette(!env.NO_COLOR && env.TERM !== "dumb" && (deps.terminal ?? process.stdout.isTTY === true));
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    io.out(API_KEY_USAGE);
    return 0;
  }
  const [sub, ...rest] = args;
  if (sub === "revoke" && (rest.length !== 1 || !/^[a-z0-9]{12}$/.test(rest[0]!))) {
    io.err(`  Give the key's id, from dl api-key list.\n${API_KEY_USAGE}`);
    return 2;
  }
  if (sub !== "list" && sub !== "revoke" && (rest.length > 0 || (sub !== undefined && (sub.startsWith("-") || !NAME_RE.test(sub))))) {
    io.err(API_KEY_USAGE);
    return 2;
  }
  const session = await signedIn(io, deps, env);
  if (!session) return 1;
  const keysUrl = `${session.origin}/v1/keys`;

  if (sub === "revoke") {
    const result = await call(deps, `${keysUrl}/${rest[0]}`, session.accessToken, { method: "DELETE" });
    if ("error" in result) return (io.err(`  ${result.error}\n`), 1);
    if (result.status !== 200) return (io.err(`  ${refusal(result)}\n`), 1);
    io.out(`  Revoked ${rest[0]}: it no longer works anywhere.\n`);
    return 0;
  }

  const listed = await call(deps, keysUrl, session.accessToken, { method: "GET" });
  if ("error" in listed) return (io.err(`  ${listed.error}\n`), 1);
  if (listed.status !== 200) return (io.err(`  ${refusal(listed)}\n`), 1);
  const all = (Array.isArray(listed.body?.keys) ? listed.body!.keys : []) as KeyRow[];
  const tools = all.filter((key) => key.kind === "tool");
  const max = typeof listed.body?.maxToolKeys === "number" ? (listed.body.maxToolKeys as number) : undefined;

  if (sub === "list") {
    if (tools.length === 0) {
      io.out(`  No API keys for other tools yet. Make one: dl api-key NAME\n`);
      return 0;
    }
    io.out(`\n  ${color.bold("API keys for other tools")}${max !== undefined ? color.dim(` (${tools.length} of ${max})`) : ""}\n`);
    for (const key of tools) io.out(`    ${key.id}  ${key.name.padEnd(20)}  made ${since(key.createdAt)}  last used ${since(key.lastUsedAt)}\n`);
    io.out(`\n  ${color.dim(`Base URLs: ${toolUrls(session.origin).openai} (OpenAI-style), ${toolUrls(session.origin).anthropic} (Anthropic-style). Revoke one: dl api-key revoke ID`)}\n\n`);
    return 0;
  }

  const name = sub ?? freeName("tools", all.map((key) => key.name));
  const made = await call(deps, keysUrl, session.accessToken, { method: "POST", body: { name, kind: "tool" } });
  if ("error" in made) return (io.err(`  ${made.error}\n`), 1);
  if (made.status !== 201 || typeof made.body?.key !== "string") {
    const code = made.body?.error?.code;
    io.err(`  ${refusal(made)}\n`);
    if (code === "key_limit_reached") io.err(`  ${color.dim("Your keys: dl api-key list")}\n`);
    return 1;
  }
  if (made.body.kind !== "tool") {
    // A free tier from before tool keys ignores `kind` and makes a server key: take it back.
    if (typeof made.body.id === "string") await call(deps, `${keysUrl}/${made.body.id}`, session.accessToken, { method: "DELETE" });
    io.err("  The free tier doesn't offer API keys for other tools yet. Try again after its next update.\n");
    return 1;
  }
  io.out(apiKeyText({ origin: session.origin, key: made.body.key as string, name, max, color }));
  return 0;
}
