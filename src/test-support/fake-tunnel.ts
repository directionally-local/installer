import { EventEmitter } from "node:events";
import { connect, createServer, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { TunnelProcess, TunnelSpawner } from "../laptop/tunnel.js";

/**
 * A stand-in for `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> server` in tests: after a
 * short delay it listens on the local port and forwards each connection to `forwardTo`
 * (a fake API server), just as the real tunnel would.
 */
export class FakeTunnel extends EventEmitter implements TunnelProcess {
  exitCode: number | null = null;
  readonly stderr = new PassThrough();
  killed = false;
  private server: Server | undefined;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly sockets = new Set<Socket>();

  constructor(readonly args: string[], forwardTo: number | undefined, options: { delayMs?: number; failWith?: string } = {}) {
    super();
    const spec = args[args.indexOf("-L") + 1] ?? "";
    const localPort = Number(spec.split(":")[1]);
    this.timer = setTimeout(() => {
      if (this.killed) return;
      if (options.failWith) {
        this.stderr.write(`${options.failWith}\n`);
        this.exit(255);
        return;
      }
      this.server = createServer((socket) => {
        this.sockets.add(socket);
        if (forwardTo === undefined) return void socket.end();
        const upstream = connect({ host: "127.0.0.1", port: forwardTo });
        socket.pipe(upstream).pipe(socket);
        const close = () => { socket.destroy(); upstream.destroy(); };
        socket.on("error", close);
        upstream.on("error", close);
      });
      this.server.listen(localPort, "127.0.0.1");
    }, options.delayMs ?? 30);
  }

  kill(): boolean {
    this.killed = true;
    clearTimeout(this.timer);
    if (this.server) this.server.close(() => this.exit(0));
    else setImmediate(() => this.exit(0));
    for (const socket of this.sockets) socket.destroy();
    return true;
  }

  private exit(code: number): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code);
  }
}

export function fakeTunnels(forwardTo?: number, options: { delayMs?: number; failWith?: string } = {}): { spawn: TunnelSpawner; spawned: FakeTunnel[] } {
  const spawned: FakeTunnel[] = [];
  return {
    spawned,
    spawn: (args) => {
      const tunnel = new FakeTunnel(args, forwardTo, options);
      spawned.push(tunnel);
      return tunnel;
    },
  };
}
