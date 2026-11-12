import assert from "node:assert/strict";
import { test } from "node:test";
import { firstRunModelUp, modelChoices, modelUpErrorType, TESTED_MODELS, type FirstRunModelUpOptions } from "./model-first-run.js";
import { SmokeError } from "./model-smoke.js";
import { FakeModelSystem } from "./test-support/fake-model-system.js";
import { PlainUi } from "./ui.js";
import { PromptCancelled, type Prompter, type SelectOption } from "./prompt.js";
import type { RunOptions, RunResult } from "./system.js";

/** A GPU machine where installing the toolkit (sh -c … under sudo or as root) makes it appear. */
class ToolkitSystem extends FakeModelSystem {
  installFails = false;
  override async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    if (command === "sudo" || command === "sh") {
      this.commands.push({ command, args });
      if (args.includes("-c")) {
        if (this.installFails) throw new Error("apt-get install failed (exit 100)");
        this.toolkit = true;
        this.runtimes = '{"nvidia":{},"runc":{}}';
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return super.run(command, args, options);
  }
}

function fixture(o: { gpu?: string; picks?: string[]; texts?: string[]; toolkit?: boolean; docker?: boolean; os?: string } = {}) {
  const system = new ToolkitSystem();
  if (o.gpu !== undefined) system.gpu = o.gpu;
  if (o.toolkit === false) {
    system.toolkit = false;
    system.runtimes = '{"runc":{}}';
  }
  if (o.docker === false) system.docker = false;
  if (o.os) system.files.set("/etc/os-release", { content: `ID=${o.os}\n`, mode: 0o644 });
  const lines: string[] = [];
  const picks = [...(o.picks ?? [])];
  const texts = [...(o.texts ?? [])];
  const shown: SelectOption[][] = [];
  const initials: Array<number | undefined> = [];
  const prompter: Prompter = {
    choose: async () => "",
    select: async (_question, options, initial) => {
      shown.push(options);
      initials.push(initial);
      const value = picks.shift();
      if (value === "cancel") throw new PromptCancelled();
      return { value: value ?? options[initial ?? 0]!.value };
    },
    secret: async () => "",
    text: async () => texts.shift() ?? "",
  };
  const ups: Array<{ action: string; args: string[]; interactive: boolean | undefined }> = [];
  let upResult: number | Error = 0;
  const options: FirstRunModelUpOptions = {
    system,
    ui: new PlainUi((line) => lines.push(line)),
    prompter,
    statePath: "/tmp/model.json",
    configPath: "/tmp/autopilot/config.json",
    modelUp: async (action, args, opts) => {
      ups.push({ action, args, interactive: opts.interactive });
      if (upResult instanceof Error) throw upResult;
      return upResult;
    },
  };
  return { system, lines, shown, initials, ups, options, setUp: (r: number | Error) => (upResult = r) };
}

test("the picker shows every model with fits or doesn't fit, and tested or untested; dl model up runs the pick with defaults", async () => {
  const f = fixture({ gpu: "0, NVIDIA GeForce RTX 4090, 24564, 24000, 570.86\n" });
  const result = await firstRunModelUp(f.options);
  assert.deepEqual(result, { ok: true, model: "Qwen/Qwen3-4B-Instruct-2507" });
  const rows = f.shown[0]!;
  assert.deepEqual(rows.map((row) => row.value), ["qwen-new", "qwen-old", "glm-flash"]);
  assert.deepEqual(rows.map((row) => row.detail), ["16 GB · fits · tested", "12 GB · fits · tested", "48 GB · doesn't fit · untested"]);
  assert.equal(f.initials[0], 0, "qwen-new, the first tested model that fits, is the default");
  assert.deepEqual(f.ups, [{ action: "up", args: ["qwen-new"], interactive: false }], "dl model up's own entry point, default context and port");
  assert.match(f.lines.join(""), /GPU: NVIDIA GeForce RTX 4090 · 24 GB/);
  assert.match(f.lines.join(""), /Docker: Nvidia container toolkit ready/);
});

test("a model that doesn't fit can't be started: it says why and asks again", async () => {
  const f = fixture({ gpu: "0, NVIDIA GeForce RTX 4090, 24564, 24000, 570.86\n", picks: ["glm-flash", "qwen-new"] });
  assert.deepEqual(await firstRunModelUp(f.options), { ok: true, model: "Qwen/Qwen3-4B-Instruct-2507" });
  assert.match(f.lines.join(""), /glm-flash needs 48 GB; this GPU has 24 GB\. Pick one that fits\./);
  assert.deepEqual(f.ups.map((up) => up.args), [["qwen-new"]]);
});

test("nothing in the catalog fits a small GPU", async () => {
  const f = fixture({ gpu: "0, NVIDIA GeForce RTX 3050, 8192, 8000, 570.86\n" });
  const result = await firstRunModelUp(f.options);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.errorType, "no_fit");
  assert.equal(f.ups.length, 0);
});

