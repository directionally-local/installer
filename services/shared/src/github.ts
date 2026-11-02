/**
 * GitHub sign-in through the OAuth web flow, shared by the services that sign people in.
 * The GitHub access token is used once, to read who signed in, and never stored. `fetch` is
 * passed in so tests can stub GitHub.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubUser {
  id: number;
  login: string;
  /** Unix ms the GitHub account was created; undefined when GitHub didn't say. */
  createdAt: number | undefined;
}

export interface GitHubOAuthApp {
  clientId: string;
  clientSecret: string;
}

/** The URL that starts sign-in. No scopes: the public profile is all we read. */
export function githubAuthorizeUrl(app: Pick<GitHubOAuthApp, "clientId">, redirectUri: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
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
  const user = (await userResponse.json().catch(() => ({}))) as { id?: unknown; login?: unknown; created_at?: unknown };
  if (typeof user.id !== "number" || !Number.isSafeInteger(user.id) || typeof user.login !== "string") return undefined;
  const createdAt = typeof user.created_at === "string" ? Date.parse(user.created_at) : Number.NaN;
  return { id: user.id, login: user.login, createdAt: Number.isFinite(createdAt) ? createdAt : undefined };
}
