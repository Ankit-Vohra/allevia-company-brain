// Accounts: people who sign in with an email and a password (docs/tenant-isolation.md, "Accounts"). They live in the registry
// graph (allevia_meta), next to the (:Tenant) nodes and the owner links, never in a business's own graph:
//   (:User {id, email, name, passHash, createdAt, disabledAt?})              email is lower case and unique
//   (:User)-[:MEMBER_OF {role: owner|member, since}]->(:Tenant)              who may open which business, and as what
//   (:User)-[:HAS_SESSION]->(:Session {idHash, createdAt, expiresAt, lastSeenAt, revokedAt?})
//   (:Tenant)-[:HAS_INVITE]->(:Invite {codeHash, slug, role, createdAt, expiresAt, createdBy, usedAt?, usedBy?})
//   (:User)-[:HAS_RESET]->(:PasswordReset {codeHash, createdAt, expiresAt, usedAt?})
// A password is kept only as its scrypt hash (passwords.ts). A session id, an invite code and a reset code are 32 random bytes
// (256 bits) shown once, and only their SHA-256 is stored, the way owner links are (tokens.ts): a fast hash is right for a
// secret that is already long and random, and a stolen registry gives nobody a way in. Each is looked up by its hash, one
// indexed read, on every request, so signing out, revoking or disabling takes effect on the very next request.
//
// Every write that must not happen twice is one query that checks and writes together (FalkorDB runs one write query on a
// graph at a time): an email cannot get two accounts, an invite cannot be used twice, a seat cannot be given twice, and an
// account cannot claim a second business during the trial. Unique constraints on the hashes and the email back that up.
// How the queries are written, for FalkorDB 6.0.2 (each was found failing and is held by tests/security/accounts.test.ts):
//   - one MATCH (one pattern, commas allowed) with one WHERE, never `MATCH … WHERE … MATCH … WHERE …`: the server can put the
//     second WHERE's test before the first MATCH's node is bound, and then nothing matches;
//   - counts are one pattern comprehension per WITH, never an OPTIONAL MATCH … WHERE after a WITH (a parameter comparison there
//     runs before the optional node is bound, so it counts nothing) and never two comprehensions in one projection (they miscount);
//   - a lookup by an account's id walks its edges after `WITH u`, so the index on User.id is used, not a scan of every Session.
import { createHash, randomBytes } from "node:crypto";
import { MAX_PAGE, onGraphDropped, openGraphByName, type GraphHandle } from "../graph/client.js";
import { ensureIndexes } from "../graph/indexes.js";
import { isTenantSlug } from "../graph/slug.js";
import { metaName, type TenantOpts } from "../graph/tenants.js";
import { burnTime, hashPassword, passwordProblem, verifyPassword } from "./passwords.js";

export type MemberRole = "owner" | "member";
export const isMemberRole = (r: unknown): r is MemberRole => r === "owner" || r === "member";

export interface AccountOpts extends TenantOpts { now?: number }

export interface Account { id: string; email: string; name: string; createdAt: number }
export interface Membership { slug: string; name: string; role: MemberRole }
export interface SessionView { user: Account; hash: string; expiresAt: number; lastSeenAt: number; memberships: Membership[] }
export interface NewSession { id: string; expiresAt: number }
export interface Member { id: string; name: string; email: string; role: MemberRole; since: number }
export interface InvitePreview { slug: string; name: string; role: MemberRole; expiresAt: number }

export const DAY_MS = 86_400_000;
export const SESSION_MS = 30 * DAY_MS;        // a session lasts 30 days from the last time it was used (sliding)
export const SESSION_TOUCH_MS = 60 * 60_000;  // ...moved forward at most once an hour, so a busy page is not a write per request
export const INVITE_MS = 7 * DAY_MS;          // an invite link works once, for 7 days
export const RESET_MS = DAY_MS;               // a reset link (made by the operator, sent by hand) works once, for a day
export const MAX_EMAIL = 254;
export const MAX_NAME = 80;

