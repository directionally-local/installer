import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseKeys, PromptCancelled, ScriptedPrompter, TtyPrompter, type PromptTerminal, type SelectOption } from "./prompt.js";

const PLACES: SelectOption[] = [
  { value: "local", label: "On this computer", detail: "start now · nothing to rent" },
  { value: "server", label: "On my own server", detail: "needs SSH access" },
];
const SERVERS: SelectOption[] = [
  { value: "0", label: "box", detail: "root@203.0.113.10" },
  { value: "another", label: "Another server", input: { prompt: "  Server address\n  › ", placeholder: "user@host[:port], e.g. root@203.0.113.10" } },
];
const QUESTION = "  Where\n  › ";

/** A terminal in a test: keys go in, what's drawn comes out. `raw: false` is a pipe or dumb terminal. */
function fakeTerminal(raw = true) {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  const rawModes: boolean[] = [];
  if (raw) {
    input.isTTY = true;
    input.setRawMode = (mode: boolean) => { rawModes.push(mode); return input; };
  }
  let written = "";
  const output = new Writable({ write(chunk, _encoding, done) { written += String(chunk); done(); } }) as Writable & { columns?: number };
  output.columns = 80;
  const terminal: PromptTerminal = { input, output, close: () => {} };
  const prompter = new TtyPrompter({ open: () => terminal, color: false, env: {} });
  return { prompter, input, rawModes, out: () => written, type: (keys: string) => input.write(keys) };
}

