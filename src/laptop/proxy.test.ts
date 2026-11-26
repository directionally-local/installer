import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { conductorText, createProxyServer, localToken, proxyCommand, proxyPaths, proxyStatus, route, runProxy, serviceFiles, stopProxy, type ProxyPaths, type ProxyServer } from "./proxy.js";
import { palette } from "../ui.js";

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A fake free tier: harness keys, events, and the Anthropic and OpenAI routes, streaming on request. */
async function fakeService() {
  const seen: Seen[] = [];
  let minted = 0;
  const state = { refreshStatus: 200, rejected: new Set<string>(), hold: undefined as Promise<void> | undefined };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const path = req.url ?? "/";
      seen.push({ method: req.method ?? "", path, headers: req.headers, body });
      const auth = req.headers.authorization ?? "";
      if (path === "/v1/harness-keys" && req.method === "POST") {
        minted++;
        const harness = JSON.parse(body).harness as string;
        res.writeHead(201, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: `abcdefabc${String(minted).padStart(3, "0")}`, key: `key-${harness}-${minted}`, harness, expiresAt: new Date(Date.now() + 900_000).toISOString(), ttlSeconds: 900, otherHarnessShare: 0.5 }));
      }
      if (/^\/v1\/harness-keys\/\w+\/refresh$/.test(path)) {
        res.writeHead(state.refreshStatus, { "content-type": "application/json" });
        return res.end(JSON.stringify({ expiresAt: new Date(Date.now() + 900_000).toISOString() }));
      }
      if (path.startsWith("/v1/harness-keys/") || path === "/v1/events") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (state.rejected.has(auth.replace("Bearer ", ""))) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "expired" } }));
      }
      if (path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek/deepseek-v4.1-flash-1017" }] }));
      }
      if (path.startsWith("/anthropic/v1/messages") || path === "/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream", "x-dl-tokens-left": "123" });
        res.write("data: first\n\n");
        await state.hold;
        res.write("data: second\n\n");
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { server, origin, seen, state, minted: () => minted };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  chunks: string[];
  body: string;
}

