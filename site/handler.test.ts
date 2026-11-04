import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downloadCount, MARKETING_SITE, respond, sendCount, TELEMETRY_URL } from "./handler.js";

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

describe("directionallylocal.run download counts", () => {
  it("counts a script served, with only the route and curl, wget or other", () => {
    assert.deepEqual(downloadCount(new Request("https://directionallylocal.run/", { headers: { "User-Agent": "curl/8.5.0" } }), new Response("x")), { route: "run", client: "curl" });
    assert.deepEqual(downloadCount(new Request("https://directionallylocal.run/install.sh", { headers: { "User-Agent": "Wget/1.21.4" } }), new Response("x")), { route: "run", client: "wget" });
    assert.deepEqual(downloadCount(new Request("https://directionallylocal.run/", { headers: { "User-Agent": "Mozilla/5.0 secret" } }), new Response("x")), { route: "run", client: "other" });
  });

  it("doesn't count redirects, 404s, HEAD, or dl.new's own fetch (?via=)", () => {
    const curl = { "User-Agent": "curl/8.5.0", Accept: "*/*" };
    for (const request of [
      new Request("https://directionallylocal.run/", { headers: { ...curl, Accept: "text/html" } }),
      new Request("http://directionallylocal.run/", { headers: curl }),
      new Request("https://directionallylocal.run/x", { headers: curl }),
      new Request("https://directionallylocal.run/", { method: "HEAD", headers: curl }),
      new Request("https://directionallylocal.run/?via=home", { headers: curl }),
    ]) {
      assert.equal(downloadCount(request, respond(request, script)), undefined, request.url);
    }
  });

  it("sends {route, client} and nothing else, and never throws", async () => {
    const sent: Array<{ url: string; body: string; headers: Headers }> = [];
    await sendCount({ route: "run", client: "curl" }, TELEMETRY_URL, (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body), headers: new Headers(init.headers) });
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    assert.deepEqual(sent.map((call) => [call.url, JSON.parse(call.body)]), [[TELEMETRY_URL, { route: "run", client: "curl" }]]);
    assert.equal(TELEMETRY_URL, "https://free.directionallylocal.com/v1/telemetry/download");
    await sendCount({ route: "run", client: "curl" }, TELEMETRY_URL, (async () => {
      throw new Error("offline");
    }) as typeof fetch);
  });

  it("serves the script at once and counts it after the response, unless turned off", async () => {
    const { default: worker } = await import("./index.js");
    const waits: Array<Promise<unknown>> = [];
    const realFetch = globalThis.fetch;
    const posted: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      posted.push(`${url} ${String(init.body)}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise) };
      const request = () => new Request("https://directionallylocal.run/", { headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" } });
      assert.equal(worker.fetch(request(), {}, ctx).status, 200);
      assert.equal(worker.fetch(request(), { TELEMETRY_URL: "off" }, ctx).status, 200);
      assert.equal(worker.fetch(request()).status, 200, "works without a ctx");
      await Promise.all(waits);
      assert.deepEqual(posted, [`${TELEMETRY_URL} {"route":"run","client":"curl"}`]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
