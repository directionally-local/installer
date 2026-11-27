import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { main } from "../cli.js";
import { AGENT_PICK_TIMEOUT_MS, notePick, sendAgentPick, type AgentPickReport } from "./agent-pick.js";
import type { DlKey } from "./dl-key.js";

const KEY: DlKey = { key: "dl_sk_0123456789abcdef", plan: "starter", baseUrl: "https://api.dl.new", anthropicBaseUrl: "https://api.dl.new/anthropic", savedAt: "" };
const PICK: AgentPickReport = { agent: "claude-code", firstRun: true, found: ["claude-code", "cursor"], dlVersion: "0.49.1" };

function recorder(status = 202) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("{\"ok\":true}", { status }));
  return { calls, fetch };
}

describe("sendAgentPick", () => {
  it("posts the pick to /v1/agent-pick with the dl key, within a 1 s timeout", async () => {
    const r = recorder();
    assert.equal(await sendAgentPick(PICK, KEY, { env: {}, fetch: r.fetch }), true);
    assert.equal(r.calls.length, 1);
    const { url, init } = r.calls[0]!;
    assert.equal(url, "https://api.dl.new/v1/agent-pick");
    assert.equal(init.method, "POST");
    assert.equal((init.headers as Record<string, string>).authorization, `Bearer ${KEY.key}`);
    assert.deepEqual(JSON.parse(String(init.body)), { agent: "claude-code", firstRun: true, found: ["claude-code", "cursor"], dlVersion: "0.49.1" });
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(AGENT_PICK_TIMEOUT_MS, 1_000);
  });

  it("leaves found out when dl didn't look, and takes a base URL ending in /v1", async () => {
    const r = recorder();
    await sendAgentPick({ agent: "pi", firstRun: false, dlVersion: "0.49.1" }, { ...KEY, baseUrl: "https://free.test/v1/" }, { env: {}, fetch: r.fetch });
    assert.equal(r.calls[0]!.url, "https://free.test/v1/agent-pick");
    assert.deepEqual(JSON.parse(String(r.calls[0]!.init.body)), { agent: "pi", firstRun: false, dlVersion: "0.49.1" });
  });

  it("sends nothing with DL_NO_TELEMETRY, DO_NOT_TRACK or CI", async () => {
    for (const env of [{ DL_NO_TELEMETRY: "1" }, { DO_NOT_TRACK: "1" }, { CI: "true" }]) {
      const r = recorder();
      assert.equal(await sendAgentPick(PICK, KEY, { env, fetch: r.fetch }), false);
      assert.equal(r.calls.length, 0, JSON.stringify(env));
    }
    // "0" and "false" don't opt out.
    const r = recorder();
    assert.equal(await sendAgentPick(PICK, KEY, { env: { DO_NOT_TRACK: "0" }, fetch: r.fetch }), true);
  });

  it("never throws: a network error or a refusal is false", async () => {
    assert.equal(await sendAgentPick(PICK, KEY, { env: {}, fetch: async () => { throw new Error("offline"); } }), false);
    assert.equal(await sendAgentPick(PICK, KEY, { env: {}, fetch: recorder(401).fetch }), false);
  });
});

describe("notePick", () => {
  it("returns at once and sends with the saved dl key; nothing without one", async () => {
    const r = recorder();
    let resolveKey!: (key: DlKey) => void;
    const pending = notePick(PICK, { env: {}, fetch: r.fetch, key: () => new Promise((resolve) => (resolveKey = resolve)) });
    // Nothing waited on the key or the network to get here.
    assert.equal(r.calls.length, 0);
    resolveKey(KEY);
    assert.equal(await pending, true);
    assert.equal(r.calls.length, 1);

    const none = recorder();
    assert.equal(await notePick(PICK, { env: {}, fetch: none.fetch, key: async () => undefined }), false);
    assert.equal(none.calls.length, 0);
  });

  it("doesn't read the key with telemetry off", async () => {
    let read = false;
    assert.equal(await notePick(PICK, { env: { DL_NO_TELEMETRY: "true" }, key: async () => ((read = true), KEY) }), false);
    assert.equal(read, false);
  });
});

describe("dl <agent> counts as a pick", () => {
  it("dl claude, dl opencode, dl pi, dl t3 and dl autopilot each report their agent", async () => {
    const picks: AgentPickReport[] = [];
    const io = { out: () => undefined, err: () => undefined };
    const reportPick = (pick: AgentPickReport) => void picks.push(pick);
    const recordAgentUse = async () => undefined;
    await main(["claude"], io, { claude: async () => 0, reportPick, recordAgentUse });
    await main(["opencode"], io, { opencode: async () => 0, reportPick, recordAgentUse });
    await main(["pi"], io, { pi: async () => 0, reportPick, recordAgentUse });
    await main(["t3"], io, { t3: async () => 0, reportPick, recordAgentUse });
    assert.deepEqual(picks.map((p) => [p.agent, "found" in p]), [["claude-code", false], ["opencode", false], ["pi", false], ["t3", false]]);
    assert.ok(picks.every((p) => /^\d+\.\d+\.\d+/.test(p.dlVersion)));
  });

  it("sends nothing when tests replace the history and not the report", async () => {
    // With recordAgentUse replaced and no reportPick, the real sender isn't used (no network in tests).
    const code = await main(["claude"], { out: () => undefined, err: () => undefined }, { claude: async () => 3, recordAgentUse: async () => undefined });
    assert.equal(code, 3);
  });
});
