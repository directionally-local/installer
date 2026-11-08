import type { RunOptions, RunResult } from "../system.js";
import { FakeSystem } from "./fake-system.js";

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "not found"): RunResult => ({ code: 1, stdout: "", stderr });

export class FakeModelSystem extends FakeSystem {
  readonly running = new Set<string>();
  readonly modelCommands: string[] = [];
  gpu = "0, NVIDIA RTX 6000, 49152, 49152, 570.86\n";
  runtimes = '{"nvidia":{}}';
  toolkit = true;
  override async probe(command: string, args: string[]): Promise<RunResult> {
    if (command === "nvidia-smi") return this.gpu ? ok(args.length ? this.gpu : "CUDA Version: 12.8\n") : fail();
    if (command === "nvidia-container-cli") return this.toolkit ? ok("NVIDIA Container CLI 1.17\n") : fail();
    if (command === "docker") {
      if (args[0] === "info") return this.docker ? ok(this.runtimes) : fail();
      if (args[0] === "inspect") return this.running.has(args.at(-1)!) ? ok("true\n") : fail();
      if (args[0] === "logs") return ok("model loading\n");
    }
    return super.probe(command, args);
  }
  override async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    if (command === "docker") {
      this.modelCommands.push(args.join(" "));
      const name = args[0] === "run" ? args[args.indexOf("--name") + 1]! : args.at(-1)!;
      if (args[0] === "run" || args[0] === "start") this.running.add(name);
      if (args[0] === "stop" || args[0] === "rm") this.running.delete(name);
      return ok();
    }
    return super.run(command, args, options);
  }
  constructor() { super({ docker: true }); }
}
