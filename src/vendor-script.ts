/**
 * Vendors' install scripts that dl up pipes to a root shell (get.docker.com,
 * tailscale.com/install.sh) run with a scrubbed environment: only what they need to find their
 * tools, talk to apt and reach the network. Nothing else from dl's environment, so none of the
 * unattended answers (DL_TAILSCALE_AUTH_KEY, DL_PROVIDER_API_KEY, DL_OPENROUTER_API_KEY,
 * DL_GITHUB_TOKEN) or anything else the person exported reaches them.
 */
export const VENDOR_SCRIPT_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "DEBIAN_FRONTEND",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

/**
 * `sh -c` text that runs `script` under `env -i` with only VENDOR_SCRIPT_ENV, each one only when
 * it's set. The values are expanded by that shell, never written into dl's command line.
 */
export function scrubbedScript(script: string): string {
  const keep = VENDOR_SCRIPT_ENV.map((name) => `\${${name}+"${name}=$${name}"}`).join(" ");
  return `exec env -i ${keep} sh -c '${script.replaceAll("'", `'\\''`)}'`;
}
