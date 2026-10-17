// ALLEVIA_AUTH=1: every /api/:t/... route needs that business's owner token; only a demo business opens without one, and
// then read-only. Real graphs for the data, a throwaway registry graph for the tokens.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AgentEvent } from "../../shared/contracts.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { issueToken, revokeToken, verifyToken } from "../../src/auth/tokens.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { listTenants } from "../../src/graph/tenants.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { createApp, type OnboardStart, type ServerDeps } from "../../src/server/app.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";
import { SCRIPTS, post, sseEvents } from "../server/harness.js";

const NOW = SEED_NOW + 3_600_000;
const NO_LIMITS = { authOpen: false, authOpenAll: false, onboard: false, onboardRuns: false } as const;
const metaGraph = testGraphName();
const opts = { metaGraph };
let a: GraphHandle;
let b: GraphHandle;
let d: GraphHandle;
let tokenA: string;
let tokenB: string;
let tokenOp: string;
let app: Hono;
let make: (over?: Partial<ServerDeps>) => Hono;
const onboarded: OnboardStart[] = [];

const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
const cookie = (name: string, token: string): RequestInit => ({ headers: { cookie: `${name}=${token}` } });
const read = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>;

beforeAll(async () => {
  ({ g: a } = await seededGraph());
  ({ g: b } = await seededGraph());
  ({ g: d } = await seededGraph());
  for (const g of [a, b, d]) await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);
  await upsertNode(b, { type: "Approval", id: "approval:b-only-1", name: "github_issue: Bravo roof", props: { status: "pending", kind: "github_issue", title: "Bravo roof", payload: JSON.stringify({ title: "Bravo roof", body: "x" }) } }, SEED_NOW);
  // the registry: three businesses, one of them a demo
  const meta = await openGraphByName(metaGraph);
  const base = { graph: "x", businessId: "business:aamdani", ontologyVersion: 2, createdAt: 1, updatedAt: 1 };
  await meta.query("CREATE (:Tenant {slug:'tenant_a', name:'Alpha Foods', domain:'alpha.example'}), (:Tenant {slug:'tenant_b', name:'Bravo Builders', domain:'bravo.example'}), (:Tenant {slug:'demo_co', name:'Demo Company', demo:true})", {});
  await meta.query("MATCH (t:Tenant) SET t += $base", { base });
  tokenA = (await issueToken("tenant_a", { label: "a" }, opts)).token;
  tokenB = (await issueToken("tenant_b", { label: "b" }, opts)).token;
  tokenOp = (await issueToken("operator", { label: "ops" }, opts)).token;
  const graphs: Record<string, GraphHandle> = { tenant_a: a, tenant_b: b, demo_co: d };
  make = (over = {}) => createApp({
    publicMode: false,
    listTenants: () => listTenants(opts),
    openGraph: async (slug) => { const g = graphs[slug]; if (!g) throw new Error(`no graph for ${slug}`); return g; },
    askDeps: async (tenant) => createAskDeps({ tenant }, { graph: graphs[tenant]!, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) }),
    embedQuery: async () => async (t: string) => fakeEmbed(t),
    loadOnboard: async () => async (input) => { onboarded.push(input); },
    auth: { enabled: true, verify: (t) => verifyToken(t, opts) },
    actions: { config: { dataDir: "/nonexistent-allevia-auth-test" } },
    directiveLlm: null, heartbeatMs: 0, replaySpeed: 0, now: () => NOW, tenantCacheMs: 0, log: () => {},
    rateLimit: NO_LIMITS, // the clock here never moves, and these tests open and set up businesses over and over: the limits have their own file (rate-limit.test.ts)
    ...over,
  });
  app = make();
}, 90_000);

afterAll(async () => {
  await a?.drop();
  await b?.drop();
  await d?.drop();
  await (await openGraphByName(metaGraph)).drop();
  await closeAll();
});

const PATHS = ["overview", "brief", "sessions", "turns/live", "search?q=x", "graph/overview", "agents", "recommendations", "approvals", "learning", "program", "capabilities", "usage", "goals/setup", "studio/latest", "studio/sample"];

