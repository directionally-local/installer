import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { autopilotAuth, parseActiveProvider } from "./autopilot.js";
import { autopilotConfigFile, formatTokens, freeTierAccount, freeTierLine, loginFromToken, type FreeTierOptions } from "./free-tier.js";

const NOW = Date.parse("2026-11-04T03:00:00.000Z"); // Wednesday 12:00 in Tokyo
const RESETS = "2026-11-09T00:00:00.000Z"; // Monday 00:00 UTC, the service's week end

/** A free tier access token: a JWT whose payload carries `login` (the signature isn't checked here). */
function token(login: string): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ typ: "access", sub: "583231", login, exp: NOW / 1000 + 1800 })}.c2lnbmF0dXJl`;
}

const ACCESS = token("octo");

function config(saved: Record<string, unknown> | undefined): string {
  return JSON.stringify({ provider: "directionally-local", providers: { openrouter: { apiKey: "sk-or-other" }, ...(saved ? { "directionally-local": saved } : {}) } });
}

/** Stubs for Autopilot's config file and the service: never the real ones. */
function stubs(saved: Record<string, unknown> | undefined, respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => me()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const reads: string[] = [];
  const options: FreeTierOptions = {
    env: { HOME: "/home/octo" },
    now: NOW,
    exists: () => false,
    readFile: async (path) => (reads.push(path), config(saved)),
    fetch: async (url, init) => (calls.push({ url, init }), respond(url, init)),
  };
  return { options, calls, reads };
}

function me(remaining = 49_900_000): Response {
  return Response.json({ login: "octo", githubId: 583231, status: "active", allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 50_000_000 - remaining, remaining, resetsAt: RESETS, usdPerWeek: 5, spentUsdThisWeek: 0.1 } });
}

describe("the free tier account in dl status", () => {
  it("reads Autopilot's saved sign-in and asks GET /v1/me with it, read-only, with a 3 s limit", async () => {
    const { options, calls, reads } = stubs({ apiKey: ACCESS, refreshToken: "refresh-secret", expiresAt: NOW + 30 * 60_000 });
    assert.deepEqual(await freeTierAccount(options), { login: "octo", remaining: 49_900_000, tokensPerWeek: 50_000_000, resetsAt: RESETS });
    assert.deepEqual(reads, ["/home/octo/.config/autopilot/config.json"]);
    assert.equal(calls.length, 1, "one call, no refresh");
    assert.equal(calls[0]!.url, "https://free.directionallylocal.com/v1/me");
    assert.equal(calls[0]!.init.method, undefined, "a GET");
    assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), `Bearer ${ACCESS}`);
    assert.ok(calls[0]!.init.signal instanceof AbortSignal);
    assert.doesNotMatch(JSON.stringify(calls[0]!.init), /refresh-secret/, "the refresh token is never sent");
  });

  it("uses the service Autopilot uses: AUTOPILOT_DL_FREE_URL, else the saved base URL", async () => {
    const saved = stubs({ apiKey: ACCESS, baseUrl: "https://free.example.com/v1" });
    await freeTierAccount(saved.options);
    assert.equal(saved.calls[0]!.url, "https://free.example.com/v1/me");
    const fromEnv = stubs({ apiKey: ACCESS, baseUrl: "https://free.example.com/v1" });
    await freeTierAccount({ ...fromEnv.options, env: { HOME: "/home/octo", AUTOPILOT_DL_FREE_URL: "http://127.0.0.1:8787/" } });
    assert.equal(fromEnv.calls[0]!.url, "http://127.0.0.1:8787/v1/me");
  });

  it("shows only the login, from the token, when the service can't be asked", async () => {
    const expired = stubs({ apiKey: ACCESS, refreshToken: "r", expiresAt: NOW - 1 });
    assert.deepEqual(await freeTierAccount(expired.options), { login: "octo" });
    assert.equal(expired.calls.length, 0, "an expired token is left alone: no call, no refresh");
    for (const respond of [
      () => Response.json({ error: { code: "invalid_token" } }, { status: 401 }),
      () => new Response("<html>", { status: 502 }),
      () => { throw new Error("timed out"); },
      () => new Response("not json"),
    ]) {
      const { options } = stubs({ apiKey: ACCESS }, respond);
      assert.deepEqual(await freeTierAccount(options), { login: "octo" });
    }
  });

  it("shows nothing when there is no sign-in to read", async () => {
    assert.equal(await freeTierAccount(stubs(undefined).options), undefined);
    assert.equal(await freeTierAccount(stubs({ refreshToken: "r" }).options), undefined);
    assert.equal(await freeTierAccount({ ...stubs(undefined).options, readFile: async () => { throw new Error("ENOENT"); } }), undefined);
    assert.equal(await freeTierAccount({ ...stubs(undefined).options, readFile: async () => "{not json" }), undefined);
    const opaque = stubs({ apiKey: "not-a-jwt" }, () => { throw new Error("offline"); });
    assert.equal(await freeTierAccount(opaque.options), undefined, "no login anywhere: nothing");
  });

  it("never shows a login that isn't a GitHub login", async () => {
    assert.equal(loginFromToken(token("octo")), "octo");
    assert.equal(loginFromToken(token("\u001b[31mevil")), undefined);
    assert.equal(loginFromToken("abc"), undefined);
    const { options } = stubs({ apiKey: token("x\ny") }, () => Response.json({ login: "\u001b]0;", allowance: {} }));
    assert.equal(await freeTierAccount(options), undefined);
  });

  it("finds Autopilot's config file where Autopilot does", () => {
    assert.equal(autopilotConfigFile({ HOME: "/home/octo" }, () => false), "/home/octo/.config/autopilot/config.json");
    assert.equal(autopilotConfigFile({ HOME: "/home/octo", XDG_CONFIG_HOME: "/xdg" }, () => false), "/xdg/autopilot/config.json");
    assert.equal(autopilotConfigFile({ HOME: "/h" }, (path) => path === "/h/.config/kimiflare/config.json"), "/h/.config/kimiflare/config.json", "before the rename");
  });

  it("formats the line: who, what's left this week, and when it resets in local time", () => {
    const tokyo = { now: NOW, timeZone: "Asia/Tokyo" };
    assert.equal(freeTierLine({ login: "octo", remaining: 49_900_000, tokensPerWeek: 50_000_000, resetsAt: RESETS }, tokyo), "@octo · 49.9M of 50M tokens left this week · resets Mon 09:00");
    assert.equal(freeTierLine({ login: "octo", remaining: 49_960_000, tokensPerWeek: 50_000_000, resetsAt: RESETS }, tokyo), "@octo · 49.9M of 50M tokens left this week · resets Mon 09:00", "rounded down");
    assert.equal(freeTierLine({ login: "octo", remaining: 0, tokensPerWeek: 50_000_000, resetsAt: RESETS }, { now: NOW, timeZone: "America/Los_Angeles" }), "@octo · 0 of 50M tokens left this week · resets Sun 16:00");
    assert.equal(freeTierLine({ login: "octo", remaining: 1_500, tokensPerWeek: 50_000_000 }, tokyo), "@octo · 1.5k of 50M tokens left this week");
    assert.equal(freeTierLine({ login: "octo" }, tokyo), "@octo");
    assert.equal(formatTokens(50_000_000), "50M");
    assert.equal(formatTokens(950), "950");
  });

  it("reads the active provider from autopilot auth status", async () => {
    const out = "  openrouter  OpenRouter · no key\n› directionally-local Directionally Local (active) · key in config\n  ollama      Ollama · no key needed\n";
    assert.equal(parseActiveProvider(out), "directionally-local");
    assert.deepEqual(await autopilotAuth({ command: "autopilot", args: [] }, async () => out), { active: "directionally-local", setUp: true });
    assert.equal(await autopilotAuth({ command: "autopilot", args: [] }, async () => "Usage: autopilot\n"), undefined);
    assert.equal(await autopilotAuth(undefined), undefined);
  });
});
