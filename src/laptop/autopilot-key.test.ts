import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { AUTOPILOT_KEY_FILE_ENV, AUTOPILOT_KEY_MIN_VERSION, REFRESH_AFTER_MS, autopilotReadsKey, startAutopilotKey, versionAtLeast, withAutopilotKey } from "./autopilot-key.js";
import type { DlKey } from "./dl-key.js";

const DL: DlKey = { key: "dl_sk_abc_0123456789ab_secretsecretsecretsecretsecretsecretsecret0", baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "" };
const akey = (n: number) => `dl_ak_abc_${String(n).padStart(12, "0")}_${"s".repeat(42)}${n}`;

interface Call {
  method: string;
  url: string;
  auth: string | null;
}

/** A fake service: mints dl_ak_ keys, answers refreshes with `refreshStatus` (or throws), records calls. */
function fakeService(options: { mintStatus?: number } = {}) {
  const calls: Call[] = [];
  let minted = 0;
  const state = { refreshStatus: 200 as number | "offline" };
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init.headers).get("authorization") });
    if (method === "POST" && url.endsWith("/v1/autopilot-keys")) {
      if (options.mintStatus && options.mintStatus !== 201) return Response.json({ error: { code: "nope" } }, { status: options.mintStatus });
      minted++;
      return Response.json({ id: `id${minted}`, key: akey(minted), expiresAt: "", ttlSeconds: 900 }, { status: 201 });
    }
    if (method === "POST" && url.endsWith("/refresh")) {
      if (state.refreshStatus === "offline") throw new Error("offline");
      return Response.json({}, { status: state.refreshStatus });
    }
    if (method === "DELETE") return Response.json({ revoked: true });
    return new Response("?", { status: 404 });
  };
  return { fetch, calls, state };
}

function clock() {
  const timers: Array<() => void> = [];
  let cleared = 0;
  return {
    t: 1_000_000,
    timers,
    get cleared() {
      return cleared;
    },
    setInterval: (fn: () => void) => {
      timers.push(fn);
      return {};
    },
    clearInterval: () => {
      cleared++;
    },
  };
}

