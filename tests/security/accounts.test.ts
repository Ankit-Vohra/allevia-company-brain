// Accounts in the registry graph (src/auth/accounts.ts): users with hashed passwords, sessions and invites kept only as SHA-256
// hashes, single-use codes, one business per account during the trial, and the checks that must hold under a race. A throwaway
// registry graph on the test database, never the real allevia_meta.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY_MS, SESSION_MS, acceptInvite, addMember, changePassword, checkLogin, claimBusiness, createInvite, createResetCode, createSession, createUser,
  listUsers, membersOf, membershipsOf, normalizeEmail, openInviteCount, ownedCount, previewInvite, resolveSession, revokeSession, revokeSessions,
  setDisabled, touchSession, useResetCode,
} from "../../src/auth/accounts.js";
import { TRIAL_SEATS, planOf, seatsFor } from "../../src/auth/seats.js";
import { startTrial } from "../../src/auth/trial.js";
import { closeAll, openGraph, openGraphByName } from "../../src/graph/client.js";
import { ensureTenant, getTenant } from "../../src/graph/tenants.js";
import { testGraphName } from "../helpers/graph.js";

const metaGraph = testGraphName();
const opts = { metaGraph };
const sfx = Math.random().toString(36).slice(2, 8);
const A = `acct_${sfx}_a`;
const B = `acct_${sfx}_b`;
const PW = "a long enough password";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let n = 0;
const email = (who: string) => `${who}.${sfx}.${n++}@example.com`;
const newUser = async (who = "u") => (await createUser({ email: email(who), name: who, password: PW }, opts))!;

beforeAll(async () => {
  await ensureTenant({ slug: A, name: "Alpha" }, opts);
  await ensureTenant({ slug: B, name: "Bravo" }, opts);
}, 60_000);
afterAll(async () => {
  await (await openGraphByName(metaGraph)).drop();
  await (await openGraph(A)).drop();
  await (await openGraph(B)).drop();
  await closeAll();
});

const dump = async () => JSON.stringify(await (await openGraphByName(metaGraph)).roQuery("MATCH (n) RETURN properties(n) AS p ORDER BY id(n)"));

