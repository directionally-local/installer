/** Human-typed codes: device user codes (`BCDF-1234`) and invite codes (`DL-XXXX-XXXX`). */

// Consonants only, so a code never spells a word, and no vowels or look-alikes.
const LETTERS = "BCDFGHJKLMNPQRSTVWXZ";
const DIGITS = "0123456789";
const INVITE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

function pick(alphabet: string, count: number): string {
  // Rejection sampling keeps every symbol equally likely.
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < count) {
    for (const byte of crypto.getRandomValues(new Uint8Array(count * 2))) {
      if (byte < limit && out.length < count) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export function newUserCode(): string {
  return `${pick(LETTERS, 4)}-${pick(DIGITS, 4)}`;
}

/** `bcdf1234`, `BCDF 1234` and `bcdf-1234` all become `BCDF-1234`; anything else is undefined. */
export function normalizeUserCode(input: string): string | undefined {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-Z]{4}[0-9]{4}$/.test(compact)) return undefined;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function newInviteCode(): string {
  return `DL-${pick(INVITE_ALPHABET, 4)}-${pick(INVITE_ALPHABET, 4)}`;
}

export function normalizeInviteCode(input: string): string {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = compact.startsWith("DL") ? compact.slice(2) : compact;
  return body.length === 8 ? `DL-${body.slice(0, 4)}-${body.slice(4)}` : input.trim().toUpperCase();
}
