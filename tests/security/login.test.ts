// Accounts over HTTP with ALLEVIA_AUTH=1, through the real app (createApp) and real registry graphs on the test database: sign up,
// set a business up and own it on the trial; sign in and out; the door's order (a member's session, then an owner link, then the
// demo read-only, then 401); a member against the owner-only routes; invites once and for 7 days; seats; passwords; the cookie;
// the rate limits. A throwaway registry graph per app, never the real allevia_meta, and never FalkorDB Cloud.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { OnboardEvent } from "../../shared/contracts.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { addMember, createResetCode, createUser, setDisabled, type MemberRole } from "../../src/auth/accounts.js";
import { getSubscription } from "../../src/billing/subscription.js";
import { issueToken, verifyToken } from "../../src/auth/tokens.js";
import { closeAll, openGraph, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { ensureTenant, listTenants } from "../../src/graph/tenants.js";
import { createApp, type ServerDeps } from "../../src/server/app.js";
import { OWNER_ONLY } from "../../src/server/roles.js";
import { INVITE_GONE, MISMATCH } from "../../src/server/routes/account.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";
import { SCRIPTS, sseBlocks } from "../server/harness.js";

const DAY = 86_400_000;
const NO_LIMITS = { authOpen: false, authOpenAll: false, onboard: false, onboardRuns: false, login: false, loginEmail: false, loginAll: false, signup: false, signupAll: false } as const;
const PW = "a long enough password";
const sfx = Math.random().toString(36).slice(2, 8);
let n = 0;
const email = (who: string) => `${who}.${sfx}.${n++}@example.com`;

const metaGraph = testGraphName();   // tenant_a, tenant_b (private) and demo_co (the demo)
const freshGraph = testGraphName();  // a fresh deployment: only the demo business
const opts = { metaGraph };
let a: GraphHandle;
let b: GraphHandle;
let d: GraphHandle;
let tokenA = "";
let tokenOp = "";
const made: string[] = []; // graphs of businesses set up in these tests, dropped at the end
let clock = SEED_NOW + 3_600_000;
const trials: Array<[string, string]> = [];

// ---- helpers ----
type Init = { headers?: Record<string, string>; method?: string; body?: string };
const send = (app: Hono, path: string, body: unknown, init: Init = {}) =>
  app.request(path, { method: init.method ?? "POST", headers: { "content-type": "application/json", ...init.headers }, body: JSON.stringify(body) });
const get = (app: Hono, path: string, headers: Record<string, string> = {}) => app.request(path, { headers });
const read = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>;
const sessionSetCookie = (res: Response): string => res.headers.getSetCookie().find((c) => c.startsWith("allevia_session=")) ?? "";
const jarOf = (res: Response): string => sessionSetCookie(res).split(";")[0]!;
const as = (cookie: string) => ({ headers: { cookie } });
const events = (text: string) => sseBlocks(text).map((x) => JSON.parse(x.data) as OnboardEvent);

async function signup(app: Hono, who: string, e = email(who)): Promise<{ cookie: string; id: string; email: string }> {
  const res = await send(app, "/api/auth/signup", { name: who, email: e, password: PW });
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await read(res);
  return { cookie: jarOf(res), id: (body.user as { id: string }).id, email: e };
}
async function member(slug: string, role: MemberRole, o = opts): Promise<{ id: string; email: string }> {
  const e = email(`${role}-${slug}`);
  const u = (await createUser({ email: e, name: `${role} of ${slug}`, password: PW }, o))!;
  await addMember(u.id, slug, role, o);
  return { id: u.id, email: e };
}
async function login(app: Hono, e: string, password = PW): Promise<string> {
  const res = await send(app, "/api/auth/login", { email: e, password });
  expect(res.status).toBe(200);
  return jarOf(res);
}

function deps(meta: string, graphs: Record<string, GraphHandle>, over: Partial<ServerDeps> = {}): ServerDeps {
  const o = { metaGraph: meta };
  return {
    publicMode: false,
    listTenants: () => listTenants(o),
    openGraph: async (slug) => graphs[slug] ?? openGraph(slug),
    askDeps: async (tenant) => createAskDeps({ tenant }, { graph: graphs[tenant]!, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) }),
    embedQuery: async () => async (t: string) => fakeEmbed(t),
    // stands in for onboarding: registers the business (as the real one does first) and says it is done
    loadOnboard: async () => async (input, emit) => {
      await ensureTenant({ slug: input.slug, name: input.name }, o);
      made.push(input.slug);
      if (/unreadable/.test(input.url)) { emit({ type: "error", message: "We could not read that website." }); return; }
      emit({ type: "done", tenant: input.slug, counts: { Page: 3 } });
    },
    auth: { enabled: true, verify: (t) => verifyToken(t, o), accounts: { metaGraph: meta, startTrial: async (slug, userId) => { trials.push([slug, userId]); } } },
    actions: { config: { dataDir: "/nonexistent-allevia-login-test" } },
    directiveLlm: null, heartbeatMs: 0, replaySpeed: 0, now: () => clock, tenantCacheMs: 0, log: () => {},
    rateLimit: NO_LIMITS,
    registry: o, // the credits ledger's subscriptions in the same throwaway registry
    ...over,
  };
}

