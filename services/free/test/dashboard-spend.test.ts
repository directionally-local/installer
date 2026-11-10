import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService } from "./harness.js";
import { admissionText, creditProviders, queueStart, routes, spendTotals, type SpendView } from "../src/dashboard-page.js";
import type { DashboardData } from "../src/dashboard-data.js";

const MONDAY = Date.parse("2026-11-09T00:00:00Z");

/** A spend view with numbers like the live ones: OpenAI the main provider, Luminal for DeepSeek. */
function view(overrides: Partial<SpendView> = {}): SpendView {
  return {
    weekUsd: 0,
    totalUsd: 0,
    adminWeekUsd: 0,
    adminTotalUsd: 0,
    weeklyCapUsd: null,
    totalCapUsd: null,
    resetsAt: MONDAY + 7 * 86_400_000,
    paused: false,
    pausedByEnv: false,
    openAdmission: true,
    requireGithubActivity: true,
    maxActiveUsers: 50,
    weeklyTokens: 50_000_000,
    perPersonWeeklyUsd: 20,
    queueThreshold: 0.8,
    primaryUpstream: "openai",
    luminalConfigured: true,
    serving: "openai",
    openRouterConfigured: true,
    openaiConfigured: true,
    creditUsd: 2000,
    creditUsedUsd: 28.75,
    creditWeekUsd: 16.08,
    freeCreditWeekUsd: 12,
    weeklyCreditUsd: 250,
    openaiCreditUsd: 5000,
    openaiCreditUsedUsd: 17.04,
    openaiCreditWeekUsd: 14.93,
    openaiFreeCreditWeekUsd: 10,
    openaiWeeklyCreditUsd: 2000,
    starterWeeklyTokens: 0,
    fullMinAccountAgeDays: 365,
    fullMinPublicRepos: 100_000,
    fullMinContributions: 100,
    ...overrides,
  };
}

const data = { now: MONDAY + 86_400_000, currentWeek: MONDAY, queue: { waiting: 0 } } as unknown as DashboardData;

