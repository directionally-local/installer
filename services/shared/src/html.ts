/**
 * Server-rendered HTML with no framework and no HTML rewriter. Every interpolated value
 * goes through `escapeHtml`; the page shell sets the CSP the approvals page relies on.
 */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export const DEFAULT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 40rem; padding: 1.5rem; }
  h1 { font-size: 1.35rem; }
  .muted { opacity: 0.7; }
  form { margin: 1rem 0; }
  button { font: inherit; padding: 0.5rem 1rem; }
`;

/** A complete page. `body` is trusted HTML; interpolate values with `escapeHtml` first. */
export function page(input: { title: string; body: string; status?: number }): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<style>${STYLE}</style>
</head>
<body>
${input.body}
</body>
</html>
`;
  return new Response(html, {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": DEFAULT_CSP,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}
