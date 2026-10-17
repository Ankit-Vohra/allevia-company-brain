// Rate limits for the doors a stranger can knock on (issue #23): opening a business with an owner link (POST /api/auth/open, where
// each try costs a registry read), setting a business up (POST /api/onboard, which spends model time and makes a graph), and the
// account doors (routes/account.ts: signing up, signing in, changing a password, a reset or an invite link, where a try costs a
// 32 MB password hash or a registry read; per client, per email address and for everybody). In memory, per process: a sliding
// window per client, and one window for everybody, so a guesser who rotates addresses is still bounded. Nothing here replaces a
// reverse proxy's own limits; it keeps the server safe when there is none.
//
// Who is "a client": the address the connection came from. Behind a reverse proxy that is the proxy for everyone, so the server
// then reads the address the proxy saw from the proxy's own header, and only when ALLEVIA_TRUST_PROXY=1: a header from a visitor is
// never believed otherwise (anyone could send a new one with every try). With the flag on, the last address in X-Forwarded-For is
// used (the one the nearest proxy added), then X-Real-IP.
import type { Context } from "hono";
import { HttpError } from "./http.js";

export interface LimitSpec { max: number; windowMs: number }

export interface RateLimitConfig {
  /** Read the client's address from X-Forwarded-For / X-Real-IP (set when a reverse proxy is in front; ALLEVIA_TRUST_PROXY=1). */
  trustProxy?: boolean;
  /** /api/auth/open: tries per client. `false` switches it off. */
  authOpen?: LimitSpec | false;
  /** /api/auth/open: tries from all clients together. */
  authOpenAll?: LimitSpec | false;
  /** /api/onboard: requests per client, whatever they are (a stranger's included). */
  onboard?: LimitSpec | false;
  /** /api/onboard: set-ups started by anybody, counted only once the request was let in (the operator's). */
  onboardRuns?: LimitSpec | false;
  /** Signing in, changing a password, a reset or an invite link: tries per client (each costs a password hash or a registry read). */
  login?: LimitSpec | false;
  /** Password tries against one email address, from anywhere (a guesser who rotates addresses still gets only these). */
  loginEmail?: LimitSpec | false;
  /** Password tries from all clients together (each is 32 MB of scrypt: this bounds the server's work). */
  loginAll?: LimitSpec | false;
  /** New accounts per client. */
  signup?: LimitSpec | false;
  /** New accounts from all clients together. */
  signupAll?: LimitSpec | false;
}

export const DEFAULT_LIMITS = {
  authOpen: { max: 10, windowMs: 60_000 },
  authOpenAll: { max: 120, windowMs: 60_000 },
  onboard: { max: 10, windowMs: 10 * 60_000 },
  onboardRuns: { max: 20, windowMs: 60 * 60_000 },
  login: { max: 10, windowMs: 60_000 },
  loginEmail: { max: 10, windowMs: 15 * 60_000 },
  loginAll: { max: 300, windowMs: 60_000 },
  signup: { max: 10, windowMs: 60 * 60_000 },
  signupAll: { max: 200, windowMs: 60 * 60_000 },
} as const satisfies Record<string, LimitSpec>;

/** At most `max` events per `windowMs` for each key; the oldest events fall out of the window one by one. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly spec: LimitSpec, private readonly now: () => number = Date.now, private readonly maxKeys = 10_000) {
    if (!(spec.max >= 1 && spec.windowMs > 0)) throw new Error("a limit needs max >= 1 and a window above 0");
  }

  /** Records one event for `key`. Returns null when it is allowed, or the seconds to wait when it is not (a refused event is not recorded). */
  take(key: string): number | null {
    const t = this.now();
    const live = (this.hits.get(key) ?? []).filter((x) => x > t - this.spec.windowMs);
    if (live.length >= this.spec.max) {
      this.hits.set(key, live);
      return Math.max(1, Math.ceil((live[0]! + this.spec.windowMs - t) / 1000));
    }
    live.push(t);
    this.hits.delete(key); // re-inserted last, so the map stays in order of last use
    this.hits.set(key, live);
    if (this.hits.size > this.maxKeys) this.prune(t);
    return null;
  }

  // Forget the keys whose events have all left the window; then, if still too many, the least recently used.
  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.at(-1)! <= t - this.spec.windowMs) this.hits.delete(k);
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

/** The address a request came from (see the header: a proxy's header is read only with `trustProxy`). */
export function clientKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    const real = c.req.header("x-real-ip")?.trim();
    const ip = forwarded || real;
    if (ip) return ip.slice(0, 64);
  }
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return socket ?? "unknown";
}

export interface Limits {
  trustProxy: boolean;
  authOpen: SlidingWindow | null;
  authOpenAll: SlidingWindow | null;
  onboard: SlidingWindow | null;
  onboardRuns: SlidingWindow | null;
  login: SlidingWindow | null;
  loginEmail: SlidingWindow | null;
  loginAll: SlidingWindow | null;
  signup: SlidingWindow | null;
  signupAll: SlidingWindow | null;
}

export function makeLimits(config: RateLimitConfig | undefined, now: () => number): Limits {
  const window = (spec: LimitSpec | false | undefined, fallback: LimitSpec): SlidingWindow | null => (spec === false ? null : new SlidingWindow(spec ?? fallback, now));
  return {
    trustProxy: config?.trustProxy === true,
    authOpen: window(config?.authOpen, DEFAULT_LIMITS.authOpen),
    authOpenAll: window(config?.authOpenAll, DEFAULT_LIMITS.authOpenAll),
    onboard: window(config?.onboard, DEFAULT_LIMITS.onboard),
    onboardRuns: window(config?.onboardRuns, DEFAULT_LIMITS.onboardRuns),
    login: window(config?.login, DEFAULT_LIMITS.login),
    loginEmail: window(config?.loginEmail, DEFAULT_LIMITS.loginEmail),
    loginAll: window(config?.loginAll, DEFAULT_LIMITS.loginAll),
    signup: window(config?.signup, DEFAULT_LIMITS.signup),
    signupAll: window(config?.signupAll, DEFAULT_LIMITS.signupAll),
  };
}

/** Counts one event in `window` (when there is one) and answers 429, with Retry-After, if it is over the limit. */
export function enforce(c: Context, window: SlidingWindow | null, key: string, words: string): void {
  if (!window) return;
  const wait = window.take(key);
  if (wait === null) return;
  c.header("Retry-After", String(wait));
  throw new HttpError(429, words);
}

export const AUTH_OPEN_WORDS = "Too many tries. Wait a minute, then open your link again.";
export const ONBOARD_WORDS = "That is a lot of set-ups in a short time. Try again in a few minutes.";
export const LOGIN_WORDS = "Too many tries. Wait a few minutes, then try again.";
export const SIGNUP_WORDS = "That is a lot of new accounts in a short time. Try again later.";
