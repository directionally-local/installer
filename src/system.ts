import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { chmod, chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface RunOptions {
  /** Written to the command's stdin; how secrets reach commands without appearing in argv. */
  input?: string;
  env?: Record<string, string>;
  cwd?: string;
  /** Return a nonzero exit instead of throwing. */
  allowFailure?: boolean;
  /** Stream output to the terminal (long installs) instead of capturing it. */
  inherit?: boolean;
  /** Shown in place of the command in the plan, e.g. when an argument is sensitive. */
  describe?: string;
  /** Output carries a secret (e.g. a one-time link): keep it out of the install log. */
  secretOutput?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WriteOptions {
  mode?: number;
  /** "user:group", resolved by the system. */
  owner?: string;
  /** Values that must never be printed in a dry-run plan. */
  secret?: boolean;
}

/** Everything the installer does to a machine. Real, dry-run, and fake (tests) implementations. */
export interface System {
  readonly dryRun: boolean;
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  /** A read-only command (detection): runs even in a dry run, never throws. */
  probe(command: string, args: string[], options?: Pick<RunOptions, "env" | "input">): Promise<RunResult>;
  readFile(path: string): Promise<string | undefined>;
  writeFile(path: string, content: string, options?: WriteOptions): Promise<void>;
  mkdir(path: string, options?: { mode?: number; owner?: string }): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  log(line: string): void;
}

export class CommandError extends Error {
  constructor(readonly command: string, readonly result: RunResult) {
    super(`${command} failed (exit ${result.code})${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
    this.name = "CommandError";
  }
}

export class RealSystem implements System {
  readonly dryRun = false;
  private readonly logFd: number | undefined;

  /**
   * With `outputLog`, every command and its output goes to that file instead of the screen,
   * including long installs that would otherwise stream (`inherit`), so the terminal UI owns
   * the screen. Without it, those installs stream as before (plain mode, logs, CI).
   */
  constructor(
    private readonly output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    options: { outputLog?: string } = {},
  ) {
    if (options.outputLog) {
      mkdirSync(dirname(options.outputLog), { recursive: true, mode: 0o700 });
      this.logFd = openSync(options.outputLog, "w", 0o600);
      appendFileSync(this.logFd, `# directionallylocal ${new Date().toISOString()}\n`);
    }
  }

  run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return this.spawn(command, args, options, true);
  }

  private spawn(command: string, args: string[], options: RunOptions, logged: boolean): Promise<RunResult> {
    const log = logged ? this.logFd : undefined;
    const stream = options.inherit && this.logFd === undefined;
    if (log !== undefined) appendFileSync(log, `\n$ ${options.describe ?? [command, ...args].join(" ")}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: [options.input === undefined ? "ignore" : "pipe", stream ? "inherit" : "pipe", stream ? "inherit" : "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (log !== undefined && !options.secretOutput) appendFileSync(log, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (log !== undefined) appendFileSync(log, chunk);
      });
      child.on("error", (error) => {
        const result = { code: 127, stdout, stderr: stderr || error.message };
        if (options.allowFailure) resolve(result);
        else reject(new CommandError(options.describe ?? command, result));
      });
      child.on("close", (code) => {
        const result = { code: code ?? 1, stdout, stderr };
        if (log !== undefined && result.code !== 0) appendFileSync(log, `(exit ${result.code})\n`);
        if (result.code !== 0 && !options.allowFailure) reject(new CommandError(options.describe ?? [command, ...args].join(" "), result));
        else resolve(result);
      });
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
  }

  /** Detection probes are frequent and read-only; they stay out of the install log. */
  probe(command: string, args: string[], options: Pick<RunOptions, "env" | "input"> = {}): Promise<RunResult> {
    return this.spawn(command, args, { ...options, allowFailure: true }, false);
  }

  async readFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeFile(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const mode = options.mode ?? 0o644;
    // Create with the final mode so a secret is never briefly world-readable.
    await writeFile(path, content, { mode });
    await chmod(path, mode);
    if (options.owner) await this.chown(path, options.owner);
  }

  /**
   * Every directory this creates gets the mode and owner, not just the last one: Node's
   * recursive mkdir applies the mode to new parents too, so a root-owned 0700 parent would
   * lock the owner out of its own directory.
   */
  async mkdir(path: string, options: { mode?: number; owner?: string } = {}): Promise<void> {
    const created: string[] = [];
    for (let dir = resolve(path); !(await this.exists(dir)); dir = dirname(dir)) created.unshift(dir);
    await mkdir(path, { recursive: true, ...(options.mode !== undefined ? { mode: options.mode } : {}) });
    for (const dir of created.length > 0 ? created : [resolve(path)]) {
      if (options.mode !== undefined) await chmod(dir, options.mode);
      if (options.owner) await this.chown(dir, options.owner);
    }
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  async exists(path: string): Promise<boolean> {
    return stat(path).then(() => true, () => false);
  }

  log(line: string): void {
    this.output(line);
  }

  private async chown(path: string, owner: string): Promise<void> {
    const [user, group = user] = owner.split(":");
    const uid = Number((await this.run("id", ["-u", user!])).stdout.trim());
    const gid = Number((await this.run("getent", ["group", group!])).stdout.split(":")[2]);
    await chown(path, uid, gid);
  }
}

/**
 * Prints what `up` would change and changes nothing. Reads still hit the real machine,
 * so the plan reflects what is already installed.
 */
export class DryRunSystem implements System {
  readonly dryRun = true;
  private readonly real: RealSystem;

  constructor(private readonly output: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
    this.real = new RealSystem(output);
  }

  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    this.output(`  would run: ${options.describe ?? [command, ...args].join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  }

  probe(command: string, args: string[], options: Pick<RunOptions, "env" | "input"> = {}): Promise<RunResult> {
    return this.real.probe(command, args, options);
  }

  readFile(path: string): Promise<string | undefined> {
    return this.real.readFile(path);
  }

  async writeFile(path: string, content: string, options: WriteOptions = {}): Promise<void> {
    const mode = (options.mode ?? 0o644).toString(8).padStart(4, "0");
    this.output(`  would write: ${path} (${mode}${options.owner ? ` ${options.owner}` : ""})`);
    if (!options.secret) for (const line of content.trimEnd().split("\n")) this.output(`      ${line}`);
  }

  async mkdir(path: string, options: { mode?: number; owner?: string } = {}): Promise<void> {
    if (!(await this.real.exists(path))) this.output(`  would create: ${path}/${options.owner ? ` (${options.owner})` : ""}`);
  }

  async remove(path: string): Promise<void> {
    if (await this.real.exists(path)) this.output(`  would remove: ${path}`);
  }

  exists(path: string): Promise<boolean> {
    return this.real.exists(path);
  }

  log(line: string): void {
    this.output(line);
  }
}
