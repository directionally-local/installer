import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADMIN_ID,
  createInvite,
  createService,
  MODEL,
  NOW,
  startBrowserFlow,
  submitDetails,
  type Service,
} from "./harness.js";
import {
  REFUSAL_REASONS,
  refusalsCard,
  refusalsCsv,
  requestRefusalReason,
} from "../src/refusals.js";
import { DAY_MS } from "../src/week.js";

/**
 * Every refusal and gate counted per UTC day and reason (refusals.ts): counts and distinct
 * people only, never who.
 */

const OLD = "2015-01-01T00:00:00Z";
const NEW = "2026-10-20T00:00:00Z"; // 15 days before the harness clock
const TODAY = new Date(NOW).toISOString().slice(0, 10);

type Row = {
  day: string;
  reason: string;
  client: string;
  count: number;
  people: number;
};

/** The admin metrics' `refusals` for today, as {"reason|client": [count, people]}. */
async function counts(
  service: Service,
): Promise<Record<string, [number, number]>> {
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" }))
    .access_token;
  const response = await service.request("GET", "/admin/metrics", {
    token: admin,
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { refusals: Row[] };
  return Object.fromEntries(
    body.refusals
      .filter((row) => row.day === TODAY)
      .map((row) => [`${row.reason}|${row.client}`, [row.count, row.people]]),
  );
}

/** Every row of the refusal tables, as text. */
function stored(service: Service): string {
  const db = (
    service.namespaces.DIRECTORY!.instances.get("directory") as unknown as {
      state: { db: { prepare(sql: string): { all(): unknown[] } } };
    }
  ).state.db;
  return ["refusals_daily", "refusal_people", "refusal_salts"]
    .map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()))
    .join("\n");
}

async function member(
  vars: Record<string, string> = {},
): Promise<{ service: Service; token: string; admin: string }> {
  const service = await createService(vars);
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" }))
    .access_token;
  const token = (
    await service.signIn(
      { id: 100, login: "alice" },
      { invite: await createInvite(service, admin) },
    )
  ).access_token;
  return { service, token, admin };
}

const chat = (
  service: Service,
  token: string,
  body: Record<string, unknown> = {},
) =>
  service.request("POST", "/v1/chat/completions", {
    token,
    body: {
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
      ...body,
    },
  });