describe("without a token", () => {
  it("every business route of a private business is a 401, whether or not the business exists, and says nothing about it", async () => {
    const bodies = new Set<string>();
    for (const slug of ["tenant_a", "tenant_b", "tenant_does_not_exist"]) {
      for (const path of PATHS) {
        const res = await app.request(`/api/${slug}/${path}`);
        expect(res.status, `${slug}/${path}`).toBe(401);
        const text = await res.text();
        expect(text).not.toMatch(/Alpha|Bravo|alpha\.example|bravo\.example/);
        bodies.add(text);
      }
    }
    expect(bodies.size).toBe(1); // the same answer for a business that exists and one that does not: no way to tell them apart
    expect([...bodies][0]).toMatch(/owner link/i);
  });

  it("every route registered under a tenant is behind it: nothing was left out", async () => {
    const tenantRoutes = app.routes.filter((r) => r.path.startsWith("/api/:t/") && r.method !== "ALL" && r.method !== "OPTIONS");
    expect(tenantRoutes.length).toBeGreaterThan(30);
    for (const r of tenantRoutes) {
      const path = r.path.replace(":t", "tenant_b").replace(/:[A-Za-z]+/g, "x").replace(/\/\*$/, "/x");
      const res = await app.request(path, { method: r.method, ...(r.method === "POST" || r.method === "PATCH" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}) });
      expect(res.status, `${r.method} ${path}`).toBe(401);
    }
  });

  it("uploads and event streams are refused before any body is read", async () => {
    const form = new FormData();
    form.set("photo", new File([new Uint8Array(10)], "x.jpg", { type: "image/jpeg" }));
    expect((await app.request("/api/tenant_b/studio/intake", { method: "POST", body: form })).status).toBe(401);
    expect((await post(app, "/api/tenant_b/ask", { question: "hi" })).status).toBe(401);
    expect((await app.request("/api/tenant_b/assets/asset%3Ax")).status).toBe(401);
  });

  it("a token in the query string, a form field or a made-up header is not a token", async () => {
    const token = tokenB;
    for (const [path, init] of [
      [`/api/tenant_b/overview?key=${token}`, {}], [`/api/tenant_b/overview?token=${token}`, {}], [`/api/tenant_b/overview?access_token=${token}`, {}],
      ["/api/tenant_b/overview", { headers: { "x-api-key": token, "x-token": token, "x-allevia-token": token } }],
      ["/api/tenant_b/overview", { headers: { authorization: token } }],
      ["/api/tenant_b/overview", { headers: { authorization: `Basic ${Buffer.from(`x:${token}`).toString("base64")}` } }],
      ["/api/tenant_b/overview", { headers: { cookie: `session=${token}; allevia_k_tenant_c=${token}` } }],
    ] as const) {
      expect((await app.request(path, init as RequestInit)).status, `${path} ${JSON.stringify(init)}`).toBe(401);
    }
  });

  it("the public pieces stay public: health (without the business count), pricing, the web app shell", async () => {
    const health = await read(await app.request("/api/health"));
    expect(health).toMatchObject({ ok: true, authRequired: true });
    expect(health).not.toHaveProperty("tenants");
    expect((await app.request("/api/plans")).status).not.toBe(401);
  });
});

describe("the demo business", () => {
  it("opens read-only without a token", async () => {
    for (const path of ["overview", "sessions", "approvals", "agents", "learning"]) {
      const res = await app.request(`/api/demo_co/${path}`);
      expect(res.status, path).toBe(200);
    }
  });

  it("refuses every change without a token, the way the public demo does", async () => {
    expect((await post(app, "/api/demo_co/approvals/approval%3At-001-1", { decision: "approve" })).status).toBe(403);
    expect((await app.request("/api/demo_co/agents/librarian", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) })).status).toBe(403);
    expect((await post(app, "/api/demo_co/directives", { text: "no emojis" })).status).toBe(403);
    expect((await post(app, "/api/demo_co/insights/run", {})).status).toBe(403);
    const ask = await post(app, "/api/demo_co/ask", { question: "How are signups doing?" });
    expect(sseEvents(await ask.text())).toEqual([{ type: "error", message: expect.stringMatching(/live chat needs/i) }]); // replays only
    expect(await d.roQuery("MATCH (t:Turn) WHERE t.question = 'How are signups doing?' RETURN count(t) AS c")).toEqual([{ c: 0 }]);
  });

  it("does not open its neighbours: a demo flag on one business is not on the others", async () => {
    expect((await app.request("/api/tenant_a/overview")).status).toBe(401);
  });

  it("does not make a token-holder's own business read-only", async () => {
    const res = await post(app, "/api/tenant_b/approvals/approval%3Ab-only-1", { decision: "reject" }, bearer(tokenB));
    expect(res.status).toBe(200);
  });
});

