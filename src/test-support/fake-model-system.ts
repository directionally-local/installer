import type { RunOptions, RunResult } from "../system.js";
import { FakeSystem } from "./fake-system.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "not found"): RunResult => ({ code: 1, stdout: "", stderr });

export class FakeModelSystem extends FakeSystem {
  readonly running = new Set<string>();
  /** Containers that exist (running or not), with their recipe label. */
  readonly vllmContainers = new Map<string, string>();
  readonly modelCommands: string[] = [];
  gpu = "0, NVIDIA RTX 6000, 49152, 49152, 570.86\n";
  runtimes = '{"nvidia":{}}';
  toolkit = true;
  /** What `du -sb` of the model's cache folder says on each look (the last one repeats); none: no folder yet. */
  downloads: number[] = [];
  /** vLLM's log, as `docker logs` prints it. */
  vllmLogs = "model loading\n";
  override async probe(command: string, args: string[]): Promise<RunResult> {
    if (command === "nvidia-smi") return this.gpu ? ok(args.length ? this.gpu : "CUDA Version: 12.8\n") : fail();
    if (command === "nvidia-ctk") return this.toolkit ? ok("NVIDIA Container Toolkit CLI version 1.17.4\n") : fail();
    if (command === "docker") {
      if (args[0] === "info") return this.docker ? ok(this.runtimes) : fail();
      if (args[0] === "inspect" && args.join(" ").includes("Labels")) {
        const name = args.at(-1)!;
        if (!this.vllmContainers.has(name) && !this.running.has(name)) return fail("No such object");
        return ok(`${this.running.has(name)} ${this.vllmContainers.get(name) || "<no value>"}\n`);
      }
      if (args[0] === "inspect") return this.running.has(args.at(-1)!) ? ok("true\n") : fail();
      if (args[0] === "logs") return ok(this.vllmLogs);
      if (args[0] === "exec" && args.includes("du")) {
        const bytes = this.downloads.length > 1 ? this.downloads.shift() : this.downloads[0];
        return bytes === undefined ? fail("du: cannot access") : ok(`${bytes}\t${args.at(-1)}\n`);
      }
    }
    return super.probe(command, args);
  }
  override async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    if (command === "docker") {
      this.modelCommands.push(args.join(" "));
      const name = args[0] === "run" ? args[args.indexOf("--name") + 1]! : args.at(-1)!;
      if (args[0] === "run" || args[0] === "start") this.running.add(name);
      if (args[0] === "run") this.vllmContainers.set(name, args.find((arg) => arg.startsWith("dl.model.spec="))?.slice("dl.model.spec=".length) ?? "");
      if (args[0] === "stop" || args[0] === "rm") this.running.delete(name);
      if (args[0] === "rm") this.vllmContainers.delete(name);
      return ok();
    }
    return super.run(command, args, options);
  }
  constructor() { super({ docker: true }); }
}
