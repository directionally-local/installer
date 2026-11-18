import { userInfo } from "node:os";
import { publicUrl, reopenSignups, shareOnTailnet, startChat, tailscaleBlocker, tunnelHint, uiStatePath, type ChatUiOptions } from "./chat-ui.js";
import type { FetchModel } from "./model-smoke.js";
import type { Prompter } from "./prompt.js";
import type { System } from "./system.js";
import { HTTPS_CERTS_URL, installTailscale, machineName, tailscaleState, type TailscaleState } from "./tailscale.js";
import { palette, type Ui } from "./ui.js";

/**
 * The GPU first run's last step, when the answer to Autopilot's "How will your team use it?" was
 * Browser chat or Both (gpu-handoff.ts): the team chat, on a private HTTPS link, done for them.
 *
 * 1. Tailscale: installed when missing (server mode's install), signed in when logged out
 *    (`tailscale up --qr` prints the sign-in link and a QR code for a phone, and waits), and
 *    HTTPS certificates checked: when the tailnet has them off, the admin-console link is shown
 *    and dl waits until they're on.
 * 2. `dl ui up` and `dl ui share`: Open WebUI on loopback, served over HTTPS on the tailnet name.
 * 3. The final screen: the admin link in red (whoever opens it first becomes the admin), then
 *    how the team gets in. dl waits for the admin account, then restarts Open WebUI once so
 *    sign-ups open (making the first account turns them off until a restart).
 *
 * Nothing here is plain HTTP: when Tailscale can't be used, it says why and what to do next,
 * and stops.
 */

export type TeamUse = "browser" | "both";

export interface FirstRunChatOptions {
  system: System;
  ui: Ui;
  prompter: Prompter;
  /** Where the final screen goes, with or without color. */
  io: { out: (text: string) => void; color?: boolean };
  /** Running as root; otherwise Tailscale's install, sign-in and settings go through sudo. */
  root: boolean;
  /** The login that may run `tailscale serve` without sudo afterwards (Tailscale's operator); this user unless replaced. */
  user?: string;
  /** The model the first run just started, for the final screen's first line. */
  model?: string;
  /** This machine's name on the tailnet; its host name unless replaced. */
  hostname?: string;
  statePath?: string;
  fetch?: FetchModel;
  delay?: (ms: number) => Promise<void>;
  /** Ctrl-C: stop waiting (for HTTPS certificates, for the admin account). */
  signal?: AbortSignal;
  /** How long to wait, in ms: for HTTPS certificates (15 min) and for the admin account (30 min). */
  waits?: { certs?: number; admin?: number };
}

export type ChatSetupResult = { ok: true; url: string; hasAdmin: boolean } | { ok: false; message: string };

const CERTS_POLL_MS = 5_000;
const ADMIN_POLL_MS = 3_000;