describe("users", () => {
  it("makes an account with a lower-case email, keeps only the password's hash, and makes the indexes and unique constraints", async () => {
    const e = email("priya");
    const u = await createUser({ email: `  ${e.toUpperCase()} `, name: "  Priya   Shah ", password: PW }, opts);
    expect(u).toMatchObject({ email: e, name: "Priya Shah" });
    expect(u!.id).toMatch(/^usr_[0-9a-f]{16}$/);
    const all = await dump();
    expect(all).not.toContain(PW);
    expect(all).toMatch(/scrypt\$32768\$8\$1\$/);
    const meta = await openGraphByName(metaGraph);
    const unique = (await meta.constraints()).filter((c) => c.type === "UNIQUE").map((c) => `${c.label}.${c.props.join(",")}`).sort();
    expect(unique).toEqual(["Invite.codeHash", "PasswordReset.codeHash", "Session.idHash", "User.email", "User.id"]);
  });

  it("gives an email one account, however it is spelled, even when two sign-ups race", async () => {
    const e = email("race");
    const made = await Promise.all([1, 2, 3].map((i) => createUser({ email: i === 2 ? e.toUpperCase() : e, name: `R${i}`, password: PW }, opts)));
    expect(made.filter(Boolean)).toHaveLength(1);
    const rows = await (await openGraphByName(metaGraph)).roQuery<{ c: number }>("MATCH (u:User {email:$e}) RETURN count(u) AS c", { e });
    expect(rows[0]!.c).toBe(1);
  });

  it("refuses input an account cannot be made from, with a plain sentence", async () => {
    await expect(createUser({ email: "not-an-email", name: "X", password: PW }, opts)).rejects.toThrow(/email address/);
    await expect(createUser({ email: email("x"), name: "   ", password: PW }, opts)).rejects.toThrow(/your name/);
    await expect(createUser({ email: email("x"), name: "X", password: "short" }, opts)).rejects.toThrow(/at least 10/);
    for (const bad of ["a@b", "a b@c.com", "@c.com", "a@.com", "a@c..com", `${"a".repeat(65)}@c.com`, "a@c.com\nb@d.com", "<a@c.com>", "a@c.com, b@d.com"]) expect(normalizeEmail(bad), bad).toBeNull();
  });

  it("signs in with the right email and password only; an unknown email, a wrong password and a switched-off account all say null", async () => {
    const u = await newUser("login");
    expect(await checkLogin(u.email.toUpperCase(), PW, opts)).toMatchObject({ id: u.id });
    expect(await checkLogin(u.email, `${PW}!`, opts)).toBeNull();
    expect(await checkLogin(`nobody.${sfx}@example.com`, PW, opts)).toBeNull();
    expect(await checkLogin("not an email", PW, opts)).toBeNull();
    await setDisabled(u.email, true, opts);
    expect(await checkLogin(u.email, PW, opts)).toBeNull();
    await setDisabled(u.email, false, opts);
    expect(await checkLogin(u.email, PW, opts)).toMatchObject({ id: u.id });
  });

  it("changes a password only with the current one, and signs every other session out", async () => {
    const u = await newUser("change");
    const keep = (await createSession(u.id, opts))!;
    const other = (await createSession(u.id, opts))!;
    const keepHash = sha256(keep.id);
    expect(await changePassword(u.id, "wrong password!", "a brand new password", { ...opts, keepSession: keepHash })).toBe(false);
    expect(await changePassword(u.id, PW, "a brand new password", { ...opts, keepSession: keepHash })).toBe(true);
    expect(await checkLogin(u.email, PW, opts)).toBeNull();
    expect(await checkLogin(u.email, "a brand new password", opts)).not.toBeNull();
    expect(await resolveSession(keep.id, opts)).not.toBeNull();
    expect(await resolveSession(other.id, opts)).toBeNull();
  });

  it("lists accounts for the operator with their businesses, never a hash", async () => {
    const u = await newUser("listed");
    await addMember(u.id, A, "member", opts);
    const listed = (await listUsers(opts)).find((x) => x.id === u.id);
    expect(listed).toMatchObject({ email: u.email, businesses: [{ slug: A, role: "member" }], disabledAt: null });
    expect(JSON.stringify(await listUsers(opts))).not.toMatch(/scrypt|passHash|[0-9a-f]{64}/);
  });
});

