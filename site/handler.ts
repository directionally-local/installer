/**
 * directionallylocal.run: the install script at the bare domain, for
 * `curl -fsSL https://directionallylocal.run | sh`. Browsers go to the marketing site.
 * The zone's subdomains are users' instant addresses (and the domain is on the Public
 * Suffix List), so this serves nothing else and never sets a cookie.
 */

export const MARKETING_SITE = "https://directionallylocal.com/";

export function respond(request: Request, script: string): Response {
  const url = new URL(request.url);
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return new Response(null, { status: 308, headers: { Location: url.toString(), ...SECURITY_HEADERS } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD", ...textHeaders() } });
  }
  if (url.pathname !== "/" && url.pathname !== "/install.sh") {
    return new Response("Not found\n", { status: 404, headers: textHeaders() });
  }
  // curl sends `Accept: */*`; a browser asks for HTML first.
  if ((request.headers.get("Accept") ?? "").includes("text/html")) {
    return new Response(null, { status: 302, headers: { Location: MARKETING_SITE, ...SECURITY_HEADERS } });
  }
  return new Response(request.method === "HEAD" ? null : script, {
    status: 200,
    headers: { ...textHeaders(), "Cache-Control": "public, max-age=300" },
  });
}

const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function textHeaders(): Record<string, string> {
  return { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS };
}
