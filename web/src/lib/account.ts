// Accounts in the web app (the server side is src/server/routes/account.ts). Only with ALLEVIA_AUTH=1: the session lives in an
// HttpOnly cookie the page never sees, so this file only calls the API and reads what it answers. A sign-in, a sign-up or a
// sign-out reloads the app, so it starts again from what the server says the browser may open.
import { ApiError, errorFrom } from "./sse";

export interface AccountUser { id: string; email: string; name: string }
export interface AccountBusiness { id: string; name: string; role: "owner" | "member" }
export interface Account { user: AccountUser; businesses: AccountBusiness[] }
export interface Member { id: string; name: string; email: string; role: "owner" | "member"; since: number; you?: boolean }
export interface MembersPage { members: Member[]; seats: number; invited: number; canInvite: boolean }
export interface InvitePreview { business: { id: string; name: string }; role: "owner" | "member"; expiresAt: number }

async function call<T>(path: string, method: "GET" | "POST", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw await errorFrom(res, path);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const accountApi = {
  /** The signed-in account, or null when this browser is not signed in. */
  async me(): Promise<Account | null> {
    try {
      return await call<Account>("/api/auth/me", "GET");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) return null;
      throw e;
    }
  },
  signup: (b: { name: string; email: string; password: string }) => call<Account>("/api/auth/signup", "POST", b),
  login: (b: { email: string; password: string }) => call<Account>("/api/auth/login", "POST", b),
  logout: () => call<{ ok: true }>("/api/auth/logout", "POST", {}),
  changePassword: (b: { current: string; next: string }) => call<{ ok: true }>("/api/auth/password", "POST", b),
  reset: (b: { code: string; password: string }) => call<Account>("/api/auth/reset", "POST", b),
  invite: (code: string) => call<InvitePreview>(`/api/auth/invites/${enc(code)}`, "GET"),
  accept: (code: string) => call<{ tenant: string; name: string; role: "owner" | "member"; already: boolean }>(`/api/auth/invites/${enc(code)}/accept`, "POST", {}),
  members: (t: string) => call<MembersPage>(`/api/${enc(t)}/members`, "GET"),
  createInvite: (t: string) => call<{ link: string; role: "owner" | "member"; expiresAt: number }>(`/api/${enc(t)}/invites`, "POST", {}),
};

/** The pages that work without a business: signing in, signing up, an invite, a reset link. */
export const AUTH_PATH = /^\/(?:login|signup|invite\/[^/]+|reset\/[^/]+)\/?$/;

// "See the demo" from the sign-in page: this tab looks at the demo business, read-only, without being sent back to sign in.
const DEMO_KEY = "allevia.demo";
export function wantsDemo(): boolean {
  const asked = new URLSearchParams(location.search).get("demo") === "1";
  try {
    if (asked) sessionStorage.setItem(DEMO_KEY, "1");
    return asked || sessionStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return asked;
  }
}
export function forgetDemo(): void {
  try { sessionStorage.removeItem(DEMO_KEY); } catch { /* storage may be blocked */ }
}

/** Where to go after signing in: a path on this site from ?next=, never another site. */
export function nextPath(fallback = "/"): string {
  const next = new URLSearchParams(location.search).get("next") ?? "";
  return /^\/(?!\/)[^\s\\]*$/.test(next) && !AUTH_PATH.test(next.split("?")[0]!) ? next : fallback;
}

/** Signs out and starts again at the sign-in page. */
export async function signOut(): Promise<void> {
  try { await accountApi.logout(); } catch { /* the cookie is cleared or already gone; either way, start again */ }
  forgetDemo();
  location.assign("/login");
}
