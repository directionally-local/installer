import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "./cli.js";
import { hotcellBin, hotcellEnv, PATHS } from "./layout.js";
import { recipe } from "./model-catalog.js";
import { modelCommand, type ModelCommandOptions } from "./model-command.js";
import { planCommand } from "./model-plan.js";
import {
  cellChecks, checkCellInspect, checkWorkspacePath, INSPECT_FORMAT, sandboxCommands, sandboxConfigPath, sandboxHomeDir, SANDBOX_LIMITS,
} from "./model-sandbox.js";
import type { Prompter } from "./prompt.js";
import { readDeployments } from "./state.js";
import type { RunOptions, RunResult } from "./system.js";
import { FIXTURES_DIR, fixtureDir, fixtureSystem } from "./test-support/gpu-fixtures.js";
import { PlainUi } from "./ui.js";

const WORKSPACE = "/srv/project";
const HOME = "/var/lib/directionallylocal/workspaces/default/home";
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

test("the plan's sandbox: the workspace and the agent's home, the internal network, no GPU, no gateway, nothing run", async () => {
  const { out } = await cli(...planArgs("--workspace", WORKSPACE));
  const create = out.slice(out.indexOf("hotcell create")).split("\n\nThen")[0]!.replace(/ \\\n {4}/g, " ");
  assert.equal(create.match(/--workspace-dir/g)?.length, 1);
  assert.match(create, /--workspace-dir \/srv\/project --home-dir \/var\/lib\/directionallylocal\/workspaces\/default\/home --user UID:GID --network dl-model-net --memory 8192 --cpus 4 --pids 1024/);
  assert.equal(create.match(/--home-dir/g)?.length, 1);
  assert.match(out, /\nUser {7}the owner of \/srv\/project, read at up \(uid:gid, e\.g\. 1000:1000\); root only when the owner is root\n/);
  assert.match(out, /\nHome {7}\/var\/lib\/directionallylocal\/workspaces\/default\/home → \/home\/agent, read-write/);
  assert.doesNotMatch(create, /--egress|--gpus|docker\.sock|--autopilot|--repo/);
  assert.match(out, /docker network create --internal -o com\.docker\.network\.bridge\.inhibit_ipv4=true/);
  assert.match(out, /docker network connect --alias model dl-model-net dl-model-1\n/);
  // The model's own docker run doesn't change and never names the workspace.
  const run = out.slice(out.indexOf("\nCommand\n"), out.indexOf("\nSandbox ("));
  assert.doesNotMatch(run, /srv\/project/);
  assert.match(run, /-p 127\.0\.0\.1:8000:8000/);
});

