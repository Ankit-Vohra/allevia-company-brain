// The hosted demo, end to end over real HTTP: the real server (startServer, production wiring for owner links and rate limits) with
// ALLEVIA_AUTH=1, one business marked as the public demo and one private business with its owner link. What a stranger sees and
// cannot change, what a link opens, how a link is revoked, and that the doors are rate limited. Real graphs for the data, a
// throwaway registry graph for the businesses and links; a free port (never 8787 or the preview ports).
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { issueToken, revokeToken } from "../../src/auth/tokens.js";
import { closeAll, openGraph, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { ensureTenant, listTenants, setDemo } from "../../src/graph/tenants.js";
import { startServer } from "../../src/server/main.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";
import { SCRIPTS } from "../server/harness.js";

const metaGraph = testGraphName();
const opts = { metaGraph };
const saved = process.env.ALLEVIA_META_GRAPH;
let demo: GraphHandle;
let priv: GraphHandle;
let url = "";
let stop: () => Promise<void>;
let ownerLink = "";
let warnings: string[] = [];
const made: string[] = []; // businesses a test signed up and set up: their graphs are dropped at the end

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${url}${path}`, { headers });
const send = (path: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (res: Response) => JSON.parse(await res.text()) as Record<string, unknown>;
const cookieOf = (res: Response): string => (res.headers.getSetCookie()[0] ?? "").split(";")[0]!;

beforeAll(async () => {
  process.env.ALLEVIA_META_GRAPH = metaGraph;
  ({ g: demo } = await seededGraph());
  ({ g: priv } = await seededGraph());
  for (const g of [demo, priv]) await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);
  const meta = await openGraphByName(metaGraph);
  const base = { graph: "x", businessId: "business:aamdani", ontologyVersion: 2, createdAt: 1, updatedAt: 1 };
  await meta.query("CREATE (:Tenant {slug:'demo_co', name:'Demo Cafe', domain:'demo.example'}), (:Tenant {slug:'private_co', name:'Private Builders', domain:'private.example'})", {});
  await meta.query("MATCH (t:Tenant) SET t += $base", { base });
  expect(await setDemo("demo_co", true, opts)).toBe(true);
  ownerLink = (await issueToken("private_co", { label: "owner" }, opts)).token;
  const graphs: Record<string, GraphHandle> = { demo_co: demo, private_co: priv };
  vi.spyOn(console, "error").mockImplementation((...a) => { warnings.push(a.join(" ")); });
  const port = await freePort();
  const s = await startServer({
    port, host: "127.0.0.1", publicMode: false, authRequired: true, staticDir: null,
    over: {
      // naming listTenants keeps the background schedules (stand-ups, check-ups, posting) off, as in every test
      listTenants: () => listTenants(opts),
      openGraph: async (slug) => graphs[slug] ?? (made.includes(slug) ? openGraph(slug) : Promise.reject(new Error(`no graph for ${slug}`))),
      // stands in for onboarding (which reads a real website with a model): registers the business, as the real one does first
      loadOnboard: async () => async (input, emit) => {
        await ensureTenant({ slug: input.slug, name: input.name }, opts);
        made.push(input.slug);
        emit({ type: "done", tenant: input.slug, counts: { Page: 1 } });
      },
      askDeps: async (tenant) => createAskDeps({ tenant }, { graph: graphs[tenant]!, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) }),
      tenantCacheMs: 0, heartbeatMs: 0, log: () => {},
    },
  });
  url = s.url;
  stop = s.close;
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await stop?.();
  await demo?.drop();
  await priv?.drop();
  for (const s of made) await (await openGraph(s)).drop().catch(() => {});
  await (await openGraphByName(metaGraph)).drop();
  if (saved === undefined) delete process.env.ALLEVIA_META_GRAPH; else process.env.ALLEVIA_META_GRAPH = saved;
  await closeAll();
});

describe("a stranger at the hosted demo", () => {
  it("starts with no warning about being open, and says only that links are needed (not how many businesses there are)", async () => {
    expect(warnings.filter((w) => /WARNING/.test(w))).toEqual([]);
    expect(warnings.some((w) => /owner links required/.test(w))).toBe(true);
    const res = await get("/api/health");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, publicMode: false, authRequired: true });
  });

  it("sees only the demo business, marked read-only, and can read its pages", async () => {
    const list = await (await get("/api/tenants")).json() as Array<Record<string, unknown>>;
    expect(list.map((t) => [t.id, t.readOnly])).toEqual([["demo_co", true]]);
    expect(JSON.stringify(list)).not.toMatch(/Private Builders|private\.example/);
    const overview = await get("/api/demo_co/overview");
    expect(overview.status).toBe(200);
    expect(((await json(overview)).tenant as Record<string, unknown>).readOnly).toBe(true);
    for (const path of ["sessions", "agents", "graph/overview", "approvals", "recommendations", "learning", "usage"]) {
      expect((await get(`/api/demo_co/${path}`)).status, path).toBe(200);
    }
  });

  it("cannot change anything: every change is a 403 that says it is the public demo", async () => {
    const attempts: Array<[string, string, unknown]> = [
      ["POST", "/api/demo_co/approvals/approval:t-001-1", { decision: "approve" }],
      ["POST", "/api/demo_co/discord/invite", {}],
      ["PUT", "/api/demo_co/studio/settings", { blurFaces: true }],
      ["POST", "/api/demo_co/studio/approve", { approvalId: "approval:t-001-1" }],
      ["POST", "/api/demo_co/directives", { text: "switch Arjun off" }],
      ["PATCH", "/api/demo_co/agents/tech-lead", { enabled: false }],
      ["POST", "/api/demo_co/insights/run", {}],
      ["POST", "/api/demo_co/checkup", {}],
    ];
    for (const [method, path, body] of attempts) {
      const res = await send(path, body, {}, method);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await json(res)).error, path).toMatch(/public read-only demo/);
    }
    // asking a question replays a recorded thread or says live chat is off: the model is never started for a stranger
    const asked = await send("/api/demo_co/ask", { question: "A question nobody recorded an answer to" });
    expect(await asked.text()).toMatch(/Live chat needs the owner's model access/);
    // and setting a business up is the operator's alone
    expect((await send("/api/onboard", { name: "Mine", url: "mine.example" })).status).toBe(401);
  });

  it("cannot open the private business, and cannot tell whether it exists", async () => {
    const a = await get("/api/private_co/overview");
    const b = await get("/api/no_such_co/overview");
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(await a.text()).toBe(await b.text());
  });

  it("is told off by another site's form: a cross-site post is refused before anything else", async () => {
    const res = await send("/api/auth/open", { token: ownerLink }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("an owner with a link", () => {
  let cookie = "";

  it("opens the private business once with the link: a cookie that scripts cannot read, for that business only", async () => {
    const res = await send("/api/auth/open", { token: ownerLink });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ scope: "private_co", tenant: "private_co" });
    const set = res.headers.getSetCookie()[0] ?? "";
    expect(set).toMatch(/^allevia_k_private_co=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).not.toMatch(/Secure/i); // plain http on 127.0.0.1; behind https the server adds it
    cookie = cookieOf(res);
    expect((await get("/api/private_co/overview", { cookie })).status).toBe(200);
  });

  it("sees their business (changes allowed) and the demo (still read-only)", async () => {
    const list = await (await get("/api/tenants", { cookie })).json() as Array<Record<string, unknown>>;
    expect(Object.fromEntries(list.map((t) => [t.id, t.readOnly ?? false]))).toEqual({ demo_co: true, private_co: false });
    // a change in their own business gets past the public-demo refusal (an unknown card is a 404, not a 403)
    const own = await send("/api/private_co/approvals/approval:nope", { decision: "approve" }, { cookie });
    expect(own.status).toBe(404);
    // the same change in the demo is still refused, link or no link for the other business
    expect((await send("/api/demo_co/approvals/approval:nope", { decision: "approve" }, { cookie })).status).toBe(403);
  });

  it("the cookie opens that business and no other", async () => {
    expect((await get("/api/demo_co/overview", { cookie })).status).toBe(200); // the demo is open to everybody
    const other = await get("/api/no_such_co/overview", { cookie });
    expect(other.status).toBe(401);
  });

  it("a revoked link stops working on the very next request, and cannot open again", async () => {
    const second = (await issueToken("private_co", { label: "second laptop" }, opts)).token;
    const opened = await send("/api/auth/open", { token: second });
    const c2 = cookieOf(opened);
    expect((await get("/api/private_co/overview", { cookie: c2 })).status).toBe(200);
    expect(await revokeToken({ scope: "private_co" }, opts)).toBeGreaterThanOrEqual(2);
    expect((await get("/api/private_co/overview", { cookie: c2 })).status).toBe(401);
    expect((await get("/api/private_co/overview", { cookie })).status).toBe(401);
    expect((await send("/api/auth/open", { token: second })).status).toBe(401);
  });
});

describe("a judge with an account, on the real server", () => {
  it("signs up, sets up their own business on the trial, still sees the demo read-only, and signs out", async () => {
    const email = `judge.${Math.random().toString(36).slice(2, 8)}@example.com`;
    const up = await send("/api/auth/signup", { name: "Jo Judge", email, password: "a long enough password" });
    expect(up.status).toBe(201);
    const set = up.headers.getSetCookie().find((c) => c.startsWith("allevia_session=")) ?? "";
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const cookie = set.split(";")[0]!;
    const res = await send("/api/onboard", { name: "Judge Bakery", url: "judge-bakery.example" }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/"type":"done","tenant":"judge_bakery"/);
    const list = await (await get("/api/tenants", { cookie })).json() as Array<Record<string, unknown>>;
    expect(list.map((t) => [t.id, t.role ?? null, t.readOnly ?? false])).toEqual([["judge_bakery", "owner", false], ["demo_co", null, true]]);
    expect((await get("/api/judge_bakery/overview", { cookie })).status).toBe(200);
    expect((await get("/api/judge_bakery/overview")).status).toBe(401);
    expect((await send("/api/demo_co/approvals/approval:t-001-1", { decision: "approve" }, { cookie })).status).toBe(403);
    // the production trial adapter recorded the trial's end on the business
    const meta = await openGraphByName(metaGraph);
    const [row] = await meta.roQuery<{ e: number | null }>("MATCH (t:Tenant {slug:'judge_bakery'}) RETURN t.trialEndsAt AS e");
    expect(row!.e).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect((await send("/api/auth/logout", {}, { cookie })).status).toBe(200);
    expect((await get("/api/judge_bakery/overview", { cookie })).status).toBe(401);
  });
});

describe("the doors are rate limited on the real server", () => {
  it("the eleventh try in a minute from one place is a 429 with Retry-After, and the demo is still readable", async () => {
    let refused: Response | undefined;
    for (let i = 0; i < 14 && !refused; i++) {
      const res = await send("/api/auth/open", { token: `private_co.${"x".repeat(43)}` });
      if (res.status === 429) refused = res;
      else expect(res.status).toBe(401);
    }
    expect(refused).toBeDefined();
    expect(Number(refused!.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await json(refused!)).error).toMatch(/Too many tries/);
    expect((await get("/api/demo_co/overview")).status).toBe(200); // reading the demo is not a try
  });
});