/** The first run's team chat setup. Never throws: a failure is printed with what to do next, and returned. */
export async function firstRunChat(options: FirstRunChatOptions): Promise<ChatSetupResult> {
  const { io, ui } = options;
  const c = palette(io.color === true);
  const say = (text = "") => io.out(text ? `  ${text}\n` : "\n");
  const stop = (message: string, next: string): ChatSetupResult => {
    say();
    say(`${c.red("✗")} ${message}`);
    say(`${c.dim("Next:")} ${next}`);
    say(c.dim(`Until then, just you: ${tunnelHint()}`));
    return { ok: false, message };
  };
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pause = (ms: number) => options.signal?.aborted ? Promise.resolve() : Promise.race([delay(ms), new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
  const sudo = (command: string, args: string[]) => options.root ? { command, args } : { command: "sudo", args: [command, ...args] };
  const operator = options.root ? undefined : options.user ?? process.env.SUDO_USER ?? userInfo().username;
  try {
    ui.title("Team chat in the browser");
    let tailscale = await tailscaleState(options.system);
    if (!options.root) {
      // Installing, signing in and making this login Tailscale's operator all need root: sudo
      // asks for the password first, on the terminal, before anything else is printed.
      await options.system.run("sudo", ["-v"], { describe: "sudo -v", inherit: true });
    }
    if (tailscale.state === "missing") {
      ui.line("info", "Tailscale", "not installed · installing it (tailscale.com/install.sh)");
      await installTailscale(options.system, { sudo: !options.root });
      tailscale = await tailscaleState(options.system);
      if (tailscale.state === "missing") return stop("Tailscale didn't install.", "install it (https://tailscale.com/download/linux), then dl ui up and dl ui share");
      ui.line("done", "Tailscale", "installed");
    }
    if (tailscale.state === "logged-out") {
      say();
      say(c.bold("Sign in to Tailscale for a private HTTPS link your team can open."));
      say("Open the link below on your laptop or phone (or scan the QR code) and sign in with Google,");
      say("Microsoft or GitHub. If your org already uses Tailscale, sign in to that account.");
      say();
      const login = sudo("tailscale", ["up", "--qr", `--hostname=${options.hostname ?? machineName()}`, "--timeout=15m", ...(operator ? [`--operator=${operator}`] : [])]);
      const result = await options.system.run(login.command, login.args, { inherit: true, allowFailure: true, describe: "tailscale up (sign-in link and QR code)" });
      tailscale = await tailscaleState(options.system);
      if (result.code !== 0 || tailscale.state === "logged-out" || tailscale.state === "missing") {
        return stop("Tailscale sign-in didn't finish.", tailscaleBlocker("logged-out").next);
      }
      ui.line("done", "Tailscale", tailscale.name ? `signed in as ${tailscale.name.split(".")[0]}` : "signed in");
    } else if (operator) {
      // Already signed in: let this login run `tailscale serve` (dl ui share, refreshes) without sudo.
      const set = sudo("tailscale", ["set", `--operator=${operator}`]);
      await options.system.run(set.command, set.args, { allowFailure: true });
    }
    if (tailscale.state === "no-https") {
      say();
      say(c.red("HTTPS certificates are off for your tailnet. Turn them on (one click):"));
      say(c.red(`${HTTPS_CERTS_URL}  >  HTTPS Certificates  >  Enable`));
      say(c.dim("MagicDNS must be on too (same page). Waiting for it… Ctrl-C to stop."));
      tailscale = await waitForCerts(options, pause);
      if (tailscale.state !== "ready") return stop("HTTPS certificates are still off for your tailnet.", tailscaleBlocker("no-https").next);
      ui.line("done", "HTTPS certificates", "on");
    }
    if (tailscale.state !== "ready") return stop("Tailscale isn't ready here.", tailscaleBlocker("logged-out").next);
    const chat: ChatUiOptions = { system: options.system, ui, prompter: options.prompter, interactive: true,
      ...(options.statePath ? { statePath: options.statePath } : {}), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.delay ? { delay: options.delay } : {}) };
    const path = uiStatePath(options.statePath);
    const started = await startChat(chat, path);
    const shared = await shareOnTailnet(chat, path, started.state, tailscale.name);
    ui.finish();
    let hasAdmin = started.hasAdmin;
    say();
    if (options.model) say(`${c.green("✓")} ${shortModel(options.model)} is running and passed its tests`);
    say(`${c.green("✓")} Team chat is running, HTTPS on your private network`);
    say();
    if (!hasAdmin) {
      say(c.red("Set up the admin account here:"));
      say(c.red(shared.url));
      say(c.red("Whoever opens this link first becomes the admin. Open it now, yourself."));
    } else {
      say(`Team chat: ${shared.url}`);
      say(c.dim("Its admin account is already set up."));
    }
    say();
    say(c.dim("Then invite your team from the chat (Admin Panel > Users), or share the link"));
    say(c.dim("and approve people as they sign up. Each person needs the Tailscale app."));
    say(c.dim("Everyone sets up an authenticator app (2FA) the first time they sign in."));
    say(c.dim("See what's running any time: dl status"));
    if (!hasAdmin) {
      say();
      say(c.dim("Waiting for the admin account… Ctrl-C stops waiting; everything keeps running."));
      const polls = Math.ceil((options.waits?.admin ?? 30 * 60_000) / ADMIN_POLL_MS);
      for (let poll = 0; ; poll++) {
        if (await reopenSignups(chat, path, started.state).catch(() => false)) { hasAdmin = true; break; }
        if (options.signal?.aborted || poll >= polls) break;
        await pause(ADMIN_POLL_MS);
      }
      if (hasAdmin) say(`${c.green("✓")} Admin account created. Sign-ups are open; each one waits for your approval.`);
      else say(c.dim("Stopped waiting. Once the admin account exists, run dl ui up once so your team can sign up."));
    }
    say();
    return { ok: true, url: publicUrl(started.state), hasAdmin };
  } catch (error) {
    ui.finish();
    return stop(error instanceof Error ? error.message.split("\n")[0]! : String(error), "fix that, then dl ui up and dl ui share");
  }
}

/** Polls Tailscale until HTTPS certificates are on, Ctrl-C or the wait runs out. */
async function waitForCerts(options: FirstRunChatOptions, pause: (ms: number) => Promise<void>): Promise<TailscaleState> {
  const polls = Math.ceil((options.waits?.certs ?? 15 * 60_000) / CERTS_POLL_MS);
  for (let poll = 0; ; poll++) {
    const state = await tailscaleState(options.system);
    if (state.state === "ready" || options.signal?.aborted || poll >= polls) return state;
    await pause(CERTS_POLL_MS);
  }
}

/** "Qwen/Qwen3-Coder-30B-A3B-Instruct" → "Qwen3-Coder-30B-A3B-Instruct". */
function shortModel(repo: string): string {
  return repo.split("/").at(-1) || repo;
}