const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url
const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const newSecret = (): string => randomBytes(32).toString("base64url");
const missingGraph = (e: unknown): boolean => /empty key/i.test(String((e as Error)?.message));
const duplicate = (e: unknown): boolean => /unique constraint/i.test(String((e as Error)?.message));
const nowOf = (opts?: AccountOpts): number => opts?.now ?? Date.now();

/** A plain sentence for input an account cannot be made from (the API answers 400 with it). */
export class AccountInputError extends Error {}

/** The address in lower case, or null when it is not one. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= MAX_EMAIL && EMAIL.test(e) ? e : null;
}

/** The name with its spaces tidied, or null when there is none. Control characters are dropped. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const n = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return n ? [...n].slice(0, MAX_NAME).join("") : null;
}

export const isSecret = (s: unknown): s is string => typeof s === "string" && SECRET.test(s);

// ---------- the registry and its schema ----------

// The registry indexes the account queries plan on (Tenant.slug is made by graph/tenants.ts; it is listed so the test suite's
// query-shape check plans the account queries on the same indexes the registry has).
export const ACCOUNT_INDEXES = [
  { label: "User", prop: "email" }, { label: "User", prop: "id" }, { label: "Session", prop: "idHash" },
  { label: "Invite", prop: "codeHash" }, { label: "Invite", prop: "slug" }, { label: "PasswordReset", prop: "codeHash" },
  { label: "Tenant", prop: "slug" },
] as const;
const ACCOUNT_UNIQUE = [
  { label: "User", prop: "email" }, { label: "User", prop: "id" }, { label: "Session", prop: "idHash" },
  { label: "Invite", prop: "codeHash" }, { label: "PasswordReset", prop: "codeHash" },
] as const;

const prepared = new Map<string, Promise<void>>();
onGraphDropped((name) => { prepared.delete(name); });

async function prepare(meta: GraphHandle): Promise<void> {
  await ensureIndexes(meta, ACCOUNT_INDEXES.map((i) => ({ ...i, type: "RANGE" as const })));
  const have = new Set((await meta.constraints()).filter((c) => c.status !== "FAILED").map((c) => `${c.type}|${c.label}|${c.props.join(",")}`));
  for (const u of ACCOUNT_UNIQUE) {
    if (have.has(`UNIQUE|${u.label}|${u.prop}`)) continue;
    try {
      await meta.createConstraint("UNIQUE", u.label, u.prop);
    } catch (e) {
      if (!/already exists/i.test(String((e as Error).message))) throw e;
    }
  }
}

// The registry, with the account indexes and constraints in place (made once per process per registry graph).
async function writable(opts?: AccountOpts): Promise<GraphHandle> {
  const meta = await openGraphByName(metaName(opts));
  let p = prepared.get(meta.name);
  if (!p) {
    p = prepare(meta);
    prepared.set(meta.name, p);
    p.catch(() => { if (prepared.get(meta.name) === p) prepared.delete(meta.name); });
  }
  await p;
  return meta;
}

// A read of the registry; a registry that does not exist yet reads as empty.
async function read<T>(opts: AccountOpts | undefined, cypher: string, params: Record<string, unknown>): Promise<T[]> {
  const meta = await openGraphByName(metaName(opts));
  try {
    return await meta.roQuery<T>(cypher, params);
  } catch (e) {
    if (missingGraph(e)) return [];
    throw e;
  }
}

type UserRow = { id: string; email: string; name: string; createdAt: number };
const account = (r: UserRow): Account => ({ id: r.id, email: r.email, name: r.name, createdAt: r.createdAt });

// ---------- users ----------

/** Makes an account. Null when the email already has one (the caller then treats it as a sign-in). */
export async function createUser(input: { email: unknown; name: unknown; password: unknown }, opts?: AccountOpts): Promise<Account | null> {
  const email = normalizeEmail(input.email);
  if (!email) throw new AccountInputError("That does not look like an email address.");
  const name = cleanName(input.name);
  if (!name) throw new AccountInputError("Tell us your name.");
  const problem = passwordProblem(input.password);
  if (problem) throw new AccountInputError(problem);
  const passHash = await hashPassword(input.password as string);
  const meta = await writable(opts);
  const id = `usr_${randomBytes(8).toString("hex")}`;
  const now = nowOf(opts);
  try {
    const rows = await meta.query<{ id: string }>(
      `OPTIONAL MATCH (x:User {email:$email}) WITH x WHERE x IS NULL
       CREATE (u:User {id:$id, email:$email, name:$name, passHash:$passHash, createdAt:$now}) RETURN u.id AS id`,
      { email, id, name, passHash, now });
    return rows[0] ? { id, email, name, createdAt: now } : null;
  } catch (e) {
    if (duplicate(e)) return null;
    throw e;
  }
}

