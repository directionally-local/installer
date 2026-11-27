import type { RunOptions, RunResult } from "../system.js";
import { FakeSystem } from "./fake-system.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "failed"): RunResult => ({ code: 1, stdout: "", stderr });

/** Docker and Tailscale as `dl ui` uses them: containers with labels, and `tailscale serve`'s config. */
export class FakeUiSystem extends FakeSystem {
  /** Every docker and tailscale command, run or probed, as one line each. */
  readonly calls: string[] = [];
  readonly uiContainers = new Map<string, { running: boolean; spec: string; args: string[] }>();
  readonly volumes = new Set<string>();
  readonly pulled = new Set<string>();
  /** HTTPS port → proxy target, as `tailscale serve` keeps it. */
  readonly served = new Map<number, string>();
  readonly funnel = new Set<number>();
  /** Tailscale before 1.52: no --bg. */
  oldTailscale = false;
  serveFails = false;
  dnsName = "box.tail1234.ts.net.";
  /** The tailnet has HTTPS certificates on (CertDomains lists this machine). */
  httpsCerts = true;
  /** Certificates come on after this many more `tailscale status` reads (someone clicks Enable). */
  certsAfterReads: number | undefined;
  /** `tailscale up` (the interactive sign-in) ends without signing in. */
  loginFails = false;
  /** `tailscale set --operator=…` given. */
  operator: string | undefined;

  constructor(options: { tailscale?: boolean; tailscaleUp?: boolean } = {}) {
    super({ docker: true, ...options });
  }

  override async probe(command: string, args: string[]): Promise<RunResult> {
    if (command === "docker" || command === "tailscale") return this.answer(command, args);
    return super.probe(command, args);
  }

  override async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    if (command === "sudo") {
      this.calls.push(["sudo", ...args].join(" "));
      if (args[0] === "tailscale" || args[0] === "docker") return this.run(args[0], args.slice(1), options);
      return super.run(args[0]!, args.slice(1), options);
    }
    if (command === "sh") this.calls.push(["sh", ...args].join(" "));
    if (command !== "docker" && command !== "tailscale") return super.run(command, args, options);
    this.commands.push({ command, args });
    const result = this.answer(command, args);
    if (result.code !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    return result;
  }

  private answer(command: string, args: string[]): RunResult {
    this.calls.push([command, ...args].join(" "));
    if (command === "docker") {
      const name = args.at(-1)!;
      switch (args[0]) {
        case "info": return this.docker ? ok("27.3.1\n") : fail("Cannot connect to the Docker daemon");
        case "image": return this.pulled.has(args[2]!) ? ok("[]") : fail("No such image");
        case "pull": this.pulled.add(args[1]!); return ok();
        case "inspect": {
          const container = this.uiContainers.get(name);
          if (!container) return fail("No such object");
          return ok(args.join(" ").includes("Labels") ? `${container.running} ${container.spec}\n` : `${container.running}\n`);
        }
        case "run": {
          const label = args[args.indexOf("--label") + 1]!;
          this.uiContainers.set(args[args.indexOf("--name") + 1]!, { running: true, spec: label.slice(label.indexOf("=") + 1), args });
          const volume = args[args.indexOf("-v") + 1]!.split(":")[0]!;
          this.volumes.add(volume);
          return ok("abc123\n");
        }
        case "restart": return ok();
        case "rm": this.uiContainers.delete(name); return ok();
        case "volume": if (args[1] === "rm") this.volumes.delete(name); return ok();
        case "logs": return ok("log line\n");
        default: return ok();
      }
    }
    // tailscale
    if (args[0] === "version") return this.tailscaleInstalled ? ok("1.76.0\n") : fail("not installed");
    if (!this.tailscaleInstalled) return fail("tailscale: command not found");
    if (args[0] === "status") {
      if (this.certsAfterReads !== undefined && this.certsAfterReads-- <= 0) { this.httpsCerts = true; this.certsAfterReads = undefined; }
      return ok(JSON.stringify(this.tailscaleUp
        ? { BackendState: "Running", Self: { DNSName: this.dnsName }, CertDomains: this.httpsCerts ? [this.dnsName.replace(/\.$/, "")] : null }
        : { BackendState: "NeedsLogin" }));
    }
    if (args[0] === "up") {
      if (this.loginFails) return fail("context canceled");
      this.tailscaleUp = true;
      const operator = args.find((arg) => arg.startsWith("--operator="));
      if (operator) this.operator = operator.slice("--operator=".length);
      return ok();
    }
    if (args[0] === "set") {
      const operator = args.find((arg) => arg.startsWith("--operator="));
      if (operator) this.operator = operator.slice("--operator=".length);
      return ok();
    }
    if (args[0] === "serve" && args[1] === "status") {
      const host = this.dnsName.replace(/\.$/, "");
      return ok(JSON.stringify({
        TCP: Object.fromEntries([...this.served.keys()].map((port) => [String(port), { HTTPS: true }])),
        Web: Object.fromEntries([...this.served].map(([port, target]) => [`${host}:${port}`, { Handlers: { "/": { Proxy: target } } }])),
        ...(this.funnel.size ? { AllowFunnel: Object.fromEntries([...this.funnel].map((port) => [`${host}:${port}`, true])) } : {}),
      }));
    }
    if (args[0] === "serve") {
      if (this.serveFails) return fail("serve: HTTPS is not enabled for this tailnet");
      const off = args.at(-1) === "off";
      const https = args.find((arg) => arg.startsWith("--https=") || arg.startsWith("https:"));
      if (args.includes("--bg") && this.oldTailscale) return fail("flag provided but not defined: -bg");
      if (!https) return fail("missing port");
      const port = Number(https.replace(/^--https=|^https:/, ""));
      const target = args.filter((arg) => /^https?:\/\/|^\d/.test(arg)).at(-1)!;
      if (off) this.served.delete(port);
      else this.served.set(port, target);
      return ok();
    }
    return ok();
  }
}

