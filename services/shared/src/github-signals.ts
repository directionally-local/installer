import { GITHUB_GRAPHQL_URL, type Fetch } from "./github.js";

/**
 * The GitHub signals the free tier reads at sign-in to decide an account's level: how old
 * the account is, how many public repositories it has, how many followers, and how much it
 * contributed in the last year (public, and private if the person shows them).
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
}

const SIGNALS_QUERY =
  "query { viewer { followers { totalCount } contributionsCollection { restrictedContributionsCount contributionCalendar { totalContributions } } } }";

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
      const body = (await response.json()) as {
        data?: {
          viewer?: {
            followers?: { totalCount?: unknown };
            contributionsCollection?: { restrictedContributionsCount?: unknown; contributionCalendar?: { totalContributions?: unknown } };
          };
        };
      };
      const viewer = body.data?.viewer;
      const followers = count(viewer?.followers?.totalCount);
      const contributions = count(viewer?.contributionsCollection?.contributionCalendar?.totalContributions);
      const restricted = count(viewer?.contributionsCollection?.restrictedContributionsCount) ?? 0;
      if (followers === undefined || contributions === undefined) throw new Error("GitHub GraphQL answered without the signals");
      return { followers, contributions, restrictedContributions: Math.min(restricted, contributions) };
    };
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}
