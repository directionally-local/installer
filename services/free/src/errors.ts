/**
 * The contract's error shape, `{"error": {"code", "message", ...extra}}`, which OpenAI
 * clients already understand. (The name service uses problem+json; this API is
 * OpenAI-compatible instead.)
 */

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message, ...extra } }, status, headers);
}
