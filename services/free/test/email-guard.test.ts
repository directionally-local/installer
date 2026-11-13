import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emailBlocked, normalizeEmail } from "../src/email-guard.js";
import { ADMIN_ID, createService, startBrowserFlow, submitDetails, type Service } from "./harness.js";

async function open(vars: Record<string, string> = {}): Promise<Service> {
  const service = await createService({ OPEN_ADMISSION: "true", ...vars });
  await service.signIn({ id: ADMIN_ID, login: "owner" });
  return service;
}

/** One sign-up from its own network, giving `email` on the details step. */
async function signUp(service: Service, id: number, email: string): Promise<{ status: number; page: string }> {
  const ip = `198.51.100.${id % 250}`;
  const request: Service["request"] = (method, path, more = {}) => service.request(method, path, { ...more, ip });
  const flow = await startBrowserFlow(request, { id, login: `user${id}`, email }, undefined, { stopAtDetails: true });
  return submitDetails(request, flow.page, { email });
}

describe("one free account per inbox", () => {
  it("normalizes +tags, case and Gmail dots to one inbox", () => {
    assert.equal(normalizeEmail("Some.One+cw4@GMail.com"), "someone@gmail.com");
    assert.equal(normalizeEmail("some.one@googlemail.com"), "someone@gmail.com");
    assert.equal(normalizeEmail("first.last+x@work.example"), "first.last@work.example", "dots only matter outside Gmail");
    assert.ok(emailBlocked("a@x.catchall.example", ["@catchall.example"]));
    assert.ok(emailBlocked("farmname@gmail.com", ["farm.name+anything@gmail.com"]));
    assert.ok(!emailBlocked("someone@gmail.com", ["@catchall.example"]));
  });

  it("refuses a second account on the same inbox, even with a +tag or dots", async () => {
    const service = await open();
    assert.match((await signUp(service, 101, "farmer+a1@gmail.com")).page, /signed in/);
    const second = await signUp(service, 102, "far.mer+b2@gmail.com");
    assert.equal(second.status, 400);
    assert.match(second.page, /already used by another dl account/);
    assert.match((await signUp(service, 103, "someone.else@gmail.com")).page, /signed in/);
  });

  it("refuses blocked inboxes and domains, from env or the runtime setting", async () => {
    const service = await open({ BLOCKED_EMAILS: "farm@example.net, @catchall.example" });
    assert.match((await signUp(service, 111, "farm+k9l555u@example.net")).page, /can.{0,6}t be used for the free tier/);
    assert.match((await signUp(service, 112, "gh.acct665@sub.catchall.example")).page, /can.{0,6}t be used for the free tier/);
    assert.match((await signUp(service, 113, "fine@example.net")).page, /signed in/, "a different inbox on the same public domain is fine");
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { blockedEmails: ["@another.example"] } })).status, 200);
    assert.match((await signUp(service, 114, "x@another.example")).page, /can.{0,6}t be used for the free tier/);
  });

  it("caps new accounts per company domain a day, but not public providers", async () => {
    const service = await open({ DOMAIN_SIGNUPS_PER_DAY: "2" });
    assert.match((await signUp(service, 121, "a@catchall.example")).page, /signed in/);
    assert.match((await signUp(service, 122, "b@catchall.example")).page, /signed in/);
    const third = await signUp(service, 123, "c@catchall.example");
    assert.match(third.page, /Too many new free accounts from this email domain/);
    for (const id of [124, 125, 126]) assert.match((await signUp(service, id, `person${id}@gmail.com`)).page, /signed in/);
    service.clock.now += 25 * 3600_000;
    assert.match((await signUp(service, 127, "d@catchall.example")).page, /signed in/, "a new day");
  });

  it("lets a returning person keep their own email", async () => {
    const service = await open();
    assert.match((await signUp(service, 131, "me+x@gmail.com")).page, /signed in/);
    // Signing in again on the same account goes straight through (the email is already on file).
    const request: Service["request"] = (method, path, more = {}) => service.request(method, path, { ...more, ip: "198.51.100.131" });
    const again = await startBrowserFlow(request, { id: 131, login: "user131", email: "me@gmail.com" });
    assert.match(again.page, /signed in/);
  });
});
