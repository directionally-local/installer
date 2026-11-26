import { readFileSync } from "node:fs";
import { formatTokens } from "./free-tier.js";
import type { DlKey } from "./dl-key.js";

/**
 * Small touches on dl's first run (router.ts, dl-key.ts): the mascot beside the intro line in
 * terminals that draw inline images, the rocking wait while the browser sign-in is approved, the
 * welcome line, and the one-time "first tokens served" line. None of them waits on anything.
 */

type Env = Record<string, string | undefined>;

/** How this terminal draws an inline image: Kitty's graphics protocol, iTerm2's OSC 1337, or not at all. */
export type ImageProtocol = "kitty" | "iterm";

/**
 * The inline image protocol this terminal speaks, or undefined (then dl prints text only):
 *  - Kitty (TERM=xterm-kitty or KITTY_WINDOW_ID) and Ghostty (TERM_PROGRAM=ghostty): Kitty's.
 *  - iTerm2, WezTerm and VS Code's terminal (TERM_PROGRAM): iTerm2's OSC 1337.
 * Never when stdout isn't a terminal, inside tmux or screen (which would need passthrough set
 * up), or with DL_NO_IMAGES=1.
 */
export function imageProtocol(env: Env, isTTY: boolean): ImageProtocol | undefined {
  if (!isTTY) return undefined;
  if (env.DL_NO_IMAGES?.trim() && env.DL_NO_IMAGES.trim() !== "0") return undefined;
  const term = env.TERM ?? "";
  if (env.TMUX || env.STY || /^(screen|tmux)/.test(term)) return undefined;
  const program = env.TERM_PROGRAM ?? "";
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID) return "kitty";
  if (program === "ghostty" || term === "xterm-ghostty") return "kitty";
  if (program === "iTerm.app" || program === "WezTerm" || program === "vscode") return "iterm";
  return undefined;
}

/** The mascot (assets/mascot.png in the package, 160 px tall), or undefined when it can't be read. */
export function mascotPng(): Buffer | undefined {
  try {
    // src/laptop/ and dist/laptop/ are both two levels below the package root.
    return readFileSync(new URL("../../assets/mascot.png", import.meta.url));
  } catch {
    return undefined;
  }
}

/** The image's size in terminal cells: about square on screen, beside one line of text. */
export const MASCOT_ROWS = 3;
export const MASCOT_COLS = 7;

/** The escape sequence that draws `png` at the cursor, `cols` x `rows` cells, without moving the cursor (where supported). */
export function inlineImage(protocol: ImageProtocol, png: Buffer, cols: number, rows: number): string {
  const data = png.toString("base64");
  if (protocol === "iterm") {
    return `\x1b]1337;File=inline=1;size=${png.length};width=${cols};height=${rows};preserveAspectRatio=1;doNotMoveCursor=1:${data}\x07`;
  }
  // Kitty: PNG (f=100), placed now (a=T) in cols x rows cells, cursor left where it is (C=1), no
  // replies (q=2); base64 in chunks of at most 4096 bytes.
  const chunks = data.match(/.{1,4096}/g) ?? [""];
  return chunks.map((chunk, i) => {
    const more = i < chunks.length - 1 ? 1 : 0;
    const head = i === 0 ? `a=T,f=100,c=${cols},r=${rows},C=1,q=2,m=${more}` : `m=${more}`;
    return `\x1b_G${head};${chunk}\x1b\\`;
  }).join("");
}

/**
 * The intro line, with the mascot beside it when there's an image to draw: room is made first
 * (so drawing never scrolls), the image goes in at the left, the text on its middle row, and the
 * cursor ends on the line below the image whatever the terminal does with it after drawing.
 * Without an image, just the line.
 */
export function introBlock(line: string, image?: { protocol: ImageProtocol; png: Buffer }): string {
  if (!image) return `\n  ${line}\n`;
  const rows = MASCOT_ROWS;
  const cols = MASCOT_COLS;
  const save = "\x1b7";
  const restore = "\x1b8";
  return [
    "\n",
    "\n".repeat(rows),
    `\x1b[${rows}A\r`,
    save,
    "  ",
    inlineImage(image.protocol, image.png, cols, rows),
    restore,
    `\x1b[${Math.floor((rows - 1) / 2)}B\x1b[${2 + cols + 2}C`,
    line,
    restore,
    `\x1b[${rows}B\r`,
  ].join("");
}

/** The wait for the browser: a chair rocking forward and back. */
export const ROCK_FRAMES = ["◜", "◠", "◝", "◞", "◡", "◟"] as const;
const ROCK_ORDER = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];

/** The frame for tick `n`: through the six and back again. */
export function rockFrame(n: number): string {
  return ROCK_FRAMES[ROCK_ORDER[((n % ROCK_ORDER.length) + ROCK_ORDER.length) % ROCK_ORDER.length]!]!;
}

