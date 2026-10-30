import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeSecretLocation, findLikelyProviderSecret } from "./secrets.js";

const PATCH = [
  "diff --git a/src/laptop/connect.test.ts b/src/laptop/connect.test.ts",
  "--- a/src/laptop/connect.test.ts",
  "+++ b/src/laptop/connect.test.ts",
  "@@ -10,3 +10,4 @@",
  " const a = 1;",
  '+const apiKey = "sk-deepseek-1234567890abcdefghij";',
  " const b = 2;",
].join("\n");

/** Inputs both copies of the patterns must agree on. */
const SAMPLES = [
  PATCH,
  PATCH.replace("+const apiKey", " const apiKey"),
  "key: ghp_0123456789abcdefghijklmnop",
  "token github_pat_0123456789abcdefghijklmnop",
  "OPENROUTER_API_KEY=whatever",
  "sk-or-v1-0123456789abcdef0123456789abcdef",
  "I want a task-management-dashboard-for-small-teams.",
  "sk-learn-is-a-python-library-for-machine-learning",
  "nothing to see here",
];

describe("key-shaped local changes", () => {
  it("names the file and line of a key in a diff, never the key", () => {
    const match = findLikelyProviderSecret(PATCH);
    assert.deepEqual(match, { file: "src/laptop/connect.test.ts", line: 11, pattern: "provider key (sk-…)" });
    assert.equal(describeSecretLocation(match!), "src/laptop/connect.test.ts:11");
    assert.ok(!JSON.stringify(match).includes("sk-deepseek"), "the match never carries the key");
  });

  it("ignores context lines, which are already in the repository the server clones", () => {
    assert.equal(findLikelyProviderSecret(PATCH.replace("+const apiKey", " const apiKey")), undefined);
  });

  it("has no location for text that isn't a diff", () => {
    const match = findLikelyProviderSecret("key: ghp_0123456789abcdefghijklmnop");
    assert.deepEqual(match, { pattern: "GitHub token (ghp_…)" });
    assert.equal(describeSecretLocation(match!), "your local changes");
  });

  it("matches autopilot-ai/secrets when the installed Autopilot has it", async () => {
    // The copy is vendored because dl pins an Autopilot that may predate the subpath export;
    // when it does have it, the two must agree on every sample.
    const specifier = "autopilot-ai/secrets";
    const mod = await import(specifier).catch(() => undefined) as { findLikelyProviderSecret?: (value: string) => unknown } | undefined;
    if (!mod?.findLikelyProviderSecret) return;
    for (const sample of SAMPLES) {
      assert.deepEqual(findLikelyProviderSecret(sample), mod.findLikelyProviderSecret(sample), sample);
    }
  });
});
