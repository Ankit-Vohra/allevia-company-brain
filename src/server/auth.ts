// "Open with your link": what the API does when ALLEVIA_AUTH=1 (docs/tenant-isolation.md). Pure helpers; app.ts wires them.
//
// A request for business T is allowed when it carries a valid, unrevoked token whose scope is T (or `operator`):
//   - as `Authorization: Bearer <token>` (the CLI, scripts, the MCP server), or
//   - in the cookie `allevia_k_<T>` that POST /api/auth/open sets (the web app: HttpOnly, SameSite=Strict, Path=/api, so
//     other sites cannot send it, scripts cannot read it, and images and event streams carry it with no extra code).
// A token in a URL is never accepted (URLs end up in logs, history and referrers). The one exception to "T needs its
// token" is a business marked as a demo (graph/tenants.ts setDemo): it opens without a token, read-only, exactly as the
// public demo does. A request for a business the caller may not open is a 401 with the same sentence whether or not that
// business exists, so the API cannot be used to find out which businesses are customers.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { MemberRole } from "../auth/accounts.js";
import { OPERATOR_SCOPE, type VerifiedToken } from "../auth/tokens.js";
import type { TenantOpts } from "../graph/tenants.js";

export interface AuthDeps {
  enabled: boolean;
  verify: (token: string) => Promise<VerifiedToken | null>; // production: verifyToken against the registry graph
  // Accounts (email and password, src/auth/accounts.ts). Absent: there is no sign-in and the account routes are 404s (owner
  // links only, as before). Present: the door lets a signed-in member in first (docs/tenant-isolation.md, "Accounts").
  accounts?: AccountWiring;
}

// Where the accounts live (the registry graph; tests point it at a throwaway one) and what the plan and the trial say.
export interface AccountWiring extends TenantOpts {
  /** People a business's plan lets in (src/auth/seats.ts seatsFor); tests pass their own. */
  seats?: (slug: string) => Promise<number>;
  /** Starts the trial of a business an account has just set up (src/auth/trial.ts startTrial); tests pass their own. */
  startTrial?: (slug: string, userId: string) => Promise<unknown>;
  /** Businesses one account may own (1 during the trial). */
  maxOwned?: number;
}

export const COOKIE_PREFIX = "allevia_k_";
export const cookieName = (scope: string): string => `${COOKIE_PREFIX}${scope}`;
export const PRIVATE_MESSAGE = "This business is private. Open it with your owner link.";
export const PRIVATE_SIGN_IN_MESSAGE = "This business is private. Sign in to open it, or use your owner link.";
export const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const MAX_TOKENS_CHECKED = 6; // a request stuffed with cookies must not turn into a pile of registry reads

// Per request: is it a public (read-only demo) view? Set by the tenant middleware; read by refuseInPublicMode and the
// routes that show less in public mode. Outside a request (and with ALLEVIA_AUTH off) it is the deployment's own switch.
// `role` and `userId` say who is asking (src/server/roles.ts): an owner link makes the caller the owner; a signed-in account
// carries its own role in the business.
export const requestView = new AsyncLocalStorage<{ publicView: boolean; role?: MemberRole; userId?: string }>();

const BEARER = /^Bearer ([^\s]+)$/;

// Every token the request carries that could be for `slug` (or the operator), or, with no slug, every token it carries.
export function presentedTokens(c: Context, slug?: string): string[] {
  const out: string[] = [];
  const m = BEARER.exec(c.req.header("authorization") ?? "");
  if (m) out.push(m[1]!);
  const jar = getCookie(c);
  for (const [name, value] of Object.entries(jar)) {
    if (!name.startsWith(COOKIE_PREFIX) || !value) continue;
    const scope = name.slice(COOKIE_PREFIX.length);
    if (slug === undefined || scope === slug || scope === OPERATOR_SCOPE) out.push(value);
  }
  return [...new Set(out)].slice(0, MAX_TOKENS_CHECKED);
}

// The scope the request is allowed to act in for `slug`, or null.
export async function authorize(auth: AuthDeps, c: Context, slug: string): Promise<string | null> {
  for (const raw of presentedTokens(c, slug)) {
    const v = await auth.verify(raw);
    if (v && (v.scope === slug || v.scope === OPERATOR_SCOPE)) return v.scope;
  }
  return null;
}

// Every scope the request's tokens verify for (for the business list).
export async function scopesOf(auth: AuthDeps, c: Context): Promise<Set<string>> {
  const scopes = new Set<string>();
  for (const raw of presentedTokens(c)) {
    const v = await auth.verify(raw);
    if (v) scopes.add(v.scope);
  }
  return scopes;
}

// Whether the browser reached the app over https, so a cookie gets Secure (the browser then never sends it over plain http).
// The app usually sits behind a reverse proxy that ends https and talks plain http to it (Caddy on the server), so:
//   - the public address (ALLEVIA_WEB_URL) starts with https: always Secure;
//   - the request itself came over https: Secure;
//   - X-Forwarded-Proto: https counts only when the proxy is trusted (ALLEVIA_TRUST_PROXY=1), the same rule the rate limits
//     use for the client's address: a header a visitor sends is not believed otherwise.
export interface CookieSecurity { trustProxy?: boolean; webBaseUrl?: string }

export function cookieSecure(c: Context, o: CookieSecurity = {}): boolean {
  if (/^https:\/\//i.test(o.webBaseUrl ?? "")) return true;
  if (new URL(c.req.url).protocol === "https:") return true;
  return o.trustProxy === true && c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() === "https";
}

export function setSession(c: Context, scope: string, token: string, secure: boolean): void {
  setCookie(c, cookieName(scope), token, {
    httpOnly: true, sameSite: "Strict", path: "/api", maxAge: COOKIE_MAX_AGE_S, secure,
  });
}

export function clearSession(c: Context, scope: string, secure: boolean): void {
  deleteCookie(c, cookieName(scope), { path: "/api", secure });
}

// ---------- the account session cookie ----------
// `allevia_session` holds the session id (32 random bytes; only its SHA-256 is stored). HttpOnly (scripts cannot read it),
// Secure over https (cookieSecure), Path=/ (the web app and the API). SameSite=Lax rather than Strict: a person who follows a
// link to the app from their email or chat arrives signed in, while another site still cannot make the browser send it with a
// change (a POST), and the Origin check in app.ts refuses a cross-site change on top of that.
export const SESSION_COOKIE = "allevia_session";

export const sessionCookie = (c: Context): string | undefined => getCookie(c, SESSION_COOKIE) || undefined;

export function setSessionCookie(c: Context, id: string, o: { expiresAt: number; now: number; secure: boolean }): void {
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true, sameSite: "Lax", path: "/", maxAge: Math.max(0, Math.floor((o.expiresAt - o.now) / 1000)), secure: o.secure,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure });
}
