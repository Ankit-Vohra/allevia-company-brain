// The operator account (User.operator, set only by `auth:operator` on the server): the person who runs Allevia signs in and
// opens every business as its owner. Over HTTP through the real app (createApp) with ALLEVIA_AUTH=1 and real registry graphs on
// the test database (127.0.0.1:6391): the operator opens and lists every business, sees a showcase unmasked, and loses all of
// it on the very next request after `--off`; a normal account keeps today's rules exactly (its own businesses plus the public
// demos, a 401 everywhere else); no HTTP route can make anyone the operator; a stranger on a showcase is still masked.
// A throwaway registry graph, never the real allevia_meta, and never FalkorDB Cloud.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { addMember, createUser, setOperator, type MemberRole } from "../../src/auth/accounts.js";
import { verifyToken } from "../../src/auth/tokens.js";
import { closeAll, openGraphByName, type GraphHandle } from "../../src/graph/client.js";
import { listTenants, setDemo, setShowcase } from "../../src/graph/tenants.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { createApp, type ServerDeps } from "../../src/server/app.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { testGraphName } from "../helpers/graph.js";
import { seededGraph } from "../helpers/tools.js";
import { SCRIPTS } from "../server/harness.js";

const NO_LIMITS = { authOpen: false, authOpenAll: false, onboard: false, onboardRuns: false, login: false, loginEmail: false, loginAll: false, signup: false, signupAll: false } as const;
const PW = "a long enough password";
const sfx = Math.random().toString(36).slice(2, 8);
let n = 0;
const email = (who: string) => `${who}.${sfx}.${n++}@example.com`;

const metaGraph = testGraphName();
const opts = { metaGraph };
// the registry lists businesses by slug, so the order below is fixed: the caller's own first, then the rest by slug
// op_co: the operator's own business; avs_co: Devika's; other_co: nobody's here; show_co: a showcase; demo_co: a plain demo
const SLUGS = ["op_co", "avs_co", "other_co", "show_co", "demo_co"] as const;
let shared: GraphHandle;
let show: GraphHandle;
let app: Hono;
let operator = { email: "", cookie: "" };
let devika = { email: "", cookie: "" };

type Init = { headers?: Record<string, string>; method?: string };
const send = (path: string, body: unknown, init: Init = {}) =>
  app.request(path, { method: init.method ?? "POST", headers: { "content-type": "application/json", ...init.headers }, body: JSON.stringify(body) });
const get = (path: string, cookie?: string) => app.request(path, { headers: cookie ? { cookie } : {} });
const jarOf = (res: Response): string => (res.headers.getSetCookie().find((c) => c.startsWith("allevia_session=")) ?? "").split(";")[0]!;
const tenants = async (cookie?: string) => (await (await get("/api/tenants", cookie)).json()) as Array<Record<string, unknown>>;

async function account(who: string, slug?: string, role: MemberRole = "owner"): Promise<{ email: string; cookie: string }> {
  const e = email(who);
  const u = (await createUser({ email: e, name: who, password: PW }, opts))!;
  if (slug) await addMember(u.id, slug, role, opts);
  const res = await send("/api/auth/login", { email: e, password: PW });
  expect(res.status).toBe(200);
  return { email: e, cookie: jarOf(res) };
}

