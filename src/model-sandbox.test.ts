import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "./cli.js";
import { hotcellBin, hotcellEnv, PATHS } from "./layout.js";
import { recipe } from "./model-catalog.js";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import {
  cellChecks, checkCellInspect, checkWorkspacePath, INSPECT_FORMAT, sandboxCommands, sandboxConfigPath, SANDBOX_LIMITS,
} from "./model-sandbox.js";
import type { Prompter } from "./prompt.js";
import { readDeployments } from "./state.js";
import type { RunOptions, RunResult } from "./system.js";
import { FIXTURES_DIR, fixtureDir, fixtureSystem } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

const WORKSPACE = "/srv/project";
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "failed"): RunResult => ({ code: 1, stdout: "", stderr });

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await main(argv, { out: (text) => { out += text; }, err: (text) => { err += text; } }, { terminal: false });
  return { code, out, err };
}

const planArgs = (...extra: string[]) => ["model", "up", "deepseek-v4.1-flash-fp8", "--plan", "--hardware", fixtureDir("rtx-pro-6000-4x-pcie"), ...extra];
/** The hardware directory is an absolute path on the machine running the tests. */
const portable = (text: string) => text.replace(fixtureDir("rtx-pro-6000-4x-pcie"), "src/test-support/fixtures/gpu/rtx-pro-6000-4x-pcie");

test("--plan --workspace on 4x RTX PRO 6000: the model plan as before, then the sandbox, byte for byte", async () => {
  const { code, out, err } = await cli(...planArgs("--workspace", WORKSPACE));
  assert.equal(err, "");
  assert.equal(code, 0);
  const snapshot = readFileSync(join(FIXTURES_DIR, "rtx-pro-6000-4x-pcie", "plan-deepseek-v4.1-flash-fp8-workspace.txt"), "utf8");
  assert.equal(portable(out), snapshot);
  // The model half is exactly the plan without --workspace.
  const plain = await cli(...planArgs());
  assert.ok(out.startsWith(plain.out), "--workspace only adds the sandbox after the model's plan");
  assert.doesNotMatch(plain.out, /Sandbox/);
});

test("the plan's sandbox: one bind mount, the internal network, no GPU, no gateway, nothing run", async () => {
  const { out } = await cli(...planArgs("--workspace", WORKSPACE));
  const create = out.slice(out.indexOf("hotcell create")).split("\n\nThen")[0]!.replace(/ \\\n {4}/g, " ");
  assert.equal(create.match(/--workspace-dir/g)?.length, 1);
  assert.match(create, /--workspace-dir \/srv\/project --network dl-model-net --memory 8192 --cpus 4 --pids 1024/);
  assert.doesNotMatch(create, /--egress|--gpus|docker\.sock|--autopilot|--repo/);
  assert.match(out, /docker network create --internal -o com\.docker\.network\.bridge\.inhibit_ipv4=true/);
  assert.match(out, /docker network connect --alias model dl-model-net dl-model-1\n/);
  // The model's own docker run doesn't change and never names the workspace.
  const run = out.slice(out.indexOf("\nCommand\n"), out.indexOf("\nSandbox ("));
  assert.doesNotMatch(run, /srv\/project/);
  assert.match(run, /-p 127\.0\.0\.1:8000:8000/);
});

test("--image and --workspace together: the image goes to the model only", async () => {
  const { code, out } = await cli(...planArgs("--workspace", WORKSPACE, "--image", "vllm/vllm-openai:v0.34.0rc2"));
  assert.equal(code, 0);
  const run = out.slice(out.indexOf("\nCommand"), out.indexOf("\nSandbox ("));
  assert.match(run, /vllm\/vllm-openai:v0\.34\.0rc2/);
  assert.match(out, /--image directionallylocal-cell:3\.22\.0/, "the sandbox keeps dl's cell image");
});

test("--allow-internet adds an egress network with only the cell on it; a named deployment gets its own names", async () => {
  const { out } = await cli(...planArgs("--workspace", WORKSPACE, "--allow-internet", "--name", "big"));
  assert.match(out, /docker network create --internal .*dl-model-big-net\n/s);
  assert.match(out, /docker network create --label hotcell.attachable=true \\\n {4}--label dl.model.deployment=big dl-model-big-net-egress/);
  assert.match(out.replace(/ \\\n {4}/g, " "), /--network dl-model-big-net,dl-model-big-net-egress /);
  assert.match(out, /Egress {5}the model, and the internet through dl-model-big-net-egress/);
  assert.match(out, /dl model attach --name big/);
});