export const WAITING_TEXT = "Waiting for you in the browser";

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** "@sina" from a GitHub login, else the email's local part ("@sina.meraji"), else undefined. */
export function welcomeHandle(login: unknown, email: unknown): string | undefined {
  if (typeof login === "string" && GITHUB_LOGIN.test(login)) return `@${login}`;
  if (typeof email === "string") {
    const local = email.split("@")[0] ?? "";
    if (/^[A-Za-z0-9._+-]{1,64}$/.test(local) && email.includes("@")) return `@${local}`;
  }
  return undefined;
}

/** "Welcome in, @sina." (or "Welcome in." when the service didn't say who). */
export function welcomeText(handle: string | undefined): string {
  return handle ? `Welcome in, ${handle}.` : "Welcome in.";
}

/** "You've got a collection." under the scan when it found this many agents or more. */
export const COLLECTION_AT = 5;
export const COLLECTION_TEXT = "You've got a collection.";
/** The scan's pace: one found agent at a time, at most this far apart, and at most SCAN_TOTAL_MS in all. */
export const SCAN_STEP_MS = 80;
export const SCAN_TOTAL_MS = 400;

/** The pause between two lines of the scan for `count` found agents (0 for one or none). */
export function scanStep(count: number): number {
  return count <= 1 ? 0 : Math.min(SCAN_STEP_MS, Math.floor(SCAN_TOTAL_MS / (count - 1)));
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const ME_TIMEOUT_MS = 2_000;

/**
 * What's left this week in real tokens at the plan mix, from GET /v1/me?week=1 on the dl key:
 * `week` (a plan's DeepSeek week, or the Free plan's), else the DeepSeek pool when it has a cap.
 * `used` says whether any tokens were served yet. Undefined when it can't be told.
 */
export function weekFromMe(body: unknown): { left: number; used: number } | undefined {
  const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const me = rec(body);
  const week = rec(me.week);
  const left = num(week.leftAtMix);
  const used = num(week.usedAtMix);
  if (left !== undefined && used !== undefined) return { left, used };
  const pool = rec(rec(me.pools).deepseek);
  const total = num(pool.realTokensPerWeek);
  const usedReal = num(pool.realUsedThisWeek);
  if (total !== undefined && usedReal !== undefined) return { left: Math.max(0, total - usedReal), used: usedReal };
  return undefined;
}

/**
 * Tokens served to this account this week by /v1/me's other counts (every pool's `usedThisWeek`,
 * the allowance's, both budgets' `tokensThisWeek`), for accounts without a `week` (old free
 * accounts: `week` null). Undefined when there's no count at all.
 */
export function servedFromMe(body: unknown): number | undefined {
  const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
  const counts: number[] = [];
  const add = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) counts.push(value);
  };
  const me = rec(body);
  for (const pool of Object.values(rec(me.pools))) add(rec(pool).usedThisWeek);
  add(rec(me.allowance).usedThisWeek);
  for (const budget of Object.values(rec(me.budgets))) add(rec(budget).tokensThisWeek);
  return counts.length ? Math.max(...counts) : undefined;
}

/**
 * "✓ First tokens served. ~9.9M left this week (95.5% caching applied)." without the colour;
 * "First tokens served." for an account without a weekly figure (`left` undefined).
 */
export function firstTokensText(left?: number): string {
  if (left === undefined) return "First tokens served.";
  return `First tokens served. ~${formatTokens(left)} left this week (95.5% caching applied).`;
}

/**
 * The line after the first agent run through dl, or undefined: nothing served yet (try again next
 * time), or the service didn't answer in time or as expected (silently). `done` is true when it
 * shouldn't be tried again: the line was made, or the service said no for good (4xx).
 */
export async function firstTokens(key: Pick<DlKey, "key" | "baseUrl">, deps: { fetch?: Fetch; timeoutMs?: number } = {}): Promise<{ text?: string; done: boolean }> {
  const call = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  try {
    const response = await call(`${key.baseUrl.replace(/\/+$/, "")}/v1/me?week=1`, {
      headers: { accept: "application/json", authorization: `Bearer ${key.key}` },
      redirect: "error",
      signal: AbortSignal.timeout(deps.timeoutMs ?? ME_TIMEOUT_MS),
    });
    if (!response.ok) return { done: response.status >= 400 && response.status < 500 && response.status !== 429 };
    const body = await response.json();
    const week = weekFromMe(body);
    if (week) return week.used > 0 ? { text: firstTokensText(week.left), done: true } : { done: false };
    // No weekly figure for this account (old free accounts): the line without "left this week",
    // once its other counts say tokens were served; until then, ask again next time.
    return (servedFromMe(body) ?? 0) > 0 ? { text: firstTokensText(), done: true } : { done: false };
  } catch {
    return { done: false };
  }
}