describe("with a token", () => {
  it("opens its own business, by header or by cookie, and not another", async () => {
    expect((await app.request("/api/tenant_a/overview", bearer(tokenA))).status).toBe(200);
    expect((await app.request("/api/tenant_a/overview", cookie("allevia_k_tenant_a", tokenA))).status).toBe(200);
    expect((await app.request("/api/tenant_b/overview", bearer(tokenA))).status).toBe(401);
    expect((await app.request("/api/tenant_b/overview", cookie("allevia_k_tenant_a", tokenA))).status).toBe(401);
    // A's token planted under B's cookie name: the token itself says it is A's
    expect((await app.request("/api/tenant_b/overview", cookie("allevia_k_tenant_b", tokenA))).status).toBe(401);
    expect((await app.request("/api/tenant_b/overview", { headers: { cookie: `allevia_k_tenant_b=${tokenB}` } })).status).toBe(200);
  });

  it("a token for A cannot change B, and B's data stays put", async () => {
    const before = await b.roQuery("MATCH (a:Approval {id:'approval:b-only-1'}) RETURN a.status AS s");
    const res = await post(app, "/api/tenant_b/approvals/approval%3Ab-only-1", { decision: "approve" }, bearer(tokenA));
    expect(res.status).toBe(401);
    expect(await b.roQuery("MATCH (a:Approval {id:'approval:b-only-1'}) RETURN a.status AS s")).toEqual(before);
  });

  it("works even on a deployment that is in public mode, because the person holding it is the owner", async () => {
    const pub = make({ publicMode: true });
    expect((await post(pub, "/api/demo_co/approvals/approval%3At-001-1", { decision: "approve" })).status).toBe(403);
    expect((await post(pub, "/api/tenant_a/directives", { text: "No emojis on LinkedIn" }, bearer(tokenA))).status).toBe(200);
  });

  it("a live question runs for the owner and the stream is that business's own", async () => {
    const res = await post(app, "/api/tenant_a/ask", { question: "Who owns the Instagram token fix?" }, bearer(tokenA));
    expect(res.status).toBe(200);
    const events = sseEvents(await res.text()) as AgentEvent[];
    expect(events.find((e) => e.type === "session")).toMatchObject({ tenant: "tenant_a" });
    expect(events.at(-1)?.type).toBe("final");
  });

  it("is refused at once after it is revoked, and never reads the registry's cache", async () => {
    const t = await issueToken("tenant_a", { label: "short lived" }, opts);
    expect((await app.request("/api/tenant_a/overview", bearer(t.token))).status).toBe(200);
    await revokeToken({ tokenId: t.tokenId }, opts);
    expect((await app.request("/api/tenant_a/overview", bearer(t.token))).status).toBe(401);
    expect((await app.request("/api/tenant_a/overview", cookie("allevia_k_tenant_a", t.token))).status).toBe(401);
  });

  it("an operator token opens every business", async () => {
    for (const slug of ["tenant_a", "tenant_b", "demo_co"]) expect((await app.request(`/api/${slug}/overview`, bearer(tokenOp))).status, slug).toBe(200);
  });

  it("a malformed Authorization header is just no token", async () => {
    for (const h of ["", "Bearer", "Bearer ", "bearer", `Bearer  ${tokenA}`, `Token ${tokenA}`, `Bearer ${tokenA} extra`, "Bearer " + "x".repeat(10_000)]) {
      expect((await app.request("/api/tenant_a/overview", { headers: { authorization: h } })).status, h.slice(0, 30)).toBe(401);
    }
  });
});

describe("the business list", () => {
  const list = async (init?: RequestInit) => (await (await app.request("/api/tenants", init)).json() as Array<{ id: string }>).map((t) => t.id).sort();

  it("shows a stranger only the demo, an owner their own business and the demo, the operator everything", async () => {
    expect(await list()).toEqual(["demo_co"]);
    expect(await list(bearer(tokenA))).toEqual(["demo_co", "tenant_a"]);
    expect(await list(cookie("allevia_k_tenant_b", tokenB))).toEqual(["demo_co", "tenant_b"]);
    expect(await list({ headers: { cookie: `allevia_k_tenant_a=${tokenA}; allevia_k_tenant_b=${tokenB}` } })).toEqual(["demo_co", "tenant_a", "tenant_b"]);
    expect(await list(bearer(tokenOp))).toEqual(["demo_co", "tenant_a", "tenant_b"]);
    // a token says whose it is, wherever it is put: A's token under B's cookie name shows A's business, not B's
    expect(await list(cookie("allevia_k_tenant_b", tokenA))).toEqual(["demo_co", "tenant_a"]);
  });

  it("never shows another business's name or web address to a stranger", async () => {
    const text = await (await app.request("/api/tenants")).text();
    expect(text).not.toMatch(/Alpha|Bravo|alpha\.example|bravo\.example/);
  });
});