test("--plan refuses a workspace that is /, a home or system directory, or holds one; and --allow-internet alone", async () => {
  for (const bad of ["/", "/root/project", "/home/me/project", "/etc", "/var", "/var/lib/docker/x", "relative/dir", "/srv/a,b"]) {
    const { code, err } = await cli(...planArgs("--workspace", bad));
    assert.equal(code, 1, bad);
    assert.match(err, /--workspace/, bad);
  }
  assert.equal(checkWorkspacePath("/srv/project/"), "/srv/project");
  assert.equal(checkWorkspacePath("/data/work"), "/data/work");
  const { code, err } = await cli(...planArgs("--allow-internet"));
  assert.equal(code, 1);
  assert.match(err, /--allow-internet is for the sandbox/);
});

test("docker inspect of the cell: only the planned mount, networks, no GPU, no socket", () => {
  const good = {
    Mounts: [
      { Type: "bind", Source: WORKSPACE, Destination: "/workspace", RW: true },
      { Type: "bind", Source: "/opt/directionallylocal/current/node_modules/hotcell/agent/hotcell-agent-linux-arm64", Destination: "/hotcell-agent", RW: false },
      { Type: "bind", Source: "/var/lib/hotcell/container-agent/abc", Destination: "/run/hotcell", RW: true },
    ],
    Networks: { "dl-model-net": {} }, DeviceRequests: null, Privileged: false,
  };
  const expected = { workspace: WORKSPACE, networks: ["dl-model-net"] };
  assert.deepEqual(checkCellInspect(JSON.stringify(good), expected), []);
  const broken = (change: Record<string, unknown>) => checkCellInspect(JSON.stringify({ ...good, ...change }), expected);
  assert.match(broken({ Mounts: [{ Type: "volume", Source: "sbx-x-workspace", Destination: "/workspace" }] }).join(), /\/workspace is volume/, "an old Hotcell ignoring --workspace-dir");
  assert.match(broken({ Mounts: [...good.Mounts, { Type: "bind", Source: "/root", Destination: "/host-root" }] }).join(), /unexpected mount \/root/);
  assert.match(broken({ Mounts: [...good.Mounts, { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }] }).join(), /Docker socket/);
  assert.match(broken({ Networks: { bridge: {} } }).join(), /networks are bridge/, "an old Hotcell ignoring --network");
  assert.match(broken({ DeviceRequests: [{ Driver: "nvidia" }] }).join(), /GPUs/);
  assert.match(broken({ Privileged: true }).join(), /privileged/);
});