/** The account when the email and password match an account that is not disabled; null otherwise, after the same work. */
export async function checkLogin(emailRaw: unknown, password: unknown, opts?: AccountOpts): Promise<Account | null> {
  const email = normalizeEmail(emailRaw);
  const rows = email
    ? await read<UserRow & { passHash: string; disabledAt: number | null }>(opts,
      "MATCH (u:User {email:$email}) RETURN u.id AS id, u.email AS email, u.name AS name, u.createdAt AS createdAt, u.passHash AS passHash, u.disabledAt AS disabledAt LIMIT 1",
      { email })
    : [];
  const row = rows[0];
  if (!row) {
    await burnTime(typeof password === "string" ? password.slice(0, 200) : "");
    return null;
  }
  const ok = await verifyPassword(password, row.passHash);
  return ok && (row.disabledAt === null || row.disabledAt === undefined) ? account(row) : null;
}

export async function findUser(emailRaw: unknown, opts?: AccountOpts): Promise<(Account & { disabledAt: number | null }) | null> {
  const email = normalizeEmail(emailRaw);
  if (!email) return null;
  const rows = await read<UserRow & { disabledAt: number | null }>(opts,
    "MATCH (u:User {email:$email}) RETURN u.id AS id, u.email AS email, u.name AS name, u.createdAt AS createdAt, u.disabledAt AS disabledAt LIMIT 1", { email });
  return rows[0] ? { ...account(rows[0]), disabledAt: rows[0].disabledAt ?? null } : null;
}

/** Changes a password when `current` is right. Every other session of the account is signed out. */
export async function changePassword(userId: string, current: unknown, next: unknown, o: AccountOpts & { keepSession?: string } = {}): Promise<boolean> {
  const problem = passwordProblem(next);
  if (problem) throw new AccountInputError(problem);
  const rows = await read<{ passHash: string }>(o, "MATCH (u:User {id:$uid}) WHERE u.disabledAt IS NULL RETURN u.passHash AS passHash LIMIT 1", { uid: userId });
  if (!rows[0] || !(await verifyPassword(current, rows[0].passHash))) return false;
  const passHash = await hashPassword(next as string);
  const meta = await writable(o);
  // compare-and-set: a change that raced another one does not overwrite it
  const done = await meta.query<{ id: string }>(
    "MATCH (u:User {id:$uid}) WHERE u.passHash = $old SET u.passHash = $passHash, u.passwordChangedAt = $now RETURN u.id AS id",
    { uid: userId, old: rows[0].passHash, passHash, now: nowOf(o) });
  if (!done[0]) return false;
  await revokeSessions(userId, { ...o, ...(o.keepSession ? { except: o.keepSession } : {}) });
  return true;
}

/** Switches an account off (or back on). Switching off signs it out everywhere. Null when there is no such account. */
export async function setDisabled(emailRaw: unknown, disabled: boolean, opts?: AccountOpts): Promise<Account | null> {
  const user = await findUser(emailRaw, opts);
  if (!user) return null;
  const meta = await writable(opts);
  await meta.query("MATCH (u:User {id:$uid}) SET u.disabledAt = $at", { uid: user.id, at: disabled ? nowOf(opts) : null });
  if (disabled) await revokeSessions(user.id, opts);
  return user;
}

export interface UserListing extends Account { disabledAt: number | null; businesses: Array<{ slug: string; role: MemberRole }> }

