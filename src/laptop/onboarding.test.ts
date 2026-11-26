import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import {
  firstTokens, firstTokensText, imageProtocol, servedFromMe, inlineImage, introBlock, mascotPng, MASCOT_COLS, MASCOT_ROWS, rockFrame, ROCK_FRAMES, weekFromMe, welcomeHandle, welcomeText,
} from "./onboarding.js";
import { isHeadless } from "./open-browser.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const KEY = { key: "dl_sk_0123456789abcdef", baseUrl: "https://api.dl.new" };

describe("the mascot beside the intro", () => {
  it("draws only in terminals that speak an inline image protocol", () => {
    assert.equal(imageProtocol({ TERM: "xterm-kitty" }, true), "kitty");
    assert.equal(imageProtocol({ TERM: "xterm-256color", KITTY_WINDOW_ID: "1" }, true), "kitty");
    assert.equal(imageProtocol({ TERM_PROGRAM: "ghostty" }, true), "kitty");
    assert.equal(imageProtocol({ TERM_PROGRAM: "iTerm.app" }, true), "iterm");
    assert.equal(imageProtocol({ TERM_PROGRAM: "WezTerm" }, true), "iterm");
    assert.equal(imageProtocol({ TERM_PROGRAM: "vscode" }, true), "iterm");
    for (const env of [{ TERM_PROGRAM: "Apple_Terminal" }, { TERM: "xterm-256color" }, { TERM_PROGRAM: "Hyper" }, {}]) {
      assert.equal(imageProtocol(env, true), undefined, JSON.stringify(env));
    }
  });

  it("never when not a terminal, inside tmux or screen, or with DL_NO_IMAGES=1", () => {
    assert.equal(imageProtocol({ TERM: "xterm-kitty" }, false), undefined);
    assert.equal(imageProtocol({ TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux-501/default,1,0" }, true), undefined);
    assert.equal(imageProtocol({ TERM: "screen-256color", KITTY_WINDOW_ID: "1" }, true), undefined);
    assert.equal(imageProtocol({ TERM: "tmux-256color", TERM_PROGRAM: "WezTerm" }, true), undefined);
    assert.equal(imageProtocol({ STY: "123.pts-0", TERM_PROGRAM: "ghostty" }, true), undefined);
    assert.equal(imageProtocol({ TERM: "xterm-kitty", DL_NO_IMAGES: "1" }, true), undefined);
    assert.equal(imageProtocol({ TERM: "xterm-kitty", DL_NO_IMAGES: "0" }, true), "kitty");
  });

  it("ships a small PNG of the mascot in the package", () => {
    const png = mascotPng();
    assert.ok(png, "readable from the package");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(png.length < 30 * 1024, `${png.length} bytes`);
    assert.equal(png.readUInt32BE(20), 160, "160 px tall");
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
    assert.ok(pkg.files.includes("assets/mascot.png"), "published with dl");
    assert.ok(statSync(new URL("../../assets/mascot.png", import.meta.url)).isFile());
  });

  it("speaks Kitty's protocol in chunks, and iTerm2's OSC 1337, without moving the cursor", () => {
    const png = Buffer.alloc(5000, 7);
    const kitty = inlineImage("kitty", png, 8, 4);
    const chunks = kitty.split("\x1b\\").filter(Boolean);
    assert.equal(chunks.length, Math.ceil(png.toString("base64").length / 4096));
    assert.match(chunks[0]!, /^\x1b_Ga=T,f=100,c=8,r=4,C=1,q=2,m=1;/);
    assert.match(chunks.at(-1)!, /^\x1b_Gm=0;/);
    const iterm = inlineImage("iterm", png, 8, 4);
    assert.ok(iterm.startsWith(`\x1b]1337;File=inline=1;size=5000;width=8;height=4;preserveAspectRatio=1;doNotMoveCursor=1:`));
    assert.ok(iterm.endsWith("\x07"));
  });

  it("puts the line beside the image and ends below it; text only without one (no ASCII art)", () => {
    const line = "dl gives your coding agent open models (DeepSeek, Kimi) on one flat plan.";
    assert.equal(introBlock(line), `\n  ${line}\n`);
    const block = introBlock(line, { protocol: "iterm", png: Buffer.from("x") });
    assert.ok(block.startsWith(`\n${"\n".repeat(MASCOT_ROWS)}\x1b[${MASCOT_ROWS}A\r\x1b7  \x1b]1337;`), "room first, so drawing never scrolls");
    assert.ok(block.includes(`\x1b8\x1b[1B\x1b[${MASCOT_COLS + 4}C${line}\x1b8\x1b[${MASCOT_ROWS}B\r`));
  });
});

describe("the sign-in's wait and welcome", () => {
  it("rocks through ◜◠◝◞◡◟ and back", () => {
    assert.deepEqual([...ROCK_FRAMES], ["◜", "◠", "◝", "◞", "◡", "◟"]);
    assert.deepEqual(Array.from({ length: 12 }, (_, i) => rockFrame(i)).join(""), "◜◠◝◞◡◟◡◞◝◠◜◠");
  });

  it("welcomes by GitHub login, else the email's local part", () => {
    assert.equal(welcomeText(welcomeHandle("sinameraji", "s@x.com")), "Welcome in, @sinameraji.");
    assert.equal(welcomeText(welcomeHandle(null, "sina.m@example.com")), "Welcome in, @sina.m.");
    assert.equal(welcomeText(welcomeHandle("acct with spaces", "nope")), "Welcome in.");
    assert.equal(welcomeText(welcomeHandle(undefined, "\x1b[31m@x.com")), "Welcome in.");
  });

  it("knows a headless box: SSH, or Linux with no display", () => {
    assert.equal(isHeadless({ SSH_CONNECTION: "a 1 b 22" }, "darwin"), true);
    assert.equal(isHeadless({ SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, "linux"), true);
    assert.equal(isHeadless({}, "linux"), true);
    assert.equal(isHeadless({ DISPLAY: ":0" }, "linux"), false);
    assert.equal(isHeadless({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), false);
    assert.equal(isHeadless({}, "darwin"), false);
    assert.equal(isHeadless({}, "win32"), false);
  });
});

describe("first tokens served", () => {
  it("reads the plan's week (real tokens at 95.5% caching) from /v1/me?week=1 on the dl key", async () => {
    const calls: Array<{ url: string; auth: string }> = [];
    const result = await firstTokens(KEY, {
      fetch: async (url, init) => (calls.push({ url, auth: (init.headers as Record<string, string>).authorization! }), json(200, { week: { tokensPerWeek: 10_000_000, usedAtMix: 4462, leftAtMix: 9_995_538 } })),
    });
    assert.deepEqual(calls, [{ url: "https://api.dl.new/v1/me?week=1", auth: `Bearer ${KEY.key}` }]);
    assert.deepEqual(result, { text: "First tokens served. ~9.9M left this week (95.5% caching applied).", done: true });
    assert.equal(firstTokensText(800_000), "First tokens served. ~800k left this week (95.5% caching applied).");
  });

  it("falls back to the DeepSeek pool when it has a cap", async () => {
    assert.deepEqual(weekFromMe({ pools: { deepseek: { realTokensPerWeek: 50_000_000, realUsedThisWeek: 1_000 } } }), { left: 49_999_000, used: 1_000 });
  });

  it("without a weekly figure (week null, no capped pool): the line without the amount left, once tokens were served", async () => {
    const old = (used: number) => ({
      week: null,
      allowance: { tokensPerWeek: null, usedThisWeek: used },
      budgets: { gpt6: { usdPerWeek: 2, spentUsd: 0, tokensThisWeek: 0 }, deepseek: { usdPerWeek: null, spentUsd: 0, tokensThisWeek: used * 3 } },
      pools: { deepseek: { tokensPerWeek: null, usedThisWeek: used, realTokensPerWeek: null, realUsedThisWeek: used * 3 } },
    });
    assert.equal(weekFromMe(old(10)), undefined);
    assert.equal(servedFromMe(old(10)), 30);
    assert.equal(servedFromMe({ week: null }), undefined);
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(200, old(10)) }), { text: "First tokens served.", done: true });
    assert.equal(firstTokensText(), "First tokens served.");
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(200, old(0)) }), { done: false }, "nothing served yet: next time");
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(200, { week: null }) }), { done: false }, "no counts at all: never marked without a line");
  });

  it("waits for real tokens, and skips silently on any error", async () => {
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(200, { week: { usedAtMix: 0, leftAtMix: 10_000_000 } }) }), { done: false }, "nothing served yet: next time");
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => { throw new Error("offline"); } }), { done: false });
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(503, {}) }), { done: false });
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(429, {}) }), { done: false });
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => json(403, { error: { code: "not_invited" } }) }), { done: true }, "no for good: never asked again");
    assert.deepEqual(await firstTokens(KEY, { fetch: async () => new Response("not json", { status: 200 }) }), { done: false });
  });
});
