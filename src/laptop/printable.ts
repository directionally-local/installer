/**
 * Text from elsewhere (the free tier service, a connected server, an agent's output) made
 * safe to print: a terminal acts on control characters, so an escape sequence in an error
 * message could recolour, retitle or rewrite the user's terminal.
 */

// C0 controls except tab and line feed, DEL, C1 controls, and the bidi overrides and
// isolates that can make printed text read differently from what it is.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** `text` with control characters removed; tabs and line breaks kept. */
export function printable(text: string): string {
  return text.replace(CONTROL, "");
}

/** One printable line: control characters removed, whitespace collapsed, cut to `max` with "…". */
export function oneLine(text: string, max = Infinity): string {
  const flat = text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** True when `text` has any control character (line breaks and tabs included). */
export function hasControl(text: string): boolean {
  return ANY_CONTROL.test(text);
}
