/**
 * Country rules (`countryRules`, COUNTRY_RULES), from the request's country as Cloudflare gives it
 * (`request.cf.country`, else the `CF-IPCountry` header: trusted like `CF-Connecting-IP`, so only
 * behind Cloudflare). The country is read per request and never stored or logged; only the
 * refusal counts (refusals.ts) remember that a rule was met.
 *
 *   - **Embargoed countries** (`embargoedCountries`, default Cuba, Iran, North Korea, Syria): no
 *     free-tier access at all, sign-in included (403 `country_not_supported`). The Crimea, Donetsk
 *     and Luhansk regions are embargoed too, but Cloudflare gives a country only (UA, which
 *     OpenAI lists "with certain exceptions"), so a region can't be told apart here.
 *   - **GPT-6** (OpenAI's models) only from a country in `gpt6Countries`, by default OpenAI's
 *     supported countries and territories (SUPPORTED_COUNTRIES_AS_OF). Elsewhere a GPT-6 request
 *     gets 402 `provider_limit`, reason "country", pointing at DeepSeek, and GPT-6 isn't listed.
 *
 * Unknown countries: Tor ("T1") and Cloudflare's "no country" ("XX") don't get GPT-6: neither
 * can show the request comes from a supported country. A request with no country at all (no
 * Cloudflare in front: local tests, a self-hosted run) isn't held to either rule, as nothing is
 * known. "off" turns both rules off. Admins are held to them like everyone else.
 */

export type CountryRulesMode = "enforce" | "off";
export const COUNTRY_RULES_MODES: readonly CountryRulesMode[] = ["enforce", "off"];

/** When OPENAI_SUPPORTED_COUNTRIES was read from https://developers.openai.com/api/docs/supported-countries. */
export const SUPPORTED_COUNTRIES_AS_OF = "2026-11-23";

/**
 * OpenAI's supported countries and territories (ISO 3166-1 alpha-2), as its page listed them on
 * SUPPORTED_COUNTRIES_AS_OF: 208 entries. Not on it, among others: China, Hong Kong, Macao,
 * Russia, Belarus, Venezuela, Cuba, Iran, North Korea, Syria, Kosovo, and US territories that
 * Cloudflare reports by their own code (PR, GU, VI, AS, MP). Ukraine is listed "with certain
 * exceptions" (the occupied regions).
 */
export const OPENAI_SUPPORTED_COUNTRIES: readonly string[] = [
  "AD", "AE", "AF", "AG", "AL", "AM", "AO", "AR", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD", "BE", "BF", "BG", "BH",
  "BI", "BJ", "BL", "BM", "BN", "BO", "BR", "BS", "BT", "BW", "BZ", "CA", "CD", "CF", "CG", "CH", "CI", "CL", "CM", "CO",
  "CR", "CV", "CY", "CZ", "DE", "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "ER", "ES", "ET", "FI", "FJ", "FM", "FO",
  "FR", "GA", "GB", "GD", "GE", "GF", "GH", "GL", "GM", "GN", "GP", "GQ", "GR", "GT", "GW", "GY", "HN", "HR", "HT", "HU",
  "ID", "IE", "IL", "IN", "IQ", "IS", "IT", "JM", "JO", "JP", "KE", "KG", "KH", "KI", "KM", "KN", "KR", "KW", "KY", "KZ",
  "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT", "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML",
  "MM", "MN", "MQ", "MR", "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NG", "NI", "NL", "NO", "NP", "NR",
  "NZ", "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS", "RW", "SA",
  "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST", "SV", "SZ", "TD", "TF",
  "TG", "TH", "TJ", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW", "TZ", "UA", "UG", "US", "UY", "UZ", "VA", "VC", "VN",
  "VU", "WF", "WS", "YE", "YT", "ZA", "ZM", "ZW",
];

/** US-embargoed countries (OpenAI Services Agreement §16.11): Cuba, Iran, North Korea, Syria. */
export const EMBARGOED_COUNTRIES: readonly string[] = ["CU", "IR", "KP", "SY"];

/** Cloudflare's codes for Tor and for an address it couldn't place. */
export const TOR_COUNTRY = "T1";
export const UNKNOWN_COUNTRY = "XX";

export const GPT6_COUNTRY_REASON = "country";
export const GPT6_COUNTRY_MESSAGE = "GPT-6 isn't available in your country; DeepSeek V4.1 Flash is.";
export const EMBARGO_MESSAGE = "dl's free tier isn't available in your country or region.";

export interface CountryRules {
  countryRules: CountryRulesMode;
  gpt6Countries: readonly string[];
  embargoedCountries: readonly string[];
}

/** A country code as the rules hold it: two letters or a letter and a digit (T1), upper case. */
export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]$/.test(value.trim());
}

/** A list of country codes (up to 300), or undefined when it isn't one. Upper-cased, de-duplicated. */
export function countryList(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 300 || !value.every(isCountryCode)) return undefined;
  return [...new Set(value.map((code: string) => code.trim().toUpperCase()))];
}

/** The request's country: Cloudflare's `request.cf.country`, else `CF-IPCountry`; undefined when neither is there. */
export function requestCountry(request: Request): string | undefined {
  const cf = (request as Request & { cf?: { country?: unknown } }).cf;
  const raw = typeof cf?.country === "string" ? cf.country : request.headers.get("cf-ipcountry");
  return isCountryCode(raw) ? raw.trim().toUpperCase() : undefined;
}

/** Whether all free-tier access is refused for `country`. */
export function isEmbargoed(rules: CountryRules, country: string | undefined): boolean {
  return rules.countryRules === "enforce" && country !== undefined && rules.embargoedCountries.includes(country);
}

/** Whether GPT-6 may be served to a request from `country` (see the top of this file). */
export function gpt6CountryAllowed(rules: CountryRules, country: string | undefined): boolean {
  if (rules.countryRules !== "enforce" || country === undefined) return true;
  if (country === TOR_COUNTRY || country === UNKNOWN_COUNTRY) return false;
  return rules.gpt6Countries.includes(country) && !rules.embargoedCountries.includes(country);
}