test("--plan on this machine reads the workspace's owner: the User line and --user follow it", async () => {
  for (const [owner, user, line] of [["1000:1000", "1000:1000", "1000:1000 (owner of /srv/project); root only when the owner is root"], ["0:0", undefined, "root (owner of /srv/project); root only when the owner is root"]] as const) {
    const system = fixtureSystem("rtx-pro-6000-4x-pcie");
    const probe = system.probe.bind(system);
    system.probe = async (command: string, args: string[]) => (command === "stat" && args[2] === WORKSPACE ? ok(`${owner}\n`) : probe(command, args));
    let out = "";
    assert.equal(await planCommand({ system, model: "deepseek-v4.1-flash-fp8", workspace: WORKSPACE, out: (text) => { out += text; }, statePath: "/tmp/model.json",
      fetch: async () => new Response("offline", { status: 503 }) }), 0);
    assert.match(out, new RegExp(`\nUser {7}${line.replace(/[()]/g, "\\$&")}\n`));
    const flat = out.replace(/ \\\n {4}/g, " ");
    if (user) {
      assert.match(flat, /--user 1000:1000 --network/);
      assert.match(out, /docker exec -it -u 1000:1000 -w \/workspace/);
    } else {
      assert.doesNotMatch(flat, /--user/);
      assert.match(out, /docker exec -it -w \/workspace/);
    }
    assert.deepEqual(system.commands, [], "the plan still runs nothing");
  }
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

test("docker inspect of the cell: only the workspace and the agent's home, the networks, no GPU, no socket, the owner", () => {
  const good = {
    Mounts: [
      { Type: "bind", Source: WORKSPACE, Destination: "/workspace", RW: true },
      { Type: "bind", Source: HOME, Destination: "/home/agent", RW: true },
      { Type: "bind", Source: "/opt/directionallylocal/current/node_modules/hotcell/agent/hotcell-agent-linux-arm64", Destination: "/hotcell-agent", RW: false },
      { Type: "bind", Source: "/var/lib/hotcell/container-agent/abc", Destination: "/run/hotcell", RW: true },
    ],
    Networks: { "dl-model-net": {} }, DeviceRequests: null, Privileged: false, User: "1000:1000",
  };
  const expected = { workspace: WORKSPACE, home: HOME, networks: ["dl-model-net"], user: "1000:1000" };
  assert.deepEqual(checkCellInspect(JSON.stringify(good), expected), []);
  assert.deepEqual(checkCellInspect(JSON.stringify({ ...good, User: "" }), { ...expected, user: undefined }), [], "root, as before");
  const broken = (change: Record<string, unknown>) => checkCellInspect(JSON.stringify({ ...good, ...change }), expected);
  assert.match(broken({ Mounts: [{ Type: "volume", Source: "sbx-x-workspace", Destination: "/workspace" }, good.Mounts[1]] }).join(), /\/workspace is volume/, "an old Hotcell ignoring --workspace-dir");
  assert.match(broken({ Mounts: [good.Mounts[0], good.Mounts[2]] }).join(), /\/home\/agent is not mounted/, "an old Hotcell ignoring --home-dir");
  assert.match(broken({ Mounts: [...good.Mounts, { Type: "bind", Source: "/root", Destination: "/host-root" }] }).join(), /unexpected mount \/root/);
  assert.match(broken({ Mounts: [...good.Mounts, { Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" }] }).join(), /Docker socket/);
  assert.match(broken({ Networks: { bridge: {} } }).join(), /networks are bridge/, "an old Hotcell ignoring --network");
  assert.match(broken({ DeviceRequests: [{ Driver: "nvidia" }] }).join(), /GPUs/);
  assert.match(broken({ Privileged: true }).join(), /privileged/);
  assert.match(broken({ User: "" }).join(), /runs as root, not 1000:1000/, "an old Hotcell ignoring --user");
});

test("the checks from inside the cell: the model answers; the owner; HOME; no socket, no GPU; no internet and no default route unless allowed", () => {
  const closed = cellChecks("http://model:8000/v1", false, "1000:1000");
  assert.match(closed, /fetch\('http:\/\/model:8000\/v1\/models'/);
  assert.match(closed, /test "\$\(id -u\):\$\(id -g\)" = "1000:1000" \|\| exit 17/);
  assert.match(closed, /test "\$HOME" = \/home\/agent && test -w \/home\/agent \|\| exit 18/);
  assert.match(closed, /touch \/workspace\/\.dl-owner-check \|\| exit 12/);
  assert.match(closed, /docker\.sock \|\| exit 13/);
  assert.match(closed, /\/dev\/nvidia\* .* \|\| exit 14/);
  assert.match(closed, /registry\.npmjs\.org.* \|\| exit 15/);
  assert.match(closed, /\/proc\/net\/route .* \|\| exit 16/);
  assert.match(cellChecks("http://model:8000/v1", false), /= "0:0" \|\| exit 17/);
  const open = cellChecks("http://model:8000/v1", true);
  assert.doesNotMatch(open, /exit 15|exit 16/);
});

interface ServerOptions {
  hotcellVersion?: string;
  inspect?: (container: string) => string;
  cellCheck?: number;
  /** Who owns the workspace (stat %u:%g); 1000:1000 by default. */
  owner?: string;
  /** dl 0.33.0 left a .dl in the workspace. */
  oldDotDl?: boolean;
  /** Makes a path appear in the workspace once a cell is created (something leaking into it). */
  leak?: string;
  /** git status --porcelain in the workspace, before and after a cell is created. */
  git?: [string, string];
}

/** A dl server with Hotcell 0.1.40 and the cell image, a 4x RTX PRO 6000 box, and a Hotcell that makes cells. */
function server(options: ServerOptions = {}) {
  const system = fixtureSystem("rtx-pro-6000-4x-pcie");
  const image = "directionallylocal-cell:3.22.0";
  system.files.set(PATHS.state, { content: JSON.stringify({ version: 1, installedAt: "", updatedAt: "", release: "", autopilotVersion: "3.22.0", hotcellVersion: options.hotcellVersion ?? "0.1.40", image, access: { mode: "loopback", url: "" } }), mode: 0o644 });
  system.files.set(PATHS.hotcellEnv, { content: hotcellEnv({ apiKey: "k".repeat(48), bridgeIp: "172.17.0.1" }), mode: 0o640 });
  system.files.set(hotcellBin(), { content: "", mode: 0o755 });
  system.images.add(image);
  const state = { owner: options.owner ?? "1000:1000" };
  const workspaceFiles = new Set(["README.md", "src", "src/main.ts", ...(options.oldDotDl ? [".dl", ".dl/config"] : [])]);
  /** Owner of each path dl made or handed over, as the fake sees it. */
  const owners = new Map<string, string>();
  const networks = new Map<string, Set<string>>();
  const cells = new Map<string, { networks: string[]; workspace: string; home: string; user: string | undefined }>();
  const sandboxCommands: string[] = [];
  let next = 0;
  const probe = system.probe.bind(system);
  const run = system.run.bind(system);
  const cellInspect = (container: string) => {
    const cell = [...cells.entries()].find(([id]) => `sbx-${id}` === container)?.[1];
    if (!cell) return "";
    return JSON.stringify({ Mounts: [{ Type: "bind", Source: cell.workspace, Destination: "/workspace", RW: true }, { Type: "bind", Source: cell.home, Destination: "/home/agent", RW: true },
      { Type: "bind", Source: "/opt/a/hotcell-agent", Destination: "/hotcell-agent", RW: false }],
    Networks: Object.fromEntries(cell.networks.map((name) => [name, {}])), DeviceRequests: null, Privileged: false, User: cell.user ?? "" });
  };
  /** setpriv --reuid U --regid G --clear-groups -- COMMAND…: what that command does, as U:G. */
  const setpriv = (args: string[], input?: string): RunResult => {
    const user = `${args[1]}:${args[3]}`;
    const command = args.slice(args.indexOf("--") + 1);
    switch (command[0]) {
      case "mkdir": for (const dir of command.slice(1).filter((arg) => arg.startsWith("/"))) { system.dirs.add(dir); owners.set(dir, user); } return ok();
      case "sh": system.files.set(command[4]!, { content: input ?? "", mode: parseInt(command[5]!, 8), owner: user }); return ok();
      case "cat": { const file = system.files.get(command[1]!); return file ? ok(file.content) : fail("No such file"); }
      case "rm": workspaceFiles.delete(command.at(-1)!.slice(WORKSPACE.length + 1)); return ok();
      case "env": return options.git ? ok(cells.size ? options.git[1] : options.git[0]) : fail("not a git repository");
      default: return fail(`setpriv: ${command[0]}`);
    }
  };
  system.probe = async (command: string, args: string[]) => {
    if (command === "realpath") return ok(`${args.at(-1)}\n`);
    if (command === "test" || command === "runuser") return ok();
    if (command === "stat" && args[1] === "%u:%g" && args[2] === WORKSPACE) return ok(`${state.owner}\n`);
    if (command === "stat" && args[1] === "%u:%g" && args[2] === `${WORKSPACE}/.dl-owner-check`) return workspaceFiles.has(".dl-owner-check") ? ok(`${state.owner === "0:0" ? "0:0" : state.owner}\n`) : fail();
    if (command === "stat" && args[1] === "%F") {
      if (args[2] === `${WORKSPACE}/.dl`) return workspaceFiles.has(".dl") ? ok("directory\n") : fail();
      return system.dirs.has(args[2]!) ? ok("directory\n") : fail();
    }
    if (command === "find" && args[0] === WORKSPACE) return ok([...workspaceFiles].map((path) => `${path}\n`).join(""));
    if (command === "setpriv") return setpriv(args);
    if (command === "docker" && args[0] === "image" && args[1] === "inspect") return system.images.has(args[2]!) ? ok("[]") : fail();
    if (command === "docker" && args[0] === "network" && args[1] === "inspect") return networks.has(args[2]!) ? ok("[]") : fail();
    if (command === "docker" && args[0] === "inspect" && args[2] === INSPECT_FORMAT) return ok((options.inspect ?? cellInspect)(args[3]!));
    if (command === "docker" && args[0] === "inspect" && args[2] === "{{json .Mounts}}") return ok('[{"Type":"volume","Name":"dl-model-hf-cache","Destination":"/root/.cache/huggingface"}]');
    if (command === "docker" && args[0] === "inspect" && args[1] === "--format" && args[2] === "{{.State.Running}}" && cells.has(args[3]!.replace(/^sbx-/, ""))) return ok("true\n");
    if (command === "docker" && args[0] === "exec") {
      sandboxCommands.push(`docker ${args.slice(0, args.indexOf("sh")).join(" ")} sh -c CHECKS`);
      // The checks touch the owner-check file, as the user the cell runs as.
      workspaceFiles.add(".dl-owner-check");
      return options.cellCheck ? { code: options.cellCheck, stdout: "", stderr: "" } : ok();
    }
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
    if (command === "setpriv") { sandboxCommands.push(`setpriv ${args.slice(0, 5).join(" ")} -- ${args.slice(6, 7).join(" ")}`); return setpriv(args, runOptions.input); }
    if (command === "chown") { sandboxCommands.push(`chown ${args.join(" ")}`); owners.set(args.at(-1)!, args.at(-2)!); return ok(); }
    if (command === "chmod" || command === "rmdir") { sandboxCommands.push(`${command} ${args.join(" ")}`); if (command === "rmdir") system.dirs.delete(args[0]!); return ok(); }
    if (command === "/usr/bin/node" && args[0] === hotcellBin()) {
      const hotcell = args.slice(1);
      sandboxCommands.push(`hotcell ${hotcell.join(" ")}`);
      assert.equal(runOptions.env?.HOTCELL_API_KEY, "k".repeat(48), "the API key goes in the environment, never argv");
      if (hotcell[0] === "create") {
        const id = `c0ffee${String(++next).padStart(6, "0")}`;
        const flag = (name: string) => (hotcell.includes(name) ? hotcell[hotcell.indexOf(name) + 1]! : undefined);
        cells.set(id, { networks: flag("--network")!.split(","), workspace: flag("--workspace-dir")!, home: flag("--home-dir")!, user: flag("--user") });
        if (options.leak) workspaceFiles.add(options.leak);
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
  const env = (key: string) => new RegExp(`${key}=(.*)`).exec(system.files.get(PATHS.hotcellEnv)!.content)?.[1];
  return { system, state, lines, networks, cells, owners, workspaceFiles, sandboxCommands, model, roots: () => env("HOTCELL_WORKSPACE_ROOTS"), homeRoots: () => env("HOTCELL_HOME_ROOTS") };
}

const ENV = "HOME=/home/agent,XDG_CONFIG_HOME=/home/agent/.config,XDG_STATE_HOME=/home/agent/.local/state,XDG_DATA_HOME=/home/agent/.local/share,XDG_CACHE_HOME=/home/agent/.cache,AUTOPILOT_LAUNCHED_BY=dl";
const SETPRIV_1000 = "setpriv --reuid 1000 --regid 1000 --clear-groups --";

test("up --workspace: the model as without it, then the sandbox as the workspace's owner, its home outside the workspace, checked and saved", async () => {
  const plain = server();
  assert.equal(await plain.model("up", ["qwen-new"]), 0);
  const { system, lines, networks, cells, owners, workspaceFiles, sandboxCommands, model, roots, homeRoots } = server();
  assert.equal(await model("up", ["qwen-new"], { workspace: WORKSPACE }), 0);
  assert.deepEqual(system.modelCommands.filter((command) => command.startsWith("run ")), plain.system.modelCommands.filter((command) => command.startsWith("run ")),
    "the model's docker run is byte for byte the one without --workspace");
  assert.doesNotMatch(system.modelCommands.join("\n"), /srv\/project/, "the model container never sees the workspace");
  const [id] = [...cells.keys()];
  assert.deepEqual(sandboxCommands, [
    "docker network create --internal -o com.docker.network.bridge.inhibit_ipv4=true --label hotcell.attachable=true --label dl.model.deployment=default dl-model-net",
    "docker network connect --alias model dl-model-net dl-model-1",
    `chown -R -h 1000:1000 ${HOME}`,
    `${SETPRIV_1000} mkdir`,
    `${SETPRIV_1000} sh`,
    `hotcell create --name dl-model-agent --image directionallylocal-cell:3.22.0 --driver container --workspace-dir ${WORKSPACE} --home-dir ${HOME} --user 1000:1000 --network dl-model-net --memory ${SANDBOX_LIMITS.memoryMb} --cpus 4 --pids 1024 --label dl.model.deployment=default --env ${ENV},USER=dl,LOGNAME=dl`,
    `docker exec -u 1000:1000 sbx-${id} sh -c CHECKS`,
    `${SETPRIV_1000} rm`,
  ]);
  assert.deepEqual(cells.get(id!), { networks: ["dl-model-net"], workspace: WORKSPACE, home: HOME, user: "1000:1000" });
  assert.deepEqual([...networks.get("dl-model-net")!], ["dl-model-1"]);
  assert.equal(roots(), WORKSPACE);
  assert.equal(homeRoots(), "/var/lib/directionallylocal/workspaces");
  assert.ok(system.ran.includes("systemctl restart hotcell.service"));
  // The home: made by dl as root, handed to the owner; its directories and the config made as the owner.
  assert.equal(owners.get(HOME), "1000:1000");
  for (const dir of [".config", ".config/autopilot", ".local/state", ".local/share", ".cache"]) assert.equal(owners.get(`${HOME}/${dir}`), "1000:1000", dir);
  const configFile = system.files.get(sandboxConfigPath(HOME))!;
  assert.equal(configFile.owner, "1000:1000");
  assert.equal(configFile.mode, 0o600);
  const repo = recipe("qwen-new").repo;
  assert.deepEqual(JSON.parse(configFile.content), { provider: "vllm", model: repo, providers: { vllm: { model: repo, baseUrl: "http://model:8000/v1" } } });
  // Nothing dl writes is in the workspace.
  assert.deepEqual([...workspaceFiles].sort(), ["README.md", "src", "src/main.ts"]);
  assert.ok(![...system.files.keys()].some((path) => path.startsWith(`${WORKSPACE}/`)), "no file written in the workspace");
  const saved = (await readDeployments(system, "/tmp/model.json")).default!;
  assert.deepEqual({ ...saved.sandbox!, createdAt: "" }, { id, container: `sbx-${id}`, workspace: WORKSPACE, home: HOME, networks: ["dl-model-net"], internet: false, image: "directionallylocal-cell:3.22.0", createdAt: "", user: "1000:1000" });
  assert.match(lines.join(""), /Open the agent: dl model attach/);
  assert.match(lines.join(""), /runs as 1000:1000/);
  assert.doesNotMatch(lines.join(""), /0\.33\.0/, "no note without an old .dl");
  lines.length = 0;
  assert.equal(await model("list", []), 0);
  assert.match(lines.join(""), /ok default: qwen-new · vLLM · vllm\/vllm-openai:\S+ · GPUs .* · port 8000 · running · sandbox \/srv\/project \(no internet, as 1000:1000, running\)\n/);
  lines.length = 0;
  await model("status", []);
  assert.match(lines.join(""), /Sandbox: \/srv\/project · runs as 1000:1000 · no internet · running · dl model attach/);
});

test("a workspace owned by root: the cell runs as root, as before; its home is root's", async () => {
  const { cells, owners, sandboxCommands, model, system } = server({ owner: "0:0" });
  assert.equal(await model("up", ["qwen-new"], { workspace: WORKSPACE }), 0);
  const [id] = [...cells.keys()];
  const create = sandboxCommands.find((command) => command.startsWith("hotcell create"))!;
  assert.doesNotMatch(create, /--user/);
  assert.match(create, /--home-dir \/var\/lib\/directionallylocal\/workspaces\/default\/home /);
  assert.match(create, new RegExp(`--env ${ENV}$`), "no USER or LOGNAME for root");
  assert.ok(sandboxCommands.includes(`docker exec sbx-${id} sh -c CHECKS`));
  assert.equal(owners.get(HOME), "0:0");
  assert.equal(system.files.get(sandboxConfigPath(HOME))!.owner, "0:0");
  const saved = (await readDeployments(system, "/tmp/model.json")).default!;
  assert.equal(saved.sandbox!.user, undefined);
  sandboxCommands.length = 0;
  assert.equal(await model("attach", []), 0);
  assert.deepEqual(sandboxCommands, [`docker exec -it -w /workspace sbx-${id} /opt/autopilot/node_modules/.bin/autopilot`]);
});

test("a .dl from dl 0.33.0 is left untouched and mentioned once", async () => {
  const { model, lines, workspaceFiles, sandboxCommands } = server({ oldDotDl: true });
  assert.equal(await model("up", ["qwen-new"], { workspace: WORKSPACE }), 0);
  assert.equal(lines.join("").match(/\/srv\/project\/\.dl is from dl 0\.33\.0/g)?.length, 1);
  assert.ok(workspaceFiles.has(".dl") && workspaceFiles.has(".dl/config"));
  assert.doesNotMatch(sandboxCommands.join("\n"), /srv\/project\/\.dl/, "dl runs nothing on it");
});

test("anything that appears in the workspace while the sandbox is made fails it, and the sandbox is undone", async () => {
  for (const options of [{ leak: ".dl" }, { git: ["", "?? notes.txt\n"] as [string, string] }]) {
    const { system, cells, networks, model, roots } = server(options);
    await assert.rejects(model("up", ["qwen-new"], { workspace: WORKSPACE }), (error: Error) => {
      assert.match(error.message, /making the sandbox changed \/srv\/project \((\.dl|git: \?\? notes\.txt)\)/);
      return true;
    });
    assert.equal(cells.size, 0);
    assert.equal(networks.size, 0);
    assert.equal(roots(), undefined);
    assert.ok(!system.dirs.has(HOME), "the new home is removed too");
    assert.ok(system.running.has("dl-model-1"), "the model keeps serving");
  }
  // A repository whose status is unchanged passes.
  const same = server({ git: [" M src/main.ts\n", " M src/main.ts\n"] });
  assert.equal(await same.model("up", ["qwen-new"], { workspace: WORKSPACE }), 0);
});

test("the owner-check file must belong to the workspace's owner on the host", async () => {
  const wrong = server();
  const probe = wrong.system.probe.bind(wrong.system);
  wrong.system.probe = async (command: string, args: string[]) => (command === "stat" && String(args[2]).endsWith(".dl-owner-check") ? ok("0:0\n") : probe(command, args));
  await assert.rejects(wrong.model("up", ["qwen-new"], { workspace: WORKSPACE }), /a file the agent wrote in \/srv\/project belongs to 0:0 on the host, not 1000:1000/);
  assert.equal(wrong.cells.size, 0);
});

test("update and rollback keep the sandbox and its user; down removes the cell, its home and networks, and keeps the workspace", async () => {
  const { system, networks, cells, sandboxCommands, model, roots, homeRoots } = server();
  await model("up", ["qwen-new"], { workspace: WORKSPACE });
  const [id] = [...cells.keys()];
  sandboxCommands.length = 0;
  assert.equal(await model("update", ["qwen-old"]), 0);
  assert.deepEqual(sandboxCommands, [
    "docker network disconnect -f dl-model-net dl-model-1",
    "docker network disconnect -f dl-model-net dl-model-2",
    "docker network connect --alias model dl-model-net dl-model-2",
    `${SETPRIV_1000} sh`,
  ]);
  assert.deepEqual([...networks.get("dl-model-net")!], ["dl-model-2"]);
  let config = JSON.parse(system.files.get(sandboxConfigPath(HOME))!.content);
  assert.equal(config.providers.vllm.model, recipe("qwen-old").repo);
  assert.equal(config.providers.vllm.baseUrl, "http://model:8000/v1", "the same address after the update");
  assert.equal(system.files.get(sandboxConfigPath(HOME))!.owner, "1000:1000");
  assert.equal((await readDeployments(system, "/tmp/model.json")).default!.sandbox!.id, id, "the same cell");
  assert.equal(await model("rollback", []), 0);
  assert.deepEqual([...networks.get("dl-model-net")!], ["dl-model-1"]);
  config = JSON.parse(system.files.get(sandboxConfigPath(HOME))!.content);
  assert.equal(config.providers.vllm.model, recipe("qwen-new").repo);

  sandboxCommands.length = 0;
  assert.equal(await model("down", []), 0);
  assert.equal(cells.size, 0);
  assert.equal(networks.size, 0);
  assert.equal(roots(), undefined, "Hotcell no longer allows the workspace");
  assert.equal(homeRoots(), "/var/lib/directionallylocal/workspaces", "the homes root stays allowed (only dl's homes are in it)");
  assert.ok(!system.dirs.has(HOME) && !system.files.has(sandboxConfigPath(HOME)), "down deletes the agent's home");
  assert.ok(sandboxCommands.includes("rmdir /var/lib/directionallylocal/workspaces/default"));
  assert.deepEqual(await readDeployments(system, "/tmp/model.json"), {});
  assert.ok(system.modelCommands.includes("rm -f dl-model-1") && system.modelCommands.includes("rm -f dl-model-2"));
});

test("an update after the workspace changed owner makes the cell again as the new owner, and says so", async () => {
  const { system, state, cells, lines, owners, sandboxCommands, model } = server();
  await model("up", ["qwen-new"], { workspace: WORKSPACE });
  const [first] = [...cells.keys()];
  state.owner = "1001:1002";
  lines.length = 0;
  sandboxCommands.length = 0;
  assert.equal(await model("update", ["qwen-old"]), 0);
  assert.match(lines.join(""), /\/srv\/project now belongs to 1001:1002 \(was 1000:1000\): the sandbox is made again to run as 1001:1002/);
  assert.ok(sandboxCommands.includes(`hotcell rm ${first}`));
  assert.match(sandboxCommands.find((command) => command.startsWith("hotcell create"))!, /--user 1001:1002 /);
  assert.equal(owners.get(HOME), "1001:1002", "the home is handed to the new owner");
  assert.equal(system.files.get(sandboxConfigPath(HOME))!.owner, "1001:1002");
  const saved = (await readDeployments(system, "/tmp/model.json")).default!;
  assert.equal(saved.sandbox!.user, "1001:1002");
  assert.notEqual(saved.sandbox!.id, first);
  assert.equal(cells.size, 1);
  assert.match(lines.join(""), /now on qwen-old · runs as 1001:1002/);
});

test("a dl 0.33.0 sandbox (config in the workspace) is made again with its home outside on update", async () => {
  const { system, cells, lines, model, workspaceFiles } = server({ oldDotDl: true });
  await model("up", ["qwen-new"], { workspace: WORKSPACE });
  const saved = (await readDeployments(system, "/tmp/model.json")).default!;
  const { home: _home, user: _user, ...old } = saved.sandbox!;
  system.files.set("/tmp/model.json", { content: JSON.stringify({ version: 1, ...saved, sandbox: old }), mode: 0o600 });
  lines.length = 0;
  assert.equal(await model("update", ["qwen-old"]), 0);
  assert.match(lines.join(""), /made again with its home in \/var\/lib\/directionallylocal\/workspaces\/default\/home; \/srv\/project\/\.dl from dl 0\.33\.0 is left untouched/);
  const now = (await readDeployments(system, "/tmp/model.json")).default!.sandbox!;
  assert.equal(now.home, HOME);
  assert.equal(now.user, "1000:1000");
  assert.equal(cells.size, 1);
  assert.ok(workspaceFiles.has(".dl/config"), "the old .dl is untouched");
});

test("a sandbox that isn't isolated as planned is removed, and the model keeps serving", async () => {
  const { system, cells, networks, model, roots } = server({
    inspect: () => JSON.stringify({ Mounts: [{ Type: "volume", Source: "sbx-x-workspace", Destination: "/workspace" }], Networks: { bridge: {} }, DeviceRequests: null, Privileged: false }),
  });
  await assert.rejects(model("up", ["qwen-new"], { workspace: WORKSPACE }), (error: Error) => {
    assert.match(error.message, /isn't isolated as planned: \/workspace is volume/);
    assert.match(error.message, /\/home\/agent is not mounted/);
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
  assert.ok(!leaky.workspaceFiles.has(".dl-owner-check"), "the owner-check file is removed even when a check fails");
  const wrongUser = server({ cellCheck: 17 });
  await assert.rejects(wrongUser.model("up", ["qwen-new"], { workspace: WORKSPACE }), /doesn't run as the workspace's owner/);
  const { system, model, cells } = server();
  await model("up", ["qwen-new"]);
  assert.equal(await model("up", [], { workspace: WORKSPACE }), 0);
  assert.equal(cells.size, 1);
  assert.equal(system.modelCommands.filter((command) => command.startsWith("run ")).length, 1, "the model wasn't started again");
  await assert.rejects(model("up", [], { workspace: WORKSPACE }), /already has a sandbox on \/srv\/project; dl model down removes both/);
});

test("the sandbox's needs are checked before any model starts; an older Hotcell is refused, never run as root", async () => {
  for (const version of ["0.1.38", "0.1.39"]) {
    const old = server({ hotcellVersion: version });
    await assert.rejects(old.model("up", ["qwen-new"], { workspace: WORKSPACE }), new RegExp(`Hotcell ${version.replace(/\./g, "\\.")} can't run the agent as the workspace's owner .* needs Hotcell 0\\.1\\.40 .* never falls back to running the agent as root`));
    assert.equal(old.system.modelCommands.length, 0);
    assert.equal(old.cells.size, 0);
  }
  const noServer = server();
  noServer.system.files.delete(PATHS.state);
  await assert.rejects(noServer.model("up", ["qwen-new"], { workspace: WORKSPACE }), /needs dl's server install: run sudo dl up first/);
  const notRoot = server();
  notRoot.system.files.delete(PATHS.hotcellEnv);
  await assert.rejects(notRoot.model("up", ["qwen-new"], { workspace: WORKSPACE }), /run dl model up --workspace as root/);
  await assert.rejects(server().model("up", ["qwen-new"], { workspace: "/home/me/code" }), /inside \/home/);
  await assert.rejects(server().model("up", ["qwen-new"], { workspace: "/var/lib/directionallylocal/workspaces" }), /inside \/var\/lib\/directionallylocal/);
  await assert.rejects(server().model("update", ["qwen-old"], { workspace: WORKSPACE }), /--workspace goes with dl model up/);
  assert.equal(noServer.system.modelCommands.length + notRoot.system.modelCommands.length, 0);
});

test("dl model attach opens Autopilot in the cell, in /workspace, as the owner, with the arguments after --", async () => {
  const { model, cells, sandboxCommands } = server();
  await model("up", ["qwen-new"], { workspace: WORKSPACE });
  const [id] = [...cells.keys()];
  sandboxCommands.length = 0;
  assert.equal(await model("attach", [], { attachArgs: ["-c"] }), 0);
  assert.deepEqual(sandboxCommands, [`docker exec -it -u 1000:1000 -w /workspace sbx-${id} /opt/autopilot/node_modules/.bin/autopilot -c`]);
  await assert.rejects(server().model("attach", []), /No model is installed/);
});

test("the sandbox commands for a named deployment with internet; its own home", () => {
  const commands = sandboxCommands({ name: "big", workspace: WORKSPACE, internet: true, image: "img", user: "1000:1000" }, "dl-model-big-1");
  assert.equal(commands.networks.length, 2);
  assert.ok(!commands.networks[1]!.includes("--internal"), "the egress network is an ordinary bridge");
  assert.deepEqual(commands.connect, ["network", "connect", "--alias", "model", "dl-model-big-net", "dl-model-big-1"]);
  assert.equal(commands.create[commands.create.indexOf("--home-dir") + 1], "/var/lib/directionallylocal/workspaces/big/home");
  assert.equal(sandboxHomeDir("big"), "/var/lib/directionallylocal/workspaces/big/home");
});

test("sudo dl up keeps the workspaces and the homes root Hotcell allows", () => {
  assert.match(hotcellEnv({ apiKey: "k", bridgeIp: "172.17.0.1", workspaceRoots: "/srv/project", homeRoots: "/var/lib/directionallylocal/workspaces" }),
    /\nHOTCELL_WORKSPACE_ROOTS=\/srv\/project\nHOTCELL_HOME_ROOTS=\/var\/lib\/directionallylocal\/workspaces\n/);
  assert.doesNotMatch(hotcellEnv({ apiKey: "k", bridgeIp: "172.17.0.1" }), /WORKSPACE_ROOTS|HOME_ROOTS/);
});
