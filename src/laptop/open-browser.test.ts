import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { browserCommand, openBrowser, webUrl } from "./open-browser.js";

describe("browser opener", () => {
  it("accepts only absolute http(s) URLs", () => {
    assert.equal(webUrl("https://example.com/device?code=AB-CD"), "https://example.com/device?code=AB-CD");
    assert.equal(webUrl("http://127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "ms-settings:", "calc.exe", "/relative", "", "https://", "\\\\host\\share"]) {
      assert.equal(webUrl(bad), undefined, bad);
    }
    assert.equal(webUrl(undefined), undefined);
    assert.equal(webUrl(42), undefined);
  });

  it("canonicalises what it accepts, so spaces and quotes can't ride along unescaped", () => {
    const href = webUrl("https://example.com/a b\"<x>");
    assert.ok(href);
    assert.doesNotMatch(href, /[ "<>]/);
  });

  it("opens on Windows without cmd.exe", () => {
    const [cmd, args] = browserCommand("https://example.com/?a=1&b=2", "win32");
    assert.equal(cmd, "rundll32");
    assert.deepEqual(args, ["url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"]);
    assert.deepEqual(browserCommand("https://e.com/", "darwin"), ["open", ["https://e.com/"]]);
    assert.deepEqual(browserCommand("https://e.com/", "linux"), ["xdg-open", ["https://e.com/"]]);
  });

  it("refuses a non-web URL before spawning anything", () => {
    const saved = { dl: process.env.DL_NO_BROWSER, browser: process.env.BROWSER };
    delete process.env.DL_NO_BROWSER;
    delete process.env.BROWSER;
    try {
      assert.equal(openBrowser("file:///etc/passwd"), false);
      assert.equal(openBrowser("not a url & calc"), false);
    } finally {
      if (saved.dl !== undefined) process.env.DL_NO_BROWSER = saved.dl;
      if (saved.browser !== undefined) process.env.BROWSER = saved.browser;
    }
  });
});
