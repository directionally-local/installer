import { escapeHtml, page } from "../../shared/src/html.js";

/**
 * The browser half of sign-in: server-rendered HTML, no framework, no scripts. Every value
 * goes through `escapeHtml`.
 */

export const PRODUCT_NAME = "dl";

/**
 * The consent notice for free tokens, on every page before and during sign-in. Short, but every
 * kind of data collected is named; the privacy policy has the detail.
 */
const DISCLOSURE = `
<details class="fine disclosure"><summary>Free tokens come with usage records, never your prompts or code. <span>What exactly?</span></summary>
<p>For each request: tokens in, cached and out, cost, model and time. Session events from dl: start and end, turns,
tool-call counts, pull requests opened, error codes, version, OS and a hash of the repository's remote URL.
We never store your prompts, completions, code, file paths or file contents. When you first join, we check that your GitHub
account has a public repository or a contribution in the last year, and don't keep the counts.</p></details>`;

/** The privacy policy and terms live on the main site, directionallylocal.com (dl.new has copies). */
export const PRIVACY_URL = "https://directionallylocal.com/privacy/";
export const TERMS_URL = "https://directionallylocal.com/terms/";

/** dl.new serves the brand's fonts and logo; these pages load them from there and nothing else. */
const BRAND_ORIGIN = "https://dl.new";

/** The shared default CSP, plus fonts and images from dl.new. Still no scripts. */
export const PAGES_CSP =
  `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: ${BRAND_ORIGIN}; font-src ${BRAND_ORIGIN}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

const GITHUB_MARK = `<svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

/** The dl.new brand (light and dark tokens, faint grid, Bricolage/Geist), cut down to what these pages use. */
const STYLE = `
@font-face { font-family: "Bricolage Grotesque"; src: url("${BRAND_ORIGIN}/fonts/bricolage.woff2") format("woff2"); font-weight: 500 800; font-display: swap; }
@font-face { font-family: "Geist"; src: url("${BRAND_ORIGIN}/fonts/geist.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Geist Mono"; src: url("${BRAND_ORIGIN}/fonts/geist-mono.woff2") format("woff2"); font-weight: 100 900; font-display: swap; }
:root {
  --bg: #F6F7F9; --surface: #FFFFFF; --ink: #0E1116; --on-ink: #FFFFFF; --muted: #5B6270; --line: #E1E4EA;
  --grid: rgba(14, 17, 22, .045); --accent: #E10600;
  --display: "Bricolage Grotesque", ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
  --body: "Geist", ui-sans-serif, system-ui, "Helvetica Neue", Arial, sans-serif;
  --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0B0E12; --surface: #161A21; --ink: #E6E9EE; --on-ink: #0B0E12; --muted: #8A919E; --line: #262B34; --grid: rgba(230, 233, 238, .045); --accent: #FF3B30; color-scheme: dark; }
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  background-color: var(--bg);
  background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 40px 40px; background-position: center;
  color: var(--ink); font: 16px/1.55 var(--body); -webkit-font-smoothing: antialiased;
  min-height: 100vh; display: grid; grid-template-rows: auto 1fr auto;
  padding: 0 max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px));
  overflow-wrap: anywhere;
}
a { color: inherit; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
header { padding-block: 18px; }
.mark { display: inline-flex; align-items: center; gap: 10px; font: 700 17px var(--display); letter-spacing: -.01em; text-decoration: none; }
.mark img { width: 32px; height: 32px; border-radius: 8px; }
main { width: 100%; max-width: 28rem; margin: 0 auto; padding-block: 24px 48px; align-self: center; text-align: center; display: grid; gap: 20px; justify-items: center; }
main > * { margin: 0; max-width: 100%; }
h1 { font: 700 clamp(30px, 8vw, 44px)/1.05 var(--display); letter-spacing: -.03em; text-wrap: balance; }
.lede { color: var(--muted); font-size: 17px; text-wrap: pretty; }
.lede strong { color: var(--ink); font-weight: 600; }
.chip { display: inline-block; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px 22px; font: 500 clamp(28px, 9vw, 40px)/1.1 var(--mono); letter-spacing: .02em; white-space: nowrap; box-shadow: 0 18px 40px -26px rgba(14, 17, 22, .35); }
form { display: grid; gap: 12px; width: 100%; margin: 0; }
.actions { display: grid; gap: 6px; width: 100%; }
input[type="text"], input:not([type]) { font: 500 20px var(--mono); letter-spacing: .04em; text-align: center; text-transform: uppercase; width: 100%; height: 52px; padding: 0 14px; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; }
input::placeholder { color: var(--muted); opacity: .6; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 10px; width: 100%; min-height: 52px; padding: 0 20px; border-radius: 12px; border: 1px solid var(--ink); background: var(--ink); color: var(--on-ink); font: 600 16px var(--body); text-decoration: none; cursor: pointer; }
.btn:hover { opacity: .9; }
.link { background: none; border: 0; padding: 10px; color: var(--muted); font: 15px var(--body); text-decoration: underline; text-underline-offset: 3px; cursor: pointer; justify-self: center; }
.link:hover { color: var(--ink); }
[role="alert"] { width: 100%; background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 10px; padding: 10px 14px; text-align: left; font-size: 15px; }
[role="alert"] strong { font-weight: 600; }
code { font-family: var(--mono); font-size: .92em; }
.invite { width: 100%; background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 18px; display: grid; gap: 10px; text-align: left; }
.invite p { margin: 0; }
.invite .link-text { display: block; font: 15px var(--mono); padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); word-break: break-all; }
.fine, .invite .fine { color: var(--muted); font-size: 13px; line-height: 1.5; text-wrap: pretty; }
.disclosure { max-width: 46ch; }
.disclosure summary { cursor: pointer; list-style: none; }
.disclosure summary::-webkit-details-marker { display: none; }
.disclosure summary span { text-decoration: underline; text-underline-offset: .2em; white-space: nowrap; }
.disclosure summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 4px; }
.disclosure[open] summary span { display: none; }
.disclosure p { margin: .6em 0 0; }
footer { padding-block: 22px 28px; text-align: center; font: 12.5px var(--mono); color: var(--muted); }
footer a { color: var(--muted); }
footer a:hover { color: var(--ink); }
`;

