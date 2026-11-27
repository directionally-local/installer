import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { autopilotOnKey, type AutopilotOnKeyDeps } from "./cli.js";
import type { DlKey } from "./laptop/dl-key.js";

const KEY: DlKey = {
  key: "dl_sk_0123456789abcdef",
  plan: "starter",
  baseUrl: "https://api.dl.new",
  anthropicBaseUrl: "https://api.dl.new/anthropic",
  savedAt: "2026-11-27T00:00:00.000Z",
};

const io = { out: () => undefined, err: () => undefined };
// Never run a real Autopilot (or ask its version) in these tests.
const NO_AUTOPILOT = async () => undefined;
// No Autopilot-only key from the service: run straight away on the dl key's environment.
const PASS_THROUGH = (async (_key: unknown, _version: unknown, _env: unknown, run: () => Promise<number>) => await run()) as unknown as NonNullable<AutopilotOnKeyDeps["withKey"]>;

function clean() {
  delete process.env.AUTOPILOT_DL_FREE_TOKEN;
  delete process.env.AUTOPILOT_PROVIDER;
}

beforeEach(clean);
afterEach(clean);

describe("dl's own Autopilot launch on the saved dl key", () => {
  it("gives Autopilot the key even when an older dl had tagged it from the free tier sign-in", async () => {
    // dl 0.47 saved keys with source "free-tier"; they are dl keys all the same. Without the
    // token Autopilot would run its own first run ("How should it think?") despite the key.
    const old = { ...KEY, source: "free-tier" } as DlKey & { source: "free-tier" };
    let started = false;
    const code = await autopilotOnKey({ cwd: "/tmp", autopilot: NO_AUTOPILOT }, io, {
      withKey: PASS_THROUGH,
      readKey: async () => old,
      provider: async () => undefined,
      start: async () => ((started = true), 0),
    });
    assert.equal(code, 0);
    assert.equal(started, true);
    assert.equal(process.env.AUTOPILOT_DL_FREE_TOKEN, KEY.key);
    assert.equal(process.env.AUTOPILOT_PROVIDER, "directionally-local", "no provider of Autopilot's own: dl's plan is the provider");
  });

  it("keeps Autopilot's own provider when it has one", async () => {
    await autopilotOnKey({ cwd: "/tmp", autopilot: NO_AUTOPILOT }, io, {
      withKey: PASS_THROUGH,
      readKey: async () => KEY,
      provider: async () => "openrouter",
      start: async () => 0,
    });
    assert.equal(process.env.AUTOPILOT_DL_FREE_TOKEN, KEY.key);
    assert.equal(process.env.AUTOPILOT_PROVIDER, undefined);
  });

  it("leaves Autopilot alone when there's no dl key", async () => {
    await autopilotOnKey({ cwd: "/tmp", autopilot: NO_AUTOPILOT }, io, {
      withKey: PASS_THROUGH,
      readKey: async () => undefined,
      provider: async () => assert.fail("no provider question without a key"),
      start: async () => 0,
    });
    assert.equal(process.env.AUTOPILOT_DL_FREE_TOKEN, undefined);
    assert.equal(process.env.AUTOPILOT_PROVIDER, undefined);
  });
});
