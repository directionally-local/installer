import { palette } from "../ui.js";
import { resolveRemote } from "./config.js";
import { openBrowser } from "./open-browser.js";
import { checkServer, realSshExec, shellQuote, type ServerFacts, type SshExec } from "./ssh.js";
import { createForwarder, type PortForwarder } from "./tunnel.js";

/**
 * `dl preview <id>` on a laptop: ask the server to deploy the task's branch, tunnel to the
 * preview's loopback port, and open it. The server does the work (`dl preview <id> --json`);
 * this only reaches it, so the hook Autopilot will call later is the same code path.
 */

export interface PreviewIO {
  out: (text: string) => void;
  err: (text: string) => void;
  color?: boolean;
}

export interface LaptopPreviewDeps {
  ssh?: SshExec;
  forward?: PortForwarder;
  openBrowser?: (url: string) => boolean;
  /** Resolves when the user is done with the preview; tests replace it. */
  hold?: () => Promise<void>;
}

/** Non-root users run the server commands with sudo; checkServer made sure it needs no password. */
function sudo(facts: Pick<ServerFacts, "root">): string {
  return facts.root ? "" : "sudo -n ";
}

export async function preview(input: { id: string; server?: string }, deps: LaptopPreviewDeps, io: PreviewIO): Promise<number> {
  const c = palette(io.color === true);
  const remote = await resolveRemote(input.server);
  if (!remote.ssh) {
    io.err(`\n  ${c.red("✗")} ${remote.name} wasn't set up over SSH, so this laptop can't reach a preview on it.\n  On the server: ${c.bold(`dl preview ${input.id}`)}\n\n`);
    return 1;
  }

  const ssh = deps.ssh ?? realSshExec;
  const facts = await checkServer(remote.ssh, ssh, remote.name);
  io.err(`  ${c.cyan("·")} Deploying ${input.id} on ${remote.name}…\n`);
  const result = await ssh(remote.ssh, `${sudo(facts)}dl preview ${shellQuote(input.id)} --json`);
  const answer = lastJson(result.stdout) as { id?: unknown; port?: unknown } | undefined;
  if (result.code !== 0 || typeof answer?.port !== "number") {
    const detail = lastLine(result.stderr) || lastLine(result.stdout) || `dl preview exited with ${result.code}`;
    io.err(`\n  ${c.red("✗")} ${detail}\n\n`);
    return 1;
  }

  const forward = deps.forward ?? createForwarder();
  const endpoint = await forward(remote.ssh, answer.port, remote.name);
  const id = typeof answer.id === "string" ? answer.id : input.id;
  io.out(`\n  ${c.green("✓")} ${id} is live at ${c.bold(endpoint.url)}\n`);
  io.out(`  ${c.dim("Ctrl-C closes the tunnel; the preview keeps running (dl preview " + id + " --remove stops it).")}\n\n`);
  if ((deps.openBrowser ?? openBrowser)(endpoint.url)) io.out(`  ${c.dim("(opened it for you)")}\n\n`);

  try {
    await (deps.hold ?? holdUntilInterrupted)();
  } finally {
    await endpoint.close();
  }
  return 0;
}

function holdUntilInterrupted(): Promise<void> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve());
  });
}

function lastJson(text: string): unknown {
  for (const line of text.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // keep looking: a banner or warning may come before the JSON
    }
  }
  return undefined;
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}
