/**
 * Access requests from inside dl: the /request command posts {building, link?} to
 * POST /v1/access-request (app.ts). What a person writes is user content: stored as plain text,
 * shown only on the admin Tools tab (escaped), never logged, never in an alert or a metric.
 */

/** Submissions per person in any 24 hours. */
export const ACCESS_REQUESTS_PER_DAY = 3;
export const ACCESS_REQUEST_MAX_BYTES = 8_192;
const BUILDING_MIN = 10;
const BUILDING_MAX = 600;
const LINK_MAX = 300;
export const ACCESS_REQUEST_USAGE = `Send {building, link?}: what you're building, ${BUILDING_MIN} to ${BUILDING_MAX} characters, and optionally an http(s) link of at most ${LINK_MAX} characters.`;

/** The body of POST /v1/access-request, checked. */
export function parseAccessRequest(body: unknown): { ok: true; building: string; link: string | null } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, message: ACCESS_REQUEST_USAGE };
  const raw = body as Record<string, unknown>;
  if (typeof raw.building !== "string") return { ok: false, message: `building is required. ${ACCESS_REQUEST_USAGE}` };
  const building = raw.building.trim();
  if (building.length < BUILDING_MIN) return { ok: false, message: `Tell us a bit more about what you're building: at least ${BUILDING_MIN} characters.` };
  if (building.length > BUILDING_MAX) return { ok: false, message: `Keep what you're building to ${BUILDING_MAX} characters or fewer.` };
  if (raw.link === undefined || raw.link === null || (typeof raw.link === "string" && raw.link.trim() === "")) return { ok: true, building, link: null };
  if (typeof raw.link !== "string") return { ok: false, message: `link must be a string. ${ACCESS_REQUEST_USAGE}` };
  const link = raw.link.trim();
  if (link.length > LINK_MAX) return { ok: false, message: `The link can be at most ${LINK_MAX} characters.` };
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    return { ok: false, message: "The link must be a full http:// or https:// URL." };
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.hostname === "") return { ok: false, message: "The link must be a full http:// or https:// URL." };
  return { ok: true, building, link };
}
