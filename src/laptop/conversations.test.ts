import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RemoteConversation } from "./client.js";
import type { RemoteServer } from "./config.js";
import {
  ageLabel, conversationState, isBlocked, listConversationsAcross, pickerOrder, resolveConversationId, summarize,
} from "./conversations.js";
import type { Connections } from "./tunnel.js";

const NOW = Date.parse("2026-10-29T12:00:00.000Z");

function conversation(id: string, extra: Partial<RemoteConversation> = {}): RemoteConversation {
  return {
    conversationId: id,
    workspaceId: "default",
    model: "deepseek/deepseek-v4.1-flash-1017",
    status: "ready",
    activeRunId: null,
    lastEventId: 1,
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z",
    kind: "code",
    repository: "me/app",
    ...extra,
  };
}

describe("conversation state", () => {
  it("uses the server's summary state when it has one", () => {
    assert.equal(conversationState(conversation("a", { state: "waiting_approval", status: "ready" })), "waiting_approval");
    assert.equal(conversationState(conversation("a", { state: "  running  " })), "running");
  });

  it("maps status and activeRunId for older servers", () => {
    assert.equal(conversationState(conversation("a", { activeRunId: "run-1", status: "ready" })), "running");
    assert.equal(conversationState(conversation("a", { status: "completed" })), "completed");
    assert.equal(conversationState(conversation("a", { status: "failed" })), "failed");
  });

  it("knows which states are blocked", () => {
    for (const state of ["waiting_approval", "waiting_input", "needs_approval", "blocked"]) assert.equal(isBlocked(state), true, state);
    for (const state of ["running", "completed", "failed", "ready"]) assert.equal(isBlocked(state), false, state);
  });

  it("keeps the summary fields a sidebar needs", () => {
    const row = summarize(conversation("a", { title: " Fix it ", costUsd: 0.25, lastActivityAt: "2026-10-29T11:00:00.000Z" }), "box");
    assert.equal(row.place, "box");
    assert.equal(row.title, "Fix it");
    assert.equal(row.costUsd, 0.25);
    assert.equal(row.lastActivityAt, "2026-10-29T11:00:00.000Z");
  });
});

describe("picker order", () => {
  it("puts blocked conversations first, then the most recently active", () => {
    const rows = [
      summarize(conversation("11111111", { activeRunId: "r", updatedAt: "2026-10-29T11:00:00.000Z" }), "a"),
      summarize(conversation("22222222", { status: "waiting_approval", updatedAt: "2026-10-29T08:00:00.000Z" }), "a"),
      summarize(conversation("33333333", { status: "completed", updatedAt: "2026-10-29T11:30:00.000Z" }), "b"),
      summarize(conversation("44444444", { status: "failed", updatedAt: "2026-10-29T09:00:00.000Z" }), "b"),
    ];
    assert.deepEqual(pickerOrder(rows).map((row) => row.conversationId), ["22222222", "33333333", "11111111", "44444444"]);
  });

  it("prefers lastActivityAt over updatedAt", () => {
    const rows = [
      summarize(conversation("11111111", { updatedAt: "2026-10-29T11:00:00.000Z", lastActivityAt: "2026-10-29T09:00:00.000Z" }), "a"),
      summarize(conversation("22222222", { updatedAt: "2026-10-29T08:00:00.000Z", lastActivityAt: "2026-10-29T10:00:00.000Z" }), "a"),
    ];
    assert.deepEqual(pickerOrder(rows).map((row) => row.conversationId), ["22222222", "11111111"]);
  });

  it("labels ages", () => {
    assert.equal(ageLabel("2026-10-29T11:59:30.000Z", NOW), "now");
    assert.equal(ageLabel("2026-10-29T11:55:00.000Z", NOW), "5m");
    assert.equal(ageLabel("2026-10-29T09:00:00.000Z", NOW), "3h");
    assert.equal(ageLabel("2026-10-27T12:00:00.000Z", NOW), "2d");
    assert.equal(ageLabel(undefined, NOW), "");
    assert.equal(ageLabel("not a date", NOW), "");
  });
});

describe("resolving an ID across places", () => {
  const rows = [
    summarize(conversation("7c1d2e3f-0000-4000-8000-000000000000"), "one"),
    summarize(conversation("3f2a9c1e-0000-4000-8000-000000000000"), "two"),
  ];

  it("takes a unique prefix, case-insensitively", () => {
    assert.equal(resolveConversationId("7c1d", rows).place, "one");
    assert.equal(resolveConversationId("3F2A", rows).place, "two");
    assert.equal(resolveConversationId("7c1d2e3f-0000-4000-8000-000000000000", rows).place, "one");
  });

  it("refuses an ambiguous prefix and an unknown one", () => {
    assert.throws(() => resolveConversationId("3f2a", [...rows, summarize(conversation("3f2a1111-0000-4000-8000-000000000000"), "one")]), /matches several conversations/);
    assert.throws(() => resolveConversationId("ffff", rows), /No conversation ffff on any connected place/);
    assert.throws(() => resolveConversationId("nope", rows), /Conversation IDs are the short hex IDs/);
  });

  it("says which places couldn't be asked", () => {
    assert.throws(
      () => resolveConversationId("ffff", rows, [{ place: "box", reason: "tunnel failed" }]),
      /No conversation ffff on any connected place\nbox: tunnel failed/,
    );
  });
});

describe("listing across places", () => {
  const remote = (name: string): RemoteServer => ({
    name, url: `https://${name}.example.com`, token: "t", credentialId: "c", expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-01-01T00:00:00.000Z",
  });

  it("collects every place and reports the ones that don't answer", async () => {
    const connections = {
      client: async (place: RemoteServer) => {
        if (place.name === "down") throw new Error("tunnel failed");
        return {
          listConversations: async () => [
            conversation("11111111-0000-4000-8000-000000000000", { repository: "me/app" }),
            conversation("22222222-0000-4000-8000-000000000000", { kind: "chat" }),
          ],
        };
      },
    } as unknown as Connections;
    const listing = await listConversationsAcross([remote("up"), remote("down")], connections, { kind: "code" });
    assert.deepEqual(listing.rows.map((row) => [row.place, row.conversationId]), [["up", "11111111-0000-4000-8000-000000000000"]]);
    assert.deepEqual(listing.unreachable, [{ place: "down", reason: "tunnel failed" }]);
  });
});
