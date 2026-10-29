import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { RemoteClient } from "./client.js";
import type { RemoteServer, SshAccess } from "./config.js";
import { sshCommandLine, sshOptions } from "./ssh.js";

/**
 * A server set up with `dl setup` listens only on its own loopback (nothing exposed, no
 * Tailscale), so each laptop command opens an SSH tunnel for as long as it runs:
 * `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:4096 <server>`, then talks to the local end.
 * Servers connected with `dl connect URL` are reached directly, as before.
 */

export interface Endpoint {
  /** Base URL for the server's API from this laptop. */
  url: string;
  close(): Promise<void>;
}

export type RemoteOpener = (remote: RemoteServer) => Promise<Endpoint>;

/** The parts of a child process a tunnel needs; tests pass a fake. */
export interface TunnelProcess {
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null) => void): unknown;
  stderr: NodeJS.ReadableStream | null;
}

export type TunnelSpawner = (args: string[]) => TunnelProcess;

export interface TunnelOptions {
  spawn?: TunnelSpawner;
  freePort?: () => Promise<number>;
  /** Resolves true once something accepts connections on 127.0.0.1:port. */
  accepts?: (port: number) => Promise<boolean>;
  timeoutMs?: number;
  pollMs?: number;
}

const realSpawn: TunnelSpawner = (args) => spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });

/** The ssh arguments for a tunnel from a local port to the server's loopback port. */
export function tunnelArgs(access: SshAccess, localPort: number, remotePort: number): string[] {
  return ["-N", "-o", "ExitOnForwardFailure=yes", ...sshOptions(access), "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, access.target];
}

export function createOpener(options: TunnelOptions = {}): RemoteOpener {
  const spawnTunnel = options.spawn ?? realSpawn;
  const freePort = options.freePort ?? pickFreePort;
  const accepts = options.accepts ?? acceptsConnections;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 100;

  return async (remote) => {
    if (!remote.ssh) return { url: remote.url, close: async () => {} };
    const access = remote.ssh;
    const remotePort = Number(new URL(remote.url).port || 80);
    const port = await freePort();
    const child = spawnTunnel(tunnelArgs(access, port, remotePort));
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    let exited = child.exitCode !== null;
    child.once("exit", () => { exited = true; });
    // If this process ends without closing the tunnel (an uncaught error), take ssh with it.
    const onExit = () => { if (!exited) child.kill("SIGTERM"); };
    process.once("exit", onExit);

    const close = async () => {
      process.off("exit", onExit);
      if (exited) return;
      const gone = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
      child.kill("SIGTERM");
      await gone;
    };

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited) {
        await close();
        const detail = stderr.trim().split("\n").at(-1)?.trim();
        throw new Error(`Couldn't open an SSH tunnel to ${remote.name} (${access.target})${detail ? `: ${detail}` : ""}\n  Check that this works: ${sshCommandLine(access)}`);
      }
      if (await accepts(port)) return { url: `http://127.0.0.1:${port}`, close };
      if (Date.now() >= deadline) {
        await close();
        throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s opening an SSH tunnel to ${remote.name} (${access.target}).\n  Check that this works: ${sshCommandLine(access)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
}

export const openRemote: RemoteOpener = createOpener();

/**
 * For an interactive session: ssh in its own process group, so Ctrl-C typed into the agent's
 * screen (which the terminal sends to its whole foreground group) doesn't drop the tunnel.
 * The session closes it itself when the agent exits, or when dl is told to stop.
 */
export const openRemoteForSession: RemoteOpener = createOpener({
  spawn: (args) => spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"], detached: true }),
});

/**
 * The endpoints one command uses: at most one tunnel per server, reused across its
 * requests, all closed when the command ends (commands close it in `finally`, which also
 * runs when Ctrl-C aborts a watch).
 */
export class Connections {
  private readonly open = new Map<string, Promise<Endpoint>>();

  constructor(private readonly opener: RemoteOpener = openRemote) {}

  async client(remote: RemoteServer): Promise<RemoteClient> {
    let endpoint = this.open.get(remote.name);
    if (!endpoint) {
      endpoint = this.opener(remote);
      this.open.set(remote.name, endpoint);
    }
    return new RemoteClient((await endpoint).url, remote.token);
  }

  async close(): Promise<void> {
    const endpoints = [...this.open.values()];
    this.open.clear();
    await Promise.all(endpoints.map((endpoint) => endpoint.then((entry) => entry.close(), () => {})));
  }
}

/** Runs `work` with a fresh set of connections and always closes them. */
export async function withConnections<T>(opener: RemoteOpener | undefined, work: (connections: Connections) => Promise<T>): Promise<T> {
  const connections = new Connections(opener);
  try {
    return await work(connections);
  } finally {
    await connections.close();
  }
}

/** A port nothing listens on right now (the OS picks it; ssh binds it a moment later). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => port ? resolve(port) : reject(new Error("no free port")));
    });
  });
}

export function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
