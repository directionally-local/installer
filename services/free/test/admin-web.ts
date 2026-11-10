import { ADMIN_ID, type Service } from "./harness.js";

/** The dashboard's browser session for the admin. */
export async function adminCookie(s: Service): Promise<string> {
  const start = await s.request("GET", "/admin/signin");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const oauthCookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const response = await s.request("GET", `/device/callback?code=${encodeURIComponent(JSON.stringify({ id: ADMIN_ID, login: "owner" }))}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: oauthCookie },
  });
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-dl_admin="))!.split(";")[0]!;
}

export const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]{64})"/.exec(html)![1]!;

/** The Tools tab's form, posted the way a browser on the page posts it. */
export async function tools(s: Service, cookie: string, form: Record<string, string>): Promise<{ status: number; html: string }> {
  const page = await (await s.request("GET", "/admin?view=tools", { headers: { cookie } })).text();
  const response = await s.request("POST", "/admin/dashboard/tools", { headers: { cookie, origin: "https://free.test" }, form: { csrf: csrfOf(page), ...form } });
  return { status: response.status, html: await response.text() };
}
