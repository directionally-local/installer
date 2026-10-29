/**
 * RFC 9457 problem details. Every error the services return is one of these, so a client
 * can branch on `type` instead of parsing prose.
 */

export const PROBLEM_BASE = "https://directionallylocal.run/problems";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

/** The body, without a Response: useful for tests and for nesting in other payloads. */
export function problemBody(
  status: number,
  slug: string,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): ProblemDetails {
  return {
    type: `${PROBLEM_BASE}/${slug}`,
    title,
    status,
    ...(detail ? { detail } : {}),
    ...extra,
  };
}

/** A problem+json response, with any extra headers (Retry-After, Allow, …). */
export function problem(
  status: number,
  slug: string,
  title: string,
  detail?: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(problemBody(status, slug, title, detail)), {
    status,
    headers: { "content-type": "application/problem+json; charset=utf-8", ...headers },
  });
}

/** A JSON response. `no-store` because every payload here is per-request state. */
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}