describe("sessions", () => {
  it("are 256-bit random ids, stored only as their SHA-256", async () => {
    const u = await newUser("sess");
    const s = (await createSession(u.id, opts))!;
    expect(s.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const all = await dump();
    expect(all).not.toContain(s.id);
    expect(all).toContain(sha256(s.id));
    const view = await resolveSession(s.id, opts);
    expect(view).toMatchObject({ user: { id: u.id, email: u.email }, hash: sha256(s.id), memberships: [] });
  });

  it("say nothing for a made-up, tampered or wrongly shaped id", async () => {
    const u = await newUser("tamper");
    const s = (await createSession(u.id, opts))!;
    for (const bad of ["", "x", s.id.slice(0, -1), `${s.id}x`, s.id.toUpperCase(), sha256(s.id), ` ${s.id}`, "A".repeat(43), null, 1]) {
      expect(await resolveSession(bad, opts), String(bad).slice(0, 20)).toBeNull();
    }
  });

  it("end when signed out, when they expire, and when the account is switched off", async () => {
    const u = await newUser("ends");
    const a = (await createSession(u.id, opts))!;
    expect(await revokeSession(sha256(a.id), opts)).toBe(1);
    expect(await resolveSession(a.id, opts)).toBeNull();
    const b = (await createSession(u.id, opts))!;
    expect(await resolveSession(b.id, { ...opts, now: Date.now() + SESSION_MS + 1000 })).toBeNull();
    const c = (await createSession(u.id, opts))!;
    await setDisabled(u.email, true, opts);
    expect(await resolveSession(c.id, opts)).toBeNull();
    expect(await createSession(u.id, opts)).toBeNull();
  });

  it("slide: using a session moves its end 30 days on", async () => {
    const u = await newUser("slide");
    const t0 = Date.now();
    const s = (await createSession(u.id, { ...opts, now: t0 }))!;
    const later = t0 + 20 * DAY_MS;
    expect(await touchSession(sha256(s.id), { ...opts, now: later })).toBe(later + SESSION_MS);
    expect(await resolveSession(s.id, { ...opts, now: t0 + 40 * DAY_MS })).not.toBeNull(); // past the first end, still live
    expect(await revokeSessions(u.id, opts)).toBe(1);
    expect(await touchSession(sha256(s.id), opts)).toBeNull();
  });
});

describe("businesses", () => {
  it("an account claims a business it set up, one during the trial, and never one that has an owner", async () => {
    const u = await newUser("owner");
    const v = await newUser("other");
    const C = `acct_${sfx}_c`;
    await ensureTenant({ slug: C, name: "Charlie" }, opts);
    try {
      // a business registered before the set-up started is never claimed (it was already there)
      expect(await claimBusiness(u.id, A, { ...opts, maxOwned: 1, createdSince: Date.now() + 60_000 })).toBe(false);
      expect(await claimBusiness(u.id, A, { ...opts, maxOwned: 1, createdSince: Date.now() - 600_000 })).toBe(true);
      expect(await claimBusiness(u.id, C, { ...opts, maxOwned: 1 })).toBe(false); // one business during the trial
      expect(await claimBusiness(v.id, A, { ...opts, maxOwned: 1 })).toBe(false); // A has an owner
      expect(await ownedCount(u.id, opts)).toBe(1);
      expect(await membershipsOf(u.id, opts)).toEqual([{ slug: A, name: "Alpha", role: "owner" }]);
      // two claims at once on the same new business: one owner
      const w = await newUser("w");
      const x = await newUser("x");
      const both = await Promise.all([claimBusiness(w.id, C, { ...opts, maxOwned: 1 }), claimBusiness(x.id, C, { ...opts, maxOwned: 1 })]);
      expect(both.filter(Boolean)).toHaveLength(1);
    } finally {
      await (await openGraph(C)).drop();
    }
  });
});

describe("invites", () => {
  it("keep only the code's hash, work once, and hold a seat while open", async () => {
    const owner = await newUser("inv-owner");
    await addMember(owner.id, B, "owner", opts);
    const r = await createInvite(B, { ...opts, role: "member", seats: 3, createdBy: owner.id });
    if ("full" in r) throw new Error("expected an invite");
    expect(r.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const all = await dump();
    expect(all).not.toContain(r.code);
    expect(all).toContain(sha256(r.code));
    expect(await previewInvite(r.code, opts)).toMatchObject({ slug: B, name: "Bravo", role: "member" });
    expect(await openInviteCount(B, opts)).toBe(1);

    const joiner = await newUser("joiner");
    expect(await acceptInvite(r.code, joiner.id, opts)).toEqual({ slug: B, name: "Bravo", role: "member", already: false });
    expect(await acceptInvite(r.code, (await newUser("late")).id, opts)).toBeNull(); // once
    expect(await previewInvite(r.code, opts)).toBeNull();
    expect((await membersOf(B, opts)).map((m) => [m.id, m.role])).toEqual([[owner.id, "owner"], [joiner.id, "member"]]);
    expect(await openInviteCount(B, opts)).toBe(0);
  });

  it("stop at the plan's seats, counting the people in and the open invites", async () => {
    const S = `acct_${sfx}_s`;
    await ensureTenant({ slug: S, name: "Seats" }, opts);
    try {
      const owner = await newUser("seat-owner");
      await addMember(owner.id, S, "owner", opts);
      const first = await createInvite(S, { ...opts, role: "member", seats: 2, createdBy: owner.id });
      expect("code" in first).toBe(true);
      expect(await createInvite(S, { ...opts, role: "member", seats: 2, createdBy: owner.id })).toEqual({ full: true });
      // two at once for the last seat: one invite
      const raced = await Promise.all([1, 2, 3].map(() => createInvite(S, { ...opts, role: "member", seats: 3, createdBy: owner.id })));
      expect(raced.filter((x) => "code" in x)).toHaveLength(1);
    } finally {
      await (await openGraph(S)).drop();
    }
  });

  it("expire after 7 days, and leave an account that is already in the business as it was", async () => {
    const owner = await newUser("exp-owner");
    await addMember(owner.id, A, "member", opts);
    const t0 = Date.now();
    const r = await createInvite(A, { ...opts, now: t0, role: "owner", seats: 50, createdBy: "test" });
    if ("full" in r) throw new Error("expected an invite");
    // already in A as a member: stays a member, and the invite is still there for someone else
    expect(await acceptInvite(r.code, owner.id, opts)).toMatchObject({ slug: A, role: "member", already: true });
    expect(await previewInvite(r.code, opts)).not.toBeNull();
    const someone = await newUser("too-late");
    expect(await acceptInvite(r.code, someone.id, { ...opts, now: t0 + 7 * DAY_MS + 1 })).toBeNull();
    expect(await membershipsOf(someone.id, opts)).toEqual([]);
    for (const bad of ["", "x".repeat(43), r.code.slice(1), sha256(r.code), undefined]) expect(await previewInvite(bad, opts)).toBeNull();
  });
});

describe("reset links", () => {
  it("set a new password once, within a day, and sign the account out everywhere", async () => {
    const u = await newUser("reset");
    const s = (await createSession(u.id, opts))!;
    const first = (await createResetCode(u.email, opts))!;
    const second = (await createResetCode(u.email, opts))!;
    expect(await useResetCode(first.code, "the first new password", opts)).toBeNull(); // replaced by the second
    expect(await dump()).not.toContain(second.code);
    expect(await useResetCode(second.code, "the second new password", opts)).toMatchObject({ id: u.id });
    expect(await resolveSession(s.id, opts)).toBeNull();
    expect(await checkLogin(u.email, PW, opts)).toBeNull();
    expect(await checkLogin(u.email, "the second new password", opts)).not.toBeNull();
    expect(await useResetCode(second.code, "a third new password", opts)).toBeNull();
    const late = (await createResetCode(u.email, opts))!;
    expect(await useResetCode(late.code, "a fourth new password", { ...opts, now: Date.now() + DAY_MS + 1000 })).toBeNull();
    expect(await createResetCode(`nobody.${sfx}@example.com`, opts)).toBeNull();
  });
});

describe("the plan's seats and the trial", () => {
  it("a business with no subscription record is on the trial, with the default plan's seats", async () => {
    expect(await planOf(A, opts)).toBe("trial");
    expect(await seatsFor(A, opts)).toBe(TRIAL_SEATS);
    expect(TRIAL_SEATS).toBe(5);
    const meta = await openGraphByName(metaGraph);
    await meta.query("MATCH (t:Tenant {slug:$s}) CREATE (t)-[:HAS_SUBSCRIPTION]->(:Subscription {plan:'starter', status:'active', startedAt:1})", { s: B });
    expect(await seatsFor(B, opts)).toBe(2);
  });

  it("starts the trial: 100 credits through the credits module when it is there, and the end in 14 days, once", async () => {
    const grants: unknown[][] = [];
    const t0 = Date.now();
    const r = await startTrial(A, "usr_x", { ...opts, now: t0, grant: async (...a) => { grants.push(a); }, log: () => {} });
    expect(grants).toEqual([[A, 100, "trial", `trial:${A}`]]);
    expect(r).toEqual({ credits: 100, trialEndsAt: t0 + 14 * DAY_MS, granted: true });
    const again = await startTrial(A, "usr_x", { ...opts, now: t0 + DAY_MS, grant: null, log: () => {} });
    expect(again.trialEndsAt).toBe(t0 + 14 * DAY_MS); // the end does not move
    const meta = await openGraphByName(metaGraph);
    expect(await meta.roQuery("MATCH (t:Tenant {slug:$s}) RETURN t.trialEndsAt AS e", { s: A })).toEqual([{ e: t0 + 14 * DAY_MS }]);
  });

  it("without the credits module, says so in the log and still records the end", async () => {
    const lines: string[] = [];
    const r = await startTrial(B, "usr_y", { ...opts, grant: null, log: (l) => lines.push(l) });
    expect(r.granted).toBe(false);
    expect(lines.join("\n")).toMatch(/credits module .* not installed/);
    expect((await getTenant(B, opts))?.slug).toBe(B);
    const failing = await startTrial(B, "usr_y", { ...opts, grant: async () => { throw new Error("ledger down"); }, log: (l) => lines.push(l) });
    expect(failing.granted).toBe(false);
    expect(lines.join("\n")).toMatch(/ledger down/);
  });
});