/** A request to the proxy with full control of the headers; `onChunk` sees the body as it arrives. */
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; onChunk?: (chunk: string) => void } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: options.method ?? "POST", headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      const chunks: string[] = [];
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        chunks.push(chunk);
        options.onChunk?.(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks, body: chunks.join("") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

const TOKEN = `dlp_${"a".repeat(43)}`;

describe("dl proxy server", () => {
  let service: Awaited<ReturnType<typeof fakeService>>;
  let proxy: ProxyServer;
  let port: number;
  let logs: string[];

  beforeEach(async () => {
    service = await fakeService();
    port = await freePort();
    logs = [];
    proxy = createProxyServer({
      localToken: TOKEN,
      port,
      token: async () => ({ ok: true, origin: service.origin, accessToken: "access" }),
      fetch: (url, init) => fetch(url, init),
      now: Date.now,
      log: (line) => logs.push(line),
      setInterval: () => 0,
      clearInterval: () => undefined,
      env: {},
    });
    await new Promise<void>((resolve) => proxy.server.listen(port, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    await proxy.close();
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  });

  const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  it("refuses a request without the local token, or with another one", async () => {
    const missing = await call(port, "/v1/messages", { headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missing.status, 401);
    assert.equal(JSON.parse(missing.body).error.type, "authentication_error");
    const wrong = await call(port, "/v1/chat/completions", { headers: { authorization: `Bearer dlp_${"b".repeat(43)}` }, body: "{}" });
    assert.equal(wrong.status, 401);
    const wrongApiKey = await call(port, "/v1/messages", { headers: { "x-api-key": "sk-ant-something" }, body: "{}" });
    assert.equal(wrongApiKey.status, 401);
    // Nothing reached the service: no key was even made.
    assert.equal(service.minted(), 0);
  });

  it("refuses browsers: an Origin, Sec-Fetch-Site, a preflight, or another Host (DNS rebinding)", async () => {
    const origin = await call(port, "/v1/messages", { headers: { ...auth, origin: "https://evil.example" }, body: "{}" });
    assert.equal(origin.status, 403);
    assert.equal(origin.headers["access-control-allow-origin"], undefined);
    const fetchSite = await call(port, "/v1/models", { method: "GET", headers: { ...auth, "sec-fetch-site": "cross-site" } });
    assert.equal(fetchSite.status, 403);
    const preflight = await call(port, "/v1/messages", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    assert.equal(preflight.status, 403);
    const rebound = await call(port, "/v1/messages", { headers: { ...auth, host: `evil.example:${port}` }, body: "{}" });
    assert.equal(rebound.status, 403);
    assert.equal(service.minted(), 0);
    // localhost by name is fine.
    const byName = await call(port, "/v1/models", { method: "GET", headers: { ...auth, host: `localhost:${port}` } });
    assert.equal(byName.status, 200);
  });

  it("forwards Anthropic-format requests as Claude Code, streaming as they come", async () => {
    let release!: () => void;
    service.state.hold = new Promise((resolve) => (release = resolve));
    let firstSeen!: () => void;
    const first = new Promise<void>((resolve) => (firstSeen = resolve));
    const reply = call(port, "/v1/messages?beta=true", {
      headers: { "x-api-key": TOKEN, "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": "x" },
      body: JSON.stringify({ model: "claude-opus-4", stream: true, messages: [{ role: "user", content: "hi" }] }),
      onChunk: (chunk) => chunk.includes("first") && firstSeen(),
    });
    // The first event arrives while the service still holds the rest.
    await first;
    release();
    const done = await reply;
    assert.equal(done.status, 200);
    assert.equal(done.headers["content-type"], "text/event-stream");
    assert.equal(done.headers["x-dl-tokens-left"], "123");
    assert.equal(done.body, "data: first\n\ndata: second\n\n");

    const mint = service.seen.find((s) => s.path === "/v1/harness-keys")!;
    assert.equal(JSON.parse(mint.body).harness, "claude-code");
    assert.equal(mint.headers.authorization, "Bearer access");
    const message = service.seen.find((s) => s.path.startsWith("/anthropic/"))!;
    assert.equal(message.path, "/anthropic/v1/messages?beta=true");
    assert.equal(message.headers.authorization, "Bearer key-claude-code-1");
    assert.equal(message.headers["x-api-key"], undefined, "the local token stays local");
    assert.equal(message.headers["anthropic-version"], "2023-06-01");
    assert.equal(JSON.parse(message.body).model, "claude-opus-4", "the body goes through untouched");
    // session.start went out before the first request.
    const order = service.seen.map((s) => s.path);
    assert.ok(order.indexOf("/v1/events") < order.indexOf("/anthropic/v1/messages?beta=true"));
    assert.equal(JSON.parse(service.seen.find((s) => s.path === "/v1/events")!.body).events[0].type, "session.start");

    const count = await call(port, "/v1/messages/count_tokens", { headers: { "x-api-key": TOKEN }, body: "{}" });
    assert.equal(count.status, 200);
    assert.equal(service.minted(), 1, "one key serves every request");
  });

  it("forwards OpenAI-format requests as OpenCode (chat completions streaming, and models)", async () => {
    const models = await call(port, "/v1/models", { method: "GET", headers: auth });
    assert.equal(models.status, 200);
    assert.equal(JSON.parse(models.body).data[0].id, "deepseek/deepseek-v4.1-flash-1017");
    const chat = await call(port, "/v1/chat/completions", { headers: auth, body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash-1017", stream: true, messages: [] }) });
    assert.equal(chat.status, 200);
    assert.equal(chat.body, "data: first\n\ndata: second\n\n");
    const mint = service.seen.find((s) => s.path === "/v1/harness-keys")!;
    assert.equal(JSON.parse(mint.body).harness, "opencode");
    assert.equal(service.seen.find((s) => s.path === "/v1/chat/completions")!.headers.authorization, "Bearer key-opencode-1");
    // And the other format gets a key of its own.
    await call(port, "/v1/messages", { headers: auth, body: "{}" });
    assert.equal(service.seen.find((s) => s.path === "/anthropic/v1/messages")!.headers.authorization, "Bearer key-claude-code-2");
  });

  it("refreshes the key mid-stream without touching the stream, and mints another once the service drops it", async () => {
    let release!: () => void;
    service.state.hold = new Promise((resolve) => (release = resolve));
    let firstSeen!: () => void;
    const first = new Promise<void>((resolve) => (firstSeen = resolve));
    const reply = call(port, "/v1/messages", { headers: auth, body: "{}", onChunk: (chunk) => chunk.includes("first") && firstSeen() });
    await first;
    await proxy.tick();
    assert.ok(service.seen.some((s) => s.path === "/v1/harness-keys/abcdefabc001/refresh" && s.headers.authorization === "Bearer key-claude-code-1"));
    release();
    assert.equal((await reply).body, "data: first\n\ndata: second\n\n");

    // The service no longer has the key (it lapsed): the next request gets a fresh one.
    service.state.refreshStatus = 404;
    service.state.hold = undefined;
    await proxy.tick();
    assert.equal(proxy.keys["claude-code"].status().live, false);
    const next = await call(port, "/v1/messages", { headers: auth, body: "{}" });
    assert.equal(next.status, 200);
    assert.equal(service.minted(), 2);
    assert.equal(service.seen.filter((s) => s.path === "/anthropic/v1/messages").at(-1)!.headers.authorization, "Bearer key-claude-code-2");
  });

  it("mints a new key and retries once when the service answers 401", async () => {
    await call(port, "/v1/models", { method: "GET", headers: auth });
    service.state.rejected.add("key-opencode-1");
    const reply = await call(port, "/v1/models", { method: "GET", headers: auth });
    assert.equal(reply.status, 200);
    assert.equal(service.minted(), 2);
  });

  it("revokes every key and ends its session on close", async () => {
    await call(port, "/v1/models", { method: "GET", headers: auth });
    await proxy.close();
    assert.ok(service.seen.some((s) => s.method === "DELETE" && s.path === "/v1/harness-keys/abcdefabc001"));
    const end = service.seen.filter((s) => s.path === "/v1/events").map((s) => JSON.parse(s.body).events[0]);
    assert.equal(end.at(-1).type, "session.end");
    assert.equal(end.at(-1).props.harness, "opencode");
  });

  it("opted out (DO_NOT_TRACK): only a bare session.start per key, no session.end", async () => {
    const quiet = createProxyServer({ localToken: TOKEN, port, token: async () => ({ ok: true, origin: service.origin, accessToken: "access" }), fetch, now: Date.now, log: () => undefined, setInterval: () => 0, clearInterval: () => undefined, env: { DO_NOT_TRACK: "1" } });
    await proxy.close();
    const before = service.seen.length;
    await new Promise<void>((resolve) => quiet.server.listen(port, "127.0.0.1", resolve));
    proxy = quiet;
    assert.equal((await call(port, "/v1/models", { method: "GET", headers: auth })).status, 200);
    await proxy.close();
    const events = service.seen.slice(before).filter((s) => s.path === "/v1/events").map((s) => JSON.parse(s.body).events[0]);
    assert.deepEqual(events.map((event) => event.type), ["session.start"]);
    assert.deepEqual(events[0].props, {});
    assert.ok(service.seen.slice(before).some((s) => s.method === "DELETE"), "the key is still revoked");
  });

  it("says what's wrong in the app's own format when the sign-in is missing", async () => {
    const signedOut = createProxyServer({ localToken: TOKEN, port, token: async () => ({ ok: false, reason: "signed_out" }), fetch, now: Date.now, log: () => undefined, setInterval: () => 0, clearInterval: () => undefined, env: {} });
    await proxy.close();
    await new Promise<void>((resolve) => signedOut.server.listen(port, "127.0.0.1", resolve));
    proxy = signedOut;
    const reply = await call(port, "/v1/messages", { headers: auth, body: "{}" });
    assert.equal(reply.status, 401);
    assert.match(JSON.parse(reply.body).error.message, /not signed in/);
  });
});

describe("dl proxy commands", () => {
  let dir: string;
  let paths: ProxyPaths;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dl-proxy-"));
    paths = proxyPaths({ XDG_STATE_HOME: dir });
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("makes one private local token and keeps it", async () => {
    const token = await localToken(paths);
    assert.match(token, /^dlp_[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(paths.token)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.dir)).mode & 0o777, 0o700);
    assert.equal(await localToken(paths), token);
  });

  it("status, then stop, of a running proxy", async () => {
    const service = await fakeService();
    const port = await freePort();
    let running: ProxyServer | undefined;
    let exited = false;
    const out: string[] = [];
    const io = { out: (t: string) => void out.push(t), err: (t: string) => void out.push(t) };
    const deps = {
      paths,
      env: { XDG_STATE_HOME: dir },
      token: async () => ({ ok: true as const, origin: service.origin, accessToken: "access" }),
      onListening: (proxy: ProxyServer) => (running = proxy),
      // SIGTERM to "the proxy's process" stops the in-process proxy.
      kill: (_pid: number, signal: NodeJS.Signals | 0) => {
        if (signal === "SIGTERM") void running?.close().then(() => (exited = true));
        else if (signal === 0 && exited) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    };
    assert.equal((await proxyStatus(deps, port)).running, false);
    const run = runProxy(["--port", String(port)], io, deps);
    while (!running) await new Promise((resolve) => setTimeout(resolve, 10));
    const status = await proxyStatus(deps);
    assert.equal(status.running, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.url, `http://127.0.0.1:${port}`);
    assert.equal(JSON.parse(await readFile(paths.pid, "utf8")).port, port);

    const statusOut: string[] = [];
    assert.equal(await proxyCommand(["status"], { out: (t) => void statusOut.push(t), err: (t) => void statusOut.push(t) }, deps), 0);
    assert.match(statusOut.join(""), new RegExp(`running at http://127.0.0.1:${port}`));

    const stopOut: string[] = [];
    assert.equal(await stopProxy({ out: (t) => void stopOut.push(t), err: (t) => void stopOut.push(t) }, deps), 0);
    assert.match(stopOut.join(""), /stopped/);
    assert.equal(await run, 0);
    await assert.rejects(stat(paths.pid), "the pid file is gone");
    assert.equal((await proxyStatus(deps)).running, false);
    service.server.closeAllConnections();
    await new Promise((resolve) => service.server.close(resolve));
  });

  it("clears a stale pid file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await localToken(paths);
    await writeFile(paths.pid, JSON.stringify({ pid: 999_999, port: await freePort(), startedAt: "x" }));
    const kill = () => {
      throw Object.assign(new Error("no such process"), { code: "ESRCH" });
    };
    const status = await proxyStatus({ paths, kill });
    assert.equal(status.running, false);
    assert.equal(status.stale, true);
    await assert.rejects(stat(paths.pid));
  });

  it("routes only the four endpoints, Anthropic ones as Claude Code and OpenAI ones as OpenCode", () => {
    assert.deepEqual(route("POST", "/v1/messages"), { harness: "claude-code", format: "anthropic", upstream: "/anthropic/v1/messages" });
    assert.deepEqual(route("POST", "/anthropic/v1/messages/count_tokens"), { harness: "claude-code", format: "anthropic", upstream: "/anthropic/v1/messages/count_tokens" });
    assert.deepEqual(route("POST", "/v1/chat/completions"), { harness: "opencode", format: "openai", upstream: "/v1/chat/completions" });
    assert.deepEqual(route("GET", "/v1/models"), { harness: "opencode", format: "openai", upstream: "/v1/models" });
    assert.equal(route("POST", "/v1/harness-keys"), undefined);
    assert.equal(route("GET", "/v1/me"), undefined);
    assert.equal(route("POST", "/v1/events"), undefined);
  });

  it("prints Conductor's settings and the other apps", () => {
    const text = conductorText({ url: "http://127.0.0.1:4789", token: TOKEN, share: 0.5, color: palette(false) });
    assert.match(text, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:4789\n/);
    assert.match(text, new RegExp(`ANTHROPIC_AUTH_TOKEN=${TOKEN}`));
    assert.match(text, /take out ANTHROPIC_API_KEY/);
    assert.match(text, /base URL  http:\/\/127\.0\.0\.1:4789\/v1/);
    assert.match(text, /Cursor won't work/);
    assert.match(text, /this agent gets 50% of your weekly free allowance/);
    assert.doesNotMatch(conductorText({ url: "http://127.0.0.1:4789", token: TOKEN, share: 1, color: palette(false) }), /allowance\./);
  });

  it("writes a systemd user unit and a LaunchAgent", () => {
    const linux = serviceFiles({ platform: "linux", home: "/home/a", node: "/usr/bin/node", script: "/opt/dl/bin/dl.mjs", port: 4789, log: "/l", env: {} })!;
    assert.equal(linux.path, "/home/a/.config/systemd/user/dl-proxy.service");
    assert.match(linux.text, /ExecStart=\/usr\/bin\/node \/opt\/dl\/bin\/dl\.mjs proxy run --port 4789/);
    const mac = serviceFiles({ platform: "darwin", home: "/Users/a", node: "/opt/homebrew/bin/node", script: "/x/dl.mjs", port: 4789, log: "/l", env: {} })!;
    assert.equal(mac.path, "/Users/a/Library/LaunchAgents/com.directionallylocal.proxy.plist");
    assert.match(mac.text, /<string>proxy<\/string>\n    <string>run<\/string>/);
    assert.equal(serviceFiles({ platform: "win32", home: "C:/", node: "n", script: "s", port: 1, log: "l", env: {} }), undefined);
    assert.doesNotMatch(linux.text + mac.text, /DL_NO_TELEMETRY/);
  });

  it("carries a telemetry opt-out in force at install into the login service", () => {
    const linux = serviceFiles({ platform: "linux", home: "/home/a", node: "/usr/bin/node", script: "/s", port: 4789, log: "/l", env: { DO_NOT_TRACK: "1" } })!;
    assert.match(linux.text, /^Environment=DL_NO_TELEMETRY=1$/m);
    const mac = serviceFiles({ platform: "darwin", home: "/Users/a", node: "/n", script: "/s", port: 4789, log: "/l", env: { CI: "true" } })!;
    assert.match(mac.text, /<key>DL_NO_TELEMETRY<\/key><string>1<\/string>/);
  });
});