test("the checks from inside the cell: the model answers; no socket, no GPU; no internet and no default route unless allowed", () => {
  const closed = cellChecks("http://model:8000/v1", false);
  assert.match(closed, /fetch\('http:\/\/model:8000\/v1\/models'/);
  assert.match(closed, /docker\.sock \|\| exit 13/);
  assert.match(closed, /\/dev\/nvidia\* .* \|\| exit 14/);
  assert.match(closed, /registry\.npmjs\.org.* \|\| exit 15/);
  assert.match(closed, /\/proc\/net\/route .* \|\| exit 16/);
  const open = cellChecks("http://model:8000/v1", true);
  assert.doesNotMatch(open, /exit 15|exit 16/);
});

/** A dl server with Hotcell 0.1.39 and the cell image, a 4x RTX PRO 6000 box, and a Hotcell that makes cells. */
function server(options: { hotcellVersion?: string; inspect?: (container: string) => string; cellCheck?: number } = {}) {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const image = "directionallylocal-cell:3.22.0";
  system.files.set(PATHS.state, { content: JSON.stringify({ version: 1, installedAt: "", updatedAt: "", release: "", autopilotVersion: "3.22.0", hotcellVersion: options.hotcellVersion ?? "0.1.39", image, access: { mode: "loopback", url: "" } }), mode: 0o644 });
  system.files.set(PATHS.hotcellEnv, { content: hotcellEnv({ apiKey: "k".repeat(48), bridgeIp: "172.17.0.1" }), mode: 0o640 });
  system.files.set(hotcellBin(), { content: "", mode: 0o755 });
  system.images.add(image);
  const networks = new Map<string, Set<string>>();
  const cells = new Map<string, { networks: string[]; workspace: string }>();
  const sandboxCommands: string[] = [];
  let next = 0;
  const probe = system.probe.bind(system);
  const run = system.run.bind(system);
  const cellInspect = (container: string) => {
    const cell = [...cells.entries()].find(([id]) => `sbx-${id}` === container)?.[1];
    if (!cell) return "";
    return JSON.stringify({ Mounts: [{ Type: "bind", Source: cell.workspace, Destination: "/workspace", RW: true }, { Type: "bind", Source: "/opt/a/hotcell-agent", Destination: "/hotcell-agent", RW: false }],
      Networks: Object.fromEntries(cell.networks.map((name) => [name, {}])), DeviceRequests: null, Privileged: false });
  };
  system.probe = async (command: string, args: string[]) => {
    if (command === "realpath") return ok(`${args.at(-1)}\n`);
    if (command === "test" || command === "runuser") return ok();
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") return system.images.has(args[2]!) ? ok("[]") : fail();
    if (command === "docker" && args[0] === "network" && args[1] === "inspect") return networks.has(args[2]!) ? ok("[]") : fail();
    if (command === "docker" && args[0] === "inspect" && args[2] === INSPECT_FORMAT) return ok((options.inspect ?? cellInspect)(args[3]!));
    if (command === "docker" && args[0] === "inspect" && args[2] === "{{json .Mounts}}") return ok('[{"Type":"volume","Name":"dl-model-hf-cache","Destination":"/root/.cache/huggingface"}]');
    if (command === "docker" && args[0] === "inspect" && args[1] === "--format" && args[2] === "{{.State.Running}}" && cells.has(args[3]!.replace(/^sbx-/, ""))) return ok("true\n");
    if (command === "docker" && args[0] === "exec") return options.cellCheck ? { code: options.cellCheck, stdout: "", stderr: "" } : ok();
    return probe(command, args);
  };
  system.run = async (command: string, args: string[], runOptions: RunOptions = {}) => {
    if (command === "docker" && args[0] === "network") {
      sandboxCommands.push(`docker ${args.join(" ")}`);
      if (args[1] === "create") networks.set(args.at(-1)!, new Set());
      if (args[1] === "rm") networks.delete(args[2]!);
      if (args[1] === "connect") networks.get(args.at(-2)!)?.add(args.at(-1)!);
      if (args[1] === "disconnect") networks.get(args.at(-2)!)?.delete(args.at(-1)!);
      return ok();
    }
    if (command === "docker" && args[0] === "exec") { sandboxCommands.push(`docker ${args.join(" ")}`); return ok(); }
    if (command === "/usr/bin/node" && args[0] === hotcellBin()) {
      const hotcell = args.slice(1);
      sandboxCommands.push(`hotcell ${hotcell.join(" ")}`);
      assert.equal(runOptions.env?.HOTCELL_API_KEY, "k".repeat(48), "the API key goes in the environment, never argv");
      if (hotcell[0] === "create") {
        const id = `c0ffee${String(++next).padStart(6, "0")}`;
        cells.set(id, { networks: hotcell[hotcell.indexOf("--network") + 1]!.split(","), workspace: hotcell[hotcell.indexOf("--workspace-dir") + 1]! });
        return ok(`${id}\n`);
      }
      if (hotcell[0] === "rm") cells.delete(hotcell[1]!);
      return ok();
    }
    return run(command, args, runOptions);
  };
  const lines: string[] = [];
  const prompter: Prompter = { choose: async () => "", select: async (_q, choices) => ({ value: choices[0]!.value }), secret: async () => "", text: async () => "" };
  const base: ModelCommandOptions = { system, ui: new PlainUi((line) => lines.push(line)), prompter, interactive: false,
    statePath: "/tmp/model.json", configPath: "/tmp/autopilot/config.json", delay: async () => {},
    fetch: async () => new Response("offline", { status: 503 }),
    smoke: async () => ({ chat: true, tools: true, json: true, tokensPerSecond: 20, at: "now" }),
    bench: async () => ({ levels: [{ concurrency: 1, requests: 1, ttftP50: 0.1, ttftP95: 0.1, decodeTokPerSec: 20 }] }) };
  const model = (action: string, args: string[], extra: Partial<ModelCommandOptions> = {}) => modelCommand(action, args, { ...base, ...extra });
  return { system, lines, networks, cells, sandboxCommands, model, roots: () => /HOTCELL_WORKSPACE_ROOTS=(.*)/.exec(system.files.get(PATHS.hotcellEnv)!.content)?.[1] };
}

test("up --workspace: the model exactly as without it, then the sandbox on the model's network, checked and saved", async () => {
  const plain = server();
  assert.equal(await plain.model("up", ["qwen-new"]), 0);
  const { system, lines, networks, cells, sandboxCommands, model, roots } = server();
  assert.equal(await model("up", ["qwen-new"], { workspace: WORKSPACE }), 0);
  assert.deepEqual(system.modelCommands.filter((command) => command.startsWith("run ")), plain.system.modelCommands.filter((command) => command.startsWith("run ")),
    "the model's docker run is byte for byte the one without --workspace");
  assert.doesNotMatch(system.modelCommands.join("\n"), /srv\/project/, "the model container never sees the workspace");
  const [id] = [...cells.keys()];
  assert.deepEqual(sandboxCommands, [
    "docker network create --internal -o com.docker.network.bridge.inhibit_ipv4=true --label hotcell.attachable=true --label dl.model.deployment=default dl-model-net",
    "docker network connect --alias model dl-model-net dl-model-1",
    `hotcell create --name dl-model-agent --image directionallylocal-cell:3.22.0 --driver container --workspace-dir ${WORKSPACE} --network dl-model-net --memory ${SANDBOX_LIMITS.memoryMb} --cpus 4 --pids 1024 --label dl.model.deployment=default --env XDG_CONFIG_HOME=/workspace/.dl/config,XDG_STATE_HOME=/workspace/.dl/state,XDG_DATA_HOME=/workspace/.dl/data,XDG_CACHE_HOME=/workspace/.dl/cache,AUTOPILOT_LAUNCHED_BY=dl`,
  ]);
  assert.deepEqual([...networks.get("dl-model-net")!], ["dl-model-1"]);
  assert.equal(roots(), WORKSPACE);
  assert.ok(system.ran.includes("systemctl restart hotcell.service"));
  const config = JSON.parse(system.files.get(sandboxConfigPath(WORKSPACE))!.content);
  const repo = recipe("qwen-new").repo;
  assert.deepEqual(config, { provider: "vllm", model: repo, providers: { vllm: { model: repo, baseUrl: "http://model:8000/v1" } } });
  assert.equal(system.files.get(`${WORKSPACE}/.dl/.gitignore`)!.content.split("\n").at(-2), "*");
  const saved = (await readDeployments(system, "/tmp/model.json")).default!;
  assert.deepEqual({ ...saved.sandbox!, createdAt: "" }, { id, container: `sbx-${id}`, workspace: WORKSPACE, networks: ["dl-model-net"], internet: false, image: "directionallylocal-cell:3.22.0", createdAt: "" });
  assert.match(lines.join(""), /Open the agent: dl model attach/);
  lines.length = 0;
  assert.equal(await model("list", []), 0);
  assert.match(lines.join(""), /ok default: qwen-new · vLLM · vllm\/vllm-openai:\S+ · GPUs .* · port 8000 · running · sandbox \/srv\/project \(no internet, running\)\n/);
});

test("update and rollback keep the sandbox on the serving model; down removes both and keeps the workspace", async () => {
  const { system, networks, cells, sandboxCommands, model, roots } = server();
  await model("up", ["qwen-new"], { workspace: WORKSPACE });
  sandboxCommands.length = 0;
  assert.equal(await model("update", ["qwen-old"]), 0);
  assert.deepEqual(sandboxCommands, [
    "docker network disconnect -f dl-model-net dl-model-1",
    "docker network disconnect -f dl-model-net dl-model-2",
    "docker network connect --alias model dl-model-net dl-model-2",
  ]);
  assert.deepEqual([...networks.get("dl-model-net")!], ["dl-model-2"]);
  let config = JSON.parse(system.files.get(sandboxConfigPath(WORKSPACE))!.content);
  assert.equal(config.providers.vllm.model, recipe("qwen-old").repo);
  assert.equal(config.providers.vllm.baseUrl, "http://model:8000/v1", "the same address after the update");
  assert.ok((await readDeployments(system, "/tmp/model.json")).default!.sandbox, "update keeps the sandbox in the state");
  assert.equal(await model("rollback", []), 0);
  assert.deepEqual([...networks.get("dl-model-net")!], ["dl-model-1"]);
  config = JSON.parse(system.files.get(sandboxConfigPath(WORKSPACE))!.content);
  assert.equal(config.providers.vllm.model, recipe("qwen-new").repo);

  sandboxCommands.length = 0;
  assert.equal(await model("down", []), 0);
  assert.equal(cells.size, 0);
  assert.equal(networks.size, 0);
  assert.equal(roots(), undefined, "Hotcell no longer allows the workspace");
  assert.deepEqual(await readDeployments(system, "/tmp/model.json"), {});
  assert.ok(system.modelCommands.includes("rm -f dl-model-1") && system.modelCommands.includes("rm -f dl-model-2"));
  assert.ok(system.files.has(sandboxConfigPath(WORKSPACE)), "down never deletes files in the workspace");
});

test("a sandbox that isn't isolated as planned is removed, and the model keeps serving", async () => {
  const { system, cells, networks, model, roots } = server({
    inspect: () => JSON.stringify({ Mounts: [{ Type: "volume", Source: "sbx-x-workspace", Destination: "/workspace" }], Networks: { bridge: {} }, DeviceRequests: null, Privileged: false }),
  });
  await assert.rejects(model("up", ["qwen-new"], { workspace: WORKSPACE }), (error: Error) => {
    assert.match(error.message, /isn't isolated as planned: \/workspace is volume/);
    assert.match(error.message, /The model is serving \(http:\/\/127\.0\.0\.1:8000\/v1\); dl model up --workspace \/srv\/project retries the sandbox/);
    return true;
  });
  assert.equal(cells.size, 0);
  assert.equal(networks.size, 0);
  assert.equal(roots(), undefined);
  const saved = (await readDeployments(system, "/tmp/model.json")).default!;
  assert.equal(saved.active.id, "qwen-new");
  assert.equal(saved.sandbox, undefined);
  assert.ok(system.running.has("dl-model-1"));
});

test("a failed check from inside the cell names what leaked; a retry on the serving model adds the sandbox", async () => {
  const leaky = server({ cellCheck: 15 });
  await assert.rejects(leaky.model("up", ["qwen-new"], { workspace: WORKSPACE }), /the internet answers from a sandbox that shouldn't reach it/);
  const { system, model, cells } = server();
  await model("up", ["qwen-new"]);
  assert.equal(await model("up", [], { workspace: WORKSPACE }), 0);
  assert.equal(cells.size, 1);
  assert.equal(system.modelCommands.filter((command) => command.startsWith("run ")).length, 1, "the model wasn't started again");
  await assert.rejects(model("up", [], { workspace: WORKSPACE }), /already has a sandbox on \/srv\/project; dl model down removes both/);
});

test("the sandbox's needs are checked before any model starts", async () => {
  const old = server({ hotcellVersion: "0.1.38" });
  await assert.rejects(old.model("up", ["qwen-new"], { workspace: WORKSPACE }), /Hotcell 0\.1\.38 can't mount one workspace .* needs Hotcell 0\.1\.39/);
  assert.equal(old.system.modelCommands.length, 0);
  const noServer = server();
  noServer.system.files.delete(PATHS.state);
  await assert.rejects(noServer.model("up", ["qwen-new"], { workspace: WORKSPACE }), /needs dl's server install: run sudo dl up first/);
  const notRoot = server();
  notRoot.system.files.delete(PATHS.hotcellEnv);
  await assert.rejects(notRoot.model("up", ["qwen-new"], { workspace: WORKSPACE }), /run dl model up --workspace as root/);
  await assert.rejects(server().model("up", ["qwen-new"], { workspace: "/home/me/code" }), /inside \/home/);
  await assert.rejects(server().model("update", ["qwen-old"], { workspace: WORKSPACE }), /--workspace goes with dl model up/);
  assert.equal(noServer.system.modelCommands.length + notRoot.system.modelCommands.length, 0);
});

test("dl model attach opens Autopilot in the cell, in /workspace, with the arguments after --", async () => {
  const { model, cells, sandboxCommands } = server();
  await model("up", ["qwen-new"], { workspace: WORKSPACE });
  const [id] = [...cells.keys()];
  sandboxCommands.length = 0;
  assert.equal(await model("attach", [], { attachArgs: ["-c"] }), 0);
  assert.deepEqual(sandboxCommands, [`docker exec -it -w /workspace sbx-${id} /opt/autopilot/node_modules/.bin/autopilot -c`]);
  await assert.rejects(server().model("attach", []), /No model is installed/);
});

test("the sandbox commands for a named deployment with internet", () => {
  const commands = sandboxCommands({ name: "big", workspace: WORKSPACE, internet: true, image: "img" }, "dl-model-big-1");
  assert.equal(commands.networks.length, 2);
  assert.ok(!commands.networks[1]!.includes("--internal"), "the egress network is an ordinary bridge");
  assert.deepEqual(commands.connect, ["network", "connect", "--alias", "model", "dl-model-big-net", "dl-model-big-1"]);
});

test("sudo dl up keeps the workspaces Hotcell allows", () => {
  assert.match(hotcellEnv({ apiKey: "k", bridgeIp: "172.17.0.1", workspaceRoots: "/srv/project" }), /\nHOTCELL_WORKSPACE_ROOTS=\/srv\/project\n/);
  assert.doesNotMatch(hotcellEnv({ apiKey: "k", bridgeIp: "172.17.0.1" }), /WORKSPACE_ROOTS/);
});
