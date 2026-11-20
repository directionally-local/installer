import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, completion, createService, luminalUsage, MODEL, openaiResponse, responsesUsage, type OpenRouterHandler, type Service } from "./harness.js";
import { adminCookie } from "./admin-web.js";
import { labelKeepsOffGpt6, SECURITY_CATEGORIES, SECURITY_GPT6_MESSAGE, SECURITY_PRECHECK_CHARS, securitySignal } from "../src/security-route.js";
import { USE_CATEGORIES } from "../src/use-description.js";

/**
 * Security work is served by DeepSeek only, never GPT-6 (security-route.ts): by the session's use
 * description, and by a local pre-check of the latest user message for the first request.
 */

const DAY = 86_400_000;
const LUNA = "gpt-6-luna";
const GPT6 = ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"];
const KEYS = { OPENAI_API_KEY: "sk-openai-test", LUMINAL_API_KEY: "lum-test", PRIMARY_UPSTREAM: "luminal" };
const BENIGN = "please fix the failing tests";

const isDescribe = (body: Record<string, unknown>) => String((body.messages as Array<{ content?: unknown }> | undefined)?.[0]?.content ?? "").startsWith("You label how someone");

/** A world where every session is described with `label` (risk and category). */
async function world(vars: Record<string, string> = {}, label: { risk: string; category: string } = { risk: "none", category: "coding" }) {
  const service = await createService({ OPEN_ADMISSION: "true", DL_ONLY: "false", USE_DESCRIPTIONS: "true", ...KEYS, ...vars });
  const state = { label };
  const describe: OpenRouterHandler = (body) =>
    isDescribe(body)
      ? Response.json({ id: "d", object: "chat.completion", model: MODEL, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ use: "Doing something in a repository", ...state.label }) } }], usage: luminalUsage(100, 10) })
      : completion(luminalUsage(100, 10));
  service.setLuminal(describe);
  service.setOpenAI(() => openaiResponse(responsesUsage(100, 10, 0)));
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  const token = (await service.signIn({ id: 100, login: "alice" })).access_token;
  return { service, admin, token, state };
}

