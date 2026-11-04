/**
 * directionallylocal.run: the install script at the bare domain, for
 * `curl -fsSL https://directionallylocal.run | sh`. Browsers go to the marketing site.
 * The zone's subdomains are users' instant addresses (and the domain is on the Public
 * Suffix List), so this serves nothing else and never sets a cookie.
 *
 * Each script served is counted, anonymously, at the free tier service (`downloadCount`,
 * `sendCount`): only that it was served, from here, to curl, wget or something else, and the
 * day it arrives. No IP address, no user agent, nothing from the URL.
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

/** Where the free tier service counts scripts served (services/free, POST /v1/telemetry/download). */
export const TELEMETRY_URL = "https://free.directionallylocal.com/v1/telemetry/download";

export interface DownloadCount {
  route: "run";
  client: "curl" | "wget" | "other";
}

/**
 * The count for a response, or undefined when it isn't a script served: a redirect, a 404, a
 * HEAD. dl.new's scripts fetch this one with `?via=<page>` after counting it there, so those
 * aren't counted twice.
 */
export function downloadCount(request: Request, response: Response): DownloadCount | undefined {
  if (request.method !== "GET" || response.status !== 200) return undefined;
  if (new URL(request.url).searchParams.has("via")) return undefined;
  const agent = request.headers.get("User-Agent") ?? "";
  const client = /^curl\//i.test(agent) ? "curl" : /^wget\//i.test(agent) ? "wget" : "other";
  return { route: "run", client };
}

/** Sends one count; never throws and gives up after 3 seconds. For `ctx.waitUntil`. */
export async function sendCount(count: DownloadCount, url: string, fetcher: typeof fetch = fetch): Promise<void> {
  try {
    await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(count),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Counting is best effort: the script was already served.
  }
}
