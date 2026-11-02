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
contents. Your GitHub account is used only to know who you are.</p>`;

function shell(title: string, body: string, status = 200): Response {
  return page({ title: `${title} · ${PRODUCT_NAME}`, body: `<h1>${escapeHtml(PRODUCT_NAME)}</h1>\n${body}`, status });
}

export function enterCodePage(error?: string): Response {
  return shell(
    "Sign in",
    `${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
<p>Enter the code your terminal shows.</p>
<form method="get" action="/device">
  <input name="user_code" autocomplete="off" autocapitalize="characters" placeholder="ABCD-1234" required>
  <button type="submit">Continue</button>
</form>
${DISCLOSURE}`,
    error ? 400 : 200,
  );
}

export function confirmPage(userCode: string): Response {
  const code = escapeHtml(userCode);
  return shell(
    "Confirm sign-in",
    `<p>Check that your terminal shows <strong><code>${code}</code></strong>, then sign in with GitHub.</p>
<p><a href="/device/authorize?user_code=${encodeURIComponent(userCode)}"><button type="button">Continue with GitHub</button></a></p>
<form method="post" action="/device/deny">
  <input type="hidden" name="user_code" value="${code}">
  <button type="submit">This isn't my code, cancel</button>
</form>
${DISCLOSURE}`,
  );
}

export function invitePage(ticket: string, login: string, error?: string): Response {
  return shell(
    "Invite code",
    `${error ? `<p role="alert"><strong>${escapeHtml(error)}</strong></p>` : ""}
<p>Signed in as <strong>${escapeHtml(login)}</strong>. The free tier is invite-only for now: enter your invite code.</p>
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
