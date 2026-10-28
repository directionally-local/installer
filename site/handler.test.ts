import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MARKETING_SITE, respond } from "./handler.js";

const script = await readFile(new URL("../install.sh", import.meta.url), "utf8");
const get = (url: string, headers: Record<string, string> = { Accept: "*/*" }) => respond(new Request(url, { headers }), script);

describe("directionallylocal.run", () => {
  it("serves install.sh to curl at the bare domain and /install.sh", async () => {
    for (const url of ["https://directionallylocal.run/", "https://directionallylocal.run/install.sh"]) {
      const response = get(url);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await response.text(), script);
    }
    assert.match(script, /^#!\/bin\/sh/);
  });

  it("sends browsers to the marketing site and never sets cookies", () => {
    const response = get("https://directionallylocal.run/", { Accept: "text/html,application/xhtml+xml" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), MARKETING_SITE);
    for (const r of [response, get("https://directionallylocal.run/"), get("https://directionallylocal.run/x")]) {
      assert.equal(r.headers.get("set-cookie"), null);
    }
  });

  it("upgrades plain HTTP and serves nothing else", () => {
    const insecure = get("http://directionallylocal.run/");
    assert.equal(insecure.status, 308);
    assert.equal(insecure.headers.get("location"), "https://directionallylocal.run/");
    assert.equal(get("https://directionallylocal.run/admin").status, 404);
    assert.equal(respond(new Request("https://directionallylocal.run/", { method: "POST" }), script).status, 405);
  });
});
