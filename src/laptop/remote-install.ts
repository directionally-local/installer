import { agentCapacity } from "../detect.js";
import { CELL_MEMORY_MB } from "../layout.js";
import { OPENROUTER, type ProviderAnswer } from "../provider.js";
import { PlainUi, type Ui } from "../ui.js";
import type { Need } from "./credentials.js";
import { shellQuote, type ServerFacts, type SshExec } from "./ssh.js";
import type { SshAccess } from "./config.js";

/**
 * Installing on the user's server from the laptop, over SSH, through the server-side
 * commands' machine-readable modes:
 *   1. bootstrap   install.sh with DL_INSTALL_ONLY=1 (plain `.. step` / `ok step: detail` lines)
 *   2. install     `dl up --access ssh --answers-stdin --events json` with `{}` (NDJSON out): everything but the keys
 *   3. needs       `dl up --needs --access ssh` (one JSON line: which keys it still lacks)
 *   4. keys        the same `dl up --answers-stdin`, now with the provider Autopilot's picker chose and the GitHub token
 *   5. pair        `dl pair --name … --json` (a credential for this laptop)
 * The server's checklist is replayed into the laptop's own Ui, so it animates here.
 */

/** What the laptop sends a server on stdin: the provider block, the GitHub token, or both (nothing for a plain repair). */
export interface ServerAnswers {
  provider?: ProviderAnswer;
  githubToken?: string;
}

export const INSTALL_URL = "https://directionallylocal.run";

/** A fresh Ui for each checklist: a TerminalUi redraws only the last plan it drew. */
export type UiFactory = () => Ui;

/** Non-root users run the server commands with sudo; checkServer made sure it needs no password. */
function sudo(facts: Pick<ServerFacts, "root">): string {
  return facts.root ? "" : "sudo -n ";
}

export function bootstrapCommand(facts: Pick<ServerFacts, "root">, installUrl = INSTALL_URL): string {
  const run = facts.root ? "DL_INSTALL_ONLY=1 sh /tmp/dl-install.sh" : "sudo -n env DL_INSTALL_ONLY=1 sh /tmp/dl-install.sh";
  return `curl -fsSL ${shellQuote(installUrl)} -o /tmp/dl-install.sh && ${run}`;
}

/**
 * Renders install.sh's plain lines as a checklist. Steps aren't known up front, so each new
 * one re-plans the list on a terminal (and restores the finished steps' ticks).
 */
export class BootstrapRenderer {
  private readonly steps: Array<{ id: string; label: string; detail?: string; done: boolean }> = [];
  private active: string | undefined;
  private readonly output: string[] = [];
  failure: string | undefined;

  constructor(private readonly ui: Ui) {}

  stdout(line: string): void {
    const started = /^\.\. (.+)$/.exec(line);
    if (started) return this.start(started[1]!.trim());
    const finished = /^ok ([^:]+?)(?:: (.*))?$/.exec(line);
    if (finished) return this.done(finished[1]!.trim(), finished[2]?.trim());
    this.keep(line);
  }

  stderr(line: string): void {
    const failed = /^directionallylocal: (.+)$/.exec(line);
    if (failed) {
      this.failure = failed[1]!.trim();
      return;
    }
    this.keep(line);
  }

  /** After install.sh exits: fails the running step and throws with its output when it failed. */
  finish(code: number): void {
    if (code === 0) {
      if (this.active) this.done(this.active);
      this.ui.finish();
      return;
    }
    const what = this.failure ?? `the install script exited with ${code}`;
    const id = this.active ?? this.steps.at(-1)?.id;
    if (id) this.ui.fail(id, what);
    this.ui.finish();
    const tail = this.output.slice(-15).map((line) => `    ${line}`).join("\n");
    throw new Error(`Installing dl on the server failed: ${what}${tail ? `\n${tail}` : ""}`);
  }

  private start(label: string): void {
    if (this.active && this.active !== label) this.done(this.active);
    let step = this.steps.find((entry) => entry.id === label);
    if (!step) {
      step = { id: label, label, done: false };
      this.steps.push(step);
      this.ui.plan(this.steps.map(({ id, label: text }) => ({ id, label: text })));
      // plan() shows every step as pending again; on a terminal, put the finished ones back.
      if (this.ui.interactive) for (const entry of this.steps) if (entry.done) this.ui.done(entry.id, entry.detail);
    }
    this.active = label;
    this.ui.start(label);
  }

  private done(label: string, detail?: string): void {
    if (!this.steps.some((entry) => entry.id === label)) this.start(label);
    const step = this.steps.find((entry) => entry.id === label)!;
    step.done = true;
    if (detail !== undefined) step.detail = detail;
    if (this.active === label) this.active = undefined;
    this.ui.done(label, detail);
  }

