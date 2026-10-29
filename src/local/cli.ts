/** `dl local status` and `dl local uninstall [--purge]`: agents running on this computer. */
import { homedir } from "node:os";
import type { palette, Ui } from "../ui.js";
import { localStatus, uninstallFromThisComputer, type LocalOptions, type LocalStatus } from "./setup.js";

type Colors = ReturnType<typeof palette>;

export const LOCAL_HELP = `  dl local status         agents on this computer: running?, where, how many fit
  dl local uninstall [--purge]   stop and remove them (--purge also deletes keys and data)
`;

export async function localCommand(
  args: string[],
  flags: { purge?: boolean },
  io: { out: (text: string) => void; err: (text: string) => void },
  colors: Colors,
  ui: Ui,
  options: LocalOptions = {},
): Promise<number> {
  const [sub = "status"] = args;
  if (sub === "status") {
    io.out(formatLocalStatus(await localStatus(options), colors, options.home ?? homedir()));
    return 0;
  }
  if (sub === "uninstall") {
    await uninstallFromThisComputer({ ui, purge: Boolean(flags.purge), ...options });
    ui.finish();
    return 0;
  }
  io.err(`  Unknown: dl local ${sub}\n\n${LOCAL_HELP}`);
  return 2;
}

export function formatLocalStatus(status: LocalStatus, c: Colors, home: string): string {
  const short = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
  if (!status.installed || !status.state) {
    const leftovers = status.services.hotcell.installed || status.services.autopilot.installed;
    return `\n  ${c.bold("Directionally Local")}  ${c.dim("isn't set up on this computer.")}\n${
      leftovers ? `\n  ${c.yellow("!")} Its services are still registered; remove them with: dl local uninstall\n` : ""
    }\n`;
  }
  const { state, services } = status;
  const mark = (ok: boolean) => (ok ? c.green("✓") : c.red("✗"));
  const line = (ok: boolean, label: string, detail: string) => `  ${mark(ok)} ${label.padEnd(12)}${c.dim(detail)}\n`;
  const describe = (entry: LocalStatus["services"]["hotcell"]) =>
    entry.running ? `running${entry.pid ? ` (pid ${entry.pid})` : ""}` : entry.installed ? "stopped" : "not installed";
  const healthy = services.hotcell.running && services.autopilot.running && status.answering && status.dockerRunning && status.modelPrices.ok;
  return [
    `\n  ${c.bold("Directionally Local")}  ${c.dim("on this computer")}  ${healthy ? c.green("running") : c.red("needs attention")}\n\n`,
    line(status.dockerRunning, "Docker", status.dockerRunning ? state.dockerRuntime : `${state.dockerRuntime} isn't running; start it`),
    line(services.hotcell.running, "Hotcell", `${describe(services.hotcell)} · 127.0.0.1:${state.ports.hotcell} · ${state.hotcellVersion}`),
    line(services.autopilot.running && status.answering, "Autopilot", `${describe(services.autopilot)}${status.answering ? "" : ", not answering"} · ${state.url} · ${state.autopilotVersion}`),
    status.modelPrices.warn
      ? `  ${c.yellow("!")} ${"Prices".padEnd(12)}${c.dim(status.modelPrices.detail)}\n`
      : line(status.modelPrices.ok, "Prices", status.modelPrices.detail),
    `\n  ${c.dim("Fits")}        ${status.capacity !== undefined ? `~${status.capacity} agents at once (estimate, from Docker's memory)` : "unknown while Docker is stopped"}\n`,
    `  ${c.dim("Installed")}   ${short(status.paths.current)}\n`,
    `  ${c.dim("Logs")}        ${short(status.paths.logs)}\n`,
    `  ${c.dim("Starts")}      at login (${status.platform === "darwin" ? "LaunchAgents" : "systemd --user"}); tasks pause while this computer sleeps\n`,
    healthy ? "\n" : `\n  ${c.dim("Fix it by running setup again; it repairs and keeps your keys.")}\n\n`,
  ].join("");
}