describe("refusal counts: sign-in", () => {
  it("counts device_taken, once per attempt, with distinct people", async () => {
    const service = await createService();
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" }))
      .access_token;
    await service.signIn(
      { id: 100, login: "alice" },
      { invite: await createInvite(service, admin), deviceId: "device-0001" },
    );
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await startBrowserFlow(
            service.request,
            { id: 101, login: "alias" },
            "device-0001",
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await startBrowserFlow(
          service.request,
          { id: 102, login: "alias2" },
          "device-0001",
        )
      ).status,
      403,
    );
    const today = await counts(service);
    assert.deepEqual(today["device_taken|signin"], [3, 2]);
    // The invite flow around it: alice's invite was shown and accepted.
    assert.equal(today["invite_accepted|signin"]?.[0], 1);
    assert.ok((today["invite_page_shown|signin"]?.[0] ?? 0) >= 1);
  });

  it("counts too-new accounts and the network daily limit as placements below Full", async () => {
    const service = await createService({ OPEN_ADMISSION: "true" });
    for (let id = 100; id < 105; id++)
      assert.match(
        (
          await startBrowserFlow(service.request, {
            id,
            login: `user${id}`,
            createdAt: NEW,
            publicRepos: 0,
          })
        ).page,
        /signed in/i,
      );
    // An old account with no repositories and no contributions: below Full for activity.
    const elsewhere: Service["request"] = (method, path, more = {}) =>
      service.request(method, path, { ...more, ip: "192.0.2.50" });
    assert.match(
      (
        await startBrowserFlow(elsewhere, {
          id: 200,
          login: "quiet",
          createdAt: OLD,
          publicRepos: 0,
          contributions: 0,
        })
      ).page,
      /signed in/i,
    );
    const today = await counts(service);
    assert.deepEqual(
      today["account_too_new|signin"],
      [3, 3],
      "within the network's limit: their own reason",
    );
    assert.deepEqual(today["network_limit|signin"], [2, 2]);
    assert.deepEqual(today["few_repos_and_contributions|signin"], [1, 1]);
  });

  it("counts invite_required and an invalid invite code while invite-only", async () => {
    const service = await createService();
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const flow = await startBrowserFlow(service.request, {
      id: 100,
      login: "alice",
      createdAt: OLD,
    });
    const ticket = /name="ticket" value="([^"]+)"/.exec(flow.page)![1]!;
    await service.request("POST", "/device/invite", {
      form: { ticket, invite_code: "DL-ZZZZ-ZZZZ" },
    });
    const today = await counts(service);
    assert.deepEqual(today["invite_required|signin"], [1, 1]);
    assert.deepEqual(today["invite_page_shown|signin"], [1, 1]);
    assert.deepEqual(today["invite_code_invalid|signin"], [1, 1]);
  });

  it("counts a blocked email domain apart from a blocked address, an inbox in use and the domain daily cap", async () => {
    const service = await createService({
      OPEN_ADMISSION: "true",
      BLOCKED_EMAILS: "farm@example.net, @catchall.example",
      DOMAIN_SIGNUPS_PER_DAY: "1",
    });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const signUp = async (id: number, email: string) => {
      const request: Service["request"] = (method, path, more = {}) =>
        service.request(method, path, {
          ...more,
          ip: `198.51.100.${id % 250}`,
        });
      const flow = await startBrowserFlow(
        request,
        { id, login: `user${id}`, email, createdAt: OLD },
        undefined,
        { stopAtDetails: true },
      );
      return (await submitDetails(request, flow.page, { email })).page;
    };
    assert.match(
      await signUp(111, "x@sub.catchall.example"),
      /can.{0,6}t be used/,
    );
    assert.match(await signUp(112, "y@catchall.example"), /can.{0,6}t be used/);
    assert.match(await signUp(113, "farm@example.net"), /can.{0,6}t be used/);
    assert.match(await signUp(114, "me@gmail.com"), /signed in/);
    assert.match(await signUp(115, "m.e+2@gmail.com"), /already used/);
    assert.match(await signUp(116, "a@company.example"), /signed in/);
    assert.match(
      await signUp(117, "b@company.example"),
      /Too many new free accounts/,
    );
    const today = await counts(service);
    assert.deepEqual(today["email_domain_blocked|signin"], [2, 2]);
    assert.deepEqual(today["email_blocked|signin"], [1, 1]);
    assert.deepEqual(today["email_in_use|signin"], [1, 1]);
    assert.deepEqual(today["email_domain_daily_cap|signin"], [1, 1]);
  });
});

describe("refusal counts: requests", () => {
  it("counts dl_only", async () => {
    const { service, token } = await member();
    for (let i = 0; i < 20; i++) {
      assert.equal((await chat(service, token)).status, 200);
      service.clock.now += 1000;
    }
    assert.equal((await chat(service, token)).status, 403);
    assert.equal((await chat(service, token)).status, 403);
    assert.deepEqual((await counts(service))["dl_only|other"], [2, 1]);
  });

  it("counts proxy_not_allowed", async () => {
    const { service, token } = await member();
    assert.equal(
      (await chat(service, token, { session_id: "9router-test-session-123" }))
        .status,
      403,
    );
    assert.deepEqual(
      (await counts(service))["proxy_not_allowed|other"],
      [1, 1],
    );
  });

  it("counts an allowance used up by level, and the GPT-6 limit with its sub-reason", async () => {
    const { service, token, admin } = await member({
      OPENAI_API_KEY: "sk-openai-test",
    });
    await service.request("POST", "/admin/people/100/grant", {
      token: admin,
      body: { spentUsdThisWeek: 1000 },
    });
    const gpt = await chat(service, token, { model: "gpt-6-luna" });
    assert.equal(gpt.status, 402);
    assert.equal(
      ((await gpt.json()) as { error: { code: string } }).error.code,
      "gpt_limit",
    );
    await service.request("POST", "/admin/people/100/grant", {
      token: admin,
      body: { deepseekSpentUsdThisWeek: 1000 },
    });
    const used = await chat(service, token);
    assert.equal(used.status, 402);
    assert.equal(
      ((await used.json()) as { error: { code: string } }).error.code,
      "quota_exceeded",
    );
    const today = await counts(service);
    assert.deepEqual(today["gpt_limit:cap|autopilot"], [1, 1]);
    assert.deepEqual(today["allowance_exhausted:full|autopilot"], [1, 1]);
  });

  it("maps every request refusal code to its reason", () => {
    assert.equal(
      requestRefusalReason(402, { code: "gpt_limit", reason: "security" }),
      "gpt_limit:security_hold",
    );
    assert.equal(
      requestRefusalReason(402, { code: "gpt_limit", reason: "spend" }),
      "gpt_limit:cap",
    );
    assert.equal(
      requestRefusalReason(402, { code: "starter_limit" }),
      "allowance_exhausted:starter",
    );
    assert.equal(
      requestRefusalReason(402, { code: "basic_limit" }),
      "allowance_exhausted:basic",
    );
    assert.equal(
      requestRefusalReason(503, { code: "global_weekly_budget_reached" }),
      "global_cap:weekly",
    );
    assert.equal(
      requestRefusalReason(503, { code: "global_total_budget_reached" }),
      "global_cap:total",
    );
    assert.equal(requestRefusalReason(403, { code: "blocked" }), "api_blocked");
    assert.equal(
      requestRefusalReason(403, { code: "not_invited" }),
      "api_not_invited",
    );
    assert.equal(
      requestRefusalReason(429, { code: "rate_limited" }),
      "rate_limited",
    );
    assert.equal(
      requestRefusalReason(403, { code: "harness_not_allowed" }),
      "harness_not_allowed",
    );
    assert.equal(
      requestRefusalReason(503, { code: "upstream_unavailable" }),
      undefined,
      "an outage isn't a gate",
    );
    assert.equal(requestRefusalReason(200, { code: "dl_only" }), undefined);
    for (const code of [
      "dl_only",
      "proxy_not_allowed",
      "below_bar",
      "trial_ended",
      "harness_limit",
      "model_not_allowed",
    ])
      assert.ok((requestRefusalReason(403, { code }) ?? "") in REFUSAL_REASONS, code);
  });
});