beforeAll(async () => {
  ({ g: shared } = await seededGraph());
  ({ g: show } = await seededGraph());
  for (const g of [shared, show]) await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);
  // a customer on the showcase: masked for a stranger, real for the people who run it
  await upsertNode(show, { type: "Client", id: "client:hollis-interiors", name: "Hollis Interiors", summary: "Buys 20 tables a year" }, SEED_NOW);
  const meta = await openGraphByName(metaGraph);
  await meta.query(
    `CREATE (:Tenant {slug:'op_co', name:'Operator Co'}), (:Tenant {slug:'avs_co', name:'AVS Atelier'}), (:Tenant {slug:'other_co', name:'Other Co'}),
            (:Tenant {slug:'show_co', name:'Oak & Grain'}), (:Tenant {slug:'demo_co', name:'Demo Cafe'})`, {});
  await meta.query("MATCH (t:Tenant) SET t += $base", { base: { graph: "x", businessId: "business:aamdani", ontologyVersion: 2, createdAt: 1, updatedAt: 1 } });
  expect(await setShowcase("show_co", true, opts)).toBe(true);
  expect(await setDemo("demo_co", true, opts)).toBe(true);
  const graphs: Record<string, GraphHandle> = { op_co: shared, avs_co: shared, other_co: shared, demo_co: shared, show_co: show };
  const deps: ServerDeps = {
    publicMode: false,
    listTenants: () => listTenants(opts),
    openGraph: async (slug) => graphs[slug] ?? Promise.reject(new Error(`no graph for ${slug}`)),
    askDeps: async (tenant) => createAskDeps({ tenant }, { graph: graphs[tenant]!, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) }),
    embedQuery: async () => async (t: string) => fakeEmbed(t),
    auth: { enabled: true, verify: (t) => verifyToken(t, opts), accounts: { metaGraph } },
    actions: { config: { dataDir: "/nonexistent-allevia-operator-test" } },
    directiveLlm: null, heartbeatMs: 0, replaySpeed: 0, now: () => SEED_NOW + 3_600_000, tenantCacheMs: 0, log: () => {},
    rateLimit: NO_LIMITS,
    registry: opts,
  };
  app = createApp(deps);
  operator = await account("founder", "op_co");
  devika = await account("devika", "avs_co");
  expect(await setOperator(operator.email, true, opts)).toMatchObject({ email: operator.email });
}, 120_000);

afterAll(async () => {
  await shared?.drop();
  await show?.drop();
  await (await openGraphByName(metaGraph)).drop();
  await closeAll();
});

describe("an operator session", () => {
  it("opens every business as its owner, including ones it is not in", async () => {
    for (const slug of SLUGS) {
      const res = await get(`/api/${slug}/overview`, operator.cookie);
      expect(res.status, slug).toBe(200);
      const t = ((await res.json()) as { tenant: Record<string, unknown> }).tenant;
      expect(t.readOnly, slug).toBeUndefined(); // not the public view, even on a demo or a showcase
    }
    // owner-only routes work too: the team page of a business it is not a member of
    const members = await get("/api/avs_co/members", operator.cookie);
    expect(members.status).toBe(200);
  });

  it("lists every registered business, its own first, each marked with its access", async () => {
    const list = await tenants(operator.cookie);
    expect(list.map((t) => t.id)[0]).toBe("op_co");
    expect(list.map((t) => t.id).sort()).toEqual([...SLUGS].sort());
    for (const t of list) {
      expect(t.role, String(t.id)).toBe("owner");
      expect(t.readOnly, String(t.id)).toBeUndefined();
      expect(t.operator, String(t.id)).toBe(t.id === "op_co" ? undefined : true);
    }
  });

  it("is told it is the operator by /api/auth/me", async () => {
    const me = (await (await get("/api/auth/me", operator.cookie)).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ operator: true, businesses: [{ id: "op_co", role: "owner" }] });
  });

  it("sees a showcase's real data, not the visitor's mask", async () => {
    const card = await get("/api/show_co/node/client:hollis-interiors", operator.cookie);
    expect(card.status).toBe(200);
    expect(((await card.json()) as { node: { name: string } }).node.name).toBe("Hollis Interiors");
    const map = (await (await get("/api/show_co/graph/map", operator.cookie)).json()) as { nodes: Array<{ label: string; name: string }> };
    expect(map.nodes.find((x) => x.label === "Client")?.name).toBe("Hollis Interiors");
  });

  it("does not open a business that is not registered (the same 401 a stranger gets)", async () => {
    expect((await get("/api/nobody_co/overview", operator.cookie)).status).toBe(401);
  });
});

describe("a normal account", () => {
  it("opens only its own business, and gets a 401 on every other private one", async () => {
    expect((await get("/api/avs_co/overview", devika.cookie)).status).toBe(200);
    for (const slug of ["op_co", "other_co"]) {
      expect((await get(`/api/${slug}/overview`, devika.cookie)).status, slug).toBe(401);
      expect((await get(`/api/${slug}/members`, devika.cookie)).status, slug).toBe(401);
    }
  });

  it("lists only its own business plus the public demos, read-only", async () => {
    const list = await tenants(devika.cookie);
    expect(list.map((t) => [t.id, t.role ?? null, t.readOnly ?? false, t.operator ?? null])).toEqual([
      ["avs_co", "owner", false, null], ["demo_co", null, true, null], ["show_co", null, true, null],
    ]);
    const me = (await (await get("/api/auth/me", devika.cookie)).json()) as Record<string, unknown>;
    expect(me.operator).toBeUndefined();
  });

  it("is masked like any visitor on a showcase it is not in", async () => {
    expect((await get("/api/show_co/node/client:hollis-interiors", devika.cookie)).status).toBe(404);
  });
});

