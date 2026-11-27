/**
 * Vendors' apt steps and install scripts that dl runs as root (Docker's and Tailscale's apt
 * repositories, and any script still piped to a shell) run with a scrubbed environment: only
 * what they need to find their tools, talk to apt and reach the network. Nothing else from dl's
 * environment, so none of the unattended answers (DL_TAILSCALE_AUTH_KEY, DL_PROVIDER_API_KEY,
 * DL_OPENROUTER_API_KEY, DL_GITHUB_TOKEN) or anything else the person exported reaches them.
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

/** The environment a vendor step gets when dl runs it directly: only VENDOR_SCRIPT_ENV. */
export function scrubbedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of VENDOR_SCRIPT_ENV) {
    const value = env[name];
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}
