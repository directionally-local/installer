import { downloadCount, respond, sendCount, TELEMETRY_URL } from "./handler.js";
import { INSTALL_SCRIPT } from "./install-script.js";

interface Env {
  /** Where to count scripts served; "off" turns counting off (for local runs). */
  TELEMETRY_URL?: string;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  fetch(request: Request, env?: Env, ctx?: Context): Response {
    const response = respond(request, INSTALL_SCRIPT);
    const count = downloadCount(request, response);
    const url = env?.TELEMETRY_URL || TELEMETRY_URL;
    // After the response, so counting never slows or breaks the script.
    if (count && ctx && url !== "off") ctx.waitUntil(sendCount(count, url));
    return response;
  },
};
