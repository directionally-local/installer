import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { ADMIN_ID, createInvite, createService, errorCode, MODEL, startBrowserFlow, type GitHubUserFixture, type Service } from "./harness.js";

/**
 * The additional account signals behind Full: active weeks, contributions to others' work, an
 * old repository, following plus stars, and followers, plus the creation-batch check. Their
 * thresholds are runtime settings; nothing a person is shown names them.
 */

// The public bar as it is run: 1 year old with 100 contributions (the repos path off), and no
// Starter allowance, so an account below it gets the below_bar refusal. The basic level is off
// here (basic.test.ts covers it), so these accounts stay Starter.
const BAR = {
  OPENAI_API_KEY: "sk-test",
  OPEN_ADMISSION: "true",
  STARTER_WEEKLY_TOKENS: "0",
  BASIC_WEEKLY_TOKENS: "0",
  FULL_MIN_ACCOUNT_AGE_DAYS: "365",
  FULL_MIN_CONTRIBUTIONS: "100",
  FULL_MIN_PUBLIC_REPOS: "100000",
  NETWORK_SIGNUPS_PER_DAY: "1000",
  DOMAIN_SIGNUPS_PER_DAY: "1000",
};
const YOUNG = "2026-06-01T00:00:00Z"; // about 5 months before the harness clock: below the age bar
const OLD = "2015-01-01T00:00:00Z";
const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };

async function open(vars: Record<string, string> = {}): Promise<{ service: Service; admin: string }> {
  const service = await createService({ ...BAR, ...vars });
  const admin = (await service.signIn({ id: ADMIN_ID, login: "owner" })).access_token;
  return { service, admin };
}

async function person(service: Service, admin: string, githubId: number): Promise<Record<string, any>> {
  const res = (await (await service.request("GET", "/admin/people", { token: admin })).json()) as { people: Array<Record<string, any>> };
  return res.people.find((row) => row.githubId === githubId)!;
}

const chat = (service: Service, token: string) => service.request("POST", "/v1/chat/completions", { token, body });