/** Replays what was written onto a virtual screen: the frame a user would see. */
function screen(output: string): string[] {
  const lines: string[] = [""];
  let row = 0;
  for (const match of output.matchAll(/\x1b\[\??(\d*)([A-Za-z])|\n|[^\x1b\n]+/g)) {
    const [token, count, code] = match;
    if (token === "\n") {
      row++;
      lines[row] ??= "";
    } else if (code === "F") {
      row = Math.max(0, row - Number(count || 1));
    } else if (code === "K") {
      lines[row] = "";
    } else if (code === "J") {
      lines.length = row + 1;
      lines[row] = "";
    } else if (!code) {
      lines[row] = (lines[row] ?? "") + token;
    }
  }
  return lines.map((line) => line.trimEnd()).filter((line, index, all) => line || index < all.length - 1);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await tick();
  assert.ok(check(), "timed out");
}

describe("select on a terminal", () => {
  it("draws an arrow-key list, moves with ↑/↓, and picks with Enter", async () => {
    const tty = fakeTerminal();
    const picked = tty.prompter.select(QUESTION, PLACES, 0);
    await tick();
    assert.deepEqual(screen(tty.out()), [
      "  Where  ↑/↓ to move · Enter to pick",
      "  › On this computer  start now · nothing to rent",
      "    On my own server  needs SSH access",
    ]);
    assert.ok(tty.out().startsWith("\x1b[?25l"), "the cursor is hidden while choosing");
    tty.type("\x1b[B");
    await tick();
    assert.deepEqual(screen(tty.out()).slice(1), ["    On this computer  start now · nothing to rent", "  › On my own server  needs SSH access"]);
    tty.type("\r");
    assert.deepEqual(await picked, { value: "server" });
    // What's left is what an answered prompt leaves, for ui.answered() to replace.
    assert.deepEqual(screen(tty.out()), ["  Where  ↑/↓ to move · Enter to pick", "  › On my own server"]);
    assert.deepEqual(tty.rawModes, [true, false]);
    assert.ok(tty.out().endsWith("\x1b[?25h"), "the cursor is back");
  });

  it("wraps around, takes j/k, and jumps to a typed number", async () => {
    const tty = fakeTerminal();
    const picked = tty.prompter.select(QUESTION, [...PLACES, { value: "third", label: "Third" }], 0);
    tty.type("\x1b[A"); // up from the first: the last
    await tick();
    assert.match(screen(tty.out())[3]!, /^ {2}› Third/);
    tty.type("j"); // down from the last: the first
    await tick();
    assert.match(screen(tty.out())[1]!, /^ {2}› On this computer/);
    tty.type("2");
    await tick();
    assert.match(screen(tty.out())[2]!, /^ {2}› On my own server/);
    tty.type("k\r");
    assert.deepEqual(await picked, { value: "local" });
  });

  it("starts on the preselected option", async () => {
    const tty = fakeTerminal();
    const picked = tty.prompter.select(QUESTION, PLACES, 1);
    await tick();
    assert.match(screen(tty.out())[2]!, /^ {2}› On my own server/);
    tty.type("\r");
    assert.deepEqual(await picked, { value: "server" });
  });

  for (const [name, key] of [["Esc", "\x1b"], ["Ctrl-C", "\x03"]] as const) {
    it(`cancels on ${name}, erasing itself and restoring the terminal`, async () => {
      const tty = fakeTerminal();
      const listeners = process.listenerCount("SIGINT");
      const picked = tty.prompter.select(QUESTION, PLACES, 0);
      await tick();
      assert.equal(process.listenerCount("SIGINT"), listeners + 1, "a stray SIGINT restores the terminal too");
      tty.type(key);
      await assert.rejects(picked, PromptCancelled);
      assert.deepEqual(screen(tty.out()), []);
      assert.deepEqual(tty.rawModes, [true, false]);
      assert.ok(tty.out().endsWith("\x1b[?25h"));
      assert.equal(process.listenerCount("SIGINT"), listeners, "no signal handler left behind");
    });
  }

  it("turns the last option into a text input, with Esc back to the list", async () => {
    const tty = fakeTerminal();
    const picked = tty.prompter.select("  Server\n  › ", SERVERS, 0);
    tty.type("2\r");
    await tick();
    assert.deepEqual(screen(tty.out()), [
      "  Server  ↑/↓ to move · Enter to pick",
      "  Another server · Esc to go back",
      "  › ▏user@host[:port], e.g. root@203.0.113.10",
    ]);
    tty.type("\r"); // nothing typed: stays
    tty.type("\x1b"); // back to the list
    await tick();
    assert.match(screen(tty.out())[2]!, /^ {2}› Another server/);
    tty.type("\rroot@203.0.113.99");
    tty.type("\x7f7:2222");
    await tick();
    assert.equal(screen(tty.out())[2], "  › root@203.0.113.97:2222▏");
    tty.type("\r");
    assert.deepEqual(await picked, { value: "another", text: "root@203.0.113.97:2222" });
    assert.deepEqual(screen(tty.out()), ["  Server  ↑/↓ to move · Enter to pick", "  › root@203.0.113.97:2222"]);
  });

  it("keeps each line within the terminal's width", async () => {
    const tty = fakeTerminal();
    const picked = tty.prompter.select(QUESTION, [{ value: "a", label: "A", detail: "x".repeat(200) }], 0);
    await tick();
    for (const line of screen(tty.out())) assert.ok(line.length < 80, line);
    tty.type("\r");
    await picked;
  });

  it("splits terminal input into keys", () => {
    assert.deepEqual(parseKeys("\x1b[A\x1bOBj\r"), ["up", "down", { text: "j" }, "enter"]);
    assert.deepEqual(parseKeys("ab\x7f\x15\x1b\x03"), [{ text: "ab" }, "backspace", "clear", "escape", "cancel"]);
  });
});

describe("select without a terminal that does raw mode", () => {
  it("falls back to the numbered prompt", async () => {
    const tty = fakeTerminal(false);
    const picked = tty.prompter.select(QUESTION, PLACES, 0);
    await waitFor(() => tty.out().includes("›"));
    assert.match(tty.out(), /1 {2}On this computer {3}start now · nothing to rent\n {2}2 {2}On my own server {3}needs SSH access/);
    assert.match(tty.out(), / {2}Where {2}1 or 2 · Enter for 1\n {2}› /);
    tty.type("2\n");
    assert.deepEqual(await picked, { value: "server" });
  });

  it("takes Enter for the preselected one, and an address typed straight in", async () => {
    const preselected = fakeTerminal(false);
    const first = preselected.prompter.select(QUESTION, PLACES, 1);
    await waitFor(() => preselected.out().includes("›"));
    assert.match(preselected.out(), /Enter for 2/);
    preselected.type("\n");
    assert.deepEqual(await first, { value: "server" });

    const typed = fakeTerminal(false);
    const server = typed.prompter.select("  Server\n  › ", SERVERS, 0);
    await waitFor(() => typed.out().includes("›"));
    assert.match(typed.out(), /1 or 2, or user@host\[:port\] · Enter for 1/);
    typed.type("root@203.0.113.10\n");
    assert.deepEqual(await server, { value: "another", text: "root@203.0.113.10" });
  });

  it("asks the input option's own prompt when it's picked by number", async () => {
    const tty = fakeTerminal(false);
    const picked = tty.prompter.select("  Server\n  › ", SERVERS, 0);
    await waitFor(() => tty.out().includes("›"));
    tty.type("2\n");
    await waitFor(() => tty.out().includes("Server address"));
    tty.type("me@host:2222\n");
    assert.deepEqual(await picked, { value: "another", text: "me@host:2222" });
  });
});

describe("ScriptedPrompter.select", () => {
  it("answers by number, value, label, or Enter for the preselected one", async () => {
    assert.deepEqual(await new ScriptedPrompter({ Where: "2" }).select("Where", PLACES), { value: "server" });
    assert.deepEqual(await new ScriptedPrompter({ Where: "local" }).select("Where", PLACES), { value: "local" });
    assert.deepEqual(await new ScriptedPrompter({ Where: "On my own server" }).select("Where", PLACES), { value: "server" });
    assert.deepEqual(await new ScriptedPrompter({ Where: "" }).select("Where", PLACES, 1), { value: "server" });
    await assert.rejects(new ScriptedPrompter({ Where: "9" }).select("Where", PLACES), /no option "9"/);
  });

  it("asks an input option's prompt, or takes the text directly", async () => {
    const prompter = new ScriptedPrompter({ "Server address": "me@host", Server: "2" });
    assert.deepEqual(await prompter.select("  Server\n  › ", SERVERS), { value: "another", text: "me@host" });
    assert.deepEqual(prompter.asked, ["  Server\n  › ", "  Server address\n  › "]);
    assert.deepEqual(await new ScriptedPrompter({ Server: "root@x" }).select("Server", SERVERS), { value: "another", text: "root@x" });
  });
});