/** Every account, oldest first, with its businesses (for the operator's CLI). Never a hash. */
export async function listUsers(opts?: AccountOpts): Promise<UserListing[]> {
  const rows = await read<UserRow & { disabledAt: number | null; ms: Array<{ slug: string | null; role: MemberRole | null }> }>(opts,
    `MATCH (u:User) OPTIONAL MATCH (u)-[m:MEMBER_OF]->(t:Tenant)
     WITH u, collect({slug: t.slug, role: m.role}) AS ms
     RETURN u.id AS id, u.email AS email, u.name AS name, u.createdAt AS createdAt, u.disabledAt AS disabledAt, ms ORDER BY createdAt, id LIMIT $limit`,
    { limit: MAX_PAGE });
  return rows.map((r) => ({
    ...account(r), disabledAt: r.disabledAt ?? null,
    businesses: r.ms.filter((m): m is { slug: string; role: MemberRole } => typeof m.slug === "string" && isMemberRole(m.role)).sort((a, b) => a.slug.localeCompare(b.slug)),
  }));
}

// ---------- sessions ----------

/** A new session for the account: the id goes in the cookie once; only its hash is kept. Null when the account is disabled. */
export async function createSession(userId: string, opts?: AccountOpts): Promise<NewSession | null> {
  const now = nowOf(opts);
  const id = newSecret();
  const meta = await writable(opts);
  // sessions that ended a while ago are cleared as the account signs in again, so they do not pile up
  await meta.query(
    "MATCH (u:User {id:$uid}) WITH u MATCH (u)-[:HAS_SESSION]->(s:Session) WHERE s.expiresAt <= $now OR s.revokedAt <= $old DETACH DELETE s",
    { uid: userId, now, old: now - SESSION_MS });
  const rows = await meta.query<{ expiresAt: number }>(
    `MATCH (u:User {id:$uid}) WHERE u.disabledAt IS NULL
     CREATE (u)-[:HAS_SESSION]->(s:Session {idHash:$idHash, createdAt:$now, expiresAt:$expiresAt, lastSeenAt:$now}) RETURN s.expiresAt AS expiresAt`,
    { uid: userId, idHash: sha256(id), now, expiresAt: now + SESSION_MS });
  return rows[0] ? { id, expiresAt: rows[0].expiresAt } : null;
}

