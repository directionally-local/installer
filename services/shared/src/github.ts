/**
 * GitHub sign-in through the OAuth web flow, shared by the services that sign people in.
 * The GitHub access token is used only while the callback request runs (to read who signed
 * in, and for the free tier, whether the account has any public activity) and never stored.
 * `fetch` is passed in so tests can stub GitHub.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubUser {
  id: number;
  login: string;
  /** Unix ms the GitHub account was created; undefined when GitHub didn't say. */
  createdAt: number | undefined;
  /** Public repositories the account owns; undefined when GitHub didn't say. */
  publicRepos: number | undefined;
}

/** A finished sign-in: the user, and the token to make further reads with during this request only. */
export interface GitHubSignIn {
  user: GitHubUser;
  accessToken: string;
}

export interface GitHubOAuthApp {
  clientId: string;
  clientSecret: string;
}

/**
 * The URL that starts sign-in. Without `scope` it asks for nothing beyond the public profile;
 * the free tier's sign-in passes `user:email` (read-only email addresses) to prefill the
 * contact email it asks for.
 */
export function githubAuthorizeUrl(app: Pick<GitHubOAuthApp, "clientId">, redirectUri: string, state: string, scope?: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

/** Exchanges the callback's `code` for the signed-in user. Undefined when GitHub says no. */
export async function githubUserFromCode(
  app: GitHubOAuthApp,
  code: string,
  redirectUri: string,
  fetcher: Fetch,
  userAgent = "directionallylocal",
): Promise<GitHubUser | undefined> {
  return (await githubSignInFromCode(app, code, redirectUri, fetcher, userAgent))?.user;
}

/** Like `githubUserFromCode`, with the access token for further reads in the same request. */
export async function githubSignInFromCode(
  app: GitHubOAuthApp,
  code: string,
  redirectUri: string,
  fetcher: Fetch,
  userAgent = "directionallylocal",
): Promise<GitHubSignIn | undefined> {
  const tokenResponse = await fetcher("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": userAgent },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }),
  });
  if (!tokenResponse.ok) return undefined;
  const token = (await tokenResponse.json().catch(() => ({}))) as { access_token?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token) return undefined;

  const userResponse = await fetcher("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.access_token}`,
      "user-agent": userAgent,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!userResponse.ok) return undefined;
  const user = (await userResponse.json().catch(() => ({}))) as { id?: unknown; login?: unknown; created_at?: unknown; public_repos?: unknown };
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || typeof user.login !== "string") return undefined;
  const createdAt = typeof user.created_at === "string" ? Date.parse(user.created_at) : Number.NaN;
  const publicRepos = typeof user.public_repos === "number" && Number.isSafeInteger(user.public_repos) && user.public_repos >= 0 ? user.public_repos : undefined;
  return {
    user: { id: user.id, login: user.login, createdAt: Number.isFinite(createdAt) ? createdAt : undefined, publicRepos },
    accessToken: token.access_token,
  };
}

/**
 * The signed-in account's primary verified email, read with its own token (needs the
 * `user:email` scope). Falls back to any verified address; undefined when there is none, the
 * token lacks the scope, or GitHub doesn't answer in time. Never throws.
 */
export async function githubPrimaryEmail(accessToken: string, fetcher: Fetch, userAgent = "directionallylocal", timeoutMs = 5000): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher("https://api.github.com/user/emails", {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": userAgent,
        "x-github-api-version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => [])) as unknown;
    if (!Array.isArray(body)) return undefined;
    const emails = body.filter(
      (entry): entry is { email: string; primary?: unknown; verified?: unknown } =>
        typeof entry === "object" && entry !== null && typeof (entry as { email?: unknown }).email === "string",
    );
    const usable = emails.filter((entry) => entry.verified === true && !entry.email.endsWith("@users.noreply.github.com"));
    return (usable.find((entry) => entry.primary === true) ?? usable[0])?.email;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The public profile fields the free tier re-reads weekly for a Starter account. */
export interface GitHubPublicProfile {
  createdAt: number | undefined;
  publicRepos: number | undefined;
  followers: number | undefined;
}

/**
 * GET https://api.github.com/users/<login>, unauthenticated: the HTTP status and the JSON body,
 * or undefined when GitHub doesn't answer within `timeoutMs` or the request fails.
 */
async function fetchPublicUser(login: string, fetcher: Fetch, userAgent: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": userAgent, "x-github-api-version": "2022-11-28" },
      signal: controller.signal,
    });
    if (!response.ok) return { status: response.status, body: {} };
    const body = (await response.json().catch(() => ({}))) as unknown;
    return { status: response.status, body: body && typeof body === "object" ? (body as Record<string, unknown>) : {} };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * An account's public profile, unauthenticated: age, public repositories and followers. Used
 * for the weekly Starter re-check, where the person's own token isn't available. Undefined
 * when GitHub doesn't answer or the profile isn't there.
 */
export async function githubPublicProfile(login: string, fetcher: Fetch, userAgent = "directionallylocal", timeoutMs = 5000): Promise<GitHubPublicProfile | undefined> {
  const found = await fetchPublicUser(login, fetcher, userAgent, timeoutMs);
  if (!found || found.status < 200 || found.status > 299) return undefined;
  const body = found.body;
  const createdAt = typeof body.created_at === "string" ? Date.parse(body.created_at) : Number.NaN;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined);
  return {
    createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
    publicRepos: count(body.public_repos),
    followers: count(body.followers),
  };
}

/**
 * A login's stable numeric GitHub id (and its current spelling), from the same public endpoint.
 * "not_found" when GitHub says there is no such user (404); "error" when it doesn't answer,
 * rate-limits, or answers with something else.
 */
export async function githubUserByLogin(login: string, fetcher: Fetch, userAgent = "directionallylocal", timeoutMs = 5000): Promise<{ id: number; login: string } | "not_found" | "error"> {
  const found = await fetchPublicUser(login, fetcher, userAgent, timeoutMs);
  if (!found) return "error";
  if (found.status === 404) return "not_found";
  if (found.status < 200 || found.status > 299) return "error";
  const { id, login: current, type } = found.body;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 || typeof current !== "string") return "error";
  // Organizations share the endpoint, but can't sign in.
  if (type !== undefined && type !== "User") return "not_found";
  return { id, login: current };
}

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
const CONTRIBUTIONS_QUERY = "query { viewer { contributionsCollection { contributionCalendar { totalContributions } } } }";

/**
 * The signed-in account's contributions over the last year (GitHub's default window for
 * `contributionsCollection`), read with that account's own token. Public contributions need
 * no OAuth scope; private ones count only if the person shows them on their profile. Throws
 * when GitHub errors, answers with something else, or takes longer than `timeoutMs`.
 */
export async function githubContributionsLastYear(accessToken: string, fetcher: Fetch, userAgent = "directionallylocal", timeoutMs = 5000): Promise<number> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`GitHub GraphQL took longer than ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const read = async (): Promise<number> => {
      const response = await fetcher(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${accessToken}`, "content-type": "application/json", "user-agent": userAgent },
        body: JSON.stringify({ query: CONTRIBUTIONS_QUERY }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GitHub GraphQL answered ${response.status}`);
      const body = (await response.json()) as { data?: { viewer?: { contributionsCollection?: { contributionCalendar?: { totalContributions?: unknown } } } } };
      const total = body.data?.viewer?.contributionsCollection?.contributionCalendar?.totalContributions;
      if (typeof total !== "number" || !Number.isFinite(total) || total < 0) throw new Error("GitHub GraphQL answered without a contribution count");
      return total;
    };
    return await Promise.race([read(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
