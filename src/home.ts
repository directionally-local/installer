import { agentCapacity, detectHost } from "./detect.js";
import { AUTOPILOT_PORT, CELL_MEMORY_MB, SERVICES } from "./layout.js";
import { approvePairing, listLaptops, listServerRuns, ownerLink, pendingPairings, revokeLaptop, type ServerRun } from "./server-api.js";
import { readState, type InstallState } from "./state.js";
import type { System } from "./system.js";
import { palette } from "./ui.js";
import { nextSteps } from "./up.js";

type Write = (text: string) => void;
type Colors = ReturnType<typeof palette>;

const ABOUT = "Background coding agents on your own server: send a task from your laptop, get a pull request back.";

/** Quick health for the home screen and the login line: services up and the API answering. */
async function health(system: System): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  for (const [unit, label] of [[SERVICES.hotcell, "sandboxes"], [SERVICES.autopilot, "agent server"]] as const) {
    if ((await system.probe("systemctl", ["is-active", unit])).stdout.trim() !== "active") problems.push(`${label} stopped`);
  }
  if (problems.length === 0) {
    const code = (await system.probe("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "3", `http://127.0.0.1:${AUTOPILOT_PORT}/api/v1/health`])).stdout.trim();
    if (code !== "401") problems.push("agent server not answering");
  }
  return { ok: problems.length === 0, problems };
}

/** `dl` on a server: what this is, whether it's healthy, who's connected, what's running, what to do. */
export async function serverHome(system: System, state: InstallState, write: Write, c: Colors): Promise<void> {
  const [status, laptops, runs, pending, facts] = await Promise.all([
    health(system), listLaptops(system), listServerRuns(system), pendingPairings(system), detectHost(system),
  ]);
  const verdict = status.ok ? c.green("● healthy") : c.red(`● ${status.problems.join(", ")}`);
  const week = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const running = runs?.filter((run) => run.active).length ?? 0;
  const doneThisWeek = runs?.filter((run) => !run.active && Date.parse(run.createdAt) >= week).length ?? 0;
  const row = (label: string, value: string, hint = "") => `  ${c.dim(label.padEnd(11))}${value}${hint ? `   ${c.dim(hint)}` : ""}\n`;

  write(`\n  ${c.bold("Directionally Local")}  ${verdict}  ${c.dim(state.access.url)}\n\n  ${ABOUT}\n\n`);
  write(row("Laptops", laptops === undefined ? c.dim("unknown (run dl up to update)") : laptops.length === 0 ? "none connected yet" : `${laptops.length} connected · ${laptops.map((laptop) => laptop.name).join(", ")}`, "dl laptops"));
  write(row("Runs", runs === undefined ? c.dim("unknown (run dl up to update)") : `${running} running · ${doneThisWeek} this week`, "dl runs"));
  write(row("Capacity", `~${agentCapacity(facts, CELL_MEMORY_MB)} agents at once (estimate)`));
  if (pending.length > 0) {
    write(`\n  ${c.yellow("!")} Waiting for approval: ${pending.map((entry) => `${c.bold(entry.code)} (${entry.name})`).join(", ")}   ${c.dim("dl connect-laptop <code>")}\n`);
  }
  write(`\n  ${c.dim("Connect a laptop")}   dl connect-laptop\n  ${c.dim("Something wrong?")}   dl doctor\n  ${c.dim("All commands")}       dl help\n\n`);
}

/** `dl status --brief`: one line, for the login message. Never slow, never fails loudly. */
export async function briefStatus(system: System, state: InstallState, write: Write, c: Colors): Promise<void> {
  const status = await health(system);
  write(`\n  ${c.bold("Directionally Local")}  ${status.ok ? c.green("● healthy") : c.red(`● ${status.problems.join(", ")}`)}  ${c.dim(state.access.url)}\n  ${c.dim("Type")} dl ${c.dim("for what this is and what's running.")}\n\n`);
}

/**
 * `dl connect-laptop [CODE]`: approve a laptop's code, or explain how to connect one and
 * print a fresh browser link for approving them.
 */
export async function connectLaptop(system: System, state: InstallState, code: string | undefined, write: Write, c: Colors): Promise<number> {
  if (code) {
    const result = await approvePairing(system, code);
    write(`\n  ${result.ok ? c.green("✓") : c.red("✗")} ${result.ok ? "Laptop approved. It finishes connecting on its own." : result.message}\n\n`);
    return result.ok ? 0 : 1;
  }
  const pending = await pendingPairings(system);
  if (pending.length > 0) {
    write(`\n  ${c.bold("Waiting for approval")}\n${pending.map((entry) => `  ${c.bold(entry.code)}  ${entry.name}   ${c.dim(`dl connect-laptop ${entry.code}`)}`).join("\n")}\n`);
  }
  const link = await ownerLink(system, state.access.url);
  write(`\n  ${c.bold("Connect a laptop")}\n`);
  nextSteps({ url: state.access.url, ownerLink: link, access: state.access.mode }).slice(0, 2).forEach((item, index) => {
    write(`\n  ${c.cyan(String(index + 1))}  ${item.label}\n${item.value.split("\n").map((line) => `     ${c.bold(line)}`).join("\n")}\n`);
  });
  write(`\n  ${c.dim("The laptop shows a code; approve it in that browser, or here with")} dl connect-laptop <code>\n\n`);
  return 0;
}

export async function laptopsCommand(system: System, args: string[], write: Write, c: Colors): Promise<number> {
  const laptops = await listLaptops(system);
  if (laptops === undefined) {
    write(`\n  ${c.red("✗")} Couldn't list laptops; run ${c.bold("dl up")} to update this server.\n\n`);
    return 1;
  }
  if (args[0] === "remove") {
    const target = args.slice(1).join(" ").trim().toLowerCase();
    const matches = laptops.filter((laptop) => laptop.id === target || laptop.id.startsWith(target) || laptop.name.toLowerCase() === target);
    if (!target || matches.length !== 1) {
      write(`\n  ${c.red("✗")} ${matches.length > 1 ? "That matches several laptops; use its id from dl laptops." : `No laptop named "${target}".`}\n\n`);
      return 1;
    }
    const ok = await revokeLaptop(system, matches[0]!.id);
    write(`\n  ${ok ? c.green("✓") : c.red("✗")} ${ok ? `Disconnected ${matches[0]!.name}. It can't reach this server any more.` : "Couldn't disconnect it."}\n\n`);
    return ok ? 0 : 1;
  }
  if (laptops.length === 0) {
    write(`\n  No laptops connected yet.   ${c.dim("dl connect-laptop")}\n\n`);
    return 0;
  }
  write("\n");
  for (const laptop of laptops) {
    const used = laptop.lastUsedAt ? `last used ${laptop.lastUsedAt.slice(0, 10)}` : "not used yet";
    write(`  ${c.green("●")} ${laptop.name.padEnd(28)} ${c.dim(`${used} · ${laptop.id.slice(0, 8)}`)}\n`);
  }
  write(`\n  ${c.dim("Disconnect one:")} dl laptops remove <name>\n\n`);
  return 0;
}

export async function serverRunsCommand(system: System, write: Write, c: Colors): Promise<number> {
  const runs = await listServerRuns(system, 50);
  if (runs === undefined) {
    write(`\n  ${c.red("✗")} Couldn't list runs; run ${c.bold("dl up")} to update this server.\n\n`);
    return 1;
  }
  if (runs.length === 0) {
    write(`\n  No runs yet. From a laptop:  ${c.bold('dl run "fix the flaky checkout test"')}\n\n`);
    return 0;
  }
  write("\n");
  for (const run of runs) write(formatRun(run, c));
  write("\n");
  return 0;
}

export function formatRun(run: ServerRun, c: Colors): string {
  const glyph = run.active ? c.cyan("◐") : run.status === "completed" || run.status === "merged" ? c.green("✓") : run.status === "failed" || run.status === "interrupted" ? c.red("✗") : c.dim("○");
  const where = run.pullRequestURL ?? run.branch ?? "";
  return `  ${glyph} ${run.conversationId.slice(0, 8)}  ${(run.active ? "running" : run.status).padEnd(11)} ${(run.repository ?? "").padEnd(28)} ${c.dim(where)}${run.startedBy ? c.dim(`  · ${run.startedBy}`) : ""}\n`;
}

/** `dl logs [hotcell|autopilot] [-f]`: the services' logs, without knowing their unit names. */
export async function logsCommand(system: System, args: string[]): Promise<number> {
  const follow = args.includes("-f") || args.includes("--follow");
  const which = args.find((arg) => !arg.startsWith("-"));
  const units = which === "hotcell" ? [SERVICES.hotcell] : which === "autopilot" ? [SERVICES.autopilot] : [SERVICES.hotcell, SERVICES.autopilot];
  const result = await system.run("journalctl", [...units.flatMap((unit) => ["-u", unit]), "-n", "80", "--no-pager", ...(follow ? ["-f"] : [])], { inherit: true, allowFailure: true });
  return result.code;
}

export { readState };