const HEADER = `<header><a class="mark" href="${BRAND_ORIGIN}"><img src="${BRAND_ORIGIN}/logo-64.webp" alt="" width="32" height="32">dl</a></header>`;
const FOOTER = `<footer><a href="${PRIVACY_URL}">Privacy</a> · <a href="${TERMS_URL}">Terms</a></footer>`;

function alertHtml(error?: string): string {
  return error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>\n` : "";
}

/** `title` names the tab; `body` is the page's main column (a big `h1`, one line, at most one action). */
function shell(title: string, body: string, status = 200): Response {
  return page({ title: `${title} · ${PRODUCT_NAME}`, body: `${HEADER}\n<main>\n${body}\n</main>\n${FOOTER}`, status, style: STYLE, csp: PAGES_CSP });
}

/** `ref` is a referral code from `/device?ref=`, carried through to sign-in. */
export function enterCodePage(error?: string, ref?: string): Response {
  return shell(
    "Sign in",
    `<h1>Sign in to dl</h1>
${alertHtml(error)}<p class="lede">Enter the code your terminal shows.</p>
<form method="get" action="/device">
  <input name="user_code" aria-label="Code from your terminal" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-1234" required>
${ref ? `  <input type="hidden" name="ref" value="${escapeHtml(ref)}">
` : ""}  <button class="btn" type="submit">Continue</button>
</form>
${DISCLOSURE}`,
    error ? 400 : 200,
  );
}

export function confirmPage(userCode: string, ref?: string): Response {
  const code = escapeHtml(userCode);
  const authorize = `/device/authorize?user_code=${encodeURIComponent(userCode)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
  return shell(
    "Confirm sign-in",
    `<h1>Sign in to dl</h1>
<p class="lede">Check that your terminal shows</p>
<p class="chip"><code>${code}</code></p>
<div class="actions">
  <a class="btn" href="${escapeHtml(authorize)}">${GITHUB_MARK}Continue with GitHub</a>
  <form method="post" action="/device/deny">
    <input type="hidden" name="user_code" value="${code}">
    <button class="link" type="submit">This isn't my code</button>
  </form>
</div>
${DISCLOSURE}`,
  );
}

export const INVITE_ONLY_INTRO = "The free tier is invite-only for now: enter your invite code.";

export function tooNewIntro(minAccountAgeDays: number): string {
  return `This GitHub account is less than ${minAccountAgeDays} days old, so it needs an invite code for the free tier: enter your invite code.`;
}

/** The invite step's intro for an account with no public repository or recent contribution. */
export const NO_GITHUB_ACTIVITY_INTRO = "Your GitHub account has no public repositories or contributions yet, so it needs an invite code for the free tier: enter your invite code.";

/** The invite step. `intro` says why a code is needed (invite-only, or the account is too new). */
export function invitePage(ticket: string, login: string, error?: string, intro: string = INVITE_ONLY_INTRO): Response {
  return shell(
    "Invite code",
    `<h1>Enter your invite code</h1>
${alertHtml(error)}<p class="lede">Signed in as <strong>${escapeHtml(login)}</strong>. ${escapeHtml(intro)}</p>
<div class="actions">
  <form method="post" action="/device/invite">
    <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
    <input name="invite_code" aria-label="Invite code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="DL-XXXX-XXXX" required>
    <button class="btn" type="submit">Join</button>
  </form>
  <form method="post" action="/device/no-invite">
    <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
    <button class="link" type="submit">I don't have a code</button>
  </form>
</div>
${DISCLOSURE}`,
    error ? 400 : 200,
  );
}

export function donePage(heading: string, message: string, status = 200): Response {
  return shell(heading, `<h1>${escapeHtml(heading)}</h1>\n<p class="lede">${escapeHtml(message)}</p>`, status);
}

/** "10M", "50M", "2.5M": token counts in the page's copy. */
export function shortTokens(value: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (value >= 1e6) return `${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${trim(value / 1e3)}k`;
  return String(Math.round(value));
}

/**
 * The page after a sign-in succeeds: `message`, then the person's invite link and what it
 * earns. The CSP allows no scripts, so there is no Copy button: the link is text that one
 * click selects (`user-select: all`).
 */
export function signedInDonePage(message: string, invite?: { link: string; bonusTokens: number; capTokens: number }): Response {
  const heading = "You're signed in";
  const inviteHtml = invite
    ? `
<section class="invite">
<p><strong>Invite friends and you both get +${escapeHtml(shortTokens(invite.bonusTokens))} tokens a week.</strong></p>
<p>Your invite link: <code class="link-text" style="user-select: all; -webkit-user-select: all; word-break: break-all">${escapeHtml(invite.link)}</code></p>
<p class="fine">The bonus starts when a friend you invite uses dl on 3 days of a week, and adds up to +${escapeHtml(shortTokens(invite.capTokens))} a week. <code>/invite</code> in dl shows your link any time.</p>
</section>`
    : "";
  return shell(heading, `<h1>${escapeHtml(heading)}</h1>\n<p class="lede">${escapeHtml(message)}</p>${inviteHtml}`);
}