export interface FakeUser { id: string; email: string; name: string; role: string; password: string; created_at: number }

/**
 * Open WebUI's HTTP API, the parts dl ui uses, with its behaviour: the first sign-up becomes the
 * admin; API keys (sk-…) work only on the user-management endpoints dl allows.
 */
export class FakeOpenWebUi {
  readonly users: FakeUser[] = [];
  /** API key → user id, as Settings > Account > API Key makes them. */
  readonly apiKeys = new Map<string, string>();
  readonly requests: Array<{ method: string; path: string; body?: Record<string, unknown>; token?: string }> = [];
  healthy = true;
  private next = 1;

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const { pathname } = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const auth = new Headers(init.headers).get("authorization") ?? undefined;
    const token = auth?.replace(/^Bearer /, "");
    this.requests.push({ method, path: pathname, ...(body ? { body } : {}), ...(token ? { token } : {}) });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (token?.startsWith("sk-") && !["/api/v1/users", "/api/v1/auths/add"].some((allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`))) {
      return json(403, { detail: "Access prohibited" });
    }
    const caller = token?.startsWith("sk-") ? this.users.find((user) => this.apiKeys.get(token) === user.id) : token ? this.users.find((user) => `token-${user.id}` === token) : undefined;
    const admin = caller?.role === "admin";
    if (pathname === "/health") return this.healthy ? json(200, { status: true }) : json(503, {});
    if (pathname === "/api/config") return json(200, { name: "Open WebUI", ...(this.users.length ? {} : { onboarding: true }) });
    if (pathname === "/api/v1/auths/signup" && method === "POST") {
      if (this.users.some((user) => user.email === body!.email)) return json(400, { detail: "Uh-oh! This email is already registered." });
      const user = this.add(String(body!.email), String(body!.name), String(body!.password), this.users.length ? "pending" : "admin");
      return json(200, { token: `token-${user.id}`, token_type: "Bearer", id: user.id, email: user.email, role: user.role });
    }
    if (pathname === "/api/v1/auths/signin" && method === "POST") {
      const user = this.users.find((entry) => entry.email === body!.email && entry.password === body!.password);
      return user ? json(200, { token: `token-${user.id}`, role: user.role }) : json(400, { detail: "The email or password provided is incorrect." });
    }
    if (!admin) return json(401, { detail: "Your session has expired or the token is invalid." });
    if (pathname === "/api/v1/auths/add" && method === "POST") {
      if (this.users.some((user) => user.email === body!.email)) return json(400, { detail: "Uh-oh! This email is already registered." });
      const user = this.add(String(body!.email), String(body!.name), String(body!.password), String(body!.role ?? "pending"));
      return json(200, { token: "t", id: user.id, email: user.email, role: user.role });
    }
    if (pathname === "/api/v1/users/all") return json(200, { users: this.users.map(({ password: _password, ...user }) => user), total: this.users.length });
    const update = pathname.match(/^\/api\/v1\/users\/([^/]+)\/update$/);
    if (update && method === "POST") {
      const user = this.users.find((entry) => entry.id === update[1]);
      if (!user) return json(404, { detail: "not found" });
      user.role = String(body!.role);
      return json(200, { id: user.id, role: user.role });
    }
    return json(404, { detail: "Not Found" });
  };

  /** The admin makes an API key in the browser. */
  apiKey(email: string): string {
    const user = this.users.find((entry) => entry.email === email)!;
    const key = `sk-${user.id}0123456789abcdef`;
    this.apiKeys.set(key, user.id);
    return key;
  }

  add(email: string, name: string, password: string, role: string): FakeUser {
    const user = { id: `u${this.next++}`, email, name, role, password, created_at: 1_763_000_000 };
    this.users.push(user);
    return user;
  }
}
