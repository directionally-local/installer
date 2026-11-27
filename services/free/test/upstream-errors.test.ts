import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GENERIC, upstreamRefusal } from "../src/upstream-errors.js";

/** A provider's refusal is never passed on verbatim (#389): dl's own message, at most an identifier. */
describe("upstreamRefusal", () => {
  const body = (error: unknown) => JSON.stringify({ error });

  it("maps known failures to dl's own messages", () => {
    assert.match(upstreamRefusal(body({ message: "This model's maximum context length is 131072 tokens. However, you requested 200000 tokens." })).message, /context window/);
    assert.match(upstreamRefusal(body({ code: "context_length_exceeded", message: "x" })).message, /context window/);
    assert.match(upstreamRefusal(body({ message: "max_tokens must be at most 8192" })).message, /max_tokens/);
    assert.match(upstreamRefusal(body({ message: "Your request was flagged by our content policy: 'quoted prompt'" })).message, /content policy/);
    assert.match(upstreamRefusal(body({ message: "Invalid image_url in messages[2]" })).message, /image or file/);
    assert.match(upstreamRefusal(body({ message: "Invalid schema for function 'x': ..." })).message, /tools or tool calls/);
    assert.equal(upstreamRefusal(body({ message: "see the function documentation" })).message, GENERIC, "a bare 'function' isn't a tool mapping");
    assert.match(upstreamRefusal(body({ message: "tools[0].function.parameters is not valid JSON schema" })).message, /tools or tool calls/);
  });

  it("never includes the provider's text, and gives a generic message for anything unknown", () => {
    const leaked = "Organization org-abc123 is not allowed. Your prompt: 'my secret plan'";
    const out = upstreamRefusal(body({ message: leaked, type: "invalid_request_error" }));
    assert.equal(out.message, GENERIC);
    assert.equal(out.reason, "invalid_request_error");
    assert.ok(!JSON.stringify(out).includes("org-abc123") && !JSON.stringify(out).includes("secret"));
  });

  it("passes a code or type only when it's a plain identifier", () => {
    assert.equal(upstreamRefusal(body({ code: "bad_request", message: "x" })).reason, "bad_request");
    assert.equal(upstreamRefusal(body({ code: 400, message: "x" })).reason, "400");
    assert.equal(upstreamRefusal(body({ code: "has spaces and 'quotes'", type: "invalid_request_error" })).reason, "invalid_request_error");
    assert.equal(upstreamRefusal(body({ code: "a\u0000b\nc" })).reason, undefined, "control characters: nothing");
    assert.equal(upstreamRefusal(body({ code: "x".repeat(65) })).reason, undefined);
  });

  it("handles bodies that aren't JSON, or carry the error as a string", () => {
    assert.deepEqual(upstreamRefusal("<html>Bad Request: quoted body</html>"), { message: GENERIC });
    assert.deepEqual(upstreamRefusal(JSON.stringify({ error: "Prompt is too long: 'secret'" })), { message: upstreamRefusal(body({ code: "context_length_exceeded" })).message });
    assert.deepEqual(upstreamRefusal(""), { message: GENERIC });
  });

  it("tells the person what to do about an unknown refusal (Open Relay's opaque 400 for a broken history)", () => {
    const out = upstreamRefusal(body({ code: "invalid_request_error", message: "the request was rejected by the model", type: "invalid_request_error" }));
    assert.equal(out.message, GENERIC);
    assert.match(out.message, /interrupted step/);
    assert.match(out.message, /\/clear/);
    assert.match(out.message, /dl update/);
  });
});
