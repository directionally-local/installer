import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CSP, escapeHtml, page } from "../src/html.js";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    assert.equal(escapeHtml(`<script>alert("x") & 'y'</script>`), "&lt;script&gt;alert(&quot;x&quot;) &amp; &#39;y&#39;&lt;/script&gt;");
  });

  it("stringifies non-strings", () => {
    assert.equal(escapeHtml(42), "42");
    assert.equal(escapeHtml(null), "null");
  });
});

describe("page", () => {
  it("sets the CSP and never caches", async () => {
    const response = page({ title: "Approvals", body: "<h1>Hi</h1>" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-security-policy"), DEFAULT_CSP);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });

  it("escapes the title but trusts the body", async () => {
    const html = await page({ title: "<b>", body: "<h1>Hi</h1>" }).text();
    assert.match(html, /<title>&lt;b&gt;<\/title>/);
    assert.match(html, /<h1>Hi<\/h1>/);
  });

  it("keeps the CSP free of scripts and frames", () => {
    assert.match(DEFAULT_CSP, /default-src 'none'/);
    assert.match(DEFAULT_CSP, /frame-ancestors 'none'/);
    assert.doesNotMatch(DEFAULT_CSP, /script-src/);
  });
});