describe("dashboard spend card", () => {
  it("adds every provider's credit and the older metered spend", () => {
    const totals = spendTotals(view({ totalUsd: 1.5, adminTotalUsd: 0.5, weekUsd: 0.25 }));
    assert.equal(totals.meteredAllTimeUsd, 2);
    assert.equal(totals.allTimeUsd, 47.79);
    assert.equal(totals.weekUsd, 31.26);
    assert.deepEqual(
      creditProviders(view()).map((row) => [row.name, row.usedUsd, row.balanceUsd, row.weekUsd]),
      [
        ["OpenAI", 17.04, 5000, 14.93],
        ["Luminal", 28.75, 2000, 16.08],
      ],
    );
  });

  it("names where each model goes, as servingModel routes it", () => {
    assert.deepEqual(routes(view()), { gpt: "OpenAI", deepseek: "Luminal" });
    // OpenAI and Luminal route the same; only OpenRouter moves DeepSeek.
    assert.deepEqual(routes(view({ primaryUpstream: "luminal" })), { gpt: "OpenAI", deepseek: "Luminal" });
    assert.deepEqual(routes(view({ primaryUpstream: "openrouter" })), { gpt: "OpenAI", deepseek: "OpenRouter" });
    assert.deepEqual(routes(view({ primaryUpstream: "openrouter", openRouterConfigured: false })), { gpt: "OpenAI", deepseek: "Luminal" });
    assert.deepEqual(routes(view({ openaiCreditUsedUsd: 5000 })), { gpt: "DeepSeek on Luminal (fallback)", deepseek: "Luminal" });
    assert.deepEqual(routes(view({ openaiConfigured: false, luminalConfigured: false, openRouterConfigured: false })), { gpt: "nowhere", deepseek: "nowhere" });
  });

  it("puts the waiting line's start on the budget the queue watches", () => {
    const openai = queueStart(view(), data);
    assert.equal(openai.provider, "OpenAI");
    assert.equal(openai.budgetUsd, 2000);
    assert.equal(openai.startUsd, 1600);
    assert.equal(openai.watchedUsd, 12, "shouldQueue compares free Luminal credit this week");
    const luminal = queueStart(view({ primaryUpstream: "luminal" }), data);
    assert.equal(luminal.provider, "Luminal");
    assert.equal(luminal.startUsd, 200);
    const openrouter = queueStart(view({ primaryUpstream: "openrouter" }), data);
    assert.equal(openrouter.startUsd, null);
    assert.match(openrouter.text, /Routed to OpenRouter/);
  });

  it("writes admission from the effective public bar, never the private thresholds", () => {
    const text = admissionText(view(), 120);
    assert.equal(
      text,
      "Admission: open, any GitHub account can sign up; 120 admitted, no cap while open. Free tokens (Full) need a GitHub account at least 365 days old with 100+ contributions in the last year, and the private account checks count too; below that, Starter: no free tokens.",
    );
    assert.doesNotMatch(text, /public repo/, "the repositories path is off at 100,000");
    assert.match(admissionText(view({ fullMinPublicRepos: 3, fullMinAccountAgeDays: 90, fullMinContributions: 50, starterWeeklyTokens: 2_000_000 }), 1), /at least 90 days old with 50\+ contributions in the last year or 3\+ public repos.*Starter: 2\.0M DeepSeek tokens a week/);
    assert.match(admissionText(view({ requireGithubActivity: false }), 1), /GitHub account check off: everyone gets Full\./);
    assert.match(admissionText(view({ openAdmission: false }), 7), /^Admission: invite-only; 7 of 50 admitted\./);
  });

  it("shows one Spend card with a row per provider, and admission from config, on /admin", async () => {
    const service = await createService({
      OPEN_ADMISSION: "true",
      OPENAI_API_KEY: "sk-openai",
      LUMINAL_API_KEY: "lum",
      FULL_MIN_ACCOUNT_AGE_DAYS: "365",
      FULL_MIN_CONTRIBUTIONS: "100",
      FULL_MIN_PUBLIC_REPOS: "100000",
      STARTER_WEEKLY_TOKENS: "0",
      HUMAN_SIGNALS_NEEDED: "4",
      MIN_ACTIVE_WEEKS: "37",
      MIN_SOCIAL: "41",
      MIN_FOLLOWERS: "43",
    });
    const adminToken = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
    const html = await (await service.request("GET", "/admin", { token: adminToken })).text();
    assert.match(html, /<section id="budget">\n<div class="head"><h2>Spend<\/h2><a href="\/admin\/dashboard\/spend\.csv" download>CSV<\/a><\/div>/);
    assert.doesNotMatch(html, /Budget: Luminal credit|Queue starts at|Serving from|Switch upstream/);
    assert.match(html, /Spent, all time<b>\$0<\/b><span class="note">OpenAI \$0 \+ Luminal \$0 \+ \$0 older metered OpenRouter spend/);
    assert.match(html, /<tr><td>OpenAI<\/td><td class="l wrap">GPT-6 Luna, GPT-6\.1 Sol, GPT-6 Astra<\/td><td class="used">\$0 <span class="muted">of \$5,000<\/span>/);
    assert.match(html, /<tr><td>Luminal<\/td><td class="l wrap">DeepSeek V4\.1 Flash 1017; the GPT-6 fallback<\/td>/);
    assert.match(html, /<tr><td>OpenRouter <span class="muted">\(older, metered\)<\/span><\/td>/);
    assert.match(html, /GPT-6 → <strong>OpenAI<\/strong><\/span><span>DeepSeek → <strong>Luminal<\/strong>/);
    assert.match(html, /Waiting line starts at<b>\$1,600 <span class="muted">a week<\/span><\/b><span class="note">New open sign-ups get an account but wait in line for free tokens once this week's free Luminal credit spend \(\$0 so far\) reaches this: 80% of the \$2,000 OpenAI weekly credit budget\./);
    const state = /State<b class="state">[^<]*<\/b><span class="note">([^<]*)<\/span>/.exec(html)?.[1] ?? "";
    assert.match(state, /Free tokens \(Full\) need a GitHub account at least 365 days old with 100\+ contributions in the last year/);
    assert.doesNotMatch(state, /public repo|old enough/);
    for (const secret of ["37", "41", "43", "active weeks", "followers", "signals needed"]) assert.ok(!state.includes(secret), secret);

    const csv = (await (await service.request("GET", "/admin/dashboard/spend.csv", { token: adminToken })).text()).trim().split("\r\n");
    const row = Object.fromEntries(csv[0]!.split(",").map((name, index) => [name, csv[1]!.split(",")[index]]));
    assert.equal(row.openai_credit_usd, "5000");
    assert.equal(row.spent_all_time_usd, "0");
  });
});
