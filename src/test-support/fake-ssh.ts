import type { SshAccess } from "../laptop/config.js";
import type { SshExec, SshExecOptions, SshResult } from "../laptop/ssh.js";

export interface SshCall {
  access: SshAccess;
  command: string;
  input?: string;
}

/**
 * A user's server, as seen through `ssh <target> '<command>'` from the laptop: the probe,
 * the install script's plain lines, and `dl up` / `dl pair` in their machine modes.
 * Commands change its state the way the real ones would, so setup can be run twice.
 */
export class FakeSshServer {
  readonly calls: SshCall[] = [];
  /**
   * Private keys (the -i path) the server accepts. Undefined means any, including ssh's
   * defaults; a list means only those keys, so a connection without -i is refused.
   */
  acceptedKeys: string[] | undefined;
  /** id -u, id -un, OS, CPU, root/sudo/nosudo, then `hostname -s`. */
  probe = "0\nroot\nubuntu 24.04\naarch64\nroot\nubuntu-4gb-nbg1-1\n";
  newHost = true;
  installed = false;
  keys = new Set<string>();
  installFails = false;
  bootstrapFails = false;
  paired: string[] = [];
  /** The server's dl predates `dl keys`. */
  oldDl = false;
  /** Replaced keys, as the server got them on stdin. */
  replaced: Array<{ key: string; value: string }> = [];
  /** What `dl keys set` answers instead of storing, e.g. "OpenRouter rejected that key." */
  rejectKey: string | undefined;
  /** What `dl keys --json` reports. */
  listing: unknown[] = [
    { key: "provider", set: true, detail: "openrouter · sk-or…aa" },
    { key: "github", set: true, detail: "signed in as sinameraji" },
  ];
  /** The provider block the last `--answers-stdin` carried, as the server parsed it. */
  provider: Record<string, unknown> | undefined;
  /** Every `--answers-stdin` object, in order. */
  answers: Array<Record<string, unknown>> = [];
  /** The server's dl predates providers: it knows `openrouterKey` and says "openrouter" in --needs. */
  oldProviderDl = false;

  readonly exec: SshExec = async (access, command, options: SshExecOptions = {}) => {
    this.calls.push({ access: { ...access }, command, ...(options.input !== undefined ? { input: options.input } : {}) });
    const out = (text: string) => { for (const line of text.split("\n").slice(0, -1)) options.onStdoutLine?.(line); };
    const err = (text: string) => { for (const line of text.split("\n").slice(0, -1)) options.onStderrLine?.(line); };
    const result = (code: number, stdout = "", stderr = ""): SshResult => {
      out(stdout);
      err(stderr);
      return { code, stdout, stderr };
    };
    // As with real ssh, the host key is saved on the first connection, even one whose key is refused.
    const warning = this.newHost ? "Warning: Permanently added '203.0.113.10' (ED25519) to the list of known hosts.\n" : "";
    this.newHost = false;
    if (this.acceptedKeys && !(access.identityFile && this.acceptedKeys.includes(access.identityFile))) {
      return result(255, "", `${warning}${access.target}: Permission denied (publickey).\n`);
    }
    if (command.startsWith("id -u;")) return result(0, this.probe, warning);
    if (command.includes("dl-install.sh")) {
      if (this.bootstrapFails) return result(1, ".. Installing Node.js\nE: Unable to locate package nodejs\n", "directionallylocal: Installing Node.js failed\n");
      this.installed = true;
      return result(0, `.. Installing Node.js\nok Installing Node.js: 24.11.0\n.. Installing dl\nok Installing dl: ${this.installed ? "0.2.0" : ""}\n`);
    }
    if (!this.installed) return result(127, "", "sh: 1: dl: not found\n");
    if (command.includes("dl up --needs")) {
      const needs = [this.oldProviderDl ? "openrouter" : "provider", "github"].filter((need) => !this.keys.has(need === "openrouter" ? "provider" : need));
      return result(0, `${JSON.stringify({ needs })}\n`);
    }
    if (command.includes("--answers-stdin")) {
      const answers = JSON.parse(options.input ?? "{}") as { openrouterKey?: string; githubToken?: string; provider?: Record<string, unknown> };
      this.answers.push(answers);
      if (answers.provider && !this.oldProviderDl) {
        this.provider = answers.provider;
        this.keys.add("provider");
      } else if (answers.openrouterKey) {
        this.provider = { id: "openrouter", apiKey: answers.openrouterKey };
        this.keys.add("provider");
      }
      if (answers.githubToken) this.keys.add("github");
      const events: unknown[] = [
        { event: "title", text: "Directionally Local" },
        { event: "line", status: "done", label: "Checked this machine", detail: "Ubuntu 24.04 · 4 CPU · 7.5 GB · 70 GB free" },
        ...(this.provider ? [{ event: "line", status: "done", label: "Provider key", detail: "kept in Hotcell · from your laptop" }] : [{ event: "line", status: "info", label: "Provider key", detail: "not set yet" }]),
        { event: "plan", steps: [{ id: "docker", label: "Setting up Docker" }, { id: "image", label: "Building the sandbox image" }, { id: "access", label: "Starting the server" }] },
        { event: "start", id: "docker" },
        { event: "done", id: "docker", detail: "27.3.1" },
        { event: "start", id: "image" },
      ];
      if (this.installFails) {
        events.push({ event: "fail", id: "image", message: "Cannot connect to the Docker daemon" }, { event: "error", message: "Building the sandbox image failed" });
        return result(1, events.map((event) => `${JSON.stringify(event)}\n`).join(""), "see /var/log/directionallylocal/up.log\n");
      }
      events.push(
        { event: "done", id: "image", detail: "built" },
        { event: "start", id: "access" },
        { event: "done", id: "access", detail: "private · reached over SSH" },
        { event: "warn", text: "Swap is off" },
        // As in SSH mode: no estimate here, so the laptop works it out from the machine check.
        { event: "ready", headline: "Ready", items: [{ label: "On your laptop, from inside a GitHub repository", value: 'dl run "fix the flaky checkout test"' }] },
      );
      return result(0, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    }
    if (/\bdl keys\b/.test(command)) {
      if (this.oldDl) return result(2, "", `Unknown option '--${command.includes("--stdin") ? "stdin" : "json"}'\n`);
      const set = /dl keys set (\S+) --stdin --json$/.exec(command);
      if (set) {
        const key = set[1]!;
        if (this.rejectKey) return result(1, `${JSON.stringify({ ok: false, key, error: this.rejectKey })}\n`);
        this.replaced.push({ key, value: (options.input ?? "").split("\n")[0]! });
        this.keys.add(key);
        return result(0, `${JSON.stringify({ ok: true, key, detail: key === "github" ? "signed in as sinameraji; Autopilot restarted" : "replaced in Hotcell; Hotcell restarted" })}\n`);
      }
      if (/dl keys --json$/.test(command)) return result(0, `${JSON.stringify({ keys: this.listing })}\n`);
    }
    if (command.includes("dl pair")) {
      const name = /--name '([^']*)'/.exec(command)?.[1] ?? "?";
      this.paired.push(name);
      return result(0, `${JSON.stringify({ token: `aster_laptop_token_${"0".repeat(34)}`, credentialId: `cred-${this.paired.length}`, name, expiresAt: "2027-01-01T00:00:00.000Z", url: "http://127.0.0.1:4096" })}\n`);
    }
    return result(127, "", `unexpected command: ${command}\n`);
  };
}
