import { downloadCount, respond, sendCount, serveBundle, TELEMETRY_URL, type BundleStore } from "./handler.js";
import { INSTALL_SCRIPT } from "./install-script.js";

interface Env {
  /** Where to count scripts served; "off" turns counting off (for local runs). */
  TELEMETRY_URL?: string;
  /** dl's prebuilt bundles, once the R2 bucket is bound (wrangler.toml). */
  BUNDLES?: BundleStore;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env?: Env, ctx?: Context): Promise<Response> {
    // A bundle download isn't a script download: served without a count.
    const bundle = await serveBundle(request, env?.BUNDLES);
    if (bundle) return bundle;
    const response = respond(request, INSTALL_SCRIPT);
    const count = downloadCount(request, response);
    const url = env?.TELEMETRY_URL || TELEMETRY_URL;
    // After the response, so counting never slows or breaks the script.
    if (count && ctx && url !== "off") ctx.waitUntil(sendCount(count, url));
    return response;
  },
};