  private keep(line: string): void {
    if (!line.trim()) return;
    this.output.push(line);
    if (this.output.length > 200) this.output.shift();
  }
}

export async function bootstrap(access: SshAccess, facts: ServerFacts, ssh: SshExec, ui: Ui, installUrl?: string): Promise<void> {
  const renderer = new BootstrapRenderer(ui);
  const result = await ssh(access, bootstrapCommand(facts, installUrl), {
    onStdoutLine: (line) => renderer.stdout(line),
    onStderrLine: (line) => renderer.stderr(line),
  });
  renderer.finish(result.code);
}

/** Which keys the server still lacks, so a configured server is asked nothing. */
export async function serverNeeds(access: SshAccess, facts: ServerFacts, ssh: SshExec): Promise<Need[]> {
  const result = await ssh(access, `${sudo(facts)}dl up --needs --access ssh`);
  const parsed = lastJson(result.stdout) as { needs?: unknown } | undefined;
  if (result.code !== 0 || !parsed || !Array.isArray(parsed.needs)) {
    throw new Error(`Couldn't ask the server what it needs: ${lastLine(result.stderr) || lastLine(result.stdout) || `exit ${result.code}`}`);
  }
  // An older server says "openrouter" where a newer one says "provider": the same question here.
  return [...new Set(parsed.needs.map((need) => (need === "openrouter" ? "provider" : need)))].filter((need): need is Need => need === "provider" || need === "github" || need === "tailscale");
}

/**
 * Replays `dl up --events json` into Ui calls. The server's own title and ready screen are
 * skipped (the laptop prints its own); "answered" becomes a plain ✓ line, since on a
 * terminal answered() erases the prompt above it, and there is none here.
 */
export class EventReplayer {
  private ui: Ui;
  private planned = false;
  private readonly ids = new Set<string>();
  private readonly output: string[] = [];
  error: string | undefined;
  capacity: number | undefined;

  constructor(private readonly newUi: UiFactory) {
    this.ui = newUi();
  }

  line(text: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { event?: unknown }).event !== "string") throw new Error("not an event");
      event = parsed as Record<string, unknown>;
    } catch {
      if (text.trim()) this.output.push(text);
      return;
    }
    const str = (key: string) => typeof event[key] === "string" ? event[key] as string : undefined;
    switch (event.event) {
      case "line":
      case "answered": {
        // A line after a checklist starts a new one below it, or the redraw would overwrite it.
        this.fresh();
        const status = event.event === "answered" ? "done" : str("status");
        this.capacity ??= capacityFromMachine(str("label"), str("detail"));
        this.ui.line(status === "done" || status === "failed" ? status : "info", str("label") ?? "", ...optional(str("detail")));
        return;
      }
      case "plan": {
        if (this.planned) this.fresh();
        const steps = Array.isArray(event.steps) ? (event.steps as Array<Record<string, unknown>>)
          .filter((step) => typeof step.id === "string")
          .map((step) => ({ id: step.id as string, label: typeof step.label === "string" ? step.label : step.id as string })) : [];
        for (const step of steps) this.ids.add(step.id);
        this.ui.plan(steps);
        this.planned = true;
        return;
      }
      case "start":
      case "done":
      case "fail": {
        const id = str("id");
        if (!id || !this.ids.has(id)) return;
        if (event.event === "start") this.ui.start(id, ...optional(str("detail")));
        else if (event.event === "done") this.ui.done(id, ...optional(str("detail")));
        else this.ui.fail(id, str("message") ?? "failed");
        return;
      }
      case "warn":
        if (str("text")) this.ui.warn(str("text")!);
        return;
      case "ready":
        this.capacity = capacityFrom(event) ?? this.capacity;
        return;
      case "error":
        this.error = str("message") ?? "the install failed";
        return;
      default:
        // "title", and anything newer than this laptop knows about.
        return;
    }
  }

  /** Recent lines that weren't events (the server's own messages), for an error. */
  tail(): string[] {
    return this.output.slice(-15);
  }

  finish(): void {
    this.ui.finish();
  }

  private fresh(): void {
    if (!this.planned) return;
    this.ui.finish();
    this.ui = this.newUi();
    this.planned = false;
    this.ids.clear();
  }
}

function optional(value: string | undefined): [] | [string] {
  return value === undefined ? [] : [value];
}

/**
 * In SSH mode the server's ready screen has no estimate, so it's worked out here the way
 * `dl up` does, from its machine check ("Ubuntu 24.04 · 4 CPU · 7.5 GB · …").
 */
