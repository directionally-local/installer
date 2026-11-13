import { GITHUB_GRAPHQL_URL, type Fetch } from "./github.js";

/**
 * The GitHub signals the free tier reads at sign-in to decide an account's level: how old
 * the account is, how many public repositories it has, how many followers, how much it
 * contributed in the last year (public, and private if the person shows them), and a few more
 * account signals from the same public profile data.
 *
 * Only numbers are kept. No repository names, no contents, no email.
 */

export interface GitHubSignals {
  /** Followers on the public profile. */
  followers: number;
  /** Contributions in the last 12 months, public ones plus the private ones the person shows. */
  contributions: number;
  /** The private part of `contributions`, when the person shows private contributions. */
  restrictedContributions: number;
  /** Weeks of the last year's contribution calendar with at least one contribution. */
  activeWeeks: number;
  /**
   * Contributions to other people's work in the last year: pull requests, issues and reviews,
   * plus commits to repositories the account doesn't own (of its 25 most committed-to).
   */
  outsideContributions: number;
  /** When the oldest non-fork repository among the account's five oldest owned ones was created (Unix ms); null for none. */
  oldestRepoCreatedAt: number | null;
  /** Accounts followed plus repositories starred. */
  social: number;
}

const SIGNALS_QUERY = [
  "query { viewer { login followers { totalCount } following { totalCount } starredRepositories { totalCount }",
  " repositories(ownerAffiliations: OWNER, first: 5, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { createdAt isFork } }",
  " contributionsCollection { restrictedContributionsCount totalPullRequestContributions totalIssueContributions totalPullRequestReviewContributions",
  " commitContributionsByRepository(maxRepositories: 25) { repository { owner { login } } contributions { totalCount } }",
  " contributionCalendar { totalContributions weeks { contributionDays { contributionCount } } } } } }",
].join("");

interface Viewer {
  login?: unknown;
  followers?: { totalCount?: unknown };
  following?: { totalCount?: unknown };
  starredRepositories?: { totalCount?: unknown };
  repositories?: { nodes?: Array<{ createdAt?: unknown; isFork?: unknown } | null> | null };
  contributionsCollection?: {
    restrictedContributionsCount?: unknown;
    totalPullRequestContributions?: unknown;
    totalIssueContributions?: unknown;
    totalPullRequestReviewContributions?: unknown;
    commitContributionsByRepository?: Array<{ repository?: { owner?: { login?: unknown } }; contributions?: { totalCount?: unknown } } | null> | null;
    contributionCalendar?: { totalContributions?: unknown; weeks?: Array<{ contributionDays?: Array<{ contributionCount?: unknown } | null> | null } | null> | null };
  };
}

/**
 * The signed-in account's signals, read with that account's own token. Public data needs no
 * OAuth scope; private contributions count only if the person shows them on their profile.
 * Throws when GitHub errors, answers with something else, or takes longer than `timeoutMs`.
 */
export async function githubSignals(accessToken: string, fetcher: Fetch, userAgent = "directionallylocal", timeoutMs = 5000): Promise<GitHubSignals> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`GitHub GraphQL took longer than ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const read = async (): Promise<GitHubSignals> => {
      const response = await fetcher(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": userAgent },
        body: JSON.stringify({ query: SIGNALS_QUERY }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub GraphQL answered ${response.status}`);
      const body = (await response.json()) as { data?: { viewer?: Viewer } };
      const viewer = body.data?.viewer;
      if (!viewer) throw new Error("GitHub GraphQL answered without the signals");
      return signalsOf(viewer);
    };
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The numbers from a GraphQL viewer. Throws when a count is missing, so the caller fails open. */
function signalsOf(viewer: Viewer): GitHubSignals {
  const collection = viewer.contributionsCollection;
  const followers = count(viewer.followers?.totalCount);
  const contributions = count(collection?.contributionCalendar?.totalContributions);
  const restricted = count(collection?.restrictedContributionsCount) ?? 0;
  const following = count(viewer.following?.totalCount);
  const starred = count(viewer.starredRepositories?.totalCount);
  const pullRequests = count(collection?.totalPullRequestContributions);
  const issues = count(collection?.totalIssueContributions);
  const reviews = count(collection?.totalPullRequestReviewContributions);
  if ([followers, contributions, following, starred, pullRequests, issues, reviews].some((value) => value === undefined)) {
    throw new Error("GitHub GraphQL answered without the signals");
  }
  const login = typeof viewer.login === "string" ? viewer.login.toLowerCase() : undefined;
  let outsideCommits = 0;
  for (const entry of collection?.commitContributionsByRepository ?? []) {
    const owner = entry?.repository?.owner?.login;
    if (typeof owner !== "string" || owner.toLowerCase() === login) continue;
    outsideCommits += count(entry?.contributions?.totalCount) ?? 0;
  }
  let activeWeeks = 0;
  for (const week of collection?.contributionCalendar?.weeks ?? []) {
    if ((week?.contributionDays ?? []).some((day) => (count(day?.contributionCount) ?? 0) > 0)) activeWeeks++;
  }
  let oldestRepoCreatedAt: number | null = null;
  for (const repo of viewer.repositories?.nodes ?? []) {
    if (!repo || repo.isFork !== false || typeof repo.createdAt !== "string") continue;
    const at = Date.parse(repo.createdAt);
    if (Number.isFinite(at) && (oldestRepoCreatedAt === null || at < oldestRepoCreatedAt)) oldestRepoCreatedAt = at;
  }
  return {
    followers: followers!,
    contributions: contributions!,
    restrictedContributions: Math.min(restricted, contributions!),
    activeWeeks,
    outsideContributions: pullRequests! + issues! + reviews! + outsideCommits,
    oldestRepoCreatedAt,
    social: following! + starred!,
  };
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