describe("refusal counts: every coding agent path, by client", () => {
  const LUMINAL = { LUMINAL_API_KEY: "lum-test" };
  async function world(): Promise<{
    service: Service;
    token: string;
    admin: string;
  }> {
    const service = await createService({ OPEN_ADMISSION: "true", ...LUMINAL });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" }))
      .access_token;
    const token = (
      await service.signIn({ id: 100, login: "alice", createdAt: OLD })
    ).access_token;
    return { service, token, admin };
  }
  async function mint(
    service: Service,
    token: string,
    harness: string,
  ): Promise<string> {
    const response = await service.request("POST", "/v1/harness-keys", {
      token,
      body: { harness },
    });
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as { key: string }).key;
  }
  const off = async (service: Service, admin: string) =>
    assert.equal(
      (
        await service.request("POST", "/admin/config", {
          token: admin,
          body: { allowOtherHarnesses: false },
        })
      ).status,
      200,
    );

  it("opencode: dl opencode's requests on /v1/chat/completions and its key minting", async () => {
    const { service, token, admin } = await world();
    const key = await mint(service, token, "opencode");
    await off(service, admin);
    assert.equal((await chat(service, key)).status, 403);
    assert.equal(
      (
        await service.request("POST", "/v1/harness-keys", {
          token,
          body: { harness: "opencode" },
        })
      ).status,
      403,
    );
    assert.deepEqual(
      (await counts(service))["harness_not_allowed|opencode"],
      [2, 1],
    );
  });

  it("claude-code: dl claude's requests on /anthropic/v1/messages", async () => {
    const { service, token, admin } = await world();
    const key = await mint(service, token, "claude-code");
    await off(service, admin);
    const refused = await service.request(
      "POST",
      "/anthropic/v1/messages?beta=true",
      {
        token: key,
        headers: { "anthropic-version": "2023-06-01" },
        body: {
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          messages: [{ role: "user", content: "hello" }],
        },
      },
    );
    assert.equal(refused.status, 403);
    assert.equal(
      ((await refused.json()) as { type: string }).type,
      "error",
      "still Anthropic's error shape",
    );
    const today = await counts(service);
    assert.deepEqual(today["harness_not_allowed|claude-code"], [1, 1]);
    assert.equal(today["harness_not_allowed|opencode"], undefined);
  });

  it("claude-code: a refusal inside chat (proxy router) keeps the harness as its client", async () => {
    const { service, token } = await world();
    const key = await mint(service, token, "claude-code");
    const refused = await service.request("POST", "/anthropic/v1/messages", {
      token: key,
      headers: {
        "anthropic-version": "2023-06-01",
        "user-agent": "9router/1.0",
      },
      body: {
        model: "claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [{ role: "user", content: "hello" }],
      },
    });
    assert.equal(refused.status, 403);
    assert.deepEqual(
      (await counts(service))["proxy_not_allowed|claude-code"],
      [1, 1],
    );
  });

  it("autopilot: plain dl on /v1/chat/completions, DeepSeek and GPT-6 (served through OpenAI's Responses API)", async () => {
    const { service, token } = await member({
      OPENAI_API_KEY: "sk-openai-test",
    });
    assert.equal(
      (await chat(service, token, { model: "not-a-model" })).status,
      400,
    );
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" }))
      .access_token;
    await service.request("POST", "/admin/people/100/grant", {
      token: admin,
      body: { spentUsdThisWeek: 1000 },
    });
    assert.equal(
      (await chat(service, token, { model: "gpt-6-luna" })).status,
      402,
    );
    const today = await counts(service);
    assert.deepEqual(today["model_not_allowed|autopilot"], [1, 1]);
    assert.deepEqual(today["gpt_limit:cap|autopilot"], [1, 1]);
  });
});

