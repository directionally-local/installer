import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentRequest, browserSignIn, dlKeyOrSignIn, keyUrls, maskKey, planName, readDlKey, reportAgentRequest, saveDlKey, type DlKey } from "./dl-key.js";

function capture() {
  let out = "";
  let err = "";
  return { out: (text: string) => { out += text; }, err: (text: string) => { err += text; }, text: () => out + err, stderr: () => err };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const KEY: DlKey = { key: "dl_sk_0123456789abcdef", keyId: "k1", accountId: "a1", plan: "starter", baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "2026-11-26T00:00:00.000Z" };

describe("dl's own sign-in", () => {
  it("opens dl.new's cli-login in the browser, polls until it's approved, and keeps the key in dl's config (0600)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-key-"));
    const path = join(dir, "directionallylocal", "dl-key.json");
    const calls: Array<{ url: string; body: any }> = [];
    const answers = [
      json(200, { loginId: "L".repeat(32), userCode: "WXYZ-2345", verificationUri: "https://dl.new/cli-login?code=WXYZ-2345", interval: 2, expiresIn: 600 }),
      json(428, { error: { code: "authorization_pending" } }),
      json(429, { error: { code: "slow_down" } }),
      json(200, { key: KEY.key, keyId: "k1", accountId: "a1", plan: null, baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", login: "sina", email: "s@example.com" }),
    ];
    const opened: string[] = [];
    const slept: number[] = [];
    const io = capture();
    const key = await browserSignIn(io, {
      env: {}, path, deviceName: "mac", headless: false, image: null,
      fetch: async (url, init) => (calls.push({ url, body: JSON.parse(String(init.body)) }), answers.shift()!),
      open: (url) => (opened.push(url), true),
      sleep: async (ms) => void slept.push(ms),
      now: () => 0,
    });
    assert.equal(key?.key, KEY.key);
    assert.equal(key?.plan, null);
    assert.deepEqual(calls[0], { url: "https://api.dl.new/v1/cli-login/start", body: { tool: "dl", deviceName: "mac" } });
    assert.deepEqual(calls.slice(1).map((call) => [call.url, call.body.loginId.length]), Array(3).fill(["https://api.dl.new/v1/cli-login/poll", 32]));
    assert.deepEqual(opened, ["https://dl.new/cli-login?code=WXYZ-2345"]);
    assert.deepEqual(slept, [2000, 2000, 3000], "slow_down backs off");
    assert.match(io.text(), /dl gives your coding agent open models \(DeepSeek, Kimi\) on one flat plan\./);
    assert.match(io.text(), /WXYZ-2345/);
    assert.match(io.text(), /Opening dl\.new in your browser to sign in or sign up\./);
    assert.match(io.text(), /Waiting for you in the browser/);
    assert.match(io.text(), /✓ Welcome in, @sina\. Free plan\n/);
    assert.ok(!io.text().includes(KEY.key), "the key is never printed by the sign-in");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readDlKey({}, path))?.key, KEY.key);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
  });

  it("says why when it's denied, expires or can't reach dl.new, and saves nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-key-"));
    const path = join(dir, "dl-key.json");
    const start = () => json(200, { loginId: "L".repeat(32), userCode: "AAAA-BBBB", verificationUri: "https://dl.new/cli-login?code=AAAA-BBBB", interval: 2, expiresIn: 600 });
    const run = async (poll: Response) => {
      const io = capture();
      const answers = [start(), poll];
      const key = await browserSignIn(io, { env: {}, path, headless: false, image: null, fetch: async () => answers.shift()!, open: () => false, sleep: async () => {}, now: () => 0 });
      return { key, io };
    };
    const denied = await run(json(403, { error: { code: "access_denied" } }));
    assert.equal(denied.key, undefined);
    assert.match(denied.io.stderr(), /denied in the browser/);
    assert.match(denied.io.text(), /Open this link in a browser to sign in or sign up:/, "the link when the browser didn't open");
    const expired = await run(json(410, { error: { code: "expired_token" } }));
    assert.match(expired.io.stderr(), /expired/);
    const offline = capture();
    assert.equal(await browserSignIn(offline, { env: {}, path, image: null, fetch: async () => { throw new Error("ENOTFOUND"); }, open: () => true }), undefined);
    assert.match(offline.stderr(), /Couldn't reach dl\.new to sign in \(ENOTFOUND\)/);
    assert.equal(await readDlKey({}, path), undefined);
  });

  it("on a headless box (SSH, or Linux with no display) never says the browser is opening: the code and the link instead", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-key-"));
    const start = () => json(200, { loginId: "L".repeat(32), userCode: "HEAD-LESS", verificationUri: "https://dl.new/cli-login?code=HEAD-LESS", interval: 2, expiresIn: 600 });
    const approved = () => json(200, { key: KEY.key, plan: "starter", email: "sina.m@example.com" });
    for (const env of [{ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22", DISPLAY: ":0" }, ...(process.platform === "linux" ? [{}] : [])]) {
      const io = capture();
      const opened: string[] = [];
      const answers = [start(), approved()];
      const key = await browserSignIn(io, { env, path: join(dir, "k.json"), image: null, fetch: async () => answers.shift()!, open: (url) => (opened.push(url), true), sleep: async () => {}, now: () => 0 });
      assert.equal(key?.key, KEY.key);
      assert.deepEqual(opened, [], "no browser launched");
      assert.doesNotMatch(io.text(), /Opening dl\.new/);
      assert.match(io.text(), /Open this link in a browser to sign in or sign up:\n {4}Code {3}HEAD-LESS[^\n]*\n {4}Link {3}https:\/\/dl\.new\/cli-login\?code=HEAD-LESS\n/);
      assert.doesNotMatch(io.text(), /if it didn't open/);
      // No GitHub login: the email's local part.
      assert.match(io.text(), /✓ Welcome in, @sina\.m\. Starter plan/);
    }
  });

  it("at a terminal: the rocking wait redraws in place and becomes the welcome; the mascot sits beside the intro when there's an image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-key-"));
    const answers = [
      json(200, { loginId: "L".repeat(32), userCode: "ROCK-CHAIR", verificationUri: "https://dl.new/cli-login?code=ROCK-CHAIR", interval: 1, expiresIn: 600 }),
      json(428, { error: { code: "authorization_pending" } }),
      json(200, { key: KEY.key, plan: null }),
    ];
    let out = "";
    const io = { out: (text: string) => { out += text; }, err: (text: string) => { out += text; }, color: true };
    const png = Buffer.from("not really a png");
    const key = await browserSignIn(io, {
      env: {}, path: join(dir, "k.json"), headless: false, image: { protocol: "kitty", png }, open: () => true,
      fetch: async () => answers.shift()!, sleep: () => new Promise((resolve) => setTimeout(resolve, 150)), now: () => 0,
    });
    assert.equal(key?.key, KEY.key);
    assert.ok(out.includes(`\x1b_Ga=T,f=100,c=7,r=3,C=1,q=2,m=0;${png.toString("base64")}\x1b\\`), "the mascot, drawn with Kitty's protocol");
    assert.match(out, /dl gives your coding agent open models/);
    const frames = [...out.matchAll(/\r\x1b\[2K {2}\S*([◜◠◝◞◡◟])\S* Waiting for you in the browser/g)].map((m) => m[1]);
    assert.ok(frames.length >= 2, "redrawn while waiting");
    assert.deepEqual(frames.slice(0, 2), ["◜", "◠"]);
    const plainOut = out.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plainOut, /\r\x1b\[2K {2}✓ Welcome in\. Free plan\n$/, "no login or email: no handle");
  });

  it("uses the saved key without signing in again, and signs in only in a terminal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-key-"));
    const path = join(dir, "dl-key.json");
    await saveDlKey(KEY, {}, path);
    const io = capture();
    assert.equal((await dlKeyOrSignIn(io, { env: {}, path, fetch: async () => { throw new Error("no network needed"); } }))?.key, KEY.key);
    assert.equal(await dlKeyOrSignIn(io, { env: {}, path: join(dir, "none.json"), interactive: false }), undefined);
  });

  it("with no dl key, takes one made from an older Autopilot free tier sign-in before any browser sign-in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dl-key-"));
    const migrated: DlKey = { ...KEY, source: "free-tier" };
    const got = await dlKeyOrSignIn(capture(), { env: {}, path: join(dir, "none.json"), migrate: async () => migrated, fetch: async () => { throw new Error("no browser sign-in"); } });
    assert.equal(got?.source, "free-tier");
    // A saved key comes first: nothing is made.
    const path = join(dir, "dl-key.json");
    await saveDlKey(KEY, {}, path);
    assert.equal((await dlKeyOrSignIn(capture(), { env: {}, path, migrate: async () => assert.fail("made a key") }))?.key, KEY.key);
  });

  it("shows keys and plans briefly", () => {
    assert.equal(maskKey(KEY.key), "dl_sk_…cdef");
    assert.equal(planName("starter"), "Starter");
    assert.equal(planName(null), "Free");
    assert.deepEqual(keyUrls(KEY), { openai: "https://api.dl.new/v1", anthropic: "https://api.dl.new/anthropic" });
  });
});