/** Who a session id belongs to, with every business they are in, when it is live (not signed out, not expired, account on). */
export async function resolveSession(raw: unknown, opts?: AccountOpts): Promise<SessionView | null> {
  if (!isSecret(raw)) return null;
  const hash = sha256(raw);
  const rows = await read<UserRow & { expiresAt: number; lastSeenAt: number; ms: Array<{ slug: string | null; name: string | null; role: string | null }> }>(opts,
    `MATCH (u:User)-[hs:HAS_SESSION]->(s:Session {idHash:$hash})
     WHERE hs IS NOT NULL AND s.revokedAt IS NULL AND s.expiresAt > $now AND u.disabledAt IS NULL
     OPTIONAL MATCH (u)-[m:MEMBER_OF]->(t:Tenant)
     WITH u, s, collect({slug: t.slug, name: t.name, role: m.role}) AS ms
     RETURN u.id AS id, u.email AS email, u.name AS name, u.createdAt AS createdAt, s.expiresAt AS expiresAt, s.lastSeenAt AS lastSeenAt, ms LIMIT 1`,
    { hash, now: nowOf(opts) });
  const r = rows[0];
  if (!r) return null;
  const memberships = r.ms
    .filter((m): m is { slug: string; name: string | null; role: MemberRole } => isTenantSlug(m.slug) && isMemberRole(m.role))
    .map((m) => ({ slug: m.slug, name: m.name ?? m.slug, role: m.role }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  return { user: account(r), hash, expiresAt: r.expiresAt, lastSeenAt: r.lastSeenAt, memberships };
}

/** Moves a live session's end 30 days on from now. Returns the new end, or null when the session is no longer live. */
export async function touchSession(hash: string, opts?: AccountOpts): Promise<number | null> {
  const now = nowOf(opts);
  const meta = await writable(opts);
  const rows = await meta.query<{ expiresAt: number }>(
    "MATCH (s:Session {idHash:$hash}) WHERE s.revokedAt IS NULL AND s.expiresAt > $now SET s.lastSeenAt = $now, s.expiresAt = $expiresAt RETURN s.expiresAt AS expiresAt",
    { hash, now, expiresAt: now + SESSION_MS });
  return rows[0]?.expiresAt ?? null;
}

/** Signs one session out (by its stored hash). */
export async function revokeSession(hash: string, opts?: AccountOpts): Promise<number> {
  const meta = await writable(opts);
  const rows = await meta.query<{ n: number }>("MATCH (s:Session {idHash:$hash}) WHERE s.revokedAt IS NULL SET s.revokedAt = $now RETURN count(s) AS n", { hash, now: nowOf(opts) });
  return rows[0]?.n ?? 0;
}

/** Signs every session of an account out, except the one whose hash is `except`. */
export async function revokeSessions(userId: string, o: AccountOpts & { except?: string } = {}): Promise<number> {
  const meta = await writable(o);
  const rows = await meta.query<{ n: number }>(
    "MATCH (u:User {id:$uid}) WITH u MATCH (u)-[hs:HAS_SESSION]->(s:Session) WHERE s.revokedAt IS NULL AND s.idHash <> $keep SET s.revokedAt = $now RETURN count(hs) AS n",
    { uid: userId, keep: o.except ?? "", now: nowOf(o) });
  return rows[0]?.n ?? 0;
}

// ---------- businesses and members ----------

export async function membershipsOf(userId: string, opts?: AccountOpts): Promise<Membership[]> {
  const rows = await read<{ slug: string; name: string | null; role: string }>(opts,
    "MATCH (u:User {id:$uid})-[m:MEMBER_OF]->(t:Tenant) RETURN t.slug AS slug, t.name AS name, m.role AS role ORDER BY t.slug LIMIT 200", { uid: userId });
  return rows.filter((r) => isMemberRole(r.role)).map((r) => ({ slug: r.slug, name: r.name ?? r.slug, role: r.role as MemberRole }));
}

/** How many businesses the account owns. */
export async function ownedCount(userId: string, opts?: AccountOpts): Promise<number> {
  const rows = await read<{ n: number }>(opts, "MATCH (u:User {id:$uid})-[m:MEMBER_OF]->(t:Tenant) WHERE m.role = 'owner' RETURN count(t) AS n", { uid: userId });
  return rows[0]?.n ?? 0;
}

/**
 * Makes the account the owner of a business it has just set up: only when the business has no owner yet, was registered at or
 * after `createdSince` (when given: the set-up's own start, so a business that was already there is never claimed), and the
 * account owns fewer than `maxOwned` businesses (one, during the trial). True when it is now the owner.
 */
export async function claimBusiness(userId: string, slug: string, o: AccountOpts & { maxOwned: number; createdSince?: number }): Promise<boolean> {
  const meta = await writable(o);
  const rows = await meta.query<{ role: string }>(
    `MATCH (u:User {id:$uid}), (t:Tenant {slug:$slug}) WHERE u.disabledAt IS NULL AND ($since IS NULL OR t.createdAt >= $since)
     WITH u, t, size([(u)-[o:MEMBER_OF]->(:Tenant) WHERE o.role = 'owner' | o]) AS owned
     WITH u, t, owned, size([(:User)-[x:MEMBER_OF]->(t) WHERE x.role = 'owner' | x]) AS owners
     WHERE owned < $maxOwned AND owners = 0
     CREATE (u)-[m:MEMBER_OF {role:'owner', since:$now}]->(t) RETURN m.role AS role`,
    { uid: userId, slug, maxOwned: o.maxOwned, now: nowOf(o), since: o.createdSince ?? null });
  return rows[0]?.role === "owner";
}

/** Adds an account to a business (the operator's CLI). Keeps an existing membership as it is. */
export async function addMember(userId: string, slug: string, role: MemberRole, opts?: AccountOpts): Promise<MemberRole | null> {
  const meta = await writable(opts);
  const rows = await meta.query<{ role: string }>(
    `MATCH (u:User {id:$uid}), (t:Tenant {slug:$slug})
     MERGE (u)-[m:MEMBER_OF]->(t) ON CREATE SET m.role = $role, m.since = $now RETURN m.role AS role`,
    { uid: userId, slug, role, now: nowOf(opts) });
  return isMemberRole(rows[0]?.role) ? rows[0]!.role as MemberRole : null;
}

/** The people in a business, in the order they joined. */
export async function membersOf(slug: string, opts?: AccountOpts): Promise<Member[]> {
  const rows = await read<{ id: string; name: string; email: string; role: string; since: number | null }>(opts,
    `MATCH (u:User)-[m:MEMBER_OF]->(t:Tenant {slug:$slug}) WHERE u.disabledAt IS NULL
     RETURN u.id AS id, u.name AS name, u.email AS email, m.role AS role, m.since AS since ORDER BY since, id LIMIT 200`, { slug });
  return rows.filter((r) => isMemberRole(r.role)).map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role as MemberRole, since: r.since ?? 0 }));
}

