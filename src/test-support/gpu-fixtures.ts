import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../system.js";
import { FakeModelSystem } from "./fake-model-system.js";

/** The machines in fixtures/gpu (see its README). */
export type GpuFixture = "rtx-pro-5000-1x" | "rtx-pro-6000-4x-pcie" | "h100-8x-nvlink";

export const FIXTURES_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "gpu");

export function fixtureDir(name: GpuFixture): string {
  return join(FIXTURES_DIR, name);
}

export function readFixture(name: GpuFixture, file: string): string {
  return readFileSync(join(fixtureDir(name), file), "utf8");
}

/** A fake model machine whose nvidia-smi prints a fixture's output; every probe is recorded. */
export function fixtureSystem(name: GpuFixture): FakeModelSystem & { probes: string[] } {
  const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
  class Fixture extends FakeModelSystem {
    readonly probes: string[] = [];
    override async probe(command: string, args: string[]): Promise<RunResult> {
      this.probes.push([command, ...args].join(" "));
      if (command === "nvidia-smi" && args[0] === "topo") {
        try { return ok(readFixture(name, "topo.txt")); } catch { return { code: 1, stdout: "", stderr: "no topology" }; }
      }
      if (command === "nvidia-smi" && args.length === 0) return ok(readFixture(name, "nvidia-smi.txt"));
      if (command === "df") return ok(readFixture(name, "df.txt"));
      return super.probe(command, args);
    }
    override async readFile(path: string): Promise<string | undefined> {
      if (path === "/proc/meminfo") return readFixture(name, "meminfo");
      return super.readFile(path);
    }
  }
  const system = new Fixture();
  system.gpu = readFixture(name, "nvidia-smi.csv");
  return system;
}
