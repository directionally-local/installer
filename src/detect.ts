import { nodeAdvisory } from "./node-advisory.js";
import type { System } from "./system.js";

export interface HostFacts {
  os: { id: string; versionId: string; prettyName: string };
  arch: string;
  memoryMb: number;
  cpus: number;
  /** Free space where sandboxes and images live (/var). */
  diskFreeGb: number;
  kvm: boolean;
  systemd: boolean;
  root: boolean;
  docker: boolean;
  /** The Docker bridge address sandboxes reach the host on (gateway, GitHub proxy). */
  dockerBridgeIp: string | undefined;
  /** e.g. "22.23.4"; undefined when node isn't on PATH. */
  nodeVersion: string | undefined;
  tailscale: boolean;
}

/** v0 supports the Ubuntu/Debian releases the issue targets; others get a clear refusal. */
const SUPPORTED_OS: Record<string, string[]> = {
  ubuntu: ["22.04", "24.04"],
  debian: ["12"],
};
export const MIN_MEMORY_MB = 3_500;
export const MIN_DISK_GB = 15;

export async function detectHost(system: System): Promise<HostFacts> {
  const [osRelease, meminfo, nproc, df, arch, kvm, systemd, uid, docker, bridge, node, tailscale] = await Promise.all([
    system.readFile("/etc/os-release"),
    system.readFile("/proc/meminfo"),
    system.probe("nproc", []),
    system.probe("df", ["-Pk", "/var"]),
    system.probe("uname", ["-m"]),
    system.exists("/dev/kvm"),
    system.exists("/run/systemd/system"),
    system.probe("id", ["-u"]),
    system.probe("docker", ["version", "--format", "{{.Server.Version}}"]),
    system.probe("ip", ["-4", "-o", "addr", "show", "docker0"]),
    system.probe("node", ["-p", "process.versions.node"]),
    system.probe("tailscale", ["version"]),
  ]);
  return {
    os: parseOsRelease(osRelease ?? ""),
    arch: arch.stdout.trim(),
    memoryMb: parseMemTotalMb(meminfo ?? ""),
    cpus: Number(nproc.stdout.trim()) || 0,
    diskFreeGb: parseDfFreeGb(df.stdout),
    kvm,
    systemd,
    root: uid.stdout.trim() === "0",
    docker: docker.code === 0 && docker.stdout.trim() !== "",
    dockerBridgeIp: parseInterfaceIp(bridge.stdout),
    nodeVersion: node.code === 0 && node.stdout.trim() ? node.stdout.trim() : undefined,
    tailscale: tailscale.code === 0,
  };
}

/** Problems that stop `up` before it changes anything. */
export function preflightProblems(facts: HostFacts): string[] {
  const problems: string[] = [];
  if (!facts.root) problems.push("Run as root (sudo dl up).");
  if (!facts.systemd) problems.push("systemd is required to run the services.");
  const versions = SUPPORTED_OS[facts.os.id];
  if (!versions?.includes(facts.os.versionId)) {
    problems.push(`${facts.os.prettyName || "This OS"} isn't supported yet; use Ubuntu 24.04 or 22.04, or Debian 12.`);
  }
  if (facts.arch !== "x86_64" && facts.arch !== "aarch64") problems.push(`CPU architecture ${facts.arch} isn't supported.`);
  if (facts.memoryMb < MIN_MEMORY_MB) problems.push(`At least 4 GB of RAM is needed (found ${(facts.memoryMb / 1024).toFixed(1)} GB).`);
  // The services run on this Node; never install onto one with a known RCE.
  const node = nodeAdvisory(facts.nodeVersion ?? "");
  if (!node.ok) problems.push(`${node.message} Re-run install.sh, which upgrades Node.`);
  if (facts.diskFreeGb < MIN_DISK_GB) problems.push(`At least ${MIN_DISK_GB} GB free under /var is needed (found ${facts.diskFreeGb} GB).`);
  return problems;
}

/**
 * How many agents fit at once: memory left after the host's own share, divided by each
 * sandbox's cap. A conservative estimate until the density benchmark (hotcell#17) lands.
 */
export function agentCapacity(facts: Pick<HostFacts, "memoryMb" | "cpus">, cellMemoryMb: number): number {
  const reservedMb = Math.max(1_536, Math.round(facts.memoryMb * 0.15));
  const byMemory = Math.floor((facts.memoryMb - reservedMb) / cellMemoryMb);
  const byCpu = Math.max(1, facts.cpus * 2);
  return Math.max(1, Math.min(byMemory, byCpu));
}

export function parseOsRelease(text: string): HostFacts["os"] {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) values.set(match[1]!, match[2]!.replace(/^"(.*)"$/, "$1"));
  }
  return { id: values.get("ID") ?? "", versionId: values.get("VERSION_ID") ?? "", prettyName: values.get("PRETTY_NAME") ?? "" };
}

export function parseMemTotalMb(text: string): number {
  const kb = Number(text.match(/^MemTotal:\s+(\d+)\s+kB/m)?.[1] ?? 0);
  return Math.round(kb / 1024);
}

export function parseDfFreeGb(text: string): number {
  const fields = text.trim().split("\n")[1]?.trim().split(/\s+/);
  const availableKb = Number(fields?.[3] ?? 0);
  return Math.floor(availableKb / 1024 / 1024);
}

export function parseInterfaceIp(text: string): string | undefined {
  return text.match(/\binet (\d+\.\d+\.\d+\.\d+)\//)?.[1];
}