test("a missing toolkit is offered for install with sudo; yes installs it and goes on", async () => {
  const f = fixture({ toolkit: false, texts: [""] });
  assert.equal((await firstRunModelUp(f.options)).ok, true);
  assert.deepEqual(f.system.commands.filter((c) => c.command === "sudo").map((c) => c.args.slice(0, 2)), [["-v"], ["-n", "sh"]], "sudo asks for the password first, then installs");
  assert.match(f.system.commands.find((c) => c.args.includes("-c"))!.args.at(-1)!, /apt-get install -y -qq nvidia-container-toolkit[\s\S]*nvidia-ctk runtime configure --runtime=docker/);
  assert.equal(f.ups.length, 1);
});

test("as root, the toolkit installs without sudo", async () => {
  const f = fixture({ toolkit: false, texts: ["y"] });
  assert.equal((await firstRunModelUp({ ...f.options, root: true })).ok, true);
  assert.deepEqual(f.system.commands.filter((c) => c.command === "sudo"), []);
  assert.equal(f.system.commands.filter((c) => c.command === "sh").length, 1);
});

test("declining the toolkit, or a failed install, ends without starting anything", async () => {
  const no = fixture({ toolkit: false, texts: ["n"] });
  const declined = await firstRunModelUp(no.options);
  assert.equal(!declined.ok && declined.errorType, "no_toolkit");
  assert.equal(no.ups.length, 0);
  const broken = fixture({ toolkit: false, texts: [""] });
  broken.system.installFails = true;
  const failed = await firstRunModelUp(broken.options);
  assert.equal(!failed.ok && failed.errorType, "toolkit_install_failed");
  assert.match(!failed.ok ? failed.message : "", /apt-get install failed/);
});

test("off Ubuntu and Debian the toolkit isn't installed for you: the guide is named", async () => {
  const f = fixture({ toolkit: false, os: "fedora" });
  const result = await firstRunModelUp(f.options);
  assert.equal(!result.ok && result.errorType, "no_toolkit");
  assert.match(!result.ok ? result.message : "", /container-toolkit\/latest\/install-guide/);
});

test("no Docker: says so with where to get it", async () => {
  const f = fixture({ docker: false });
  const result = await firstRunModelUp(f.options);
  assert.equal(!result.ok && result.errorType, "no_docker");
  assert.match(!result.ok ? result.message : "", /docs\.docker\.com/);
});

