import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { freeTierSignedIn, normalizeReferral, pendingReferralPath, referralForAutopilot, settleReferral, withReferral } from "./referral.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "dl-referral-test-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** Only files under the test's own directory: XDG_CONFIG_HOME points there. */
const env = (extra: Record<string, string> = {}) => ({ HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), ...extra });
const pending = () => join(root, "config", "directionallylocal", "pending-referral");
const autopilotConfig = () => join(root, "config", "autopilot", "config.json");
async function signIn(saved: Record<string, unknown> = { apiKey: "at", refreshToken: "rt", expiresAt: 1 }): Promise<void> {
  await mkdir(join(root, "config", "autopilot"), { recursive: true });
  await writeFile(autopilotConfig(), JSON.stringify({ provider: "directionally-local", providers: { "directionally-local": saved } }));
}

describe("referral codes", () => {
  it("are GitHub logins, lowercased; anything else is ignored", () => {
    assert.equal(normalizeReferral("Octo-Cat"), "octo-cat");
    assert.equal(normalizeReferral("  sinameraji\n"), "sinameraji");
    assert.equal(normalizeReferral("a"), "a");
    assert.equal(normalizeReferral("a".repeat(39)), "a".repeat(39));
    for (const bad of [undefined, "", "-octo", "octo-", "a".repeat(40), "octo cat", "octo_cat", "../etc", "octo;rm"]) {
      assert.equal(normalizeReferral(bad), undefined, String(bad));
    }
  });

  it("are kept next to dl's config", () => {
    assert.equal(pendingReferralPath({ XDG_CONFIG_HOME: "/x" }), "/x/directionallylocal/pending-referral");
    assert.equal(pendingReferralPath({ HOME: "/home/octo" }), "/home/octo/.config/directionallylocal/pending-referral");
  });
});

describe("the referral dl gives plain Autopilot", () => {
  it("passes DL_REFERRAL on and keeps the first one, privately, for a later run without it", async () => {
    assert.equal(await referralForAutopilot({ env: env({ DL_REFERRAL: "Octo" }) }), "octo");
    assert.equal(await readFile(pending(), "utf8"), "octo\n");
    assert.equal((await stat(pending())).mode & 0o777, 0o600);
    assert.equal(await referralForAutopilot({ env: env() }), "octo", "a later run without the variable");
    // A second link before signing in: that run passes it on, the first stays kept.
    assert.equal(await referralForAutopilot({ env: env({ DL_REFERRAL: "other" }) }), "other");
    assert.equal(await referralForAutopilot({ env: env() }), "octo");
  });

  it("is nothing without a link, and never keeps a code that isn't a login", async () => {
    assert.equal(await referralForAutopilot({ env: env() }), undefined);
    assert.equal(await referralForAutopilot({ env: env({ DL_REFERRAL: "not a login" }) }), undefined);
    await assert.rejects(stat(pending()));
  });

  it("stops once Autopilot has a free tier refresh token, and deletes the kept one", async () => {
    await referralForAutopilot({ env: env({ DL_REFERRAL: "octo" }) });
    assert.equal(await freeTierSignedIn({ env: env() }), false);
    await signIn();
    assert.equal(await freeTierSignedIn({ env: env() }), true);
    await settleReferral({ env: env() });
    await assert.rejects(stat(pending()), "deleted after the sign-in");
    assert.equal(await referralForAutopilot({ env: env() }), undefined);
    assert.equal(await referralForAutopilot({ env: env({ DL_REFERRAL: "octo" }) }), "octo", "a code given now is still passed on as given");
    await assert.rejects(stat(pending()), "but not kept");
  });

  it("an access token without a refresh token, or another provider's, isn't a free tier sign-in", async () => {
    await signIn({ apiKey: "at" });
    assert.equal(await freeTierSignedIn({ env: env() }), false);
    await writeFile(autopilotConfig(), JSON.stringify({ providers: { chatgpt: { refreshToken: "rt" } } }));
    assert.equal(await freeTierSignedIn({ env: env() }), false);
    await writeFile(autopilotConfig(), "{ damaged");
    assert.equal(await freeTierSignedIn({ env: env() }), false);
  });

  it("never fails: a kept file that can't be written only loses the referral", async () => {
    await writeFile(join(root, "config"), "a file where the directory would go");
    assert.equal(await referralForAutopilot({ env: env({ DL_REFERRAL: "octo" }) }), "octo");
    assert.equal(await referralForAutopilot({ env: env() }), undefined);
  });

  it("sets DL_REFERRAL in Autopilot's environment, or removes it", () => {
    assert.deepEqual(withReferral({ PATH: "/bin", DL_REFERRAL: "Not A Login" }, undefined), { PATH: "/bin" });
    assert.deepEqual(withReferral({ PATH: "/bin" }, "octo"), { PATH: "/bin", DL_REFERRAL: "octo" });
  });
});