describe("refusal counts: storage", () => {
  it("stores no login, email, IP or GitHub id", async () => {
    const service = await createService({
      OPEN_ADMISSION: "true",
      BLOCKED_EMAILS: "@catchall.example",
    });
    await service.signIn({ id: ADMIN_ID, login: "owner" });
    const request: Service["request"] = (method, path, more = {}) =>
      service.request(method, path, { ...more, ip: "198.51.100.77" });
    const flow = await startBrowserFlow(
      request,
      {
        id: 987654,
        login: "secretlogin",
        email: "secret@catchall.example",
        createdAt: OLD,
      },
      "device-secret",
      { stopAtDetails: true },
    );
    await submitDetails(request, flow.page, {
      email: "secret@catchall.example",
    });
    const text = stored(service);
    assert.match(text, /email_domain_blocked/);
    for (const secret of [
      "secretlogin",
      "secret@",
      "catchall",
      "198.51.100",
      "987654",
      "device-secret",
    ])
      assert.ok(!text.includes(secret), secret);
  });

  it("drops the day's hashes and salt the next day and counts older than 120 days", async () => {
    const service = await createService();
    const directory = service.directory();
    await directory.countRefusal("dl_only", "other", NOW - 130 * DAY_MS, 5);
    await directory.countRefusal("dl_only", "other", NOW - DAY_MS, 5);
    await directory.countRefusal("dl_only", "other", NOW, 5);
    await directory.countRefusal("dl_only", "other", NOW, 5);
    await directory.countRefusal("dl_only", "other", NOW, 6);
    const rows = await directory.refusals();
    assert.deepEqual(
      rows.map((row: { day: number; count: number; people: number }) => [
        row.day - Math.floor(NOW / DAY_MS),
        row.count,
        row.people,
      ]),
      [
        [-1, 1, 1],
        [0, 3, 2],
      ],
    );
    const db = (
      service.namespaces.DIRECTORY!.instances.get("directory") as unknown as {
        state: {
          db: { prepare(sql: string): { all(): Array<{ day: number }> } };
        };
      }
    ).state.db;
    assert.deepEqual(
      new Set(
        db
          .prepare("SELECT day FROM refusal_people")
          .all()
          .map((row) => row.day),
      ),
      new Set([Math.floor(NOW / DAY_MS)]),
    );
    assert.equal(db.prepare("SELECT day FROM refusal_salts").all().length, 1);
  });

  it("shows on the admin page and in the CSV", async () => {
    const { service, token, admin } = await member();
    await chat(service, token, { session_id: "9router-x" });
    const page = await (
      await service.request("GET", "/admin", { token: admin })
    ).text();
    assert.match(page, /id="refusals"/);
    assert.match(page, /proxy_not_allowed/);
    const csv = await service.request("GET", "/admin/dashboard/refusals.csv", {
      token: admin,
    });
    assert.equal(csv.status, 200);
    const text = await csv.text();
    assert.ok(text.startsWith("day,reason,client,count,people\r\n"));
    assert.ok(
      text.includes(`\r\n${TODAY},proxy_not_allowed,other,1,1\r\n`),
      text,
    );
    const day = Math.floor(NOW / DAY_MS);
    assert.match(
      refusalsCard(
        [{ day, reason: "dl_only", client: "other", count: 4, people: 2 }],
        NOW,
      ),
      /<td class="num">4<\/td>/,
    );
    assert.equal(refusalsCsv([]), "day,reason,client,count,people\r\n");
  });
});
