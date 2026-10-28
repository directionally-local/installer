import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PlainUi, TerminalUi } from "./ui.js";

/** Replays what TerminalUi wrote onto a virtual screen: the frame a user would see. */
function screen(output: string): string[] {
  const lines: string[] = [""];
  let row = 0;
  const pattern = /\x1b\[(\d*)([A-Za-z])|\n|[^\x1b\n]+/g;
  for (const match of output.matchAll(pattern)) {
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
    } else if (code === "m") {
      // colors don't change the text
    } else if (!code) {
      lines[row] = (lines[row] ?? "") + token;
    }
  }
  return lines.map((line) => line.trimEnd()).filter((line, index, all) => line || index < all.length - 1);
}

function terminal(columns = 80) {
  let out = "";
  const ui = new TerminalUi((text) => { out += text; }, () => columns, false);
  return { ui, frame: () => screen(out), raw: () => out };
}

describe("terminal UI", () => {
  it("redraws one checklist in place, then leaves the summary to copy", () => {
    const { ui, frame } = terminal();
    ui.title("Directionally Local");
    ui.line("done", "Checked this machine", "Ubuntu 24.04 · 4 CPU · 7.5 GB");
    ui.plan([{ id: "docker", label: "Setting up Docker" }, { id: "image", label: "Building the sandbox image" }]);
    ui.start("docker");
    assert.ok(frame().some((line) => /^  ⠋ Setting up Docker\s+0:00$/.test(line)), frame().join("\n"));
    assert.ok(frame().includes("  ○ Building the sandbox image"));
    ui.done("docker", "already running");
    ui.start("image");
    ui.done("image", "already built");
    ui.ready("Ready · fits ~6 agents at once (estimate)", [
      { label: "On your laptop", value: "autopilot remote add https://box.tail1234.ts.net" },
    ]);
    const shown = frame();
    // Each step appears exactly once: redraws replaced lines rather than adding new ones.
    assert.equal(shown.filter((line) => line.includes("Setting up Docker")).length, 1);
    assert.match(shown.find((line) => line.includes("Setting up Docker"))!, /^  ✓ Setting up Docker\s+already running$/);
    assert.ok(shown.includes("  ✓ Ready · fits ~6 agents at once (estimate)"));
    assert.ok(shown.includes("     autopilot remote add https://box.tail1234.ts.net"), "the command is shown whole, ready to copy");
  });

  it("never wraps a line, so redraws stay aligned on narrow terminals", () => {
    const { ui, frame } = terminal(40);
    ui.plan([{ id: "a", label: "Installing Hotcell + Autopilot" }]);
    ui.done("a", "Autopilot 2.4.4 · Hotcell 0.1.30 · a long detail");
    for (const line of frame()) assert.ok(line.length <= 39, `${line.length}: ${line}`);
    assert.ok(frame()[0]!.endsWith("…"));
  });

  it("replaces a prompt with its confirmation, and marks a failed step", () => {
    const { ui, frame } = terminal();
    ui.questions("2 keys, then it runs on its own.");
    const prompt = ui.prompt("GitHub token", "fine-grained");
    assert.equal(prompt.split("\n").length, 2, "a label line and an input line");
    ui.answered("GitHub token", "signed in as octo");
    assert.ok(frame().some((line) => /^  ✓ GitHub token\s+signed in as octo$/.test(line)));
    ui.plan([{ id: "x", label: "Building the sandbox image" }]);
    ui.fail("x", "Cannot connect to the Docker daemon\nmore detail");
    assert.ok(frame().some((line) => /^  ✗ Building the sandbox image\s+Cannot connect to the Docker daemon$/.test(line)));
  });

  it("uses no escape codes for color when color is off", () => {
    const { ui, raw } = terminal();
    ui.line("done", "Checked this machine");
    assert.doesNotMatch(raw(), /\x1b\[\d+m/);
  });
});

describe("plain UI", () => {
  it("writes one readable line per event for logs and unattended installs", () => {
    let out = "";
    const ui = new PlainUi((text) => { out += text; });
    ui.plan([{ id: "docker", label: "Setting up Docker" }]);
    ui.start("docker");
    ui.done("docker", "already running");
    ui.ready("Ready", [{ label: "On your laptop", value: "autopilot remote add https://x" }]);
    assert.equal(out, ".. Setting up Docker\nok Setting up Docker: already running\n\nReady\n  On your laptop: autopilot remote add https://x\n");
    assert.doesNotMatch(out, /\x1b/);
  });
});
