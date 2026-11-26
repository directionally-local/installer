import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scrubbedScript } from "./vendor-script.js";

describe("scrubbedScript", () => {
  it("runs a vendor's script without dl's answers or anything else from the environment", () => {
    const result = spawnSync("sh", ["-c", scrubbedScript("env; echo \"it's $HOME\"")], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: "/home/me",
        https_proxy: "http://proxy.example:3128",
        DL_TAILSCALE_AUTH_KEY: "tskey-auth-secret",
        DL_PROVIDER_API_KEY: "sk-secret",
        DL_OPENROUTER_API_KEY: "sk-or-secret",
        DL_GITHUB_TOKEN: "ghp_secret",
        OTHER_SECRET: "x",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const names = result.stdout.split("\n").filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map((line) => line.split("=")[0] ?? "");
    assert.ok(!names.some((name) => name.startsWith("DL_") || name === "OTHER_SECRET"), names.join(" "));
    assert.doesNotMatch(result.stdout, /secret/);
    assert.match(result.stdout, /^HOME=\/home\/me$/m);
    assert.match(result.stdout, /^https_proxy=http:\/\/proxy\.example:3128$/m, "a proxy still reaches the download");
    assert.match(result.stdout, /^it's \/home\/me$/m, "quotes in the script survive");
  });

  it("puts no values on the command line", () => {
    const text = scrubbedScript("curl -fsSL https://get.docker.com | sh");
    assert.match(text, /\$\{PATH\+"PATH=\$PATH"\}/, "names, for the shell to expand");
    assert.ok(!text.includes(process.env.PATH ?? "/usr/bin"), "not this process's values");
  });
});