describe("a stranger on a showcase", () => {
  it("is still masked", async () => {
    expect((await get("/api/show_co/node/client:hollis-interiors")).status).toBe(404);
    const map = (await (await get("/api/show_co/graph/map")).json()) as { nodes: Array<{ label: string; name: string }> };
    expect(map.nodes.find((x) => x.label === "Client")?.name).toBe("A customer");
    expect(JSON.stringify(map)).not.toContain("Hollis Interiors");
    expect((await get("/api/other_co/overview")).status).toBe(401);
    expect((await tenants()).map((t) => t.id)).toEqual(["demo_co", "show_co"]);
  });
});

describe("no HTTP route makes anyone the operator", () => {
  it("has no route about the operator flag", () => {
    const paths = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths.filter((p) => /operator/i.test(p))).toEqual([]);
  });

  it("ignores operator in a sign-up body, and every plausible way to ask for it", async () => {
    const e = email("sneaky");
    const res = await send("/api/auth/signup", { name: "Sneaky", email: e, password: PW, operator: true });
    expect(res.status).toBe(201);
    const cookie = jarOf(res);
    const tries: Array<[string, string]> = [
      ["POST", "/api/auth/operator"], ["PATCH", "/api/auth/me"], ["POST", "/api/auth/me"], ["POST", "/api/operator"], ["PATCH", "/api/auth/operator"],
      ["POST", "/api/avs_co/operator"], ["POST", "/api/auth/password"],
    ];
    for (const [method, path] of tries) {
      const r = await send(path, { operator: true, email: e, current: PW, next: `${PW} 2` }, { method, headers: { cookie } });
      expect(r.status, `${method} ${path}`).not.toBe(500);
    }
    const me = (await (await get("/api/auth/me", cookie)).json()) as Record<string, unknown>;
    expect(me.operator).toBeUndefined();
    expect((await get("/api/other_co/overview", cookie)).status).toBe(401);
    expect((await tenants(cookie)).map((t) => t.id)).toEqual(["demo_co", "show_co"]);
  });

  it("is written only by the CLI: setOperator is called from src/cli/auth.ts and nowhere else in src/", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");
    const callers = files.filter((f) => f !== join("src", "auth", "accounts.ts") && /\bsetOperator\b/.test(readFileSync(f, "utf8")));
    expect(callers).toEqual([join("src", "cli", "auth.ts")]);
    // and no other query in src/ writes the flag
    const writers = files.filter((f) => /\b(?:SET|CREATE|MERGE)\b[^\n]*[.{\s]operator\b/.test(readFileSync(f, "utf8").replace(/\/\/[^\n]*/g, "")));
    expect(writers).toEqual([join("src", "auth", "accounts.ts")]);
  });
});

describe("switching the operator off", () => {
  it("takes away every business it is not in on the very next request", async () => {
    expect((await get("/api/avs_co/overview", operator.cookie)).status).toBe(200);
    expect(await setOperator(operator.email, false, opts)).toMatchObject({ email: operator.email });
    // the same session, the very next request
    expect((await get("/api/avs_co/overview", operator.cookie)).status).toBe(401);
    expect((await get("/api/other_co/overview", operator.cookie)).status).toBe(401);
    expect((await get("/api/op_co/overview", operator.cookie)).status).toBe(200); // its own business stays
    const list = await tenants(operator.cookie);
    expect(list.map((t) => [t.id, t.role ?? null, t.operator ?? null])).toEqual([["op_co", "owner", null], ["demo_co", null, null], ["show_co", null, null]]);
    expect((await get("/api/show_co/node/client:hollis-interiors", operator.cookie)).status).toBe(404); // masked again
    expect(((await (await get("/api/auth/me", operator.cookie)).json()) as Record<string, unknown>).operator).toBeUndefined();
  });
});
