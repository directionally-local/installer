import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ID, createService } from "./harness.js";
import { creditProviders, spendTotals, type SpendView } from "../src/dashboard-page.js";
import { weeklyBudget } from "../src/admin-home-page.js";

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
    starterWeeklyUsd: 0.5,
    basicWeeklyTokens: 10_000_000,
    basicWeeklyUsd: 3,
    basicMinAccountAgeDays: 365,
    fullMinAccountAgeDays: 365,
    fullMinPublicRepos: 100_000,
    fullMinContributions: 100,
    ...overrides,
  };
}

describe("dashboard spend", () => {
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

  it("puts this week's free use against the configured weekly credit budgets on the home page's Global Budget card", () => {
    // Free credit this week (OpenAI $10 + Luminal $12) plus free OpenRouter cash, of $2,000 + $250.
    assert.deepEqual(weeklyBudget(view({ weekUsd: 0.5 })), { usedUsd: 22.5, totalUsd: 2250 });
    // Without credit budgets, the global weekly cap; without that either, none.
    assert.deepEqual(weeklyBudget(view({ weeklyCreditUsd: null, openaiWeeklyCreditUsd: null, weeklyCapUsd: 300 })), { usedUsd: 22, totalUsd: 300 });
    assert.deepEqual(weeklyBudget(view({ weeklyCreditUsd: null, openaiWeeklyCreditUsd: null })), { usedUsd: 22, totalUsd: null });
  });

  it("writes the spend CSV from config and the counters", async () => {
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
    const csv = (await (await service.request("GET", "/admin/dashboard/spend.csv", { token: adminToken })).text()).trim().split("\r\n");
    const row = Object.fromEntries(csv[0]!.split(",").map((name, index) => [name, csv[1]!.split(",")[index]]));
    assert.equal(row.openai_credit_usd, "5000");
    assert.equal(row.spent_all_time_usd, "0");
  });
});