function capacityFromMachine(label: string | undefined, detail: string | undefined): number | undefined {
  if (label !== "Checked this machine" || !detail) return undefined;
  const cpus = /(\d+) CPU/.exec(detail);
  const memory = /([\d.]+) GB(?! free)/.exec(detail);
  if (!cpus || !memory) return undefined;
  return agentCapacity({ cpus: Number(cpus[1]), memoryMb: Math.round(Number(memory[1]) * 1024) }, CELL_MEMORY_MB);
}

/** "fits ~6 agents at once" anywhere in the server's ready screen (non-SSH servers print it). */
function capacityFrom(event: Record<string, unknown>): number | undefined {
  const match = /fits ~(\d+)/.exec(JSON.stringify(event));
  return match ? Number(match[1]) : undefined;
}

/**
 * The answers as the wire carries them. An older server knows only `openrouterKey`, so an
 * OpenRouter provider is sent both ways; it ignores the field it doesn't know.
 */
export function wireAnswers(answers: ServerAnswers): Record<string, unknown> {
  const { provider, githubToken } = answers;
  return {
    ...(provider ? { provider: { id: provider.id, baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiKeyEnv: provider.apiKeyEnv, ...(provider.authHeader ? { authHeader: provider.authHeader } : {}), ...(provider.authFormat ? { authFormat: provider.authFormat } : {}) } } : {}),
    ...(provider?.id === OPENROUTER.id && provider.apiKey ? { openrouterKey: provider.apiKey } : {}),
    ...(githubToken ? { githubToken } : {}),
  };
}

/** Runs the install, answers on stdin as one JSON object. Resolves with the capacity estimate, if given. */
export async function installOnServer(access: SshAccess, facts: ServerFacts, ssh: SshExec, answers: ServerAnswers, newUi: UiFactory): Promise<{ capacity?: number }> {
  const replay = new EventReplayer(newUi);
  const stderr: string[] = [];
  const result = await ssh(access, `${sudo(facts)}dl up --access ssh --answers-stdin --events json`, {
    input: `${JSON.stringify(wireAnswers(answers))}\n`,
    onStdoutLine: (line) => replay.line(line),
    onStderrLine: (line) => { if (line.trim()) stderr.push(line); },
  });
  replay.finish();
  if (result.code !== 0 || replay.error) {
    const tail = [...replay.tail(), ...stderr.slice(-15)].map((line) => `    ${line}`).join("\n");
    throw new Error(`Setting up the server failed: ${replay.error ?? `dl up exited with ${result.code}`}${tail ? `\n${tail}` : ""}\n  Fix it and run dl setup again; it picks up where it stopped.`);
  }
  return replay.capacity === undefined ? {} : { capacity: replay.capacity };
}

/**
 * Stores the keys on an installed server: the same `dl up --answers-stdin`, whose checklist
 * (a quick repair pass that restarts the services) stays off the screen; only an error shows.
 */
export async function applyOnServer(access: SshAccess, facts: ServerFacts, ssh: SshExec, answers: ServerAnswers): Promise<void> {
  const replay = new EventReplayer(() => new PlainUi(() => {}));
  const stderr: string[] = [];
  const result = await ssh(access, `${sudo(facts)}dl up --access ssh --answers-stdin --events json`, {
    input: `${JSON.stringify(wireAnswers(answers))}\n`,
    onStdoutLine: (line) => replay.line(line),
    onStderrLine: (line) => { if (line.trim()) stderr.push(line); },
  });
  if (result.code !== 0 || replay.error) {
    const tail = [...replay.tail(), ...stderr.slice(-15)].map((line) => `    ${line}`).join("\n");
    throw new Error(`Storing the keys on the server failed: ${replay.error ?? `dl up exited with ${result.code}`}${tail ? `\n${tail}` : ""}`);
  }
}

export interface Pairing {
  token: string;
  credentialId: string;
  name: string;
  expiresAt: string;
  url: string;
}

/** A credential for this laptop, issued on the server (no browser approval needed: SSH already proved who we are). */
export async function pairLaptop(access: SshAccess, facts: ServerFacts, ssh: SshExec, name: string): Promise<Pairing> {
  const result = await ssh(access, `${sudo(facts)}dl pair --name ${shellQuote(name)} --json`);
  const parsed = lastJson(result.stdout) as Partial<Pairing> | undefined;
  const fields = ["token", "credentialId", "name", "expiresAt", "url"] as const;
  if (result.code !== 0 || !parsed || !fields.every((key) => typeof parsed[key] === "string")) {
    throw new Error(`Couldn't connect this laptop to the server: ${lastLine(result.stderr) || `dl pair exited with ${result.code}`}`);
  }
  return parsed as Pairing;
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