let graphs: Record<string, GraphHandle>;
let app: Hono;

beforeAll(async () => {
  ({ g: a } = await seededGraph());
  ({ g: b } = await seededGraph());
  ({ g: d } = await seededGraph());
  for (const g of [a, b, d]) await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);
  await upsertNode(b, { type: "Approval", id: "approval:b-only-1", name: "github_issue: Bravo roof", props: { status: "pending", kind: "github_issue", title: "Bravo roof", payload: JSON.stringify({ title: "Bravo roof", body: "x" }) } }, SEED_NOW);
  const base = { graph: "x", businessId: "business:aamdani", ontologyVersion: 2, createdAt: 1, updatedAt: 1 };
  const meta = await openGraphByName(metaGraph);
  await meta.query("CREATE (:Tenant {slug:'tenant_a', name:'Alpha Foods', domain:'alpha.example'}), (:Tenant {slug:'tenant_b', name:'Bravo Builders', domain:'bravo.example'}), (:Tenant {slug:'demo_co', name:'Demo Company', demo:true})", {});
  await meta.query("MATCH (t:Tenant) SET t += $base", { base });
  const fresh = await openGraphByName(freshGraph);
  await fresh.query("CREATE (:Tenant {slug:'demo_co', name:'Demo Company', demo:true})", {});
  await fresh.query("MATCH (t:Tenant) SET t += $base", { base });
  tokenA = (await issueToken("tenant_a", { label: "a" }, opts)).token;
  tokenOp = (await issueToken("operator", { label: "ops" }, opts)).token;
  graphs = { tenant_a: a, tenant_b: b, demo_co: d };
  app = createApp(deps(metaGraph, graphs));
}, 120_000);

afterAll(async () => {
  for (const s of new Set(made)) await (await openGraph(s)).drop().catch(() => {});
  await a?.drop();
  await b?.drop();
  await d?.drop();
  await (await openGraphByName(metaGraph)).drop();
  await (await openGraphByName(freshGraph)).drop();
  await closeAll();
});