test("a model already serving here is reused: Autopilot's provider points at it", async () => {
  const f = fixture();
  f.system.files.set("/tmp/model.json", { mode: 0o600, content: JSON.stringify({ version: 1, active: { id: "qwen-new", repo: "Qwen/Qwen3-4B-Instruct-2507", container: "dl-model-1", port: 8000, context: 32768, image: "x", flags: [], minVramMiB: 16384, lastTest: { chat: true, tools: true, json: true, tokensPerSecond: 1, at: "" } } }) });
  f.system.running.add("dl-model-1");
  assert.deepEqual(await firstRunModelUp(f.options), { ok: true, model: "Qwen/Qwen3-4B-Instruct-2507" });
  const config = JSON.parse(f.system.files.get("/tmp/autopilot/config.json")!.content);
  assert.equal(config.provider, "vllm");
  assert.equal(config.providers.vllm.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(f.ups.length, 0);
  f.system.running.delete("dl-model-1");
  const stopped = await firstRunModelUp(f.options);
  assert.equal(!stopped.ok && stopped.errorType, "already_running");
});

test("failures from dl model up become short error types; Esc is cancelled", async () => {
  const smoke = fixture();
  smoke.setUp(new Error("Smoke test failed for Qwen/Qwen3-4B: Tool call did not return ping(1)"));
  const failed = await firstRunModelUp(smoke.options);
  assert.equal(!failed.ok && failed.errorType, "smoke_failed");
  assert.equal(modelUpErrorType(new SmokeError("chat", "the model returned no text")), "smoke_failed");
  assert.equal(modelUpErrorType(new SmokeError("ready", "vLLM stopped while loading the model")), "launch_failed");
  const cancelled = fixture({ picks: ["cancel"] });
  const esc = await firstRunModelUp(cancelled.options);
  assert.equal(!esc.ok && esc.errorType, "cancelled");
  assert.equal(modelUpErrorType(new Error("Could not start vLLM: boom")), "launch_failed");
  assert.equal(modelUpErrorType(new Error("glm-flash reserves 44 GB of GPU VRAM but the largest GPU has 20 GB free.")), "no_fit");
  assert.equal(modelUpErrorType(new Error("something else")), "other");
  const noGpu = fixture({ gpu: "" });
  const none = await firstRunModelUp(noGpu.options);
  assert.equal(!none.ok && none.errorType, "other");
});

test("tested models are the ones verified on a real GPU", () => {
  assert.deepEqual([...TESTED_MODELS].sort(), ["qwen-new", "qwen-old"]);
  assert.deepEqual(modelChoices(49152).map((c) => [c.recipe.id, c.fits]), [["qwen-new", true], ["qwen-old", true], ["glm-flash", true]]);
});

const PRO_5000 = "0, NVIDIA RTX PRO 5000 Blackwell, 48935, 48000, 580.95.05\n";

test("an RTX PRO 5000 (48 GB): a short GPU line, and the picker, since two models fit", async () => {
  const f = fixture({ gpu: PRO_5000 });
  assert.equal((await firstRunModelUp(f.options)).ok, true);
  assert.equal(f.shown.length, 1, "the picker was shown");
  assert.deepEqual(f.shown[0]!.map((row) => row.detail?.split(" · ")[1]), ["fits", "fits", "doesn't fit"]);
  const text = f.lines.join("");
  assert.match(text, /GPU: NVIDIA RTX PRO 5000 · 48 GB\n/);
  assert.match(text, /Driver: 580\.95\.05 · CUDA 12\.8\n/);
  assert.doesNotMatch(text, /Blackwell/);
});

test("exactly one model fits: picked without asking, and the line says why", async () => {
  const f = fixture({ gpu: "0, NVIDIA GeForce RTX 4080, 16376, 16000, 570.86\n" });
  assert.deepEqual(await firstRunModelUp(f.options), { ok: true, model: "Qwen/Qwen3-4B" });
  assert.equal(f.shown.length, 0, "no picker for one option");
  assert.match(f.lines.join(""), /Model: Only one model fits this GPU: qwen-old/);
  assert.deepEqual(f.ups.map((up) => up.args), [["qwen-old"]]);
});

test("Retry runs the same model without the picker; Pick another marks the failed one and defaults elsewhere", async () => {
  const retry = fixture({ gpu: PRO_5000 });
  assert.equal((await firstRunModelUp({ ...retry.options, model: "qwen-old" })).ok, true);
  assert.equal(retry.shown.length, 0);
  assert.deepEqual(retry.ups.map((up) => up.args), [["qwen-old"]]);
  assert.match(retry.lines.join(""), /Model: qwen-old, trying again/);
  const pick = fixture({ gpu: PRO_5000 });
  assert.equal((await firstRunModelUp({ ...pick.options, avoid: "qwen-new" })).ok, true);
  assert.equal(pick.shown[0]![0]!.detail, "16 GB · fits · tested · failed");
  assert.equal(pick.initials[0], 1, "the default moves to qwen-old");
  assert.deepEqual(pick.ups.map((up) => up.args), [["qwen-old"]]);
});

test("a failed setup is one short line, the run log and the model tried; never the server's logs", async () => {
  const f = fixture({ gpu: PRO_5000 });
  const error = Object.assign(new SmokeError("chat", "the model returned no text, thinking mode used all tokens"), { logPath: "/home/me/.directionallylocal/logs/x-up.log" });
  error.message += "\nFull log: /home/me/.directionallylocal/logs/x-up.log";
  f.setUp(error);
  assert.deepEqual(await firstRunModelUp(f.options), {
    ok: false,
    errorType: "smoke_failed",
    message: "Chat test: the model returned no text, thinking mode used all tokens",
    log: "/home/me/.directionallylocal/logs/x-up.log",
    model: "qwen-new",
  });
});