describe("the Autopilot key dl hands the Autopilot it launches", () => {
  it("is used only with an Autopilot new enough to read it", () => {
    assert.equal(autopilotReadsKey(undefined), false);
    assert.equal(autopilotReadsKey("3.34.1"), false);
    assert.equal(autopilotReadsKey(AUTOPILOT_KEY_MIN_VERSION), true);
    assert.equal(autopilotReadsKey("3.40.0"), true);
    assert.equal(versionAtLeast("4.0.0-beta.1", "3.35.0"), true);
    assert.equal(versionAtLeast("3.9.0", "3.35.0"), false);
  });

  it("is minted with the dl key and written to a private file Autopilot reads", async () => {
    const service = fakeService();
    const time = clock();
    const session = await startAutopilotKey(DL, { fetch: service.fetch, now: () => time.t, setInterval: time.setInterval, clearInterval: time.clearInterval });
    assert.ok(session);
    assert.equal(service.calls[0]!.auth, `Bearer ${DL.key}`);
    assert.equal(session.env.AUTOPILOT_DL_FREE_TOKEN, akey(1));
    const file = session.env[AUTOPILOT_KEY_FILE_ENV]!;
    assert.equal(await readFile(file, "utf8"), akey(1));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
    await session.stop();
    assert.equal(existsSync(dirname(file)), false, "the key file is removed when Autopilot exits");
  });

  it("is refreshed with the dl key (never the key itself) every few minutes, and revoked at the end", async () => {
    const service = fakeService();
    const time = clock();
    const session = (await startAutopilotKey(DL, { fetch: service.fetch, now: () => time.t, setInterval: time.setInterval, clearInterval: time.clearInterval }))!;
    assert.equal(time.timers.length, 1);
    time.t += REFRESH_AFTER_MS - 1;
    await session.tick();
    assert.equal(service.calls.filter((call) => call.url.endsWith("/refresh")).length, 0, "not due yet");
    time.t += 1;
    await session.tick();
    const refreshes = service.calls.filter((call) => call.url.endsWith("/refresh"));
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0]!.url, "https://api.dl.new/v1/autopilot-keys/id1/refresh");
    assert.equal(refreshes[0]!.auth, `Bearer ${DL.key}`);
    // Offline: kept, tried again on the next check.
    service.state.refreshStatus = "offline";
    time.t += REFRESH_AFTER_MS;
    await session.tick();
    assert.equal(session.current(), akey(1));
    await session.stop();
    assert.equal(time.cleared, 1, "refreshing stops");
    const revoke = service.calls.at(-1)!;
    assert.equal(revoke.method, "DELETE");
    assert.equal(revoke.url, "https://api.dl.new/v1/autopilot-keys/id1");
    assert.equal(revoke.auth, `Bearer ${DL.key}`);
  });

  it("is minted again when a refresh finds it gone (the computer slept), and the file gets the new key", async () => {
    const service = fakeService();
    const time = clock();
    const session = (await startAutopilotKey(DL, { fetch: service.fetch, now: () => time.t, setInterval: time.setInterval, clearInterval: time.clearInterval }))!;
    const file = session.env[AUTOPILOT_KEY_FILE_ENV]!;
    service.state.refreshStatus = 404;
    time.t += 60 * 60_000;
    await session.tick();
    assert.equal(session.current(), akey(2));
    assert.equal(await readFile(file, "utf8"), akey(2));
    // A passing refusal (429, 5xx) keeps the key.
    service.state.refreshStatus = 503;
    time.t += REFRESH_AFTER_MS;
    await session.tick();
    assert.equal(session.current(), akey(2));
    await session.stop();
    assert.equal(service.calls.at(-1)!.url, "https://api.dl.new/v1/autopilot-keys/id2", "the current key is the one revoked");
  });

  it("falls back to the dl key when the service can't make one, or Autopilot is too old", async () => {
    const refused = fakeService({ mintStatus: 404 });
    assert.equal(await startAutopilotKey(DL, { fetch: refused.fetch }), undefined);

    const env: Record<string, string | undefined> = { [AUTOPILOT_KEY_FILE_ENV]: "/inherited/key" };
    const ran = await withAutopilotKey(DL, AUTOPILOT_KEY_MIN_VERSION, env, async () => ({ ...env }), { fetch: refused.fetch });
    assert.equal(ran.AUTOPILOT_DL_FREE_TOKEN, DL.key);
    assert.equal(ran[AUTOPILOT_KEY_FILE_ENV], undefined, "no stale key file from a parent process");

    const service = fakeService();
    const old = await withAutopilotKey(DL, "3.34.1", {}, async () => "ran", { fetch: service.fetch });
    assert.equal(old, "ran");
    assert.equal(service.calls.length, 0, "an Autopilot that can't read the key: nothing minted");
  });

  it("runs Autopilot with the Autopilot key, and revokes it after, even when Autopilot fails", async () => {
    const service = fakeService();
    const time = clock();
    const env: Record<string, string | undefined> = {};
    await assert.rejects(
      withAutopilotKey(DL, AUTOPILOT_KEY_MIN_VERSION, env, async () => {
        assert.equal(env.AUTOPILOT_DL_FREE_TOKEN, akey(1));
        assert.equal(await readFile(env[AUTOPILOT_KEY_FILE_ENV]!, "utf8"), akey(1));
        throw new Error("boom");
      }, { fetch: service.fetch, now: () => time.t, setInterval: time.setInterval, clearInterval: time.clearInterval }),
      /boom/,
    );
    assert.equal(service.calls.at(-1)!.method, "DELETE");
    assert.equal(existsSync(env[AUTOPILOT_KEY_FILE_ENV]!), false);
  });
});