describe("a judge on a fresh deployment (only the demo business): sign up, set up their business, keep the demo read-only", () => {
  let fresh: Hono;
  let judge: { cookie: string; id: string; email: string };
  let slug = "";
  beforeAll(() => {
    // the production trial adapter (src/auth/trial.ts) over the server's own credits ledger, not a stand-in
    const dep = deps(freshGraph, { demo_co: d });
    fresh = createApp({ ...dep, auth: { ...dep.auth!, accounts: { metaGraph: freshGraph } } });
  });

  it("a stranger sees only the demo, read-only, is not signed in, and cannot set a business up", async () => {
    expect((await (await get(fresh, "/api/tenants")).json() as Array<Record<string, unknown>>).map((t) => [t.id, t.readOnly])).toEqual([["demo_co", true]]);
    const me = await get(fresh, "/api/auth/me");
    expect([me.status, (await read(me)).error]).toEqual([401, "You are not signed in."]);
    const onboard = await send(fresh, "/api/onboard", { name: "Mine", url: "mine.example" });
    expect([onboard.status, (await read(onboard)).error]).toEqual([401, "Sign in first, then set up your business."]);
  });

  it("signs up: a session cookie that scripts cannot read, for the whole app, and no business yet", async () => {
    const e = email("judge");
    const res = await send(fresh, "/api/auth/signup", { name: "  Jo   Judge ", email: e.toUpperCase(), password: PW });
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body).toEqual({ user: { id: expect.stringMatching(/^usr_/), email: e, name: "Jo Judge" }, businesses: [] });
    const set = sessionSetCookie(res);
    expect(set).toMatch(/^allevia_session=[A-Za-z0-9_-]{43};/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).toMatch(/Path=\/(;|$)/);
    expect(set).toMatch(/Max-Age=2592000/); // 30 days
    expect(set).not.toMatch(/Secure/i); // plain http here: see "the cookie" below for https
    expect(JSON.stringify(body)).not.toContain(PW);
    judge = { cookie: jarOf(res), id: (body.user as { id: string }).id, email: e };
    expect(await read(await get(fresh, "/api/auth/me", { cookie: judge.cookie }))).toMatchObject({ user: { email: e }, businesses: [] });
    // still only the demo, read-only
    const list = await (await get(fresh, "/api/tenants", { cookie: judge.cookie })).json() as Array<Record<string, unknown>>;
    expect(list.map((t) => [t.id, t.readOnly])).toEqual([["demo_co", true]]);
  });

  it("pastes the website: the business is set up, they are its owner, and the trial starts", async () => {
    const res = await send(fresh, "/api/onboard", { name: `Kestrel ${sfx}`, url: "kestrel.example" }, as(judge.cookie));
    expect(res.status).toBe(200);
    const evs = events(await res.text());
    const done = evs.find((e) => e.type === "done") as Extract<OnboardEvent, { type: "done" }>;
    expect(done).toBeDefined();
    slug = done.tenant;
    expect(slug).toBe(`kestrel_${sfx}`);
    const list = await (await get(fresh, "/api/tenants", { cookie: judge.cookie })).json() as Array<Record<string, unknown>>;
    expect(list.map((t) => [t.id, t.role ?? null, t.readOnly ?? false])).toEqual([[slug, "owner", false], ["demo_co", null, true]]);
    expect((await read(await get(fresh, "/api/auth/me", { cookie: judge.cookie }))).businesses).toEqual([{ id: slug, name: `Kestrel ${sfx}`, role: "owner" }]);
    const members = await read(await get(fresh, `/api/${slug}/members`, { cookie: judge.cookie }));
    expect(members).toMatchObject({ members: [{ id: judge.id, role: "owner", you: true }], seats: 5, invited: 0, canInvite: true });
    expect((await get(fresh, `/api/${slug}/overview`, { cookie: judge.cookie })).status).toBe(200);
    // the trial, granted through the server's own ledger: a trial subscription ending in 14 days, and 100 credits to spend
    expect(await getSubscription(slug, { metaGraph: freshGraph })).toMatchObject({ status: "trial", trialEndsAt: clock + 14 * DAY });
    const credits = await read(await get(fresh, `/api/${slug}/credits`, { cookie: judge.cookie }));
    expect(credits.balance).toMatchObject({ status: "trial", trial: 100, left: 100 });
  });

  it("the demo stays read-only for them, and nobody else can open their business", async () => {
    const demo = await get(fresh, "/api/demo_co/overview", { cookie: judge.cookie });
    expect(((await read(demo)).tenant as Record<string, unknown>).readOnly).toBe(true);
    const change = await send(fresh, "/api/demo_co/approvals/approval:t-001-1", { decision: "approve" }, as(judge.cookie));
    expect([change.status, (await read(change)).error]).toEqual([403, expect.stringMatching(/public read-only demo/)]);
    expect((await get(fresh, `/api/${slug}/overview`)).status).toBe(401);
    const other = await signup(fresh, "other");
    expect((await get(fresh, `/api/${slug}/overview`, { cookie: other.cookie })).status).toBe(401);
    expect((await get(fresh, `/api/${slug}/members`, { cookie: other.cookie })).status).toBe(401);
  });

  it("one business per account during the trial", async () => {
    const res = await send(fresh, "/api/onboard", { name: `Second ${sfx}`, url: "second.example" }, as(judge.cookie));
    expect([res.status, (await read(res)).error]).toEqual([403, "Your free trial covers one business, and you have set yours up."]);
  });

  it("a set-up that does not finish leaves the account free to try again, and owning nothing", async () => {
    const t = await signup(fresh, "retry");
    const bad = await send(fresh, "/api/onboard", { name: `Unreadable ${sfx}`, url: "unreadable.example" }, as(t.cookie));
    expect(events(await bad.text()).some((e) => e.type === "done")).toBe(false);
    expect((await read(await get(fresh, "/api/auth/me", { cookie: t.cookie }))).businesses).toEqual([]);
    const good = await send(fresh, "/api/onboard", { name: `Readable ${sfx}`, url: "readable.example" }, as(t.cookie));
    expect(events(await good.text()).some((e) => e.type === "done")).toBe(true);
    expect(((await read(await get(fresh, "/api/auth/me", { cookie: t.cookie }))).businesses as unknown[]).length).toBe(1);
  });
});

