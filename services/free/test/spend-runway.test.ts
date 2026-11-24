import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService, MODEL, NOW, type Service } from "./harness.js";
import { PROBE_CRON } from "../src/probes.js";
import { policyOf, type Policy } from "../src/queue.js";
import { readFreeConfig, type Upstream } from "../src/config.js";
import { parseSettingsUpdate } from "../src/runtime-config.js";
import { runwayAlert, runwayFindings, type RunwayInput } from "../src/runway.js";
import { weekEnd, weekStart } from "../src/week.js";

/**
 * Spend controls: the global caps count every provider's free spend (OpenRouter cash, OpenAI,
 * Luminal and each registry provider's credit; admins, paid usage and the service's own calls
 * left out), and the runway alerts (runway.ts) warn the owner before a cap or a credit runs out.
 * NOW is Wednesday 2026-11-04 12:00 UTC.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const HOOK = "https://alerts.test/hook";
const BASE_ENV = { OPENROUTER_API_KEY: "k", GITHUB_CLIENT_ID: "c", GITHUB_CLIENT_SECRET: "s", TOKEN_SIGNING_KEY: "x".repeat(32) };

function policy(service: Service): Policy {
  return policyOf(readFreeConfig(service.env as unknown as Record<string, unknown>));
}

/** One request in the log, as the chat path records it. */
async function record(service: Service, input: { upstream: Upstream; usd: number; at?: number; githubId?: number; isAdmin?: boolean; paid?: boolean; model?: string }): Promise<unknown> {
  const cash = input.upstream === "openrouter";
  return service.directory().recordRequest(
    {
      githubId: input.githubId ?? 500,
      isAdmin: input.isAdmin ?? false,
      at: input.at ?? NOW,
      model: input.model ?? MODEL,
      promptTokens: 1,
      completionTokens: 1,
      cachedTokens: 0,
      chargedTokens: 2,
      costUsd: cash ? input.usd : 0,
      status: "ok",
      latencyMs: 1,
      upstream: input.upstream,
      creditUsd: cash ? 0 : input.usd,
      ...(input.paid ? { paid: true } : {}),
    },
    policy(service),
  );
}

const alertTexts = (service: Service) => service.calls.webhooks.map((hook) => String(hook.body.text));
const runwayTexts = (service: Service) => alertTexts(service).filter((text) => text.includes("runway warning"));

async function tick(service: Service, at = service.clock.now): Promise<void> {
  await (service.handler as unknown as { scheduled(controller: { cron: string; scheduledTime: number }, env: never): Promise<void> }).scheduled({ cron: PROBE_CRON, scheduledTime: at }, service.env as never);
}

describe("global caps: every provider's free spend", () => {
  it("adds OpenRouter cash and OpenAI, Luminal, Liquid and Open Relay credit; admins and paid usage are left out", async () => {
    const service = await createService({ ALERT_WEBHOOK_URL: HOOK });
    await record(service, { upstream: "openrouter", usd: 1 });
    await record(service, { upstream: "openai", usd: 2 });
    await record(service, { upstream: "luminal", usd: 4 });
    await record(service, { upstream: "liquid", usd: 8, model: "moonshotai/kimi-k3.1-pro" });
    await record(service, { upstream: "openrelay", usd: 16, model: "z-ai/glm-5.3-flash" });
    // Not counted: an admin's and paid usage, on every provider.
    for (const upstream of ["openrouter", "openai", "luminal", "openrelay"] as const) {
      await record(service, { upstream, usd: 100, isAdmin: true, githubId: ADMIN_ID, model: upstream === "openrelay" ? "z-ai/glm-5.3-flash" : MODEL });
      await record(service, { upstream, usd: 100, paid: true, model: upstream === "openrelay" ? "z-ai/glm-5.3-flash" : MODEL });
    }
    // Last week's free spend counts in the total only.
    await record(service, { upstream: "openrelay", usd: 32, at: NOW - 7 * DAY, model: "z-ai/glm-5.3-flash" });
    await record(service, { upstream: "luminal", usd: 64, at: NOW - 7 * DAY });
    const gate = await service.directory().gate(NOW);
    assert.equal(gate.weekUsd, 31);
    assert.equal(gate.totalUsd, 127);
    const spend = await service.directory().spend(NOW);
    assert.equal(spend.capWeekUsd, 31);
    assert.equal(spend.capTotalUsd, 127);
    assert.equal(spend.spentUsd, 1, "spentUsd stays OpenRouter cash");
  });

  it("refuses free requests at the weekly cap reached on a registry provider's credit alone", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: HOOK, GLOBAL_WEEKLY_USD_CAP: "10" });
    const { access_token: token } = await service.signIn({ id: 100, login: "alice" });
    const alerts = (await record(service, { upstream: "openrelay", usd: 10, model: "z-ai/glm-5.3-flash" })) as Array<{ text: string }>;
    // The 100% alert counts it too.
    assert.ok(alerts.some((alert) => alert.text.includes("$10 of the $10 weekly cap used (100%)")), JSON.stringify(alerts));
    const response = await service.request("POST", "/v1/chat/completions", { token, ip: "10.8.0.1", body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "global_weekly_budget_reached");
  });

  it("refuses free requests at the all-time cap reached on OpenAI and registry credit", async () => {
    const service = await createService({ OPEN_ADMISSION: "true", ALERT_WEBHOOK_URL: HOOK, GLOBAL_WEEKLY_USD_CAP: "none", GLOBAL_TOTAL_USD_CAP: "20" });
    const { access_token: token } = await service.signIn({ id: 100, login: "alice" });
    await record(service, { upstream: "openai", usd: 12, at: NOW - 14 * DAY });
    await record(service, { upstream: "liquid", usd: 8, at: NOW - 7 * DAY, model: "moonshotai/kimi-k3.1-pro" });
    const response = await service.request("POST", "/v1/chat/completions", { token, ip: "10.8.0.2", body: { model: MODEL, messages: [{ role: "user", content: "hi" }] } });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "global_total_budget_reached");
  });
});

