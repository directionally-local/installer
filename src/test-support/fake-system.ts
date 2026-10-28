import type { RunOptions, RunResult, System, WriteOptions } from "../system.js";

export interface FakeCommand {
  command: string;
  args: string[];
  input?: string;
}

/**
 * A simulated Ubuntu 24.04 server for tests. Commands change its state the way the
 * real ones would (useradd adds a user, npm install drops packages, …), so `up` can be
 * run twice to prove it's idempotent.
 */
export class FakeSystem implements System {
  readonly dryRun = false;
  readonly files = new Map<string, { content: string; mode: number; owner?: string }>();
  readonly dirs = new Set<string>();
  readonly commands: FakeCommand[] = [];
  readonly logs: string[] = [];
  readonly users = new Set<string>();
  readonly images = new Set<string>();
  readonly enabled = new Set<string>();
  readonly containers: string[] = [];
  /** The daemon answers. */
  docker: boolean;
  /** dockerd is installed (it may be stopped). */
  dockerInstalled: boolean;
  /** docker.socket is up; without it, starting docker.service fails, as on real Ubuntu. */
  dockerSocket = false;
  tailscaleInstalled: boolean;
  tailscaleUp: boolean;
  ufwActive = false;
  hotcellKeys = new Set<string>();
  memoryKb = 8 * 1024 * 1024;
  nodeVersion = "24.22.1";
  /** What Autopilot's server CLI reports (aster token list / runs / pair list). */
  laptops: Array<{ id: string; name: string; status: string; scopes: string[]; createdAt: string; lastUsedAt: string | null }> = [];
  serverRuns: Array<Record<string, unknown>> = [];
  pendingCodes: Array<{ code: string; name: string }> = [];
  approved: string[] = [];
  revoked: string[] = [];
  unattendedUpgrades = true;
  nodeFromNodeSource = true;
  serving = false;

