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
  /** Keys the server accepts; undefined means any (the agent's default key works). */
  acceptedKeys: string[] | undefined;
  probe = "0\nroot\nubuntu 24.04\naarch64\nroot\n";
  newHost = true;
  installed = false;
  keys = new Set<string>();
  installFails = false;
  bootstrapFails = false;
  paired: string[] = [];

  readonly exec: SshExec = async (access, command, options: SshExecOptions = {}) => {
    this.calls.push({ access: { ...access }, command, ...(options.input !== undefined ? { input: options.input } : {}) });
    const out = (text: string) => { for (const line of text.split("\n").slice(0, -1)) options.onStdoutLine?.(line); };
    const err = (text: string) => { for (const line of text.split("\n").slice(0, -1)) options.onStderrLine?.(line); };
    const result = (code: number, stdout = "", stderr = ""): SshResult => {
      out(stdout);
      err(stderr);
      return { code, stdout, stderr };
    };
    if (this.acceptedKeys && !(access.identityFile && this.acceptedKeys.includes(access.identityFile))) {
      return result(255, "", `${access.target}: Permission denied (publickey).\n`);
    }
    if (command.startsWith("id -u;")) {
      const warning = this.newHost ? "Warning: Permanently added '203.0.113.10' (ED25519) to the list of known hosts.\n" : "";
      this.newHost = false;
      return result(0, this.probe, warning);
    }
    if (command.includes("dl-install.sh")) {
      if (this.bootstrapFails) return result(1, ".. Installing Node.js\nE: Unable to locate package nodejs\n", "directionallylocal: Installing Node.js failed\n");
      this.installed = true;
      return result(0, `.. Installing Node.js\nok Installing Node.js: 24.11.0\n.. Installing dl\nok Installing dl: ${this.installed ? "0.2.0" : ""}\n`);
    }
    if (!this.installed) return result(127, "", "sh: 1: dl: not found\n");
    if (command.includes("dl up --needs")) {
      const needs = ["openrouter", "github"].filter((need) => !this.keys.has(need));
      return result(0, `${JSON.stringify({ needs })}\n`);
    }
    if (command.includes("--answers-stdin")) {
      const answers = JSON.parse(options.input ?? "{}") as { openrouterKey?: string; githubToken?: string };
      if (answers.openrouterKey) this.keys.add("openrouter");
      if (answers.githubToken) this.keys.add("github");
      const events: unknown[] = [
        { event: "title", text: "Directionally Local" },
        { event: "line", status: "done", label: "Checked this machine", detail: "Ubuntu 24.04 · 4 CPU · 7.5 GB · 70 GB free" },
        { event: "answered", label: "OpenRouter key", detail: "stored in Hotcell" },
        { event: "plan", steps: [{ id: "docker", label: "Setting up Docker" }, { id: "image", label: "Building the sandbox image" }] },
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
        { event: "warn", text: "Swap is off" },
        // As in SSH mode: no estimate here, so the laptop works it out from the machine check.
        { event: "ready", headline: "Ready", items: [{ label: "On your laptop, from inside a GitHub repository", value: 'dl run "fix the flaky checkout test"' }] },
      );
      return result(0, events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    }
    if (command.includes("dl pair")) {
      const name = /--name '([^']*)'/.exec(command)?.[1] ?? "?";
      this.paired.push(name);
      return result(0, `${JSON.stringify({ token: `aster_laptop_token_${"0".repeat(34)}`, credentialId: `cred-${this.paired.length}`, name, expiresAt: "2027-01-01T00:00:00.000Z", url: "http://127.0.0.1:4096" })}\n`);
    }
    return result(127, "", `unexpected command: ${command}\n`);
  };
}