describe("opening a business with its link", () => {
  const open = (token: unknown, init: RequestInit = {}) => app.request("/api/auth/open", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }), ...init,
  });

  it("sets an HttpOnly, SameSite=Strict cookie for that business only, and never repeats the token", async () => {
    const res = await open(tokenA);
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({ scope: "tenant_a", tenant: "tenant_a" });
    const set = res.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^allevia_k_tenant_a=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/api/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify([...res.headers])).not.toContain(tokenA.slice(tokenA.indexOf(".") + 1) + "x");
    const jar = set.split(";")[0]!;
    expect((await app.request("/api/tenant_a/overview", { headers: { cookie: jar } })).status).toBe(200);
    expect((await app.request("/api/tenant_b/overview", { headers: { cookie: jar } })).status).toBe(401);
  });

  it("is Secure when the site is served over https", async () => {
    const res = await open(tokenA, { headers: { "content-type": "application/json", "x-forwarded-proto": "https" } });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("refuses a wrong, revoked, malformed or missing token with the same plain sentence", async () => {
    const revoked = await issueToken("tenant_a", {}, opts);
    await revokeToken({ tokenId: revoked.tokenId }, opts);
    const answers = new Set<string>();
    for (const t of ["", "x", `${tokenA}x`, revoked.token, undefined, null, 42, { a: 1 }, `tenant_b.${tokenA.slice(tokenA.indexOf(".") + 1)}`]) {
      const res = await open(t);
      expect(res.status, JSON.stringify(t)).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      answers.add(await res.text());
    }
    expect(answers.size).toBe(1);
  });

  it("an operator link opens the operator scope", async () => {
    const res = await open(tokenOp);
    expect(await read(res)).toEqual({ scope: "operator" });
    expect(res.headers.get("set-cookie")).toMatch(/^allevia_k_operator=/);
  });

  it("closing a business clears its cookie", async () => {
    const res = await app.request("/api/auth/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: "tenant_a" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/allevia_k_tenant_a=;.*(Max-Age=0|Expires=)/i);
    expect((await app.request("/api/auth/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenant: "../x" }) })).status).toBe(400);
  });

  it("is not a cross-site door: another site's page cannot read the answer or send the cookie", async () => {
    const res = await app.request("/api/tenant_a/overview", { headers: { origin: "https://evil.example", cookie: "allevia_k_tenant_a=" + tokenA } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const pre = await app.request("/api/tenant_a/overview", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("a page on another site cannot make the browser change or open anything", () => {
  const send = (path: string, headers: Record<string, string>, body: unknown = { decision: "reject" }) =>
    app.request(path, { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: JSON.stringify(body) });
  const jar = (): Record<string, string> => ({ cookie: `allevia_k_tenant_b=${tokenB}` });

  it("a cookie-carrying write with a foreign Origin or a cross-site fetch is refused, and changes nothing", async () => {
    await b.query("MATCH (a:Approval {id:'approval:b-only-1'}) SET a.status = 'pending'");
    const attempts: Array<Record<string, string>> = [
      { origin: "https://evil.example" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" }, { origin: "http://tenant-b.example.com.evil.example" },
    ];
    for (const headers of attempts) {
      const res = await send("/api/tenant_b/approvals/approval%3Ab-only-1", { ...jar(), ...headers });
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(await b.roQuery("MATCH (a:Approval {id:'approval:b-only-1'}) RETURN a.status AS s")).toEqual([{ s: "pending" }]);
  });

  it("the same write from the app's own origin (or the dev server's) goes through, and so does a script with no Origin at all", async () => {
    expect((await send("/api/tenant_b/directives", { ...jar(), origin: "http://localhost", host: "localhost", "sec-fetch-site": "same-origin" }, { text: "no emojis" })).status).toBe(200);
    expect((await send("/api/tenant_b/directives", { ...jar(), origin: "http://localhost:5173" }, { text: "no emojis" })).status).toBe(200);
    expect((await send("/api/tenant_b/directives", { authorization: `Bearer ${tokenB}` }, { text: "no emojis" })).status).toBe(200);
  });

  it("opening or closing a business, and onboarding, are not doors for a form on another site either", async () => {
    for (const path of ["/api/auth/open", "/api/auth/close", "/api/onboard"]) {
      const res = await send(path, { origin: "https://evil.example" }, { token: tokenB, tenant: "tenant_b", name: "x", url: "x.example" });
      expect(res.status, path).toBe(403);
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
  });

  it("reads are not affected (they carry no change, and SameSite=Strict keeps the cookie from other sites)", async () => {
    const res = await app.request("/api/tenant_b/overview", { headers: { ...jar(), origin: "https://evil.example" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull(); // so that page cannot read it
  });
});

describe("the Discord hub's join links are an owner's, never a demo visitor's", () => {
  // A join link puts a person in a business's Discord area with its role: they can ask its team and decide its cards.
  const calls: string[] = [];
  const hub = {
    home: async (slug: string) => { calls.push(`home:${slug}`); return { enabled: true, inviteUrl: `https://discord.gg/join-${slug}` }; },
    newLink: async (slug: string) => { calls.push(`link:${slug}`); return { enabled: true, inviteUrl: `https://discord.gg/new-${slug}` }; },
  } as unknown as import("../../src/discord/hub-service.js").HubService;
  const withHub = () => make({ discordHub: async () => hub });

  it("a visitor to a demo business (no token) is not shown a link, on a private or a public deployment", async () => {
    for (const publicMode of [false, true]) {
      calls.length = 0;
      const h = make({ discordHub: async () => hub, publicMode });
      const res = await h.request("/api/demo_co/discord");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false });
      expect((await post(h, "/api/demo_co/discord/invite", {})).status).toBe(403);
      expect(calls, `publicMode ${publicMode}`).toEqual([]);
    }
  });

  it("an owner is shown their own business's link, and not by asking for another's", async () => {
    calls.length = 0;
    const h = withHub();
    const own = await h.request("/api/tenant_a/discord", bearer(tokenA));
    expect(JSON.stringify(await own.json())).toContain("join-tenant_a");
    expect((await post(h, "/api/tenant_a/discord/invite", {}, bearer(tokenA))).status).toBe(200);
    expect((await h.request("/api/tenant_b/discord", bearer(tokenA))).status).toBe(401);
    expect((await post(h, "/api/tenant_b/discord/invite", {}, bearer(tokenA))).status).toBe(401);
    expect((await h.request("/api/tenant_b/discord")).status).toBe(401);
    expect(calls).toEqual(["home:tenant_a", "link:tenant_a"]);
  });
});

describe("onboarding with the flag on", () => {
  const start = (body: Record<string, unknown>, init?: RequestInit) => post(app, "/api/onboard", body, init);

  it("needs the operator: a stranger and an owner are refused, and the onboarder does not run", async () => {
    const before = onboarded.length;
    expect((await start({ name: "Kestrel", url: "kestrel.example" })).status).toBe(401);
    expect((await start({ name: "Kestrel", url: "kestrel.example" }, bearer(tokenA))).status).toBe(403);
    expect(onboarded.length).toBe(before);
  });

  it("runs for the operator, on a new business", async () => {
    const res = await start({ name: "Kestrel", url: "kestrel.example" }, bearer(tokenOp));
    expect(res.status).toBe(200);
    await res.text();
    expect(onboarded.at(-1)).toMatchObject({ slug: "kestrel" });
  });

  it("an operator can re-run an existing business, and an explicit slug that is reserved is still refused", async () => {
    const again = await start({ name: "Alpha Foods", url: "alpha.example", slug: "tenant_a" }, bearer(tokenOp));
    expect(again.status).toBe(200);
    await again.text();
    expect(onboarded.at(-1)).toMatchObject({ slug: "tenant_a" });
    expect((await start({ name: "X", url: "x.example", slug: "meta" }, bearer(tokenOp))).status).toBe(400);
  });
});

describe("with the flag off nothing changes (local development)", () => {
  it("a business opens without a token, as before", async () => {
    const off = make({ auth: undefined });
    expect((await off.request("/api/tenant_b/overview")).status).toBe(200);
    const offToo = make({ auth: { enabled: false, verify: async () => null } });
    expect((await offToo.request("/api/tenant_b/overview")).status).toBe(200);
    expect(await (await off.request("/api/health")).json()).toMatchObject({ tenants: 3 });
    expect((await off.request("/api/auth/open", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(404);
  });
});
