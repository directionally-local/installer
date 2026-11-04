/**
 * directionallylocal.run: the install script at the bare domain, for
 * `curl -fsSL https://directionallylocal.run | sh`, and dl's prebuilt bundles under /dl/
 * for it to download. Browsers go to the marketing site. The zone's subdomains are users'
 * instant addresses (and the domain is on the Public Suffix List), so this serves nothing
 * else and never sets a cookie.
 *
 * Each script served is counted, anonymously, at the free tier service (`downloadCount`,
 * `sendCount`): only that it was served, from here, to curl, wget or something else, and the
 * day it arrives. No IP address, no user agent, nothing from the URL. Bundle downloads aren't
 * counted here.
 */

export const MARKETING_SITE = "https://directionallylocal.com/";

/** The installer repository's GitHub releases, where the release workflow uploads the bundles. */
export const RELEASES = "https://github.com/directionally-local/installer/releases";

/**
 * The bundles' R2 bucket, bound as BUNDLES once it's set up (site/wrangler.toml). The
 * release workflow puts each version's files at dl/<version>/<file>, and the newest list at
 * dl/latest/dl-bundles.txt. Only what this Worker uses of R2's API.
 */
export interface BundleStore {
  get(key: string): Promise<{ body: ReadableStream; size: number; httpEtag: string } | null>;
}

/**
 * /dl/<version>/<file>, where version is a release or "latest" and file is that release's
 * dl-bundles.txt or one of its dl-<version>-<platform>.tar.gz. "latest" serves only the list,
 * which names the version to download.
 */
const BUNDLE_PATH = /^\/dl\/(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\/(dl-bundles\.txt|dl-[0-9A-Za-z.+-]+\.tar\.gz)$/;

/**
 * A bundle file: from the R2 bucket when one is bound and has it, otherwise a redirect to
 * the same file among the GitHub release's assets. Undefined when the path isn't a bundle's.
 */
export async function bundle(url: URL, method: string, store: BundleStore | undefined): Promise<Response | undefined> {
  const match = BUNDLE_PATH.exec(url.pathname);
  if (!match) return undefined;
  const [, version, file] = match as unknown as [string, string, string];
  const list = file === "dl-bundles.txt";
  if (version === "latest" && !list) return undefined;
  // A version's files never change; the latest list does, with each release.
  const cache = version === "latest" ? "public, max-age=300" : "public, max-age=31536000, immutable";
  const object = store ? await store.get(`dl/${version}/${file}`) : null;
  if (object) {
    return new Response(method === "HEAD" ? null : object.body, {
      status: 200,
      headers: {
        "Content-Type": list ? "text/plain; charset=utf-8" : "application/gzip",
        "Content-Length": String(object.size),
        ETag: object.httpEtag,
        "Cache-Control": cache,
        ...SECURITY_HEADERS,
      },
    });
  }
  const location = version === "latest" ? `${RELEASES}/latest/download/${file}` : `${RELEASES}/download/v${version}/${file}`;
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "public, max-age=300", ...SECURITY_HEADERS } });
}

/** A bundle file for an HTTPS GET or HEAD of one; undefined for anything else. */
export async function serveBundle(request: Request, store?: BundleStore): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || (request.method !== "GET" && request.method !== "HEAD")) return undefined;
  return bundle(url, request.method, store);
}

/** A bundle file, or else what `respond` serves. (The Worker also counts the script; see index.ts.) */
export async function route(request: Request, script: string, store?: BundleStore): Promise<Response> {
  return (await serveBundle(request, store)) ?? respond(request, script);
}

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
