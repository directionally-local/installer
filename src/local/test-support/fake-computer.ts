import type { RunOptions, RunResult, System, WriteOptions } from "../../system.js";
import { HTTP_STATUS_SCRIPT, PORT_FREE_SCRIPT } from "../probes.js";

export interface FakeRun {
  command: string;
  args: string[];
  input?: string;
  env?: Record<string, string>;
}

/**
 * A simulated Mac (or Linux desktop) with Docker Desktop, for "on this computer" tests.
 * launchctl/systemctl load and unload services, which then answer on the ports in their
 * env files; npm installs packages; Autopilot's CLI issues credentials. So setup can run
 * twice to prove it repairs without reinstalling.
 */
export class FakeComputer implements System {
  readonly dryRun = false;
  readonly files = new Map<string, { content: string; mode: number }>();
  /** Modification times (seconds) for `stat`; set on every write. */
  readonly mtimes = new Map<string, number>();
  readonly dirs = new Map<string, number | undefined>();
  readonly commands: FakeRun[] = [];
  readonly probes: FakeRun[] = [];
  readonly logs: string[] = [];
  readonly images = new Set<string>();
  readonly containers: Array<{ id: string; labels: string[] }> = [];
  /** launchd labels or systemd units that are running. */
  readonly running = new Set<string>();
  /** Services restarted in place (launchctl kickstart -k, systemctl --user restart), in order. */
  readonly restarted: string[] = [];
  /** Ports something else on this computer listens on. */
  readonly busy = new Set<number>();
  readonly credentials: Array<{ id: string; name: string; status: string; token: string; expiresAt: number }> = [];
  hotcellKeys = new Map<string, string>();
  /** A custom provider's address, from `--base-url`. */
  hotcellRouteUrls = new Map<string, string>();
  docker = true;
  /** Docker Desktop is installed as an app (it may be stopped). */
  dockerApp = true;
  dockerDenied = false;
  /** Containers reach host.docker.internal. */
  reachHost = true;
  git = true;
  uid = "501";
  diskFreeKb = 120 * 1024 * 1024;
  /** Docker Desktop's VM: 8 GB, 8 CPUs. */
  dockerMemBytes = 8 * 1024 * 1024 * 1024;
  systemdUser = true;
  bridgeIp: string | undefined = undefined;

