// Accounts over HTTP (docs/tenant-isolation.md, "Accounts"; design section 4), only with ALLEVIA_AUTH=1 and accounts wired in
// (AuthDeps.accounts); otherwise every route here is a 404 and nothing changes for local use.
//   POST /api/auth/signup {name, email, password}   a new account, signed in (an email that has one: a sign-in with what was typed)
//   POST /api/auth/login {email, password}          signed in; every failure is the same sentence
//   POST /api/auth/logout                           this session ends at once
//   GET  /api/auth/me                               the account and its businesses, with the role in each
//   POST /api/auth/password {current, next}         a new password; every other session ends
//   POST /api/auth/reset {code, password}           a new password from a reset link the operator made (auth:reset-link)
//   GET  /api/auth/invites/:code                    which business an invite opens, while it is valid
//   POST /api/auth/invites/:code/accept             the signed-in account joins that business
//   GET  /api/:t/members                            the people in a business (its owner and members)
//   POST /api/:t/invites {role?}                    owner only: a link that lets one more person in, once, for 7 days
// Sign-in failures never say whether an email has an account. The doors are rate limited per client, per email and in total
// (ratelimit.ts), before the body is read where they can be.
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  AccountInputError, acceptInvite, changePassword, checkLogin, cleanName, createInvite, createSession, createUser, membersOf, membershipsOf,
  normalizeEmail, openInviteCount, previewInvite, revokeSession, useResetCode, type Account, type AccountOpts, type Membership, type SessionView,
} from "../../auth/accounts.js";
import { passwordProblem } from "../../auth/passwords.js";
import { clearSessionCookie, sessionCookie, setSessionCookie, type AccountWiring } from "../auth.js";
import { HttpError, readBody, type TenantRef } from "../http.js";
import { LOGIN_WORDS, SIGNUP_WORDS, clientKey, enforce, type Limits } from "../ratelimit.js";
import { callerRole, callerUserId, requireOwner } from "../roles.js";

export const MISMATCH = "That email and password don't match.";
export const SIGNED_OUT = "You are not signed in.";
export const INVITE_GONE = "That invite link is not valid any more. Ask for a new one.";
export const RESET_GONE = "That reset link is not valid any more. Ask for a new one.";
const NOT_FOUND = "No such endpoint.";

export interface AccountRouteCtx {
  /** The accounts wiring, or null when accounts are off (every route here is then a 404). */
  wiring: AccountWiring | null;
  opts: () => AccountOpts;
  sessionOf: (c: Context) => Promise<SessionView | null>;
  limits: Limits;
  tenantOf: (c: Context) => Promise<{ reg: TenantRef }>;
  seats: (slug: string) => Promise<number>;
  now: () => number;
  /** Whether this request's cookie gets Secure (auth.ts cookieSecure). */
  secure: (c: Context) => boolean;
}

export interface AccountDto {
  user: { id: string; email: string; name: string };
  businesses: Array<{ id: string; name: string; role: Membership["role"] }>;
}

export const accountDto = (user: Account, memberships: Membership[]): AccountDto => ({
  user: { id: user.id, email: user.email, name: user.name },
  businesses: memberships.map((m) => ({ id: m.slug, name: m.name, role: m.role })),
});

const Signup = z.object({ name: z.string().max(400), email: z.string().max(400), password: z.string().max(1000) });
const Login = z.object({ email: z.unknown().optional(), password: z.unknown().optional() });
const Password = z.object({ current: z.string().max(1000), next: z.string().max(1000) });
const Reset = z.object({ code: z.string().max(200), password: z.string().max(1000) });
const InviteBody = z.object({ role: z.enum(["member", "owner"]).optional() });

// A body sentence the owner can act on, for input an account cannot be made from.
const input = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AccountInputError) throw new HttpError(400, e.message);
    throw e;
  }
};

