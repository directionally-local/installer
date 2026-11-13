/**
 * How a machine's GPUs are wired to each other, from `nvidia-smi topo -m`. Its legend:
 *
 *   X    = Self
 *   SYS  = Connection traversing PCIe as well as the SMP interconnect between NUMA nodes (e.g., QPI/UPI)
 *   NODE = Connection traversing PCIe as well as the interconnect between PCIe Host Bridges within a NUMA node
 *   PHB  = Connection traversing PCIe as well as a PCIe Host Bridge (typically the CPU)
 *   PXB  = Connection traversing multiple PCIe bridges (without traversing the PCIe Host Bridge)
 *   PIX  = Connection traversing at most a single PCIe bridge
 *   NV#  = Connection traversing a bonded set of # NVLinks
 *
 * Tensor parallelism all-reduces activations on every layer, so the link between the GPUs
 * decides the layout: NVLink carries that well, PCIe (any of PIX…SYS) far less so.
 */

/** A link between two GPUs: "NV18", or a PCIe path, best first. */
export type PcieLink = "PIX" | "PXB" | "PHB" | "NODE" | "SYS";
const PCIE_ORDER: readonly PcieLink[] = ["PIX", "PXB", "PHB", "NODE", "SYS"];

export interface Topology {
  /** GPU indices, in the matrix's order. */
  gpus: number[];
  /** links[a][b]: the link between gpus[a] and gpus[b] as printed ("X", "NV18", "NODE", …). */
  links: string[][];
}

export type InterconnectKind = "single" | "nvlink" | "pcie";

export interface Interconnect {
  kind: InterconnectKind;
  /** The slowest link between any two of the GPUs: "NV18", "NODE", "SYS"; "" for one GPU or unknown. */
  worst: string;
  /** In words, for the plan: "NVLink (NV18) between every pair", "PCIe only (NODE), no NVLink". */
  text: string;
}

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/** The GPU-to-GPU part of `nvidia-smi topo -m`; undefined when it can't be read. */
export function parseTopology(output: string): Topology | undefined {
  const lines = strip(output).split("\n");
  const headerAt = lines.findIndex((line) => /^\s+GPU0\b/.test(line));
  if (headerAt === -1) return undefined;
  const columns: number[] = [];
  for (const cell of lines[headerAt]!.trim().split(/\s+/)) {
    const match = /^GPU(\d+)$/.exec(cell);
    if (!match) break;
    columns.push(Number(match[1]));
  }
  const links: string[][] = [];
  for (const line of lines.slice(headerAt + 1)) {
    const cells = line.trim().split(/\s+/);
    const row = /^GPU(\d+)$/.exec(cells[0] ?? "");
    if (!row) break;
    const values = cells.slice(1, 1 + columns.length);
    if (values.length !== columns.length) return undefined;
    links.push(values);
  }
  if (columns.length === 0 || links.length !== columns.length) return undefined;
  return { gpus: columns, links };
}

/** Higher is slower: any NVLink beats PCIe (more bonded links beat fewer), then PIX…SYS, then unknown. */
function rank(link: string): number {
  if (/^NV\d+$/.test(link)) return -1 - Number(link.slice(2)) / 1000;
  const index = PCIE_ORDER.indexOf(link as PcieLink);
  return index === -1 ? 100 : index;
}

/** How the given GPUs (all of them by default) reach each other; PCIe when any pair lacks NVLink. */
export function interconnect(topology: Topology | undefined, indices?: readonly number[]): Interconnect {
  const chosen = indices ?? topology?.gpus ?? [];
  if (chosen.length <= 1) return { kind: "single", worst: "", text: "one GPU" };
  if (!topology) return { kind: "pcie", worst: "", text: "unknown (nvidia-smi topo -m unreadable), planned as PCIe" };
  let worst = "";
  for (const a of chosen) {
    for (const b of chosen) {
      if (a >= b) continue;
      const row = topology.gpus.indexOf(a);
      const column = topology.gpus.indexOf(b);
      const link = row === -1 || column === -1 ? "SYS" : topology.links[row]![column]!;
      if (!worst || rank(link) > rank(worst)) worst = link;
    }
  }
  if (/^NV\d+$/.test(worst)) return { kind: "nvlink", worst, text: `NVLink (${worst}) between every pair` };
  const known = PCIE_ORDER.includes(worst as PcieLink);
  return { kind: "pcie", worst, text: known ? `PCIe only (${worst}), no NVLink` : `PCIe (link "${worst}"), no NVLink` };
}
