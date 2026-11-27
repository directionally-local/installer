import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createService, NOW, type Service } from "./harness.js";
import {
  escapeSlackText,
  postSlackMessage,
  SLACK_FEEDBACK_DAILY_CAP,
  SLACK_TEXT_MAX_CHARS,
  SLACK_TRUNCATED_NOTE,
  slackMessage,
  truncateSlackText,
  type SlackItem,
} from "../src/slack-feedback.js";

const WEBHOOK = "https://hooks.slack.com/services/T000/B000/secret";
const DAY = 86_400_000;
const VARS = { OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com", SLACK_FEEDBACK_WEBHOOK_URL: WEBHOOK };

const feedbackItem: SlackItem = {
  kind: "feedback",
  at: NOW,
  message: "The deck froze <again> & I lost work.",
  sender: { login: "alice", githubId: 501 },
  client: { dl: "0.11.0", autopilot: "3.5.0", os: "macos", arch: "arm64", provider: "free" },
  replyTo: "alice@example.org",
};

async function service(vars: Record<string, string> = VARS): Promise<Service> {
  return createService(vars, { email: true });
}

describe("Slack message text", () => {
  it("escapes &, < and > in user text, in the right order", () => {
    assert.equal(escapeSlackText("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    assert.equal(escapeSlackText("&lt;"), "&amp;lt;");
  });

  it("truncates at 2,500 characters without splitting emoji, and says so", () => {
    assert.equal(truncateSlackText("short"), "short");
    const long = "🙂".repeat(SLACK_TEXT_MAX_CHARS + 50);
    const cut = truncateSlackText(long);
    assert.ok(cut.endsWith(SLACK_TRUNCATED_NOTE));
    assert.equal([...cut].length, SLACK_TEXT_MAX_CHARS + [...SLACK_TRUNCATED_NOTE].length);
    assert.equal(cut.slice(0, cut.indexOf(SLACK_TRUNCATED_NOTE)), "🙂".repeat(SLACK_TEXT_MAX_CHARS));
  });

  it("formats feedback with the type, who, message, client, reply-to and time", () => {
    const text = slackMessage(feedbackItem);
    assert.match(text, /^\*Feedback\* \(POST \/v1\/feedback\)/);
    assert.match(text, /From: @alice \(https:\/\/github\.com\/alice\)/);
    assert.match(text, /> The deck froze &lt;again&gt; &amp; I lost work\./);
    assert.match(text, /Client: dl 0\.11\.0, Autopilot 3\.5\.0, OS macos, Arch arm64, Provider free/);
    assert.match(text, /Reply to: alice@example\.org/);
    assert.match(text, /Time: 2026-11-04 12:00:00 UTC/);
  });

  it("formats an agent request and a provider inquiry", () => {
    const agent = slackMessage({
      kind: "agent-request",
      at: NOW,
      name: "Aider & Goose",
      os: "darwin",
      arch: "arm64",
      dlVersion: "0.48.0",
      found: ["claude", "<opencode>"],
      account: { login: "alice", githubId: 501 },
    });
    assert.match(agent, /^\*Unsupported coding agent\* \(POST \/v1\/agent-request\)/);
    assert.match(agent, /From: @alice \(https:\/\/github\.com\/alice\)/);
    assert.match(agent, /Agent: Aider &amp; Goose/);
    assert.match(agent, /OS\/arch: darwin\/arm64/);
    assert.match(agent, /dl version: 0\.48\.0/);
    assert.match(agent, /Agents dl found: claude, &lt;opencode&gt;/);

    const provider = slackMessage({
      kind: "provider-inquiry",
      at: NOW,
      company: "Acme <Inference>",
      name: "Ada & Bob",
      email: "ada@acme.example.com",
      website: "https://acme.example.com/?a=1&b=2",
      models: "DeepSeek <V4>",
      notes: "Line <one>\nLine two & three",
    });
    assert.match(provider, /^\*Provider inquiry\* \(POST \/web\/provider-inquiry\)/);
    assert.match(provider, /Company: Acme &lt;Inference&gt;/);
    assert.match(provider, /Name: Ada &amp; Bob/);
    assert.match(provider, /Website: https:\/\/acme\.example\.com\/\?a=1&amp;b=2/);
    assert.match(provider, /Models: DeepSeek &lt;V4&gt;/);
    assert.match(provider, /> Line &lt;one&gt;\n> Line two &amp; three/);
    assert.match(provider, /Reply to: ada@acme\.example\.com/);
    assert.doesNotMatch(provider, /Email:/);
  });

  it("escapes the login in the display text and link", () => {
    const text = slackMessage({ ...feedbackItem, sender: { login: "a&b" } });
    assert.match(text, /From: @a&amp;b \(https:\/\/github\.com\/a%26b\)/);
  });
});

describe("postSlackMessage", () => {
  it("posts {text} and gives up after the timeout even when the fetch ignores the abort", async () => {
    const started = Date.now();
    const result = await postSlackMessage(WEBHOOK, feedbackItem, () => new Promise<Response>(() => {}), 20);
    assert.equal(result, false);
    assert.ok(Date.now() - started < 1000);
  });

  it("posts the message and reports a non-2xx response without throwing", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    assert.equal(await postSlackMessage(WEBHOOK, feedbackItem, async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("no", { status: 500 });
    }), false);
    assert.equal(calls[0]!.url, WEBHOOK);
    assert.equal(typeof (calls[0]!.body as { text?: unknown }).text, "string");

    const ok = await postSlackMessage(WEBHOOK, feedbackItem, async () => new Response("ok"));
    assert.equal(ok, true);
  });
});

describe("POST /v1/feedback, agent requests and provider inquiries to Slack", () => {
  it("posts one message each for feedback, an agent request and a provider inquiry", async () => {
    const s = await service();
    const { access_token } = await s.signIn({ id: 501, login: "alice" });

    assert.equal((await s.request("POST", "/v1/feedback", {
      token: access_token,
      body: { message: "Frozen <deck> & no reply", email: "alice@work.example", client: { dl: "0.11.0", os: "macos", provider: "free" } },
    })).status, 200);
    assert.equal((await s.request("POST", "/v1/agent-request", {
      token: access_token,
      body: { name: "Aider", os: "darwin", arch: "arm64", dlVersion: "0.48.0", found: ["claude", "opencode"] },
    })).status, 200);
    assert.equal((await s.request("POST", "/web/provider-inquiry", {
      headers: { origin: "https://dl.new" },
      body: { company: "Acme Inference", name: "Ada Lovelace", email: "ada@acme.example.com", notes: "We have <capacity> & credits." },
    })).status, 200);
    await s.settle();

    assert.equal(s.calls.webhooks.length, 3);
    assert.ok(s.calls.webhooks.every((call) => call.url === WEBHOOK));
    const [feedback, agent, provider] = s.calls.webhooks.map((call) => String(call.body.text));
    assert.match(feedback!, /\*Feedback\*/);
    assert.match(feedback!, /From: @alice \(https:\/\/github\.com\/alice\)/);
    assert.match(feedback!, /> Frozen &lt;deck&gt; &amp; no reply/);
    assert.match(feedback!, /Client: dl 0\.11\.0, OS macos, Provider free/);
    assert.match(feedback!, /Reply to: alice@work\.example/);
    assert.match(agent!, /\*Unsupported coding agent\*/);
    assert.match(agent!, /Agent: Aider/);
    assert.match(agent!, /OS\/arch: darwin\/arm64/);
    assert.match(agent!, /Agents dl found: claude, opencode/);
    assert.match(provider!, /\*Provider inquiry\*/);
    assert.match(provider!, /Company: Acme Inference/);
    assert.match(provider!, /> We have &lt;capacity&gt; &amp; credits\./);
    assert.match(provider!, /Reply to: ada@acme\.example\.com/);
  });

  it("still answers 200 when the Slack fetch throws", async () => {
    const s = await service({ ...VARS, SLACK_FEEDBACK_WEBHOOK_URL: "https://slack.example.com/webhook-that-throws" });
    const response = await s.request("POST", "/v1/feedback", { body: { message: "The Slack post may fail" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, replyTo: null });
    await s.settle();
    assert.equal(s.calls.webhooks.length, 0);
  });

  it("posts nothing when SLACK_FEEDBACK_WEBHOOK_URL isn't set", async () => {
    const s = await service({ OPEN_ADMISSION: "true", ALERT_EMAIL_TO: "owner@example.com" });
    await s.request("POST", "/v1/feedback", { body: { message: "hi" } });
    await s.request("POST", "/v1/agent-request", { body: { name: "Aider" } });
    await s.request("POST", "/web/provider-inquiry", { headers: { origin: "https://dl.new" }, body: { company: "Acme", name: "Ada", email: "ada@acme.example.com" } });
    await s.settle();
    assert.equal(s.calls.webhooks.length, 0);
  });

  it("stops at the 200-a-day cap, shared by all three sources, and starts again the next UTC day", async () => {
    const s = await service();
    const directory = s.directory();
    for (let i = 0; i < SLACK_FEEDBACK_DAILY_CAP; i++) assert.equal(await directory.takeSlackPost(NOW), true);
    assert.equal(await directory.takeSlackPost(NOW), false);

    await s.request("POST", "/v1/agent-request", { body: { name: "One too many" } });
    await s.settle();
    assert.equal(s.calls.webhooks.length, 0);

    assert.equal(await directory.takeSlackPost(NOW + DAY), true);
  });

  it("still stores neither the feedback message nor the reply address with Slack on", async () => {
    const s = await service();
    await s.request("POST", "/v1/feedback", { body: { message: "SECRET-SLACK-FEEDBACK-TEXT", email: "secret-slack-address@example.net" } });
    await s.settle();
    assert.equal(s.calls.webhooks.length, 1);

    const stored: string[] = [];
    const tableNames = new Set<string>();
    for (const namespace of Object.values(s.namespaces)) {
      for (const { state } of namespace.instances.values()) {
        const tables = state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        for (const { name } of tables) {
          tableNames.add(name);
          stored.push(JSON.stringify(state.db.prepare(`SELECT * FROM "${name}"`).all()));
        }
      }
    }
    const all = stored.join("\n");
    assert.ok(!all.includes("SECRET-SLACK-FEEDBACK-TEXT"));
    assert.ok(!all.includes("secret-slack-address"));
    assert.ok(tableNames.has("slack_feedback_daily"));
  });
});