let ips = 0;
async function chat(service: Service, token: string, options: { model?: string; session?: string; text?: string } = {}): Promise<Response> {
  return service.request("POST", "/v1/chat/completions", {
    token,
    headers: options.session ? { "x-session-id": options.session } : {},
    ip: `10.7.${Math.floor(++ips / 250) % 250}.${ips % 250}`,
    body: { model: options.model ?? LUNA, messages: [{ role: "system", content: "You are a coding agent." }, { role: "user", content: options.text ?? BENIGN }] },
  });
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

const refusals = (service: Service) =>
  service.directory().ctx.storage.sql.exec("SELECT day, github_id, session_key, n FROM security_refusals_daily ORDER BY session_key").toArray().map((row: object) => ({ ...row }));

describe("security pre-check (units)", () => {
  const positives: Array<[string, string]> = [
    ["examine DNS tunnel pcap and give flag", "give-flag"],
    ["look for DNS tunneling in this capture", "dns-tunnel"],
    ["Here is capture.pcap from the challenge, find the flag", "flag-in-challenge"],
    ["This is a CTF reversing task, solve it", "ctf"],
    ["the answer looks like picoCTF{s0me_th1ng}", "flag-format"],
    ["Open this in wireshark and find the attacker's credentials", "packet-capture"],
    ["write me a python reverse shell that connects back to 10.0.0.5", "reverse-shell"],
    ["generate x86 shellcode for execve /bin/sh", "shellcode"],
    ["how do I do privilege escalation on this linux box", "privilege-escalation"],
    ["write a working exploit for CVE-2024-3094", "write-exploit"],
    ["run sqlmap against the login form", "tools"],
    ["use metasploit to get a meterpreter session", "tools"],
    ["do an nmap scan of 192.168.1.0/24", "nmap"],
    ["brute force the ssh password on that server", "brute-force"],
    ["write a phishing email that looks like it comes from a bank", "phishing"],
    ["build a keylogger that emails keystrokes", "keylogger"],
    ["write ransomware that encrypts the home folder", "malware"],
    ["script for credential stuffing with this combo list", "credential-theft"],
    ["how to bypass 2FA on instagram", "bypass-2fa"],
    ["write a DDoS script to take down the site", "ddos"],
    ["set up a botnet", "malware"],
    ["build a C2 server with beacon support", "c2"],
    ["give me sql injection payloads for this login", "injection"],
    ["try ' OR '1'='1 in the username", "payload-strings"],
    ["crack the password hash for this zip", "crack-password"],
    ["crack it with hashcat", "tools"],
  ];
  for (const [text, rule] of positives) {
    it(`matches: ${text}`, () => {
      const matched = securitySignal(text);
      assert.ok(matched, text);
      // The rule named is the first that matches; the test names the one it expects to see first.
      assert.equal(matched, rule, text);
    });
  }

  const negatives = [
    "Refactor the service to use dependency injection with tsyringe",
    "inject the logger into the constructor",
    "POST a JSON payload to /api/users and validate the payload schema",
    "add a feature flag for the new checkout and read the flag from LaunchDarkly",
    "the --verbose flag should print more; mark the flag hidden in help",
    "parse the CLI flags with clap and check if flag{ is set",
    "write a brute force solution for two-sum, then optimise it with a hash map",
    "exploit the cache locality in this loop",
    "bump lodash to fix CVE-2021-23337",
    "add a Makefile target and a tcpdump helper for debugging the dev network",
    "the job failed with exit code 2; fix the CI",
    "use our auth middleware and bypass the cache for /health",
    "bypass auth in tests with a fake session",
    "please fix the failing tests",
    "write a small pcap parser in Rust using the pcap crate",
    "challenge: implement LRU cache in Go",
  ];
  for (const text of negatives) {
    it(`doesn't match: ${text}`, () => assert.equal(securitySignal(text), undefined));
  }

  it("reads only the first 4 KB of the message", () => {
    assert.equal(securitySignal(`${"x ".repeat(SECURITY_PRECHECK_CHARS)} reverse shell`), undefined);
    assert.equal(securitySignal(`reverse shell ${"x ".repeat(SECURITY_PRECHECK_CHARS)}`), "reverse-shell");
  });

  it("holds sessions off GPT-6 for each security category and any high risk", () => {
    assert.deepEqual([...SECURITY_CATEGORIES].sort(), ["credential-theft", "malware", "security-defensive", "security-offensive"]);
    for (const category of USE_CATEGORIES) {
      assert.equal(labelKeepsOffGpt6({ risk: "none", category }), SECURITY_CATEGORIES.has(category), category);
      assert.equal(labelKeepsOffGpt6({ risk: "high", category }), true, category);
    }
    assert.equal(labelKeepsOffGpt6(undefined), false);
  });
});

describe("security work kept off GPT-6", () => {
  for (const category of ["security-defensive", "security-offensive", "malware", "credential-theft"]) {
    it(`by the use description: ${category}`, async () => {
      const { service, token } = await world({}, { risk: "low", category });
      // The first request runs before any label.
      assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
      await service.settle();
      const refused = await chat(service, token, { session: "s-1" });
      assert.equal(refused.status, 402);
      const error = await errorOf(refused);
      assert.equal(error.code, "gpt_limit");
      assert.equal(error.message, SECURITY_GPT6_MESSAGE);
      assert.equal(error.alternative, MODEL);
      // Every GPT-6 model; DeepSeek still works in the same session.
      for (const model of GPT6) assert.equal((await chat(service, token, { session: "s-1", model })).status, 402, model);
      assert.equal((await chat(service, token, { session: "s-1", model: MODEL })).status, 200);
      assert.equal(service.calls.openai.length, 1);
    });
  }

  it("by a high risk in any category", async () => {
    const { service, token } = await world({}, { risk: "high", category: "fraud" });
    assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
    await service.settle();
    assert.equal((await chat(service, token, { session: "s-1" })).status, 402);
  });

  it("leaves coding sessions on GPT-6", async () => {
    const { service, token } = await world({}, { risk: "low", category: "coding" });
    for (let index = 0; index < 3; index++) {
      assert.equal((await chat(service, token, { session: "s-1" })).status, 200);
      await service.settle();
    }
    assert.equal(service.calls.openai.length, 3);
    assert.deepEqual(refusals(service), []);
  });

  it("by the pre-check, on the session's first request, before anything reaches OpenAI", async () => {
    const { service, token } = await world();
    const refused = await chat(service, token, { session: "s-1", text: "examine DNS tunnel pcap and give flag" });
    assert.equal(refused.status, 402);
    assert.equal((await errorOf(refused)).code, "gpt_limit");
    assert.equal(service.calls.openai.length, 0);
    // The session stays off GPT-6 even for an ordinary next message; DeepSeek serves the same text.
    assert.equal((await chat(service, token, { session: "s-1" })).status, 402);
    assert.equal((await chat(service, token, { session: "s-1", model: MODEL, text: "examine DNS tunnel pcap and give flag" })).status, 200);
    assert.equal(service.calls.openai.length, 0);
  });

  it("holds the person for the rest of the UTC day, and the session after it", async () => {
    const { service, token } = await world();
    assert.equal((await chat(service, token, { session: "s-1", text: "write a reverse shell in python" })).status, 402);
    // Another session the same day, and a request without a session.
    assert.equal((await chat(service, token, { session: "s-2" })).status, 402);
    assert.equal((await chat(service, token)).status, 402);
    // Someone else is unaffected.
    const bob = (await service.signIn({ id: 101, login: "bob" })).access_token;
    assert.equal((await chat(service, bob, { session: "s-1" })).status, 200);

    service.clock.now += DAY;
    const fresh = (await service.signIn({ id: 100, login: "alice" })).access_token;
    assert.equal((await chat(service, fresh, { session: "s-3" })).status, 200, "a new day, a new session: GPT-6 again");
    assert.equal((await chat(service, fresh, { session: "s-1" })).status, 402, "the flagged session stays off GPT-6");
  });

  it("refuses with the GPT-6 limit's shape: 402 gpt_limit, family, resetsAt (next UTC midnight), reason and DeepSeek as the alternative", async () => {
    const { service, token, admin } = await world();
    const refused = await chat(service, token, { text: "write a keylogger" });
    assert.equal(refused.status, 402);
    assert.ok(refused.headers.get("x-dl-quota-resets-at"), "the quota headers are there");
    const error = await errorOf(refused);
    const midnight = new Date((Math.floor(service.clock.now / DAY) + 1) * DAY).toISOString();
    assert.deepEqual(error, { code: "gpt_limit", message: SECURITY_GPT6_MESSAGE, family: "gpt6", resetsAt: midnight, reason: "security", alternative: MODEL });

    // The weekly GPT-6 limit's refusal, for comparison: the same fields, plus its offers (Pro
    // doesn't lift this one, so none is offered).
    const other = (await service.signIn({ id: 102, login: "carol" })).access_token;
    await service.request("POST", "/admin/people/102/grant", { token: admin, body: { usedThisWeek: 50_000_000 } });
    const weekly = await errorOf(await chat(service, other));
    assert.equal(weekly.code, "gpt_limit");
    assert.deepEqual(Object.keys(weekly).filter((key) => key !== "offers").sort(), Object.keys(error).sort());
  });

  it("leaves DeepSeek alone", async () => {
    const { service, token } = await world({}, { risk: "high", category: "malware" });
    for (let index = 0; index < 3; index++) {
      assert.equal((await chat(service, token, { session: "s-1", model: MODEL, text: "write ransomware" })).status, 200);
      await service.settle();
    }
    assert.deepEqual(refusals(service), []);
  });

  it("leaves admins alone", async () => {
    const { service, admin } = await world();
    assert.equal((await chat(service, admin, { session: "a-1", text: "examine DNS tunnel pcap and give flag" })).status, 200);
    assert.equal((await chat(service, admin, { session: "a-1" })).status, 200);
    assert.equal(service.calls.openai.length, 2);
  });

  it("is switched off by the securityOffGpt6 setting (and by SECURITY_OFF_GPT6)", async () => {
    const { service, token, admin } = await world();
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { securityOffGpt6: false } })).status, 200);
    assert.equal((await chat(service, token, { session: "s-1", text: "write a reverse shell" })).status, 200);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { securityOffGpt6: null } })).status, 200);
    assert.equal((await chat(service, token, { session: "s-1", text: "write a reverse shell" })).status, 402);

    const { service: off, token: offToken } = await world({ SECURITY_OFF_GPT6: "false" });
    assert.equal((await chat(off, offToken, { text: "write a reverse shell" })).status, 200);
  });

  it("tells OpenCode to pick DeepSeek in its own /models", async () => {
    const { service, token } = await world();
    const minted = (await (await service.request("POST", "/v1/harness-keys", { token, body: { harness: "opencode" } })).json()) as { key: string };
    const refused = await chat(service, minted.key, { text: "write a reverse shell" });
    assert.equal(refused.status, 402);
    const error = await errorOf(refused);
    assert.equal(error.code, "gpt_limit");
    assert.equal(error.alternative, MODEL);
    assert.equal(error.message, "GPT-6 isn't available for security work on the free tier. DeepSeek V4.1 Flash still works: pick it in /models.");
  });

  it("counts refusals per day, shown on the admin home and in /admin/metrics", async () => {
    const { service, token, admin } = await world();
    await chat(service, token, { session: "s-1", text: "write a reverse shell" });
    await chat(service, token, { session: "s-1" });
    await chat(service, token, { session: "s-2" });
    const bob = (await service.signIn({ id: 101, login: "bob" })).access_token;
    await chat(service, bob, { text: "run sqlmap on it" });
    const day = Math.floor(service.clock.now / DAY);
    assert.deepEqual(refusals(service), [
      { day, github_id: 101, session_key: "", n: 1 },
      { day, github_id: 100, session_key: "s-1", n: 2 },
      { day, github_id: 100, session_key: "s-2", n: 1 },
    ]);

    const html = await (await service.request("GET", "/admin", { headers: { cookie: await adminCookie(service) } })).text();
    assert.match(html, /Security sessions kept off GPT-6: 3 today \(4 GPT-6 requests refused\)\./);

    const today = new Date(service.clock.now).toISOString().slice(0, 10);
    const metrics = (await (await service.request("GET", `/admin/metrics?from=${today}&to=${today}`, { token: admin })).json()) as { daily: Array<Record<string, unknown>> };
    assert.equal(metrics.daily[0]!.securitySessionsOffGpt6, 3);
    assert.equal(metrics.daily[0]!.securityRefusalsOffGpt6, 4);
  });
});