  constructor(options: { docker?: boolean; tailscale?: boolean; tailscaleUp?: boolean } = {}) {
    this.docker = options.docker ?? false;
    this.dockerInstalled = this.docker;
    this.dockerSocket = this.docker;
    this.tailscaleInstalled = options.tailscale ?? false;
    this.tailscaleUp = options.tailscaleUp ?? false;
    this.files.set("/etc/os-release", { content: 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n', mode: 0o644 });
    this.dirs.add("/run/systemd/system");
    this.dirs.add("/etc/update-motd.d");
  }

  get ran(): string[] {
    return this.commands.map(({ command, args }) => [command, ...args].join(" "));
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.commands.push({ command, args, ...(options.input !== undefined ? { input: options.input } : {}) });
    const result = this.respond(command, args, options);
    if (result.code !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    return result;
  }

  async probe(command: string, args: string[]): Promise<RunResult> {
    return this.respond(command, args, {});
  }

  async readFile(path: string): Promise<string | undefined> {
    if (path === "/proc/meminfo") return `MemTotal:       ${this.memoryKb} kB\n`;
    return this.files.get(path)?.content;
  }

  async writeFile(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    this.files.set(path, { content, mode: options.mode ?? 0o644, ...(options.owner ? { owner: options.owner } : {}) });
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path);
  }

  async remove(path: string): Promise<void> {
    for (const file of [...this.files.keys()]) if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
    for (const dir of [...this.dirs]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
  }

  async exists(path: string): Promise<boolean> {
    if (path === "/dev/kvm") return false;
    if (path === "/usr/bin/dockerd") return this.dockerInstalled;
    return this.files.has(path) || this.dirs.has(path) || [...this.files.keys()].some((file) => file.startsWith(`${path}/`));
  }

  log(line: string): void {
    this.logs.push(line);
  }

  private respond(command: string, args: string[], options: RunOptions): RunResult {
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr = "failed"): RunResult => ({ code: 1, stdout: "", stderr });
    const line = args.join(" ");
    switch (command) {
      case "nproc": return ok("4\n");
      case "uname": return ok("x86_64\n");
      case "df": return ok("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 83886080 4194304 73400320 6% /\n");
      case "id":
        if (args[0] === "-u" && args[1]) return this.users.has(args[1]) ? ok("998\n") : fail("no such user");
        return ok("0\n");
      case "node": return ok(`${this.nodeVersion}\n`);
      case "docker":
        if (args[0] === "version") return this.docker ? ok("27.3.1\n") : fail("not installed");
        if (args[0] === "image" && args[1] === "inspect") return this.images.has(args[2]!) ? ok("[]") : fail("no such image");
        if (args[0] === "build") {
          this.images.add(args[args.indexOf("-t") + 1]!);
          return ok();
        }
        if (args[0] === "ps") return ok(this.containers.join("\n"));
        return ok();
      case "ip": return this.docker ? ok("4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\n") : fail("no docker0");
      case "sh":
        // Docker's script installs the packages; the daemon still has to be started properly.
        if (line.includes("get.docker.com")) this.dockerInstalled = true;
        if (line.includes("tailscale.com/install.sh")) this.tailscaleInstalled = true;
        return ok();
      case "useradd":
        this.users.add(args.at(-1)!);
        return ok();
      case "npm":
        if (args[0] === "view") return ok(args[1] === "hotcell" ? "0.1.26\n" : "2.2.0\n");
        if (args[0] === "install" && args[1] === "--prefix") {
          for (const pkg of ["autopilot-ai", "hotcell"]) this.files.set(`${args[2]}/node_modules/${pkg}/package.json`, { content: "{}", mode: 0o644 });
          this.files.set(`${args[2]}/node_modules/hotcell/dist/index.js`, { content: "", mode: 0o755 });
        }
        return ok();
      case "ln":
        // current -> release: mirror the release's files under the link.
        for (const [path, file] of [...this.files]) if (path.startsWith(`${args[1]}/`)) this.files.set(path.replace(args[1]!, args[2]!), file);
        return ok();
      case "runuser":
        if (args.includes("keys") && args.includes("add")) this.hotcellKeys.add(args[args.indexOf("add") + 1]!);
        if (args.includes("keys") && args.includes("ls")) return ok([...this.hotcellKeys].map((key) => `  ${key}  file\n`).join(""));
        if (args.includes("owner") && args.includes("link")) return ok(`${args.at(-1)}/api/v1/auth/claim?token=aster_claim_${"x".repeat(43)}\n`);
        if (args.includes("token") && args.includes("list")) return ok(`${JSON.stringify(this.laptops)}\n`);
        if (args.includes("token") && args.includes("revoke")) {
          this.revoked.push(args.at(-1)!);
          return ok(`Revoked credential ${args.at(-1)}\n`);
        }
        if (args.includes("runs") && args.includes("--json")) return ok(`${JSON.stringify(this.serverRuns)}\n`);
        if (args.includes("pair") && args.includes("list")) {
          return ok(this.pendingCodes.length ? this.pendingCodes.map((entry) => `${entry.code}  ${entry.name}  expires 2026-10-28T08:00:00.000Z`).join("\n") + "\n" : "No pairings waiting.\n");
        }
        if (args.includes("pair") && args.includes("approve")) {
          const code = args.at(-1)!;
          if (!this.pendingCodes.some((entry) => entry.code === code)) return fail("No pairing with that code.");
          this.approved.push(code);
          return ok("Approved. The device finishes signing in on its own.\n");
        }
        if (args.includes("init")) this.dirs.add("/var/lib/autopilot/workspaces/default/.git");
        return ok();
      case "mktemp": return ok("/tmp/tmp.build\n");
      case "dpkg-query": return ok(this.unattendedUpgrades ? "install ok installed" : "");
      case "apt-cache": return ok(this.nodeFromNodeSource ? "nodejs:\n  Installed: 24.22.1-1nodesource1\n  500 https://deb.nodesource.com/node_24.x nodistro/main arm64 Packages\n" : "nodejs:\n  Installed: 18.19.1+dfsg-6ubuntu5\n");
      case "apt-get":
        if (args.includes("unattended-upgrades")) this.unattendedUpgrades = true;
        return ok();
      case "systemctl":
        if (args[0] === "enable" && args.includes("docker.socket") && this.dockerInstalled) this.dockerSocket = true;
        if (args[0] === "restart" && args[1] === "docker.service") {
          if (!this.dockerSocket) return fail("dockerd: failed to load listeners: no sockets found via socket activation");
          this.docker = true;
        }
        if (args[0] === "enable") for (const unit of args.filter((arg) => arg.endsWith(".service"))) this.enabled.add(unit);
        if (args[0] === "disable") for (const unit of args.filter((arg) => arg.endsWith(".service"))) this.enabled.delete(unit);
        if (args[0] === "is-active") return ok(this.enabled.has(args[1]!) ? "active\n" : "inactive\n");
        return ok();
      case "curl":
        if (line.includes(":4750")) return ok("401");
        if (line.includes("/api/v1/health")) return ok(this.enabled.has("autopilot.service") ? "401" : "000");
        return ok();
      case "ufw":
        if (args[0] === "status") return ok(this.ufwActive ? "Status: active\n" : "Status: inactive\n");
        return ok();
      case "tailscale":
        if (args[0] === "version") return this.tailscaleInstalled ? ok("1.76.0\n") : fail("not installed");
        if (args[0] === "status" && args[1] === "--json") {
          return this.tailscaleUp
            ? ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1234.ts.net." } }))
            : ok(JSON.stringify({ BackendState: "NeedsLogin" }));
        }
        if (args[0] === "up") {
          this.tailscaleUp = true;
          return ok();
        }
        if (args[0] === "serve" && args[1] === "status") return ok(this.serving ? "https://box.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:4096\n" : "No serve config\n");
        if (args[0] === "serve") {
          this.serving = !args.includes("off");
          return ok();
        }
        return ok();
      default:
        void options;
        return ok();
    }
  }
}
