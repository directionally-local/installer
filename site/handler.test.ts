import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { downloadCount, MARKETING_SITE, RELEASES, respond, route, sendCount, TELEMETRY_URL, type BundleStore } from "./handler.js";

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
      assert.equal((await worker.fetch(request(), {}, ctx)).status, 200);
      assert.equal((await worker.fetch(request(), { TELEMETRY_URL: "off" }, ctx)).status, 200);
      assert.equal((await worker.fetch(request())).status, 200, "works without a ctx");
      // A bundle download (from R2 or the redirect to GitHub) isn't counted as a script.
      const store: BundleStore = { get: async () => ({ body: new Response("tarball").body!, size: 7, httpEtag: '"a"' }) };
      const bundle = new Request("https://directionallylocal.run/dl/0.14.0/dl-0.14.0-linux-x64.tar.gz", { headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" } });
      assert.equal((await worker.fetch(bundle, { BUNDLES: store }, ctx)).status, 200);
      assert.equal((await worker.fetch(bundle.clone(), {}, ctx)).status, 302);
      await Promise.all(waits);
      assert.deepEqual(posted, [`${TELEMETRY_URL} {"route":"run","client":"curl"}`]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("directionallylocal.run/dl/: dl's prebuilt bundles", () => {
  const fetchBundle = (path: string, store?: BundleStore, method = "GET") => route(new Request(`https://directionallylocal.run${path}`, { method, headers: { Accept: "*/*" } }), script, store);

  it("redirects to the GitHub release's assets while no bucket is bound", async () => {
    const list = await fetchBundle("/dl/latest/dl-bundles.txt");
    assert.equal(list.status, 302);
    assert.equal(list.headers.get("location"), `${RELEASES}/latest/download/dl-bundles.txt`);
    const tarball = await fetchBundle("/dl/0.14.0/dl-0.14.0-darwin-arm64.tar.gz");
    assert.equal(tarball.status, 302);
    assert.equal(tarball.headers.get("location"), `${RELEASES}/download/v0.14.0/dl-0.14.0-darwin-arm64.tar.gz`);
    assert.equal((await fetchBundle("/dl/0.14.0/dl-bundles.txt")).headers.get("location"), `${RELEASES}/download/v0.14.0/dl-bundles.txt`);
  });

  it("serves from the bucket when it has the file, and falls back to GitHub when it doesn't", async () => {
    const keys: string[] = [];
    const store: BundleStore = {
      async get(key) {
        keys.push(key);
        if (key !== "dl/0.14.0/dl-0.14.0-linux-x64.tar.gz") return null;
        return { body: new Response("tarball").body!, size: 7, httpEtag: '"abc"' };
      },
    };
    const found = await fetchBundle("/dl/0.14.0/dl-0.14.0-linux-x64.tar.gz", store);
    assert.equal(found.status, 200);
    assert.equal(await found.text(), "tarball");
    assert.equal(found.headers.get("content-type"), "application/gzip");
    assert.equal(found.headers.get("content-length"), "7");
    assert.match(found.headers.get("cache-control") ?? "", /immutable/, "a version's files never change");
    const missing = await fetchBundle("/dl/latest/dl-bundles.txt", store);
    assert.equal(missing.status, 302);
    assert.deepEqual(keys, ["dl/0.14.0/dl-0.14.0-linux-x64.tar.gz", "dl/latest/dl-bundles.txt"]);
  });

  it("serves only bundle files: anything else under /dl/ is the plain 404", async () => {
    for (const path of ["/dl/", "/dl/latest/dl-0.14.0-linux-x64.tar.gz", "/dl/0.14.0/install.sh", "/dl/../install.sh", "/dl/0.14/dl-bundles.txt", "/dl/0.14.0/sub/dl-bundles.txt"]) {
      const response = await fetchBundle(path);
      assert.ok(response.status === 404 || (response.status === 200 && path === "/dl/../install.sh"), `${path}: ${response.status}`);
    }
    // The install script is still at the bare domain, through the same entry point.
    assert.equal(await (await fetchBundle("/")).text(), script);
  });
});
