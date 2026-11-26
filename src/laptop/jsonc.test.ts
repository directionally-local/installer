import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { JsoncError, parseJsonc, readMember, removeMember, setMember } from "./jsonc.js";

const ZED = `// Zed settings
//
// For information on how to configure Zed, see the Zed
// documentation: https://zed.dev/docs/configuring-zed
{
  "theme": "One Dark", // the dark one
  /* fonts */
  "buffer_font_size": 15,
  "agent_servers": {
    "My Agent": {
      "type": "custom",
      "command": "node",
      "args": ["~/agent/index.js", "--acp"],
    },
  },
  "languages": { "Rust": { "tab_size": 4 } },
}
`;

const entry = { type: "custom", command: "/usr/bin/node", args: ["/opt/dl/bin/directionallylocal.mjs", "acp"] };

const parse = (text: string) => parseJsonc(text) as Record<string, unknown>;

describe("jsonc edits", () => {
  it("adds an entry next to existing agents, keeping comments, order and the other settings", () => {
    const next = setMember(ZED, "agent_servers", "Autopilot by dl.new", entry);
    assert.ok(next.startsWith("// Zed settings\n//\n// For information"));
    assert.ok(next.includes(`"theme": "One Dark", // the dark one`));
    assert.ok(next.includes("/* fonts */"));
    const parsed = parse(next);
    assert.deepEqual(Object.keys(parsed), ["theme", "buffer_font_size", "agent_servers", "languages"]);
    const servers = parsed.agent_servers as Record<string, unknown>;
    assert.deepEqual(servers["Autopilot by dl.new"], entry);
    assert.deepEqual(servers["My Agent"], { type: "custom", command: "node", args: ["~/agent/index.js", "--acp"] });
    assert.deepEqual(readMember(next, "agent_servers", "Autopilot by dl.new"), entry);
  });

  it("adds agent_servers when there is none, and writes a new file when there is nothing", () => {
    const next = setMember(`{\n  "theme": "Ayu"\n}\n`, "agent_servers", "dl", entry);
    assert.deepEqual(parse(next), { agent_servers: { dl: entry }, theme: "Ayu" });
    assert.deepEqual(parse(setMember("", "agent_servers", "dl", entry)), { agent_servers: { dl: entry } });
    assert.deepEqual(parse(setMember("{}", "agent_servers", "dl", entry)), { agent_servers: { dl: entry } });
    assert.deepEqual(parse(setMember(`{ "agent_servers": {} }`, "agent_servers", "dl", entry)), { agent_servers: { dl: entry } });
  });

  it("replaces its own entry in place (a second run updates the paths)", () => {
    const once = setMember(ZED, "agent_servers", "dl", entry);
    const moved = { ...entry, command: "/new/node" };
    const twice = setMember(once, "agent_servers", "dl", moved);
    assert.deepEqual((parse(twice).agent_servers as Record<string, unknown>).dl, moved);
    assert.equal(twice.split('"dl"').length, 2, "one entry, not two");
  });

  it("removes only its entry, leaving valid settings, whether it's first, last or alone", () => {
    const added = setMember(ZED, "agent_servers", "dl", entry);
    const removed = removeMember(added, "agent_servers", "dl");
    assert.deepEqual(parse(removed), parse(ZED));
    const last = `{\n  "agent_servers": {\n    "a": { "command": "x" },\n    "dl": { "command": "y" }\n  }\n}\n`;
    assert.deepEqual(parse(removeMember(last, "agent_servers", "dl")), { agent_servers: { a: { command: "x" } } });
    const alone = `{\n  "agent_servers": {\n    "dl": { "command": "y" }\n  }\n}\n`;
    assert.deepEqual(parse(removeMember(alone, "agent_servers", "dl")), { agent_servers: {} });
    assert.equal(removeMember(ZED, "agent_servers", "dl"), ZED, "nothing to remove: unchanged");
  });

  it("refuses a file it can't read rather than rewriting it", () => {
    assert.throws(() => setMember(`{ "theme": "One Dark" `, "agent_servers", "dl", entry), JsoncError);
    assert.throws(() => setMember(`{ "agent_servers": [] }`, "agent_servers", "dl", entry), JsoncError);
    assert.throws(() => setMember(`{ /* open comment `, "agent_servers", "dl", entry), JsoncError);
  });

  it("isn't fooled by braces, slashes and quotes inside strings", () => {
    const tricky = `{\n  "url": "https://x.dev/a//b/*c*/",\n  "q": "say \\"}\\" here"\n}\n`;
    const next = setMember(tricky, "agent_servers", "dl", entry);
    assert.deepEqual(parse(next).url, "https://x.dev/a//b/*c*/");
    assert.deepEqual(parse(next).q, 'say "}" here');
  });
});
