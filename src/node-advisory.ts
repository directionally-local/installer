/**
 * Whether a Node.js version is safe to run the stack on. CVE-2026-111497 ("Node2Shell")
 * is a critical out-of-bounds write in Node's bundled Brotli decoder, reachable through
 * fetch(); it's fixed in 22.23.4, 24.22.1 and 26.12.1. Odd lines get no fix. Mirrors
 * Hotcell's `engines` (^22.23.4 || ^24.22.1 || >=26.12.1) and its startup advisory.
 */

const FIXED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
/** End of security support for each LTS line (nodejs/Release schedule). */
export const NODE_END_OF_LIFE: Record<number, string> = { 22: "2027-04-30", 24: "2028-04-30", 26: "2029-04-30" };

export interface NodeAdvisory {
  ok: boolean;
  /** Why it isn't safe, or a soon-to-end support warning when it is. */
  message: string | undefined;
}

export function nodeAdvisory(version: string, today = new Date()): NodeAdvisory {
  const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return { ok: false, message: `Couldn't read the Node.js version (${version || "none"}).` };
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const fixed = FIXED[major];
  const patched = major > 26 || (fixed !== undefined && (minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1])));
  if (!patched) {
    const reason = major < 22 || major % 2 === 1 ? `Node.js ${major} is unsupported and gets no fix` : `Node.js ${version.replace(/^v/, "")} is vulnerable`;
    return { ok: false, message: `${reason} for CVE-2026-111497 (remote code execution via fetch). Use 22.23.4+, 24.22.1+ or 26.12.1+.` };
  }
  const end = NODE_END_OF_LIFE[major];
  if (end && Date.parse(end) - today.getTime() < 90 * 24 * 60 * 60 * 1000) {
    return { ok: true, message: `Node.js ${major} stops getting security fixes on ${end}; move to a newer LTS line.` };
  }
  return { ok: true, message: undefined };
}