/** Below the public bar (young, few contributions, no public repositories). */
const below = (id: number, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({ id, login: `user${id}`, createdAt: YOUNG, publicRepos: 0, contributions: 10, social: 0, ...extra });
/** Above the public bar: old, with 250 contributions. */
const above = (id: number, extra: Partial<GitHubUserFixture> = {}): GitHubUserFixture => ({ id, login: `user${id}`, createdAt: OLD, publicRepos: 0, contributions: 250, social: 0, ...extra });

describe("additional account signals", () => {
  it("never gives Full below the public bar, whatever the additional signals, and stores them as numbers", async () => {
    const { service, admin } = await open();
    const tokens = await service.signIn(below(100, { activeWeeks: 10, social: 20, followers: 5, outsideCommits: 1 }));
    const row = await person(service, admin, 100);
    assert.equal(row.level, "starter");
    assert.equal(row.levelReason, "account_too_new", "the public reason only");
    assert.equal(row.signals.activeWeeks, 10);
    assert.equal(row.signals.outsideContributions, 1);
    assert.equal(row.signals.oldestRepoCreatedAt, null);
    assert.equal(row.signals.social, 20);
    assert.equal(row.signals.followers, 5);
    assert.equal(row.signals.githubCreatedDay, "2026-06-01");
    assert.deepEqual(row.checks, {
      publicBar: false,
      activeWeeks: true,
      outsideContributions: true,
      oldRepo: false,
      social: true,
      followers: true,
      humanSignals: 4,
      batchPeers: 0,
      creationBatch: false,
      full: false,
    });
    assert.equal(await errorCode(await chat(service, tokens.access_token)), "below_bar");
  });

  it("counts pull requests, outside commits and an old non-fork repository", async () => {
    const { service, admin } = await open();
    await service.signIn(above(100, { pullRequests: 0, outsideCommits: 4, repoCreatedAt: "2025-01-01T00:00:00Z" }));
    const row = await person(service, admin, 100);
    assert.equal(row.signals.outsideContributions, 4, "commits to the account's own repositories don't count");
    assert.equal(row.checks.oldRepo, true);
    assert.equal(row.level, "full");
    // A fork doesn't count as the account's own repository.
    await service.signIn(above(101, { outsideCommits: 4, repoCreatedAt: "2025-01-01T00:00:00Z", repoIsFork: true }));
    const fork = await person(service, admin, 101);
    assert.equal(fork.signals.oldestRepoCreatedAt, null);
    assert.equal(fork.level, "starter");
  });

  it("keeps a public-bar account with only one signal on Starter, with the usual below_bar message", async () => {
    const { service, admin } = await open();
    const tokens = await service.signIn(above(100, { activeWeeks: 30 }));
    const row = await person(service, admin, 100);
    assert.equal(row.checks.publicBar, true);
    assert.equal(row.checks.humanSignals, 1);
    assert.equal(row.level, "starter");
    // The person is told the public reason only.
    assert.equal(row.levelReason, "few_repos_and_contributions");
    const res = await chat(service, tokens.access_token);
    assert.equal(res.status, 403);
    assert.equal(await errorCode(res), "below_bar");
    // With a second signal the public bar is enough.
    await service.signIn(above(101, { activeWeeks: 30, followers: 3 }));
    assert.equal((await person(service, admin, 101)).level, "full");
  });

  it("keeps a sign-up farm account off Full and off free tokens: a young creation batch that follows itself", async () => {
    // A Starter allowance and the basic level both on, so the batch flag is what gives 0 tokens.
    const { service, admin } = await open({ STARTER_WEEKLY_TOKENS: "5000000", BASIC_WEEKLY_TOKENS: "10000000", BASIC_MIN_ACCOUNT_AGE_DAYS: "30" });
    const day = new Date(service.clock.now - 100 * 86_400_000).toISOString();
    const nextDay = new Date(service.clock.now - 99 * 86_400_000).toISOString();
    // Twenty farm accounts already signed up, created within a day of each other.
    for (let id = 200; id < 220; id++) await service.signIn(below(id, { createdAt: id % 2 === 0 ? day : nextDay, followers: 11, outsideCommits: 1, social: 30 }));
    // One more: 100 days old, following and followed by the others, one contribution to another's repository.
    const tokens = await service.signIn(below(100, { createdAt: day, followers: 11, outsideCommits: 1, social: 30 }));
    const farm = await person(service, admin, 100);
    assert.equal(farm.checks.publicBar, false);
    assert.equal(farm.checks.humanSignals, 3);
    assert.equal(farm.checks.batchPeers, 20);
    assert.equal(farm.checks.creationBatch, true, "followers don't get an account out of a batch");
    assert.equal(farm.checks.full, false);
    assert.equal(farm.level, "starter", "never basic while flagged");
    assert.equal((await service.directory().getPerson(100))?.batch_flag, 1);
    assert.equal(await errorCode(await chat(service, tokens.access_token)), "below_bar", "0 tokens");
    // A young account created well apart from the batch isn't in it: Starter's allowance.
    const apart = await service.signIn(below(102, { createdAt: new Date(service.clock.now - 60 * 86_400_000).toISOString(), followers: 11, outsideCommits: 1, social: 30 }));
    assert.equal((await person(service, admin, 102)).checks.batchPeers, 0);
    assert.equal((await person(service, admin, 102)).checks.creationBatch, false);
    assert.equal((await chat(service, apart.access_token)).status, 200);
  });

  it("never flags an established account created on a busy day, and gives it Full with the public bar", async () => {
    const { service, admin } = await open();
    for (let id = 200; id < 220; id++) await service.signIn(below(id, { createdAt: OLD }));
    const tokens = await service.signIn(above(100, { activeWeeks: 30, followers: 5, social: 20 }));
    const row = await person(service, admin, 100);
    assert.equal(row.checks.batchPeers, 20);
    assert.equal(row.checks.creationBatch, false);
    assert.equal(row.level, "full");
    assert.equal(row.levelReason, "qualifies");
    assert.equal((await chat(service, tokens.access_token)).status, 200);
  });

  for (const failure of ["error", "throw"] as const) {
    it(`fails open to Full when GitHub's GraphQL API fails (${failure})`, async () => {
      const { service, admin } = await open();
      const tokens = await service.signIn(below(100, { contributions: failure }));
      const row = await person(service, admin, 100);
      assert.equal(row.level, "full");
      assert.equal(row.signals.activeWeeks, null, "nothing read, nothing stored");
      assert.equal((await chat(service, tokens.access_token)).status, 200);
    });
  }

  it("takes every threshold from the admin settings", async () => {
    const { service, admin } = await open();
    const config = async (settings: Record<string, unknown>) => assert.equal((await service.request("POST", "/admin/config", { token: admin, body: settings })).status, 200);
    // The public bar and one signal: Starter by default (one fewer than humanSignalsNeeded).
    await service.signIn(above(100, { activeWeeks: 10 }));
    assert.equal((await person(service, admin, 100)).level, "starter");
    await config({ humanSignalsNeeded: 2 });
    await service.signIn(above(101, { activeWeeks: 10 }));
    assert.equal((await person(service, admin, 101)).level, "full");
    // Below the public bar no setting gives Full.
    await service.signIn(below(110, { activeWeeks: 10, social: 20, followers: 5 }));
    assert.equal((await person(service, admin, 110)).level, "starter");
    await config({ humanSignalsNeeded: null, minActiveWeeks: 11 });
    await service.signIn(above(102, { activeWeeks: 10, social: 20, followers: 3 }));
    assert.equal((await person(service, admin, 102)).checks.activeWeeks, false);
    await config({ minActiveWeeks: null, minSocial: 21, minFollowers: 4, minRepoAgeDays: 10 });
    const row = await person(service, admin, 102);
    assert.deepEqual([row.checks.activeWeeks, row.checks.social, row.checks.followers], [true, false, false], "the admin view uses today's settings");
    await service.signIn(above(103, { social: 30, repoCreatedAt: "2026-10-01T00:00:00Z" }));
    assert.equal((await person(service, admin, 103)).level, "full", "a 34-day-old repository is old enough at 10 days");
    // The batch check: size and window, and 0 turns it off. Only accounts younger than the bar's age.
    await config({ batchSize: 1, batchWindowDays: 0 });
    await service.signIn(below(104, { activeWeeks: 10, social: 30, followers: 5, outsideCommits: 1 }));
    assert.equal((await person(service, admin, 104)).checks.creationBatch, true, "account 110 was created the same day");
    assert.equal((await person(service, admin, 104)).level, "starter");
    await service.signIn(above(106, { activeWeeks: 10, social: 30 }));
    assert.equal((await person(service, admin, 106)).checks.creationBatch, false, "older than the bar's age");
    assert.equal((await person(service, admin, 106)).level, "full");
    await config({ batchSize: 0 });
    await service.signIn(below(105, { activeWeeks: 10, social: 30, followers: 0, outsideCommits: 1 }));
    assert.equal((await person(service, admin, 105)).checks.creationBatch, false);
    // The settings are listed with the rest.
    const settings = ((await (await service.request("GET", "/admin/config", { token: admin })).json()) as { effective: Record<string, unknown> }).effective;
    for (const name of ["humanSignalsNeeded", "minActiveWeeks", "minRepoAgeDays", "minSocial", "minFollowers", "batchWindowDays", "batchSize"]) assert.ok(name in settings, name);
  });

  it("names only the public bar, /request and the email route in what a Starter account is shown", async () => {
    const { service } = await open();
    const hidden = /follow|star|week(?!ly)|fork|batch|signal|review|pull request|issue|oldest|creat/i;
    const tokens = await service.signIn(above(100));
    const res = await chat(service, tokens.access_token);
    const message = ((await res.json()) as { error: { message: string } }).error.message;
    assert.match(message, /at least 1 year old with 100\+ contributions in the last year/);
    assert.match(message, /contact@directionallylocal\.com/);
    assert.match(message, /Type \/request in dl/);
    assert.doesNotMatch(message, hidden);
    const flow = await startBrowserFlow(service.request, above(101), undefined, { stopAtDetails: true });
    const line = /Free tokens are for[^<]*/.exec(flow.page)?.[0] ?? "";
    assert.ok(line.length > 0);
    assert.doesNotMatch(line, hidden);
    // /v1/me shows the public thresholds and signals only.
    const me = (await (await service.request("GET", "/v1/me", { token: tokens.access_token })).json()) as Record<string, any>;
    assert.deepEqual(Object.keys(me.thresholds).sort(), ["minAccountAgeDays", "minContributions", "minPublicRepos"]);
    assert.deepEqual(Object.keys(me.signals).sort(), ["accountAgeDays", "checkedAt", "contributions", "followers", "publicRepos", "restrictedContributions"]);
    assert.doesNotMatch(JSON.stringify(me.levelReason), hidden);
  });
});

describe("the weekly re-check with the additional signals", () => {
  async function starterWithKey(user: GitHubUserFixture): Promise<{ service: Service; admin: string; key: string }> {
    const { service, admin } = await open();
    const { access_token } = await service.signIn(user);
    // A server key outlives the access token, so the clock can move a week.
    const key = ((await (await service.request("POST", "/v1/keys", { token: access_token, body: { name: "test" } })).json()) as { key: string }).key;
    return { service, admin, key };
  }

  it("promotes when the stored signals plus the public profile now pass", async () => {
    const { service, key } = await starterWithKey(above(100, { activeWeeks: 10 }));
    assert.equal((await service.directory().getPerson(100))?.level, "starter");
    // No token on the re-check: the profile adds followers; the rest is what sign-in stored.
    service.setGithubProfile((login) => Response.json({ login, email: null, created_at: OLD, public_repos: 0, followers: 3 }));
    service.clock.now += 8 * 86_400_000;
    assert.equal((await chat(service, key)).status, 200);
    const row = await service.directory().getPerson(100);
    assert.equal(row?.level, "full");
    assert.equal(row?.active_weeks, 10, "stored signals are kept");
  });

  it("doesn't promote when they still don't pass", async () => {
    const { service, key } = await starterWithKey(below(100, { activeWeeks: 10 }));
    service.setGithubProfile((login) => Response.json({ login, email: null, created_at: YOUNG, public_repos: 0, followers: 3 }));
    service.clock.now += 8 * 86_400_000;
    assert.equal(await errorCode(await chat(service, key)), "below_bar");
    assert.equal((await service.directory().getPerson(100))?.level, "starter");
  });

  it("never demotes Full", async () => {
    const { service, admin, key } = await starterWithKey(above(100, { activeWeeks: 10, social: 20, followers: 5 }));
    assert.equal((await service.directory().getPerson(100))?.level, "full");
    // Tighter settings and a profile that no longer passes: still Full.
    assert.equal((await service.request("POST", "/admin/config", { token: admin, body: { humanSignalsNeeded: 5 } })).status, 200);
    service.setGithubProfile((login) => Response.json({ login, email: null, created_at: OLD, public_repos: 0, followers: 0 }));
    service.clock.now += 8 * 86_400_000;
    assert.equal((await chat(service, key)).status, 200);
    assert.equal((await service.directory().getPerson(100))?.level, "full");
  });

  it("leaves an admin's choice of Starter alone, even when the signals pass", async () => {
    const { service, admin, key } = await starterWithKey(above(100, { activeWeeks: 10, social: 20, followers: 5 }));
    assert.equal((await service.request("POST", "/admin/people/100/level", { token: admin, body: { level: "starter" } })).status, 200);
    service.setGithubProfile((login) => Response.json({ login, email: null, created_at: OLD, public_repos: 0, followers: 5 }));
    service.clock.now += 8 * 86_400_000;
    assert.equal(await errorCode(await chat(service, key)), "below_bar");
    const row = await service.directory().getPerson(100);
    assert.equal(row?.level, "starter");
    assert.equal(row?.level_reason, "admin");
  });

  it("moves a basic account the creation-batch check now flags to Starter with no free tokens, but never an admin's basic", async () => {
    const { service, admin } = await open({ BASIC_WEEKLY_TOKENS: "10000000", BASIC_MIN_ACCOUNT_AGE_DAYS: "30" });
    const day = new Date(service.clock.now - 100 * 86_400_000).toISOString();
    const keyFor = async (user: GitHubUserFixture) => {
      const { access_token } = await service.signIn(user);
      return ((await (await service.request("POST", "/v1/keys", { token: access_token, body: { name: "test" } })).json()) as { key: string }).key;
    };
    // Signed up before the rest of its batch: basic.
    const key = await keyFor(below(100, { createdAt: day }));
    const kept = await keyFor(below(101, { createdAt: day }));
    assert.equal((await service.directory().getPerson(100))?.level, "basic");
    assert.equal((await service.request("POST", "/admin/people/101/level", { token: admin, body: { level: "basic" } })).status, 200);
    for (let id = 200; id < 220; id++) await service.signIn(below(id, { createdAt: day, followers: 11 }));
    service.setGithubProfile((login) => Response.json({ login, email: null, created_at: day, public_repos: 0, followers: 11 }));
    service.clock.now += 8 * 86_400_000;
    assert.equal(await errorCode(await chat(service, key)), "below_bar");
    const row = await service.directory().getPerson(100);
    assert.equal(row?.level, "starter");
    assert.equal(row?.batch_flag, 1);
    assert.equal((await chat(service, kept)).status, 200, "an admin's level stands");
    assert.equal((await service.directory().getPerson(101))?.level, "basic");
  });

  it("keeps an invite's Full when the signals don't pass", async () => {
    const { service, admin } = await open({ OPEN_ADMISSION: "false" });
    const invite = await createInvite(service, admin);
    const tokens = await service.signIn(below(100), { invite });
    const row = await person(service, admin, 100);
    assert.equal(row.level, "full");
    assert.equal(row.levelReason, "invite");
    assert.equal(row.checks.full, false);
    assert.equal((await chat(service, tokens.access_token)).status, 200);
  });
});

describe("the admin views of the additional signals", () => {
  it("lists Starter accounts with their signals and checks on the full dashboard", async () => {
    const { service, admin } = await open();
    await service.signIn(above(100, { activeWeeks: 30 }));
    await service.signIn(above(101, { activeWeeks: 10, social: 20, followers: 5 }));
    const page = await (await service.request("GET", "/admin?view=full", { token: admin })).text();
    assert.match(page, /<h2>Starter accounts<\/h2>/);
    assert.match(page, /user100/);
    assert.doesNotMatch(page.slice(page.indexOf("<h2>Starter accounts</h2>")), /user101/, "Full accounts aren't listed");
  });

  it("backfills the creation day from the stored age on start", async () => {
    const { service, admin } = await open();
    await service.signIn(below(100));
    service.directory();
    const namespace = service.namespaces.DIRECTORY! as unknown as { Class: new (ctx: never, env: never) => unknown; instances: Map<string, { state: { db: DatabaseSync } }> };
    const entry = namespace.instances.get("directory")!;
    // A row from before the creation day was stored.
    entry.state.db.exec("UPDATE people SET github_created_day = NULL WHERE github_id = 100");
    assert.equal((await person(service, admin, 100)).signals.githubCreatedDay, null);
    // The object starting again on the same storage.
    new namespace.Class(entry.state as never, {} as never);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await person(service, admin, 100)).signals.githubCreatedDay, "2026-06-01");
  });
});