/** Invites not used yet and not expired. */
export async function openInviteCount(slug: string, opts?: AccountOpts): Promise<number> {
  const rows = await read<{ n: number }>(opts,
    "MATCH (t:Tenant {slug:$slug}) WITH t MATCH (t)-[hi:HAS_INVITE]->(i:Invite) WHERE i.usedAt IS NULL AND i.expiresAt > $now RETURN count(hi) AS n", { slug, now: nowOf(opts) });
  return rows[0]?.n ?? 0;
}

// ---------- invites ----------

export type InviteResult = { code: string; expiresAt: number } | { full: true };

/**
 * A single-use link into one business, as `role`, for 7 days. Every open invite holds a seat: when the people in the business
 * and its open invites already fill `seats`, no invite is made ({full: true}).
 */
export async function createInvite(slug: string, o: AccountOpts & { role: MemberRole; seats: number; createdBy: string; days?: number }): Promise<InviteResult> {
  if (!isTenantSlug(slug)) throw new AccountInputError("No such business.");
  const now = nowOf(o);
  const code = newSecret();
  const meta = await writable(o);
  const rows = await meta.query<{ expiresAt: number }>(
    `MATCH (t:Tenant {slug:$slug})
     WITH t, size([(u:User)-[:MEMBER_OF]->(t) WHERE u.disabledAt IS NULL | u]) AS members
     WITH t, members, size([(t)-[:HAS_INVITE]->(o:Invite) WHERE o.usedAt IS NULL AND o.expiresAt > $now | o]) AS open
     WHERE members + open < $seats
     CREATE (t)-[:HAS_INVITE]->(i:Invite {codeHash:$codeHash, slug:$slug, role:$role, createdAt:$now, expiresAt:$expiresAt, createdBy:$createdBy})
     RETURN i.expiresAt AS expiresAt`,
    { slug, now, seats: o.seats, codeHash: sha256(code), role: o.role, expiresAt: now + (o.days ?? 7) * DAY_MS, createdBy: o.createdBy.slice(0, 80) });
  return rows[0] ? { code, expiresAt: rows[0].expiresAt } : { full: true };
}

/** What an invite opens, while it is unused and not expired; null otherwise (one answer for every kind of "no"). */
export async function previewInvite(code: unknown, opts?: AccountOpts): Promise<InvitePreview | null> {
  if (!isSecret(code)) return null;
  const rows = await read<{ slug: string; name: string | null; role: string; expiresAt: number }>(opts,
    `MATCH (t:Tenant)-[:HAS_INVITE]->(i:Invite {codeHash:$codeHash}) WHERE i.usedAt IS NULL AND i.expiresAt > $now
     RETURN t.slug AS slug, t.name AS name, i.role AS role, i.expiresAt AS expiresAt LIMIT 1`,
    { codeHash: sha256(code), now: nowOf(opts) });
  const r = rows[0];
  return r && isMemberRole(r.role) ? { slug: r.slug, name: r.name ?? r.slug, role: r.role, expiresAt: r.expiresAt } : null;
}

