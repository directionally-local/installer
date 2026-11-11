/**
 * Free-tier sign-up checks on the contact email: one free account per inbox, a blocklist of
 * inboxes and domains, and a daily cap on new accounts from one company or custom domain.
 * Farms reuse one inbox through `name+tag@` and Gmail's ignored dots, or a catch-all domain.
 */

/** Big public mail providers: anyone can have an address there, so the per-domain cap skips them. */
export const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de", "gmx.net",
  "web.de", "mail.com", "yandex.ru", "yandex.com", "mail.ru", "qq.com", "163.com", "126.com", "foxmail.com", "naver.com",
  "hey.com", "fastmail.com", "zoho.com", "tutanota.com", "duck.com", "hotmail.co.uk", "yahoo.co.jp", "outlook.jp",
]);

/** The inbox an address delivers to: lowercase, `+tag` dropped, and Gmail's dots dropped. */
export function normalizeEmail(address: string): string {
  const value = address.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0) return value;
  let local = value.slice(0, at);
  let domain = value.slice(at + 1);
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return `${local}@${domain}`;
}

/** A plausible address: one @, a dot in the domain, no spaces, at most 254 characters. */
export function plausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function emailDomain(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf("@") + 1);
}

/**
 * Whether a normalized address is blocked. Entries are an address (matched as the same inbox)
 * or `@domain` (that domain and its subdomains).
 */
export function emailBlocked(normalized: string, blocklist: readonly string[]): boolean {
  const domain = emailDomain(normalized);
  return blocklist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.startsWith("@")) return domain === e.slice(1) || domain.endsWith(`.${e.slice(1)}`);
    return normalizeEmail(e) === normalized;
  });
}

/** A blocklist entry: `@domain.tld` or `local@domain.tld`, at most 254 characters. */
export function isEmailBlocklistEntry(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(value);
}