export function registerAccountRoutes(app: Hono, ctx: AccountRouteCtx): void {
  const on = (): AccountWiring => {
    if (!ctx.wiring) throw new HttpError(404, NOT_FOUND);
    return ctx.wiring;
  };
  const client = (c: Context) => clientKey(c, ctx.limits.trustProxy);
  const emailKey = (raw: unknown) => `email:${normalizeEmail(raw) ?? "-"}`;

  async function signIn(c: Context, user: Account, status: 200 | 201) {
    const s = await createSession(user.id, ctx.opts());
    if (!s) throw new HttpError(401, MISMATCH); // the account was switched off in between
    setSessionCookie(c, s.id, { expiresAt: s.expiresAt, now: ctx.now(), secure: ctx.secure(c) });
    return c.json(accountDto(user, await membershipsOf(user.id, ctx.opts())), status);
  }

  async function signedIn(c: Context): Promise<SessionView> {
    const s = await ctx.sessionOf(c);
    if (!s) {
      if (sessionCookie(c)) clearSessionCookie(c, ctx.secure(c));
      throw new HttpError(401, SIGNED_OUT);
    }
    return s;
  }

  app.post("/api/auth/signup", async (c) => {
    on();
    enforce(c, ctx.limits.signup, client(c), SIGNUP_WORDS);
    enforce(c, ctx.limits.signupAll, "all", SIGNUP_WORDS);
    const body = await readBody(c, Signup);
    const email = normalizeEmail(body.email);
    if (!cleanName(body.name)) throw new HttpError(400, "Tell us your name.");
    if (!email) throw new HttpError(400, "That does not look like an email address.");
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    enforce(c, ctx.limits.loginEmail, emailKey(email), LOGIN_WORDS);
    const made = await input(() => createUser({ name: body.name, email, password: body.password }, ctx.opts()));
    if (made) return signIn(c, made, 201);
    // The email already has an account: this is a sign-in with what was typed, under the sign-in limits. A wrong password gets
    // the sign-in sentence, never "that email is taken" in other words.
    enforce(c, ctx.limits.loginAll, "all", LOGIN_WORDS);
    const user = await checkLogin(email, body.password, ctx.opts());
    if (!user) throw new HttpError(401, MISMATCH);
    return signIn(c, user, 200);
  });

  app.post("/api/auth/login", async (c) => {
    on();
    enforce(c, ctx.limits.login, client(c), LOGIN_WORDS);
    enforce(c, ctx.limits.loginAll, "all", LOGIN_WORDS);
    const body = await readBody(c, Login);
    enforce(c, ctx.limits.loginEmail, emailKey(body.email), LOGIN_WORDS);
    const user = await checkLogin(body.email, body.password, ctx.opts());
    if (!user) throw new HttpError(401, MISMATCH);
    return signIn(c, user, 200);
  });

  app.post("/api/auth/logout", async (c) => {
    on();
    const s = await ctx.sessionOf(c);
    if (s) await revokeSession(s.hash, ctx.opts());
    clearSessionCookie(c, ctx.secure(c));
    return c.json({ ok: true });
  });

  app.get("/api/auth/me", async (c) => {
    on();
    const s = await signedIn(c);
    return c.json(accountDto(s.user, s.memberships));
  });

  app.post("/api/auth/password", async (c) => {
    on();
    enforce(c, ctx.limits.login, client(c), LOGIN_WORDS);
    const s = await signedIn(c);
    const body = await readBody(c, Password);
    enforce(c, ctx.limits.loginEmail, emailKey(s.user.email), LOGIN_WORDS);
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    const ok = await input(() => changePassword(s.user.id, body.current, body.next, { ...ctx.opts(), keepSession: s.hash }));
    if (!ok) throw new HttpError(403, "That is not your current password.");
    return c.json({ ok: true });
  });

  app.post("/api/auth/reset", async (c) => {
    on();
    enforce(c, ctx.limits.login, client(c), LOGIN_WORDS);
    enforce(c, ctx.limits.loginAll, "all", LOGIN_WORDS);
    const body = await readBody(c, Reset);
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    const user = await input(() => useResetCode(body.code, body.password, ctx.opts()));
    if (!user) throw new HttpError(404, RESET_GONE);
    return signIn(c, user, 200);
  });

  app.get("/api/auth/invites/:code", async (c) => {
    on();
    enforce(c, ctx.limits.login, client(c), LOGIN_WORDS);
    const p = await previewInvite(c.req.param("code"), ctx.opts());
    if (!p) throw new HttpError(404, INVITE_GONE);
    return c.json({ business: { id: p.slug, name: p.name }, role: p.role, expiresAt: p.expiresAt });
  });

  app.post("/api/auth/invites/:code/accept", async (c) => {
    on();
    enforce(c, ctx.limits.login, client(c), LOGIN_WORDS);
    const s = await signedIn(c);
    const r = await acceptInvite(c.req.param("code"), s.user.id, ctx.opts());
    if (!r) throw new HttpError(404, INVITE_GONE);
    return c.json({ tenant: r.slug, name: r.name, role: r.role, already: r.already });
  });

  // ---- inside a business (behind the door in app.ts) ----

  app.get("/api/:t/members", async (c) => {
    on();
    const role = callerRole();
    if (role === "public") throw new HttpError(403, "Only the people in this business can see who is in it.");
    const { reg } = await ctx.tenantOf(c);
    const [members, seats, invited] = await Promise.all([membersOf(reg.slug, ctx.opts()), ctx.seats(reg.slug), openInviteCount(reg.slug, ctx.opts())]);
    const me = callerUserId();
    return c.json({
      members: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role, since: m.since, ...(m.id === me ? { you: true } : {}) })),
      seats, invited, canInvite: role === "owner",
    });
  });

  app.post("/api/:t/invites", async (c) => {
    on();
    requireOwner();
    const { reg } = await ctx.tenantOf(c);
    const body = await readBody(c, InviteBody);
    const seats = await ctx.seats(reg.slug);
    const r = await input(() => createInvite(reg.slug, { ...ctx.opts(), role: body.role ?? "member", seats, createdBy: callerUserId() ?? "owner link" }));
    if ("full" in r) throw new HttpError(409, `Every seat on your plan is taken (${seats}, counting invites not used yet).`);
    return c.json({ link: `/invite/${r.code}`, role: body.role ?? "member", expiresAt: r.expiresAt }, 201);
  });
}
