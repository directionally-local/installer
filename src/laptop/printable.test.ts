import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hasControl, oneLine, printable } from "./printable.js";

describe("printable text", () => {
  it("removes C0, DEL, C1 and bidi controls but keeps tabs and line breaks", () => {
    assert.equal(printable("ok\x1b]2;pwned\x07 \x1b[31mred\x9b0m\x7f\nnext\tcol\r"), "ok]2;pwned [31mred0m\nnext\tcol");
    assert.equal(printable("abc‮def⁦"), "abcdef");
    assert.equal(printable("plain — ünïcode ✓"), "plain — ünïcode ✓");
  });

  it("makes one line, cut with an ellipsis", () => {
    assert.equal(oneLine("a\x1b[2J\r\nb   c"), "a [2J b c");
    assert.equal(oneLine("abcdefgh", 5), "abcd…");
    assert.equal(oneLine("abc", 5), "abc");
  });

  it("detects control characters", () => {
    assert.equal(hasControl("https://dl.new/account"), false);
    assert.equal(hasControl("https://dl.new/\x1b[0m"), true);
    assert.equal(hasControl("a\nb"), true);
  });
});