describe("signing in and out", () => {
  let user: { cookie: string; id: string; email: string };
  beforeAll(async () => { user = await signup(app, "signin"); });

  it("one sentence for every failure: unknown email, wrong password, malformed email, nothing at all", async () => {
    const answers = new Set<string>();
    for (const body of [{ email: user.email, password: `${PW}!` }, { email: `nobody.${sfx}@example.com`, password: PW }, { email: "not an email", password: PW }, {}, { email: user.email }, { email: user.email, password: "short" }]) {
      const res = await send(app, "/api/auth/login", body);
      expect(res.status, JSON.stringify(body)).toBe(401);
      expect(res.headers.getSetCookie()).toEqual([]);
      answers.add(await res.text());
    }
    expect([...answers]).toEqual([JSON.stringify({ error: MISMATCH })]);
    expect(MISMATCH).toBe("That email and password don't match.");
  });

  it("signs in with the right email (in any case) and password", async () => {
    const res = await send(app, "/api/auth/login", { email: ` ${user.email.toUpperCase()} `, password: PW });
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ user: { id: user.id } });
    expect(sessionSetCookie(res)).toMatch(/^allevia_session=/);
  });

  it("signing up with an email that has an account is a sign-in: the right password signs in, a wrong one gets the same sentence", async () => {
    const wrong = await send(app, "/api/auth/signup", { name: "Someone", email: user.email, password: "another long password" });
    expect([wrong.status, (await read(wrong)).error]).toEqual([401, MISMATCH]);
    const right = await send(app, "/api/auth/signup", { name: "Someone else", email: user.email, password: PW });
    expect(right.status).toBe(200);
    expect(await read(right)).toMatchObject({ user: { id: user.id, name: "signin" } }); // the account is untouched
  });

  it("says plainly what a sign-up is missing", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ name: "X", email: email("x"), password: "short" }, /at least 10 characters/],
      [{ name: "X", email: "nope", password: PW }, /email address/],
      [{ name: "   ", email: email("x"), password: PW }, /your name/],
      [{ email: email("x"), password: PW }, /Bad request/],
    ];
    for (const [body, words] of cases) {
      const res = await send(app, "/api/auth/signup", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await read(res)).error).toMatch(words);
    }
  });

  it("signing out ends that session at once, everywhere it is used, and clears the cookie", async () => {
    const owner = await member("tenant_a", "member");
    const cookie = await login(app, owner.email);
    expect((await get(app, "/api/tenant_a/overview", { cookie })).status).toBe(200);
    const out = await send(app, "/api/auth/logout", {}, as(cookie));
    expect(out.status).toBe(200);
    expect(sessionSetCookie(out)).toMatch(/^allevia_session=;.*Max-Age=0/);
    expect((await get(app, "/api/auth/me", { cookie })).status).toBe(401);
    expect((await get(app, "/api/tenant_a/overview", { cookie })).status).toBe(401);
    expect(((await (await get(app, "/api/tenants", { cookie })).json()) as Array<{ id: string }>).map((t) => t.id)).toEqual(["demo_co"]);
  });

  it("a made-up or tampered cookie is no session", async () => {
    for (const cookie of ["allevia_session=", `allevia_session=${"A".repeat(43)}`, `${user.cookie}x`, "allevia_session=../../x", `allevia_session=${"x".repeat(5000)}`]) {
      expect((await get(app, "/api/auth/me", { cookie })).status, cookie.slice(0, 40)).toBe(401);
    }
  });

  it("a switched-off account is signed out on its next request", async () => {
    const u = await signup(app, "switched");
    expect((await get(app, "/api/auth/me", { cookie: u.cookie })).status).toBe(200);
    await setDisabled(u.email, true, opts);
    expect((await get(app, "/api/auth/me", { cookie: u.cookie })).status).toBe(401);
    expect((await send(app, "/api/auth/login", { email: u.email, password: PW })).status).toBe(401);
  });

  it("another site cannot sign a browser in or out (the Origin check)", async () => {
    const res = await send(app, "/api/auth/login", { email: user.email, password: PW }, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect((await send(app, "/api/auth/signup", { name: "x", email: email("x"), password: PW }, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });
});

describe("the door, in order: a member's session, an owner link, the demo read-only, then 401", () => {
  it("a session for business A cannot open business B, and B cannot tell it apart from a business that does not exist", async () => {
    const ownerA = await member("tenant_a", "owner");
    const cookie = await login(app, ownerA.email);
    expect((await get(app, "/api/tenant_a/overview", { cookie })).status).toBe(200);
    const [bRes, none] = [await get(app, "/api/tenant_b/overview", { cookie }), await get(app, "/api/no_such_co/overview", { cookie })];
    expect([bRes.status, none.status]).toEqual([401, 401]);
    expect(await bRes.text()).toBe(await none.text());
    const before = await b.roQuery("MATCH (x:Approval {id:'approval:b-only-1'}) RETURN x.status AS s");
    expect((await send(app, "/api/tenant_b/approvals/approval%3Ab-only-1", { decision: "approve" }, as(cookie))).status).toBe(401);
    expect(await b.roQuery("MATCH (x:Approval {id:'approval:b-only-1'}) RETURN x.status AS s")).toEqual(before);
    const list = await (await get(app, "/api/tenants", { cookie })).json() as Array<Record<string, unknown>>;
    expect(list.map((t) => [t.id, t.role ?? null, t.readOnly ?? false])).toEqual([["tenant_a", "owner", false], ["demo_co", null, true]]);
    expect(JSON.stringify(list)).not.toMatch(/Bravo/);
  });

  it("owner links still work, alone or beside a session for another business", async () => {
    expect((await get(app, "/api/tenant_a/overview", { authorization: `Bearer ${tokenA}` })).status).toBe(200);
    expect((await get(app, "/api/tenant_a/overview", { cookie: `allevia_k_tenant_a=${tokenA}` })).status).toBe(200);
    const memberB = await member("tenant_b", "member");
    const cookie = `${await login(app, memberB.email)}; allevia_k_tenant_a=${tokenA}`;
    expect((await get(app, "/api/tenant_a/overview", { cookie })).status).toBe(200);
    expect((await get(app, "/api/tenant_b/overview", { cookie })).status).toBe(200);
    // the owner link makes its holder the owner: an owner-only route lets them in
    const inv = await send(app, "/api/tenant_a/invites", {}, as(cookie));
    expect(inv.status).toBe(201);
    const list = await (await get(app, "/api/tenants", { cookie })).json() as Array<Record<string, unknown>>;
    expect(Object.fromEntries(list.map((t) => [t.id, t.role ?? "read-only"]))).toEqual({ tenant_a: "owner", tenant_b: "member", demo_co: "read-only" });
  });

  it("the operator's link still sets businesses up; an account can never set up over one that exists", async () => {
    const op = await send(app, "/api/onboard", { name: "Alpha Foods", url: "alpha.example", slug: "tenant_a" }, { headers: { authorization: `Bearer ${tokenOp}` } });
    expect(op.status).toBe(200);
    await op.text();
    const u = await signup(app, "steer");
    const named = await send(app, "/api/onboard", { name: "Steer", url: "steer.example", slug: "tenant_b" }, as(u.cookie));
    expect([named.status, (await read(named)).error]).toEqual([409, "That business id is already taken."]);
    // a name that comes out as an existing business's id gets a new id, never that business
    const same = await send(app, "/api/onboard", { name: "Tenant B", url: "steer.example" }, as(u.cookie));
    const done = events(await same.text()).find((e) => e.type === "done") as Extract<OnboardEvent, { type: "done" }>;
    expect(done.tenant).toBe("tenant_b_2");
    expect(await b.roQuery("MATCH (x:Approval {id:'approval:b-only-1'}) RETURN count(x) AS c")).toEqual([{ c: 1 }]);
    expect(trials.some(([s, uid]) => s === "tenant_b_2" && uid === u.id)).toBe(true);
  });

  it("every route under a business is behind the door for a stranger, the account routes included", async () => {
    const routes = app.routes.filter((r) => r.path.startsWith("/api/:t/") && r.method !== "ALL" && r.method !== "OPTIONS");
    expect(routes.some((r) => r.path === "/api/:t/invites")).toBe(true);
    expect(routes.some((r) => r.path === "/api/:t/members")).toBe(true);
    for (const r of routes) {
      const path = r.path.replace(":t", "tenant_b").replace(/:[A-Za-z]+/g, "x").replace(/\/\*$/, "/x");
      const res = await app.request(path, { method: r.method, ...(["POST", "PATCH", "PUT"].includes(r.method) ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      expect(res.status, `${r.method} ${path}`).toBe(401);
      expect((await read(res)).error).toBe("This business is private. Sign in to open it, or use your owner link.");
    }
  });

  it("without accounts wired in (or with ALLEVIA_AUTH off) the account routes do not exist", async () => {
    const dep = deps(metaGraph, graphs);
    const linksOnly = createApp({ ...dep, auth: { enabled: true, verify: dep.auth!.verify } });
    const off = createApp({ ...dep, auth: undefined });
    for (const x of [linksOnly, off]) {
      expect((await send(x, "/api/auth/signup", { name: "x", email: email("x"), password: PW })).status).toBe(404);
      expect((await send(x, "/api/auth/login", { email: "a@b.co", password: PW })).status).toBe(404);
      expect((await get(x, "/api/auth/me")).status).toBe(404);
    }
    expect((await get(off, "/api/tenant_a/members")).status).toBe(404);
    expect((await get(linksOnly, "/api/tenant_a/overview")).status).toBe(401);
    expect((await read(await get(linksOnly, "/api/tenant_a/overview"))).error).toBe("This business is private. Open it with your owner link.");
  });
});

describe("a member, and invites", () => {
  let owner: { cookie: string; id: string };
  let mate: { cookie: string; id: string; email: string };
  let code = "";

  beforeAll(async () => {
    const o = await member("tenant_b", "owner");
    owner = { cookie: await login(app, o.email), id: o.id };
  });

  it("the owner makes an invite link: once, for 7 days; anyone holding it sees which business it opens", async () => {
    const res = await send(app, "/api/tenant_b/invites", {}, as(owner.cookie));
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body).toEqual({ link: expect.stringMatching(/^\/invite\/[A-Za-z0-9_-]{43}$/), role: "member", expiresAt: clock + 7 * DAY });
    code = (body.link as string).slice("/invite/".length);
    expect(await read(await get(app, `/api/auth/invites/${code}`))).toEqual({ business: { id: "tenant_b", name: "Bravo Builders" }, role: "member", expiresAt: clock + 7 * DAY });
  });

  it("accepting needs a signed-in account; then they are a member, and the invite is used up", async () => {
    expect((await send(app, `/api/auth/invites/${code}/accept`, {})).status).toBe(401);
    mate = await signup(app, "mate");
    const res = await send(app, `/api/auth/invites/${code}/accept`, {}, as(mate.cookie));
    expect(await read(res)).toEqual({ tenant: "tenant_b", name: "Bravo Builders", role: "member", already: false });
    expect((await get(app, "/api/tenant_b/overview", { cookie: mate.cookie })).status).toBe(200);
    const late = await signup(app, "late");
    const again = await send(app, `/api/auth/invites/${code}/accept`, {}, as(late.cookie));
    expect([again.status, (await read(again)).error]).toEqual([404, INVITE_GONE]);
    expect((await get(app, `/api/auth/invites/${code}`)).status).toBe(404);
    const people = await read(await get(app, "/api/tenant_b/members", { cookie: mate.cookie }));
    expect(people).toMatchObject({ canInvite: false });
    expect((people.members as Array<{ id: string; you?: boolean }>).find((m) => m.id === mate.id)).toMatchObject({ role: "member", you: true });
  });

  it("a member asks and approves, but cannot use the owner's routes: the team, invites, connections", async () => {
    const approve = await send(app, "/api/tenant_b/approvals/approval%3Ab-only-1", { decision: "reject" }, as(mate.cookie));
    expect(approve.status).toBe(200);
    const ownerOnly: Array<[string, string, unknown]> = [
      ["POST", "/api/tenant_b/invites", {}],
      ["PATCH", "/api/tenant_b/agents/tech-lead", { enabled: false }],
      ["POST", "/api/tenant_b/directives/directive:x/apply", {}],
      ["POST", "/api/tenant_b/connections/gmail/connect", {}],
      ["POST", "/api/tenant_b/connections/gmail/disconnect", {}],
      ["POST", "/api/tenant_b/connectors/search-console/connect", {}],
      ["POST", "/api/tenant_b/actions/target", { repo: "someone/else" }],
    ];
    for (const [method, path, body] of ownerOnly) {
      const res = await send(app, path, body, { method, headers: { cookie: mate.cookie } });
      expect([res.status, (await read(res)).error], `${method} ${path}`).toEqual([403, OWNER_ONLY]);
    }
    // the owner gets past the role check on the same routes (an unknown preview is a 404, not a 403)
    expect((await send(app, "/api/tenant_b/directives/directive:x/apply", {}, as(owner.cookie))).status).toBe(404);
  });

  it("an invite expires after 7 days", async () => {
    const res = await send(app, "/api/tenant_b/invites", {}, as(owner.cookie));
    const c2 = ((await read(res)).link as string).slice("/invite/".length);
    const saved = clock;
    try {
      clock += 7 * DAY + 1;
      const u = await signup(app, "expired");
      const r = await send(app, `/api/auth/invites/${c2}/accept`, {}, as(u.cookie));
      expect([r.status, (await read(r)).error]).toEqual([404, INVITE_GONE]);
    } finally {
      clock = saved;
    }
  });

  it("the plan's seats limit invites, counting the people in and the open invites", async () => {
    const dep = deps(metaGraph, graphs);
    const small = createApp({ ...dep, auth: { ...dep.auth!, accounts: { ...dep.auth!.accounts!, seats: async () => 2 } } });
    const S = `seats_${sfx}`;
    await ensureTenant({ slug: S, name: "Seats Co" }, opts);
    made.push(S);
    const o = await member(S, "owner");
    const cookie = await login(small, o.email);
    expect((await send(small, `/api/${S}/invites`, {}, as(cookie))).status).toBe(201);
    const full = await send(small, `/api/${S}/invites`, {}, as(cookie));
    expect([full.status, (await read(full)).error]).toEqual([409, "Every seat on your plan is taken (2, counting invites not used yet)."]);
    expect(await read(await get(small, `/api/${S}/members`, { cookie }))).toMatchObject({ seats: 2, invited: 1 });
  });
});

describe("passwords", () => {
  it("changes with the current one only, and signs the account's other sessions out", async () => {
    const u = await signup(app, "pw");
    const other = await login(app, u.email);
    const wrong = await send(app, "/api/auth/password", { current: "not my password", next: "a brand new password" }, as(u.cookie));
    expect([wrong.status, (await read(wrong)).error]).toEqual([403, "That is not your current password."]);
    const short = await send(app, "/api/auth/password", { current: PW, next: "short" }, as(u.cookie));
    expect(short.status).toBe(400);
    expect((await send(app, "/api/auth/password", { current: PW, next: "a brand new password" }, as(u.cookie))).status).toBe(200);
    expect((await get(app, "/api/auth/me", { cookie: u.cookie })).status).toBe(200);
    expect((await get(app, "/api/auth/me", { cookie: other })).status).toBe(401);
    expect((await send(app, "/api/auth/login", { email: u.email, password: PW })).status).toBe(401);
    expect((await send(app, "/api/auth/login", { email: u.email, password: "a brand new password" })).status).toBe(200);
    expect((await send(app, "/api/auth/password", { current: PW, next: "whatever whatever" })).status).toBe(401);
  });

  it("a reset link from the operator sets a new password once and signs the account in", async () => {
    const u = await signup(app, "reset");
    const r = (await createResetCode(u.email, { metaGraph, now: clock }))!;
    const res = await send(app, "/api/auth/reset", { code: r.code, password: "my reset password" });
    expect(res.status).toBe(200);
    expect(sessionSetCookie(res)).toMatch(/^allevia_session=/);
    expect((await get(app, "/api/auth/me", { cookie: u.cookie })).status).toBe(401); // the old session is gone
    expect((await send(app, "/api/auth/login", { email: u.email, password: PW })).status).toBe(401);
    const again = await send(app, "/api/auth/reset", { code: r.code, password: "another reset password" });
    expect([again.status, (await read(again)).error]).toEqual([404, "That reset link is not valid any more. Ask for a new one."]);
  });
});

describe("the cookie is Secure on https", () => {
  const signupOn = (x: Hono, headers: Record<string, string> = {}) => send(x, "/api/auth/signup", { name: "S", email: email("secure"), password: PW }, { headers });

  it("when the public address is https (ALLEVIA_WEB_URL), though the proxy talks plain http to the app", async () => {
    const x = createApp(deps(metaGraph, graphs, { webBaseUrl: "https://13-232-139-42.sslip.io" }));
    expect(sessionSetCookie(await signupOn(x))).toMatch(/;\s*Secure/i);
  });

  it("from X-Forwarded-Proto only when the proxy is trusted (ALLEVIA_TRUST_PROXY=1)", async () => {
    const trusted = createApp(deps(metaGraph, graphs, { rateLimit: { ...NO_LIMITS, trustProxy: true } }));
    expect(sessionSetCookie(await signupOn(trusted, { "x-forwarded-proto": "https" }))).toMatch(/;\s*Secure/i);
    expect(sessionSetCookie(await signupOn(trusted))).not.toMatch(/Secure/i);
    expect(sessionSetCookie(await signupOn(app, { "x-forwarded-proto": "https" }))).not.toMatch(/Secure/i);
    // signing out clears it with the same flags
    const r = await signupOn(trusted, { "x-forwarded-proto": "https" });
    const out = await send(trusted, "/api/auth/logout", {}, { headers: { cookie: jarOf(r), "x-forwarded-proto": "https" } });
    expect(sessionSetCookie(out)).toMatch(/Max-Age=0.*Secure|Secure.*Max-Age=0/i);
  });
});

describe("rate limits (scanners already knock)", () => {
  const limited = () => createApp(deps(metaGraph, graphs, { rateLimit: { trustProxy: true } }));
  const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

  it("ten sign-in tries a minute from one place; the eleventh is a 429 with Retry-After, and costs no password check", async () => {
    const x = limited();
    const u = (await createUser({ email: email("limited"), name: "L", password: PW }, opts))!;
    for (let i = 0; i < 10; i++) expect((await send(x, "/api/auth/login", { email: email("nobody"), password: PW }, from("203.0.113.10"))).status).toBe(401);
    const refused = await send(x, "/api/auth/login", { email: u.email, password: PW }, from("203.0.113.10"));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await read(refused)).error).toBe("Too many tries. Wait a few minutes, then try again.");
    expect(refused.headers.getSetCookie()).toEqual([]);
    expect((await send(x, "/api/auth/login", { email: u.email, password: PW }, from("203.0.113.11"))).status).toBe(200); // another place is not held up
  });

  it("ten password tries against one email from anywhere; the eleventh is a 429 even from a new address", async () => {
    const x = limited();
    const u = (await createUser({ email: email("target"), name: "T", password: PW }, opts))!;
    for (let i = 0; i < 10; i++) expect((await send(x, "/api/auth/login", { email: u.email, password: `wrong ${i} password` }, from(`198.51.100.${i + 1}`))).status).toBe(401);
    const refused = await send(x, "/api/auth/login", { email: u.email.toUpperCase(), password: PW }, from("198.51.100.99"));
    expect(refused.status).toBe(429);
  });

  it("ten new accounts an hour from one place", async () => {
    const x = limited();
    for (let i = 0; i < 10; i++) expect((await send(x, "/api/auth/signup", { name: "N", email: email("bulk"), password: PW }, from("192.0.2.50"))).status).toBe(201);
    const refused = await send(x, "/api/auth/signup", { name: "N", email: email("bulk"), password: PW }, from("192.0.2.50"));
    expect([refused.status, (await read(refused)).error]).toEqual([429, "That is a lot of new accounts in a short time. Try again later."]);
    expect((await send(x, "/api/auth/signup", { name: "N", email: email("bulk"), password: PW }, from("192.0.2.51"))).status).toBe(201);
  }, 60_000);
});
