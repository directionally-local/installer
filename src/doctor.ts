import { detectHost, MIN_DISK_GB } from "./detect.js";
import { nodeAdvisory } from "./node-advisory.js";
import { AUTOPILOT_PORT, AUTO_UPGRADES, HOTCELL_PORT, NODE_AUTO_UPDATES, PATHS, SERVICES, parseEnvFile } from "./layout.js";
import { describeAccess, readState } from "./state.js";
import { palette } from "./ui.js";
import type { System } from "./system.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when it fails. */
  fix?: string;
}

/** `directionallylocal doctor`: every moving part, with a fix for each failure. */
export async function doctor(system: System): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (check: Check) => checks.push(check);
  const state = await readState(system);
  add(state
    ? { name: "installed", ok: true, detail: `${state.release}, ${state.access.mode === "ssh" ? describeAccess(state.access) : `${state.access.mode} at ${state.access.url}`}` }
    : { name: "installed", ok: false, detail: "not installed", fix: "sudo dl up" });

  const facts = await detectHost(system);
  const node = nodeAdvisory(facts.nodeVersion ?? "");
  add({
    name: "node",
    ok: node.ok && node.message === undefined,
    detail: node.message ?? `${facts.nodeVersion} (patched)`,
    fix: "re-run install.sh to upgrade Node.js (apt-get install --only-upgrade nodejs for a patch)",
  });
  const periodic = /APT::Periodic::Unattended-Upgrade\s+"1"/.test((await system.readFile(AUTO_UPGRADES)) ?? "");
  const nodeUpdates = await system.exists(NODE_AUTO_UPDATES);
  add({
    name: "security updates",
    ok: periodic && nodeUpdates,
    detail: periodic && nodeUpdates ? "daily, including Node.js" : !periodic ? "unattended-upgrades is off" : "Node.js isn't included",
    fix: "sudo dl up",
  });
  add({ name: "disk", ok: facts.diskFreeGb >= MIN_DISK_GB, detail: `${facts.diskFreeGb} GB free under /var`, fix: "free space: docker system prune, or grow the disk" });
  add(facts.docker
    ? { name: "docker", ok: true, detail: "running" }
    : { name: "docker", ok: false, detail: "not running", fix: "dl up" });

  // People read these, so they're named for what they do, not their systemd units.
  for (const [service, name, logs] of [
    [SERVICES.metadataBlock, "sandbox firewall", "dl up"],
    [SERVICES.hotcell, "sandboxes", "dl logs hotcell · then dl up"],
    [SERVICES.autopilot, "agent server", "dl logs autopilot · then dl up"],
  ] as const) {
    const active = (await system.probe("systemctl", ["is-active", service])).stdout.trim();
    add({ name, ok: active === "active", detail: active === "active" ? "running" : active || "unknown", fix: logs });
  }

  const hotcell = await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${HOTCELL_PORT}/`]);
  add({ name: "sandboxes API", ok: /^\d{3}$/.test(hotcell.stdout.trim()) && hotcell.stdout.trim() !== "000", detail: `HTTP ${hotcell.stdout.trim() || "none"}`, fix: "dl up" });

  const keys = await system.probe("runuser", ["-u", "hotcell", "--", "env", `HOTCELL_HOME=${PATHS.hotcellHome}`, "HOTCELL_KEYSTORE=file", "/usr/bin/node", `${PATHS.current}/node_modules/hotcell/dist/index.js`, "keys", "ls"]);
  const hasModelKey = keys.code === 0 && /^\s*openrouter\b/m.test(keys.stdout);
  add({ name: "model key", ok: hasModelKey, detail: hasModelKey ? "OpenRouter key in Hotcell" : "no OpenRouter key in Hotcell", fix: "sudo dl up (asks for it)" });

  const github = Boolean(parseEnvFile(await system.readFile(PATHS.githubEnv)).GITHUB_TOKEN);
  add({ name: "github", ok: github, detail: github ? "token configured" : "no token; runs can't push or open PRs", fix: "sudo dl up (asks for it)" });

  const autopilot = (await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${AUTOPILOT_PORT}/api/v1/health`])).stdout.trim();
  add({ name: "agent server API", ok: autopilot === "401", detail: autopilot === "401" ? "up (refuses requests without a token)" : `HTTP ${autopilot || "none"}`, fix: "dl logs autopilot · then dl up" });

  // Loopback and SSH access have nothing published to check: the tunnel is the laptop's.
  if (state?.access.mode === "tailscale") {
    const serve = await system.probe("tailscale", ["serve", "status"]);
    const serving = serve.code === 0 && serve.stdout.includes(`127.0.0.1:${AUTOPILOT_PORT}`);
    add({ name: "private access", ok: serving, detail: serving ? `on ${state.access.url}` : "not published on your tailnet", fix: "dl up" });
    const remote = await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", `${state.access.url}/api/v1/health`]);
    add({ name: "reachable", ok: remote.stdout.trim() === "401", detail: `${state.access.url}: HTTP ${remote.stdout.trim() || "none"}`, fix: "turn on HTTPS certificates at https://login.tailscale.com/admin/dns" });
  }
  return checks;
}

export function formatChecks(checks: Check[], color = false): string {
  const c = palette(color);
  const width = Math.max(...checks.map((check) => check.name.length)) + 2;
  const rows = checks.map((check) => {
    const glyph = check.ok ? c.green("✓") : c.red("✗");
    const fix = !check.ok && check.fix ? `\n     ${c.dim(`fix: ${check.fix}`)}` : "";
    return `  ${glyph} ${check.name.padEnd(width)}${check.ok ? c.dim(check.detail) : c.red(check.detail)}${fix}`;
  });
  const failed = checks.filter((check) => !check.ok).length;
  const verdict = failed === 0 ? `${c.green("✓")} ${c.bold("All good")}` : `${c.red("✗")} ${c.bold(`${failed} to fix`)}`;
  return `${rows.join("\n")}\n\n  ${verdict}`;
}