describe("reporting an agent dl doesn't know", () => {
  it("posts the agent's name with the os, arch, dl version and found agents, with the key as Bearer", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const request = agentRequest(`  My\nAgent ${"x".repeat(100)}`, ["cursor"], "0.48.0");
    assert.equal(request.name.length, 80);
    assert.ok(!request.name.includes("\n"));
    assert.equal(await reportAgentRequest(request, { env: {}, key: KEY.key, fetch: async (url, init) => (sent.push({ url, init }), json(200, { ok: true })) }), true);
    assert.equal(sent[0]!.url, "https://free.directionallylocal.com/v1/agent-request");
    assert.equal((sent[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY.key}`);
    const body = JSON.parse(String(sent[0]!.init.body));
    assert.deepEqual(Object.keys(body).sort(), ["arch", "dlVersion", "found", "name", "os"]);
    assert.deepEqual(body.found, ["cursor"]);
  });

  it("never throws or blocks: a failing service is just false", async () => {
    assert.equal(await reportAgentRequest(agentRequest("x", [], "1"), { env: {}, fetch: async () => { throw new Error("offline"); } }), false);
    assert.equal(await reportAgentRequest(agentRequest("x", [], "1"), { env: {}, fetch: async () => json(404, {}) }), false);
    const sent: RequestInit[] = [];
    await reportAgentRequest(agentRequest("x", [], "1"), { env: {}, fetch: async (_url, init) => (sent.push(init), json(200, { ok: true })) });
    assert.equal((sent[0]!.headers as Record<string, string>).authorization, undefined, "no key: no auth");
  });
});
