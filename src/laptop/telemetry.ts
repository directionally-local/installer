/**
 * The opt-out from dl's usage counts, with install.sh's rules: `DL_NO_TELEMETRY` or `DO_NOT_TRACK`
 * set to anything but empty, `0` or `false`, or a non-empty `CI`.
 *
 * In the CLI it turns off the session details `dl claude`, `dl opencode`, `dl pi`, `dl t3` and
 * `dl proxy` send (session.end with its duration and exit reason, and the os and harness on
 * session.start), and `dl status` counting dl Pro's offer as seen (`/v1/me?prompt=shown`).
 * A bare session.start (its id and time, nothing else) still goes when a free tier key starts and
 * every few hours after: the free tier's dl-only check needs one in the last 24 hours, or the
 * account's free tokens are refused after a few requests (`dl_only`, services/free/src/abuse.ts).
 */
export function telemetryOff(env: Record<string, string | undefined> = process.env): boolean {
  const on = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value !== "false";
  return on(env.DL_NO_TELEMETRY) || on(env.DO_NOT_TRACK) || Boolean(env.CI);
}
