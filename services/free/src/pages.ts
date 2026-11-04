import { escapeHtml, page } from "../../shared/src/html.js";

/**
 * The browser half of sign-in: server-rendered HTML, no framework, no scripts. Every value
 * goes through `escapeHtml`.
 */

export const PRODUCT_NAME = "Directionally Local, free";

const DISCLOSURE = `
<p class="muted"><strong>What we collect, as the condition for free tokens:</strong> for every request, how many
tokens went in, came from cache and came out, the cost, the model and the time; and session events from Autopilot
(when a session starts and ends, turns, tool-call counts, pull requests opened, error codes, version and OS, and a
hash of the repository's remote URL). We never store your prompts, completions, code, file paths or file
contents. Your GitHub account is used to know who you are and, when you first join, to check that it has a public
repository or a contribution in the last year (we read the two counts and don't keep them).</p>`;

/** The privacy policy and terms live on the main site, directionallylocal.com (dl.new has copies). */
export const PRIVACY_URL = "https://directionallylocal.com/privacy/";
export const TERMS_URL = "https://directionallylocal.com/terms/";

const LEGAL_LINKS = `<p class="muted"><a href="${PRIVACY_URL}">Privacy</a> · <a href="${TERMS_URL}">Terms</a></p>`;

function shell(title: string, body: string, status = 200): Response {
  return page({ title: `${title} · ${PRODUCT_NAME}`, body: `<h1>${escapeHtml(PRODUCT_NAME)}</h1>\n${body}\n${LEGAL_LINKS}`, status });
}

/** `ref` is a referral code from `/device?ref=`, carried through to sign-in. */
export function enterCodePage(error?: string, ref?: string): Response {
  return shell(
    "Sign in",
    `${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
<p>Enter the code your terminal shows.</p>
<form method="get" action="/device">
  <input name="user_code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-1234" required>
${ref ? `  <input type="hidden" name="ref" value="${escapeHtml(ref)}">
` : ""}  <button type="submit">Continue</button>
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
    `<p>Check that your terminal shows <strong><code>${code}</code></strong>, then sign in with GitHub.</p>
<p><a href="${escapeHtml(authorize)}"><button type="button">Continue with GitHub</button></a></p>
<form method="post" action="/device/deny">
  <input type="hidden" name="user_code" value="${code}">
  <button type="submit">This isn't my code, cancel</button>
</form>
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
    `${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
<p>Signed in as <strong>${escapeHtml(login)}</strong>. ${escapeHtml(intro)}</p>
<form method="post" action="/device/invite">
  <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
  <input name="invite_code" autocomplete="off" autocapitalize="characters" placeholder="DL-XXXX-XXXX" required>
  <button type="submit">Join</button>
</form>
<form method="post" action="/device/no-invite">
  <input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
  <button type="submit">I don't have a code</button>
</form>
${DISCLOSURE}`,
    error ? 400 : 200,
  );
}

export function donePage(heading: string, message: string, status = 200): Response {
  return shell(heading, `<h2>${escapeHtml(heading)}</h2>\n<p>${escapeHtml(message)}</p>`, status);
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
<p><strong>Invite friends and you both get +${escapeHtml(shortTokens(invite.bonusTokens))} tokens a week.</strong></p>
<p>Your invite link: <code style="user-select: all; -webkit-user-select: all; word-break: break-all">${escapeHtml(invite.link)}</code></p>
<p class="muted">The bonus starts when a friend you invite uses dl on 3 days of a week, and adds up to +${escapeHtml(shortTokens(invite.capTokens))} a week. <code>/invite</code> in Autopilot shows your link any time.</p>`
    : "";
  return shell(heading, `<h2>${escapeHtml(heading)}</h2>\n<p>${escapeHtml(message)}</p>${inviteHtml}`);
}