  constructor(readonly home = "/Users/ada") {
    this.files.set(`${home}/.docker/run/docker.sock`, { content: "", mode: 0o755 });
    this.files.set("/opt/homebrew/opt/node/bin/node", { content: "", mode: 0o755 });
    this.files.set("/Applications/Docker.app/Contents/Info.plist", { content: "", mode: 0o644 });
    this.files.set("/etc/os-release", { content: 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n', mode: 0o644 });
  }

  get ran(): string[] {
    return this.commands.map(({ command, args }) => [command, ...args].join(" "));
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.commands.push({ command, args, ...(options.input !== undefined ? { input: options.input } : {}), ...(options.env ? { env: options.env } : {}) });
    const result = this.respond(command, args, options);
    if (result.code !== 0 && !options.allowFailure) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    return result;
  }

  async probe(command: string, args: string[], options: Pick<RunOptions, "env" | "input"> = {}): Promise<RunResult> {
    this.probes.push({ command, args, ...(options.input !== undefined ? { input: options.input } : {}), ...(options.env ? { env: options.env } : {}) });
    return this.respond(command, args, options);
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path)?.content;
  }

  async writeFile(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    this.files.set(path, { content, mode: options.mode ?? 0o644 });
    this.mtimes.set(path, Math.floor(Date.now() / 1000));
  }

  async mkdir(path: string, options: { mode?: number } = {}): Promise<void> {
    this.dirs.set(path, options.mode);
  }

  async remove(path: string): Promise<void> {
    for (const file of [...this.files.keys()]) if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
    for (const dir of [...this.dirs.keys()]) if (dir === path || dir.startsWith(`${path}/`)) this.dirs.delete(dir);
  }

  async exists(path: string): Promise<boolean> {
    if (path === "/Applications/Docker.app") return this.dockerApp;
    return this.files.has(path) || this.dirs.has(path) || [...this.files.keys(), ...this.dirs.keys()].some((entry) => entry.startsWith(`${path}/`));
  }

  log(line: string): void {
    this.logs.push(line);
  }

  /** The ports a running service of ours listens on, from its env file. */
  private ourPorts(): Map<number, "hotcell" | "autopilot"> {
    const ports = new Map<number, "hotcell" | "autopilot">();
    const env = (name: string) => Object.fromEntries((this.files.get(`${this.home}/.directionallylocal/config/${name}`)?.content ?? "")
      .split("\n").flatMap((line) => line.match(/^([A-Z_]+)=(.*)$/) ? [[line.split("=")[0]!, line.slice(line.indexOf("=") + 1)]] : []));
    if ([...this.running].some((name) => name.includes("hotcell"))) {
      const hotcell = env("hotcell.env");
      for (const key of ["HOTCELL_PORT", "HOTCELL_PROXY_PORT", "HOTCELL_EGRESS_PORT"]) if (hotcell[key]) ports.set(Number(hotcell[key]), "hotcell");
    }
    if ([...this.running].some((name) => name.includes("autopilot"))) {
      const autopilot = env("autopilot.env");
      if (autopilot.AUTOPILOT_PUBLIC_URL) ports.set(Number(autopilot.AUTOPILOT_PUBLIC_URL.split(":").at(-1)), "autopilot");
      if (autopilot.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN) ports.set(Number(autopilot.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN.split(":").at(-1)), "autopilot");
    }
    return ports;
  }

  private respond(command: string, args: string[], options: Pick<RunOptions, "env" | "input">): RunResult {
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
    const fail = (stderr = "failed"): RunResult => ({ code: 1, stdout: "", stderr });
    const line = args.join(" ");
    if (command.endsWith("/node") && args[0] === "-e") {
      if (args[1] === PORT_FREE_SCRIPT) {
        const port = Number(args[3]);
        return this.busy.has(port) || this.ourPorts().has(port) ? fail() : ok();
      }
      if (args[1] === HTTP_STATUS_SCRIPT) {
        const url = new URL(args[2]!);
        const owner = this.ourPorts().get(Number(url.port));
        if (owner === "hotcell") return ok("401\n");
        if (owner === "autopilot" && url.pathname === "/api/v1/health") {
          const token = (options.input ?? "").trim();
          return ok(token && this.credentials.some((entry) => entry.token === token && entry.status === "active") ? "200\n" : "401\n");
        }
        return ok("0\n");
      }
    }
    if (command.endsWith("/node") && args[0]?.endsWith("hotcell/dist/index.js")) {
      if (args[1] === "keys" && args[2] === "add") {
        // A keyless provider (ollama) comes without --stdin and stores an empty key.
        this.hotcellKeys.set(args[3]!, options.input ?? "");
        if (args.includes("--base-url")) this.hotcellRouteUrls.set(args[3]!, args[args.indexOf("--base-url") + 1]!);
        const home = options.env?.HOTCELL_HOME ?? "";
        this.files.set(`${home}/keys.json`, { content: "{}", mode: 0o600 });
        return ok("stored\n");
      }
      if (args[1] === "keys" && args[2] === "ls") {
        if (!this.files.has(`${options.env?.HOTCELL_HOME ?? ""}/keys.json`)) return ok(args.includes("--json") ? '{"routes":[]}\n' : "");
        // Like Hotcell's own listing: a header, then each provider with its masked value; `--json` lists routes.
        const mask = (value: string) => value.length <= 8 ? "•".repeat(Math.max(4, value.length)) : `${value.slice(0, 5)}…${value.slice(-2)}`;
        if (args.includes("--json")) {
          return ok(`${JSON.stringify({ routes: [...this.hotcellKeys].map(([key, value]) => ({ provider: key, active: true, ...(value ? { mask: mask(value) } : {}) })) })}\n`);
        }
        return ok(`PROVIDER  KEY           SOURCE\n${[...this.hotcellKeys].map(([key, value]) => `${key.padEnd(8)}  ${mask(value).padEnd(12)}  file\n`).join("")}`);
      }
      return ok();
    }
    if (command.endsWith("/node") && args[0]?.endsWith("autopilot-ai/bin/autopilot.mjs")) {
      const sub = args.slice(1, 4).join(" ");
      if (sub.startsWith("aster token create")) {
        const id = `cred_${this.credentials.length + 1}`;
        const token = `aster_${"t".repeat(30)}${this.credentials.length + 1}`;
        const expiresAt = Date.parse("2027-10-28T10:00:00Z");
        this.credentials.push({ id, name: args[args.indexOf("--name") + 1]!, status: "active", token, expiresAt });
        return ok(`${JSON.stringify({ credentialId: id, workspaceIds: ["default"], scopes: [], createdAt: 0, expiresAt, token })}\n`);
      }
      if (sub.startsWith("aster token list")) {
        return ok(`${JSON.stringify(this.credentials.map(({ token: _token, ...entry }) => ({ ...entry, scopes: [] })))}\n`);
      }
      if (sub.startsWith("aster token revoke")) {
        const entry = this.credentials.find((credential) => credential.id === args.at(-1));
        if (entry) entry.status = "revoked";
        return ok();
      }
      return ok();
    }
    switch (command) {
      case "id": return ok(`${this.uid}\n`);
      case "sw_vers": return ok("15.1\n");
      case "df": return ok(`Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 971350180 1000 ${this.diskFreeKb} 10% /System/Volumes/Data\n`);
      case "git":
        if (!this.git) return { code: 127, stdout: "", stderr: "not found" };
        if (args[0] === "--version") return ok("git version 2.50.1\n");
        if (args.includes("init")) this.dirs.set(`${args[1]}/.git`, undefined);
        return ok();
      case "sh":
        if (line === "-c command -v docker") return ok("/usr/local/bin/docker\n");
        return ok();
      case "ip": return this.bridgeIp ? ok(`4: docker0    inet ${this.bridgeIp}/16 brd 172.17.255.255 scope global docker0\n`) : fail("no docker0");
      case "systemctl":
        if (args[1] === "is-system-running") return this.systemdUser ? ok("running\n") : fail("Failed to connect to bus");
        if (args[1] === "restart") {
          this.running.add(args[2]!);
          this.restarted.push(args[2]!);
        }
        if (args[1] === "disable" && args[2] === "--now") this.running.delete(args[3]!);
        if (args[1] === "is-active") return ok(this.running.has(args[2]!) ? "active\n" : "inactive\n");
        return ok();
      case "launchctl": {
        if (args[0] === "bootstrap") {
          const plist = this.files.get(args[2]!)?.content ?? "";
          const label = plist.match(/<key>Label<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
          if (!label) return fail("Bootstrap failed: 5: Input/output error");
          this.running.add(label);
          return ok();
        }
        if (args[0] === "bootout") {
          const label = args[1]!.split("/").at(-1)!;
          return this.running.delete(label) ? ok() : fail("Boot-out failed: 3: No such process");
        }
        if (args[0] === "kickstart") {
          // -k restarts a loaded service; one that isn't loaded can't be kickstarted.
          const label = args.at(-1)!.split("/").at(-1)!;
          if (!this.running.has(label)) return fail("Could not find service");
          this.restarted.push(label);
          return ok();
        }
        if (args[0] === "print") {
          const label = args[1]!.split("/").at(-1)!;
          return this.running.has(label) ? ok(`${args[1]} = {\n\tstate = running\n\tpid = 4242\n}\n`) : fail("Could not find service");
        }
        return ok();
      }
      case "open":
        if (this.dockerApp) this.docker = true;
        return ok();
      case "npm":
        if (args[0] === "view") return ok(args[1] === "hotcell" ? "0.1.30\n" : "2.6.1\n");
        if (args[0] === "install" && args[1] === "--prefix") {
          // Each installed package reports the version its spec named (a tarball or path: a dev build).
          for (const pkg of ["autopilot-ai", "hotcell"]) {
            const spec = args.find((arg) => arg.startsWith(`${pkg}@`));
            const version = spec ? spec.slice(pkg.length + 1) : `9.9.9-dev.${pkg}`;
            this.files.set(`${args[2]}/node_modules/${pkg}/package.json`, { content: JSON.stringify({ name: pkg, version }), mode: 0o644 });
          }
          this.files.set(`${args[2]}/node_modules/hotcell/dist/index.js`, { content: "", mode: 0o755 });
          this.dirs.set(args[2]!, 0o700);
        }
        return ok();
      case "ln":
        for (const [path, file] of [...this.files]) if (path.startsWith(`${args[1]}/`)) this.files.set(path.replace(args[1]!, args[2]!), file);
        return ok();
      case "ls":
        return ok([...this.dirs.keys()].filter((dir) => dir.startsWith(`${args[1]}/`) && !dir.slice(args[1]!.length + 1).includes("/")).map((dir) => dir.split("/").at(-1)).join("\n"));
      case "mktemp": return ok("/tmp/tmp.build\n");
      case "stat": {
        const mtime = this.files.has(args.at(-1)!) ? this.mtimes.get(args.at(-1)!) : undefined;
        return mtime === undefined ? fail("No such file or directory") : ok(`${mtime}\n`);
      }
      case "wc": return ok("0\n");
      case "/usr/local/bin/docker": {
        if (args[0] === "context") return ok(`unix://${this.home}/.docker/run/docker.sock\n`);
        if (args[0] === "info") {
          if (this.dockerDenied) return { code: 1, stdout: "", stderr: "permission denied while trying to connect to the Docker daemon socket" };
          if (!this.docker) return fail("Cannot connect to the Docker daemon");
          return args[2]!.startsWith("{{.ServerVersion}}") ? ok(`29.5.2|Docker Desktop|${this.dockerMemBytes}|8\n`) : ok(`${this.dockerMemBytes}|8\n`);
        }
        if (!this.docker) return fail("Cannot connect to the Docker daemon");
        if (args[0] === "image" && args[1] === "inspect") return this.images.has(args[2]!) ? ok("[]") : fail("no such image");
        if (args[0] === "image" && args[1] === "rm") {
          this.images.delete(args[2]!);
          return ok();
        }
        if (args[0] === "build") {
          this.images.add(args[args.indexOf("-t") + 1]!);
          return ok();
        }
        if (args[0] === "run") return ok(this.reachHost && this.ourPorts().size > 0 ? "404\n" : "0\n");
        if (args[0] === "ps") {
          const filters = args.flatMap((arg, index) => args[index - 1] === "--filter" ? [arg.replace(/^label=/, "")] : []);
          return ok(this.containers.filter((entry) => filters.every((filter) => entry.labels.includes(filter))).map((entry) => entry.id).join("\n"));
        }
        if (args[0] === "rm") {
          for (const id of args.slice(2)) this.containers.splice(this.containers.findIndex((entry) => entry.id === id), 1);
          return ok();
        }
        return ok();
      }
      default:
        return ok();
    }
  }
}