export type AcceptResult = { slug: string; name: string; role: MemberRole; already: boolean };

/**
 * Uses an invite: the account joins the business with the invite's role, and the invite cannot be used again. An account that is
 * already in the business keeps its role and leaves the invite unused. Null when the invite is not valid (used, expired, unknown).
 */
export async function acceptInvite(code: unknown, userId: string, opts?: AccountOpts): Promise<AcceptResult | null> {
  const preview = await previewInvite(code, opts);
  if (!preview) return null;
  const mine = (await membershipsOf(userId, opts)).find((m) => m.slug === preview.slug);
  if (mine) return { slug: mine.slug, name: mine.name, role: mine.role, already: true };
  const meta = await writable(opts);
  const rows = await meta.query<{ slug: string; role: string }>(
    `MATCH (t:Tenant)-[:HAS_INVITE]->(i:Invite {codeHash:$codeHash}), (u:User {id:$uid})
     WHERE i.usedAt IS NULL AND i.expiresAt > $now AND u.disabledAt IS NULL
     WITH i, t, u, size([(u)-[old:MEMBER_OF]->(t) | old]) AS already
     WHERE already = 0
     SET i.usedAt = $now, i.usedBy = $uid
     CREATE (u)-[m:MEMBER_OF {role: i.role, since: $now}]->(t)
     RETURN t.slug AS slug, m.role AS role`,
    { codeHash: sha256(code as string), uid: userId, now: nowOf(opts) });
  const r = rows[0];
  return r && isMemberRole(r.role) ? { slug: r.slug, name: preview.name, role: r.role, already: false } : null;
}

// ---------- reset links (made by the operator: there is no email sender yet) ----------

/** A single-use link to choose a new password, for a day. Earlier unused ones stop working. Null when there is no such account. */
export async function createResetCode(emailRaw: unknown, opts?: AccountOpts): Promise<{ code: string; expiresAt: number; user: Account } | null> {
  const user = await findUser(emailRaw, opts);
  if (!user) return null;
  const now = nowOf(opts);
  const code = newSecret();
  const meta = await writable(opts);
  await meta.query("MATCH (u:User {id:$uid}) WITH u MATCH (u)-[:HAS_RESET]->(r:PasswordReset) WHERE r.usedAt IS NULL SET r.usedAt = $now", { uid: user.id, now });
  await meta.query(
    "MATCH (u:User {id:$uid}) CREATE (u)-[:HAS_RESET]->(:PasswordReset {codeHash:$codeHash, createdAt:$now, expiresAt:$expiresAt})",
    { uid: user.id, codeHash: sha256(code), now, expiresAt: now + RESET_MS });
  return { code, expiresAt: now + RESET_MS, user };
}

/** Sets a new password with a reset code; every session of the account is signed out. The account, or null for a bad code. */
export async function useResetCode(code: unknown, password: unknown, opts?: AccountOpts): Promise<Account | null> {
  const problem = passwordProblem(password);
  if (problem) throw new AccountInputError(problem);
  if (!isSecret(code)) return null;
  const passHash = await hashPassword(password as string);
  const meta = await writable(opts);
  const rows = await meta.query<UserRow>(
    `MATCH (u:User)-[:HAS_RESET]->(r:PasswordReset {codeHash:$codeHash}) WHERE r.usedAt IS NULL AND r.expiresAt > $now AND u.disabledAt IS NULL
     SET r.usedAt = $now, u.passHash = $passHash, u.passwordChangedAt = $now
     RETURN u.id AS id, u.email AS email, u.name AS name, u.createdAt AS createdAt`,
    { codeHash: sha256(code), now: nowOf(opts), passHash });
  if (!rows[0]) return null;
  await revokeSessions(rows[0].id, opts);
  return account(rows[0]);
}