describe("runway: the checks", () => {
  const start = weekStart(NOW);
  const base: RunwayInput = {
    now: NOW,
    weekStart: start,
    weekEnd: weekEnd(NOW),
    weekUsd: 0,
    dayUsd: 0,
    totalUsd: 0,
    weeklyCapUsd: 500,
    totalCapUsd: 7000,
    providers: [],
    alertDays: 7,
    totalCapShare: 0.1,
  };
  const keys = (input: Partial<RunwayInput>) => runwayFindings({ ...base, ...input }).map((finding) => finding.key);

  it("is quiet when nothing is close", () => {
    assert.deepEqual(keys({ weekUsd: 100, dayUsd: 40, totalUsd: 1000, providers: [{ id: "luminal", name: "Luminal", balanceUsd: 2000, usedUsd: 200, dayUsd: 10 }] }), []);
  });

  it("projects the week at the faster of the week's average and the last 24 hours", () => {
    // Wednesday noon: 2.5 days in, 4.5 left. $150 so far is $60 a day: $420, under $500.
    assert.deepEqual(keys({ weekUsd: 150, dayUsd: 60 }), []);
    // A spike: $150 in the last 24 hours projects $150 + 4.5 × 150 = $825.
    assert.deepEqual(keys({ weekUsd: 150, dayUsd: 150 }), ["week"]);
    // The average alone: $200 by Wednesday noon is $80 a day, $560 by the end.
    assert.deepEqual(keys({ weekUsd: 200, dayUsd: 0 }), ["week"]);
    // Monday's first hour isn't a forecast: the average is taken over at least a day.
    assert.deepEqual(keys({ now: start + HOUR, weekUsd: 60, dayUsd: 60 }), []);
    // At or past the cap the 100% alert has said it; no weekly cap, no check.
    assert.deepEqual(keys({ weekUsd: 500, dayUsd: 500 }), []);
    assert.deepEqual(keys({ weekUsd: 400, dayUsd: 400, weeklyCapUsd: undefined }), []);
    const [finding] = runwayFindings({ ...base, weekUsd: 150, dayUsd: 150 });
    assert.match(finding!.line, /\$150 of \$500 spent this week; at \$150 a day it is reached around Fri 20:00 UTC, before the week resets Mon 00:00 UTC \(projected \$825\)/);
  });

  it("reports each provider whose credit runs out within runwayAlertDays at the last day's burn", () => {
    const providers = [
      { id: "openai", name: "OpenAI", balanceUsd: 5000, usedUsd: 500, dayUsd: 100 }, // 45 days
      { id: "luminal", name: "Luminal", balanceUsd: 2000, usedUsd: 1700, dayUsd: 50 }, // 6 days
      { id: "liquid", name: "Liquid Inference", balanceUsd: 100, usedUsd: 90, dayUsd: 5 }, // 2 days
      { id: "openrelay", name: "Open Relay", balanceUsd: 200, usedUsd: 190, dayUsd: 0 }, // no burn
      { id: "none", name: "No balance", balanceUsd: 0, usedUsd: 0, dayUsd: 5 },
    ];
    assert.deepEqual(keys({ providers }), ["credit:luminal", "credit:liquid"]);
    assert.deepEqual(keys({ providers, alertDays: 3 }), ["credit:liquid"]);
    assert.deepEqual(keys({ providers, alertDays: 0 }), [], "0 turns it off");
    const lines = runwayFindings({ ...base, providers }).map((finding) => finding.line);
    assert.match(lines[0]!, /Luminal credit: \$300 of \$2,000 left; at the last 24 hours' \$50 it runs out in about 6 days/);
    assert.match(lines[1]!, /providerCredit\.liquid/);
  });

  it("reports the total cap within runwayTotalCapShare of its end", () => {
    assert.deepEqual(keys({ totalUsd: 6200 }), []);
    assert.deepEqual(keys({ totalUsd: 6300 }), ["total"]);
    assert.deepEqual(keys({ totalUsd: 6300, totalCapShare: 0 }), []);
    assert.deepEqual(keys({ totalUsd: 5600, totalCapShare: 0.2 }), ["total"]);
    assert.deepEqual(keys({ totalUsd: 7000 }), [], "the 100% alert covers a cap reached");
  });

  it("puts every new condition in one email", () => {
    const alert = runwayAlert(runwayFindings({ ...base, weekUsd: 250, totalUsd: 6900, providers: [{ id: "liquid", name: "Liquid Inference", balanceUsd: 100, usedUsd: 90, dayUsd: 5 }] }));
    assert.equal(alert.subject, "dl free tier: runway: weekly cap on pace to be reached (+2 more)");
    assert.equal(alert.text.split("\n").filter((line) => line.startsWith("- ")).length, 3);
  });

  it("has settings with conservative defaults, changeable at run time", () => {
    const config = readFreeConfig({ ...BASE_ENV });
    assert.deepEqual([config.runwayAlerts, config.runwayAlertDays, config.runwayTotalCapShare], [true, 7, 0.1]);
    const env = readFreeConfig({ ...BASE_ENV, RUNWAY_ALERTS: "off", RUNWAY_ALERT_DAYS: "3", RUNWAY_TOTAL_CAP_SHARE: "0.25" });
    assert.deepEqual([env.runwayAlerts, env.runwayAlertDays, env.runwayTotalCapShare], [false, 3, 0.25]);
    assert.deepEqual(parseSettingsUpdate({ runwayAlertDays: 14, runwayTotalCapShare: 0.2, runwayAlerts: false }), {
      changes: [
        { key: "runwayAlertDays", value: 14 },
        { key: "runwayTotalCapShare", value: 0.2 },
        { key: "runwayAlerts", value: false },
      ],
    });
    assert.ok("error" in parseSettingsUpdate({ runwayTotalCapShare: 2 }));
  });
});

describe("runway: the 10-minute cron", () => {
  it("emails each condition at most once a UTC day, and again the next day while it holds", async () => {
    const service = await createService({ ALERT_WEBHOOK_URL: HOOK, GLOBAL_WEEKLY_USD_CAP: "100", LUMINAL_API_KEY: "lum", LUMINAL_CREDIT_USD: "200" });
    await record(service, { upstream: "luminal", usd: 60, at: NOW - HOUR }); // $60 a day: past $100 by Thursday; credit for 2.3 days
    await tick(service);
    await tick(service, NOW + 10 * 60_000);
    let sent = runwayTexts(service);
    assert.equal(sent.length, 1, sent.join("\n"));
    assert.match(sent[0]!, /Weekly cap: \$60 of \$100 spent this week/);
    assert.match(sent[0]!, /Luminal credit: \$140 of \$200 left/);

    // A new condition later the same day is sent on its own; the ones already sent aren't repeated.
    // Paid usage: not in the caps, but it burns the provider's credit.
    await record(service, { upstream: "openrelay", usd: 150, at: NOW + HOUR, githubId: 501, paid: true, model: "z-ai/glm-5.3-flash" }); // $50 of $200 left
    service.clock.now = NOW + 2 * HOUR;
    await tick(service);
    sent = runwayTexts(service);
    assert.equal(sent.length, 2, sent.join("\n"));
    assert.match(sent[1]!, /Open Relay credit/);
    assert.doesNotMatch(sent[1]!, /Weekly cap|Luminal/);

    // The next UTC day, the week still on pace past the cap ($60 over 3.5 days): sent again.
    service.clock.now = NOW + DAY;
    await tick(service);
    sent = runwayTexts(service);
    assert.equal(sent.length, 3, sent.join("\n"));
    assert.match(sent[2]!, /Weekly cap/);
  });

  it("sends nothing with runwayAlerts off, or when nothing is close", async () => {
    const off = await createService({ ALERT_WEBHOOK_URL: HOOK, GLOBAL_WEEKLY_USD_CAP: "100", RUNWAY_ALERTS: "false" });
    await record(off, { upstream: "openai", usd: 90, at: NOW - HOUR });
    await tick(off);
    assert.equal(runwayTexts(off).length, 0);

    const calm = await createService({ ALERT_WEBHOOK_URL: HOOK, GLOBAL_WEEKLY_USD_CAP: "500" });
    await record(calm, { upstream: "openai", usd: 5, at: NOW - HOUR });
    await tick(calm);
    assert.equal(runwayTexts(calm).length, 0);
  });

  it("follows an admin override of the settings", async () => {
    const service = await createService({ ALERT_WEBHOOK_URL: HOOK, GLOBAL_WEEKLY_USD_CAP: "none", GLOBAL_TOTAL_USD_CAP: "100" });
    const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    await record(service, { upstream: "openai", usd: 85, at: NOW - 7 * DAY }); // 15% left
    await tick(service);
    assert.equal(runwayTexts(service).length, 0);
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { runwayTotalCapShare: 0.2 } })).status, 200);
    await tick(service);
    const sent = runwayTexts(service);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /Total cap: \$85 of the \$100 all-time cap spent, \$15 left \(15%\)/);
  });
});
