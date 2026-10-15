// Tenant isolation, layer 3: the HTTP API with two real tenants (A and B, two graphs). Whatever a request for A names,
// whether a crafted slug, an id that only exists in B, a turn B is running, or a file only B has, it never reads,
// changes or reveals B. (Authentication, which decides who may ask for A at all, is tested in auth.test.ts.)
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import type { AgentEvent } from "../../shared/contracts.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { FakeRuntime } from "../../src/agent/runtime.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { createApp, type OnboardStart, type RegistryTenant } from "../../src/server/app.js";
import type { StudioWiring } from "../../src/server/studio.js";
import { FakeEngine } from "../../src/studio/engine.js";
import { AssetStore } from "../../src/studio/store.js";
import { FakeVision } from "../../src/studio/vision.js";
import { fakeEmbed, SEED_NOW } from "../fixtures/seed-graph.js";
import { seededGraph } from "../helpers/tools.js";
import { SCRIPTS, post, sseEvents } from "../server/harness.js";
import { CRAFTED_SLUGS } from "./crafted.js";

const TENANT_A: RegistryTenant = { slug: "tenant_a", name: "Alpha Foods", businessId: "business:aamdani", domain: "alpha.example", industry: "food" };
const TENANT_B: RegistryTenant = { slug: "tenant_b", name: "Bravo Builders", businessId: "business:aamdani", domain: "bravo.example", industry: "construction" };
const B_CODE = "ZB-7731-floor";
const B_SHA = "b".repeat(64);
const NOW = SEED_NOW + 3_600_000;

let a: GraphHandle;
let b: GraphHandle;
let dataDir: string;
let app: Hono;
const opened: string[] = [];
const onboarded: OnboardStart[] = [];
let studioWiring: StudioWiring;
let registry: RegistryTenant[];

const get = (path: string, init?: RequestInit) => app.request(path, init);
const jsonOf = async (res: Response) => JSON.parse(await res.text()) as unknown;
const countB = async (cypher: string, params?: Record<string, unknown>) => (await b.roQuery<{ c: number }>(cypher, params))[0]!.c;

beforeAll(async () => {
  ({ g: a } = await seededGraph());
  ({ g: b } = await seededGraph());
  dataDir = mkdtempSync(join(tmpdir(), "allevia-iso-"));
  for (const g of [a, b]) await ensureRoster(g, { businessId: "business:aamdani" }, SEED_NOW);

  // Things only B has: a card waiting for approval, a learned rule, a thread, an uploaded photo, a secret note.
  await upsertNode(b, { type: "Approval", id: "approval:b-only-1", name: "github_issue: Bravo roof",
    props: { status: "pending", kind: "github_issue", title: "Bravo roof", payload: JSON.stringify({ title: "Bravo roof", body: `bid ${B_CODE}` }) } }, SEED_NOW);
  await upsertNode(b, { type: "Rule", id: "rule:b-learned-1", name: "Never quote under floor", props: { kind: "learned", status: "active", text: `never quote under ${B_CODE}`, op: "instruction" } }, SEED_NOW);
  await upsertNode(b, { type: "Session", id: "session:b-only-1", name: "Bravo thread", props: { channel: "web", startedAt: SEED_NOW } }, SEED_NOW);
  await upsertNode(b, { type: "Memory", id: "memory:b-only-1", name: "Bravo note", summary: `bid floor ${B_CODE}`, props: { kind: "note", text: `bid floor ${B_CODE}`, at: SEED_NOW } }, SEED_NOW);
  await upsertNode(b, { type: "Asset", id: "asset:b-only-1", name: "Bravo photo", props: { kind: "original", mediaType: "image", mime: "image/jpeg", storageKey: `${B_SHA}.jpg`, w: 1, h: 1, sha256: B_SHA } }, SEED_NOW);
  // The same key in A's graph, as if A's data had been crafted to point at B's file, and a traversal key
  await upsertNode(a, { type: "Asset", id: "asset:a-points-at-b-file", name: "Alpha photo", props: { kind: "original", mediaType: "image", mime: "image/jpeg", storageKey: `${B_SHA}.jpg`, w: 1, h: 1, sha256: B_SHA } }, SEED_NOW);
  await upsertNode(a, { type: "Asset", id: "asset:a-traversal", name: "Alpha photo 2", props: { kind: "original", mediaType: "image", mime: "image/jpeg", storageKey: `../tenant_b/${B_SHA}.jpg`, w: 1, h: 1, sha256: B_SHA } }, SEED_NOW);
  const store = new AssetStore(dataDir);
  store.put("tenant_b", B_SHA, Buffer.from("B-PHOTO-BYTES"));
  mkdirSync(join(dataDir, "studio-demo", "tenant_b"), { recursive: true });
  writeFileSync(join(dataDir, "studio-demo", "tenant_b", "rough.jpg"), "B-SAMPLE-BYTES");
  writeFileSync(join(dataDir, "studio-demo", "tenant_b", "sample.json"), JSON.stringify({ note: "b note", caption: "b caption" }));

  studioWiring = {
    deps: { store, vision: new FakeVision({}), engine: new FakeEngine(() => Buffer.from("x")) },
    sample: (tenant) => (tenant === "tenant_b" ? { file: join(dataDir, "studio-demo", "tenant_b", "rough.jpg"), note: "b note", caption: "b caption" } : null),
  };
  registry = [TENANT_A, TENANT_B];
  const graphs: Record<string, GraphHandle> = { tenant_a: a, tenant_b: b };
  app = createApp({
    publicMode: false,
    listTenants: async () => registry,
    openGraph: async (slug) => {
      opened.push(slug);
      const g = graphs[slug];
      if (!g) throw new Error(`no graph for ${slug}`);
      return g;
    },
    askDeps: async (tenant) => createAskDeps({ tenant }, { graph: graphs[tenant]!, runtime: new FakeRuntime(SCRIPTS), embedQuery: async (t) => fakeEmbed(t) }),
    embedQuery: async () => async (t: string) => fakeEmbed(t),
    studio: async () => studioWiring,
    loadOnboard: async () => async (input) => { onboarded.push(input); },
    actions: { config: { dataDir } },
    directiveLlm: null,
    heartbeatMs: 0, replaySpeed: 0, now: () => NOW, log: () => {},
  });
}, 90_000);

afterAll(async () => {
  await a?.drop();
  await b?.drop();
  rmSync(dataDir, { recursive: true, force: true });
  const { closeAll } = await import("../../src/graph/client.js");
  await closeAll();
});

describe("a path that names a tenant is checked against the registry, and only a valid slug gets that far", () => {
  const PATHS = ["overview", "brief", "sessions", "turns/live", "search?q=x", "graph/overview", "agents", "recommendations", "approvals", "learning", "program", "capabilities", "usage", "goals/setup", "studio/latest"];

  it("answers 404 for every crafted slug, on every kind of route, and never opens a graph for one", async () => {
    const before = opened.length;
    for (const [what, slug] of [...CRAFTED_SLUGS, ["the registry", "meta"] as [string, string], ["the other case", "TENANT_A"] as [string, string]]) {
      for (const path of PATHS) {
        const res = await get(`/api/${encodeURIComponent(slug)}/${path}`);
        expect([400, 404], `${what}: ${path}`).toContain(res.status);
        expect(await res.text(), `${what}: ${path}`).not.toMatch(/Alpha Foods|Bravo Builders|alpha\.example|bravo\.example/);
      }
    }
    expect(opened.slice(before)).toEqual([]);
  });

  it("a slug smuggled in through path syntax is not a tenant (a path that the URL parser resolves to B's own address is simply a request for B)", async () => {
    for (const path of [
      "/api/tenant_a%2f..%2ftenant_b/overview", "/api/tenant_a%2F..%2Ftenant_b%2Foverview", "/api/tenant_a;tenant_b/overview", "/api/tenant_a%00/overview",
      "/api/tenant_a%0a/overview", "/api/tenant_a./overview", "/api/tenant_a%20/overview", "/api/tenant_b%2Foverview", "/api/TENANT_B/overview",
      "/api/tenant_a%252f..%252ftenant_b/overview", "/api/tenant_a%5c..%5ctenant_b/overview",
    ]) {
      const res = await get(path);
      expect([400, 404], path).toContain(res.status);
      expect(await res.text(), path).not.toContain("Bravo Builders");
    }
  });

  it("a tenant is asked for by the path alone: a header, a cookie or a query value naming another tenant is ignored", async () => {
    const res = await get("/api/tenant_a/overview?tenant=tenant_b&t=tenant_b&slug=tenant_b", {
      headers: { "x-tenant": "tenant_b", "x-allevia-tenant": "tenant_b", "x-forwarded-host": "tenant_b", cookie: "tenant=tenant_b; slug=tenant_b" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Alpha Foods");
    expect(body).not.toContain("Bravo Builders");
  });
});

describe("an id that exists only in B is not found through A, on every route that takes an id", () => {
  it("reads", async () => {
    for (const path of [
      "/api/tenant_a/node/memory%3Ab-only-1", "/api/tenant_a/graph?focus=memory%3Ab-only-1", "/api/tenant_a/sessions/session%3Ab-only-1",
      "/api/tenant_a/agents/memory%3Ab-only-1", "/api/tenant_a/turns/turn%3Ab-only/events", "/api/tenant_a/turns/turn%3Ab-only/replay",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain(B_CODE);
    }
    for (const path of ["/api/tenant_a/approvals", "/api/tenant_a/learning", "/api/tenant_a/recommendations", "/api/tenant_a/graph/overview", "/api/tenant_a/search?q=" + encodeURIComponent(`bid floor ${B_CODE}`)]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(B_CODE);
    }
    // the same B routes do show it (so the checks above are not passing on an empty answer)
    expect(await (await get("/api/tenant_b/node/memory%3Ab-only-1")).text()).toContain(B_CODE);
    expect(await (await get("/api/tenant_b/approvals")).text()).toContain("approval:b-only-1");
    expect(await (await get("/api/tenant_b/learning")).text()).toContain(B_CODE);
  });

  it("writes: deciding, retiring, confirming or applying B's thing through A is a 404 and B is untouched", async () => {
    const decide = await post(app, "/api/tenant_a/approvals/approval%3Ab-only-1", { decision: "approve" });
    expect(decide.status).toBe(404);
    const retire = await app.request("/api/tenant_a/learning/rule%3Ab-learned-1", { method: "DELETE" });
    expect(retire.status).toBe(404);
    const goal = await post(app, "/api/tenant_a/goals/goal%3Ab-only", { confirm: true });
    expect(goal.status).toBe(404);
    const apply = await post(app, "/api/tenant_a/directives/directive%3Ab-only/apply", {});
    expect(apply.status).toBe(404);
    const studio = await post(app, "/api/tenant_a/studio/approve", { approvalId: "approval:b-only-1" });
    expect([404, 409, 400]).toContain(studio.status);
    // an approval id sent as "edited" content or as a path trick does not reach B either
    const trick = await post(app, "/api/tenant_a/approvals/approval%3Ab-only-1%2F..%2Fapproval%3At-001-1", { decision: "reject" });
    expect(trick.status).toBe(404);

    expect(await countB("MATCH (a:Approval {id:'approval:b-only-1'}) WHERE a.status = 'pending' RETURN count(a) AS c")).toBe(1);
    expect(await countB("MATCH (r:Rule {id:'rule:b-learned-1'}) WHERE r.status = 'active' RETURN count(r) AS c")).toBe(1);
    expect(await countB("MATCH (x:Action) RETURN count(x) AS c")).toBe(0);
  });

  it("the same call for B itself does work, so the 404s above are about the tenant and not about the route", async () => {
    const decided = await post(app, "/api/tenant_b/approvals/approval%3Ab-only-1", { decision: "reject" });
    expect(decided.status).toBe(200);
    expect(await jsonOf(decided)).toMatchObject({ id: "approval:b-only-1", status: "rejected" });
    // and it changed nothing in A
    const inA = await (await get("/api/tenant_a/approvals")).text();
    expect(inA).not.toContain("approval:b-only-1");
  });
});

describe("a turn that B is running or has saved is B's alone", () => {
  it("is not listed, followed, replayed or stopped through A; A's own thread list does not show it", async () => {
    const res = await post(app, "/api/tenant_b/ask", { question: "Who owns the Instagram token fix?" });
    const events = sseEvents(await res.text()) as AgentEvent[];
    const session = events.find((e): e is Extract<AgentEvent, { type: "session" }> => e.type === "session")!;
    expect(session.tenant).toBe("tenant_b");
    // wait for it to be saved in B
    for (let i = 0; i < 80 && (await countB("MATCH (t:Turn {id:$id}) RETURN count(t) AS c", { id: session.turnId })) === 0; i++) await new Promise((r) => setTimeout(r, 100));

    const enc = encodeURIComponent;
    expect(await jsonOf(await get("/api/tenant_a/turns/live"))).toEqual([]);
    for (const path of [`/api/tenant_a/turns/${enc(session.turnId)}/events?after=0`, `/api/tenant_a/turns/${enc(session.turnId)}/replay`, `/api/tenant_a/sessions/${enc(session.sessionId)}`]) {
      expect((await get(path)).status, path).toBe(404);
    }
    expect((await post(app, `/api/tenant_a/turns/${enc(session.turnId)}/stop`, {})).status).toBe(404);
    const aThreads = await (await get("/api/tenant_a/sessions")).text();
    expect(aThreads).not.toContain(session.sessionId);
    expect(aThreads).not.toContain("Instagram token fix");
    // B does have it
    expect((await get(`/api/tenant_b/turns/${enc(session.turnId)}/replay`)).status).toBe(200);
    expect(await (await get("/api/tenant_b/sessions")).text()).toContain(session.sessionId);
  });

  it("a session id taken from B and continued through A starts a thread in A, and B's history is not read", async () => {
    const res = await post(app, "/api/tenant_a/ask", { question: "What did we decide?", sessionId: "session:b-only-1" });
    const text = await res.text();
    expect(text).not.toContain(B_CODE);
    expect(await countB("MATCH (t:Turn) WHERE t.question = 'What did we decide?' RETURN count(t) AS c")).toBe(0);
  });
});

describe("files: a photo is served only from its own tenant's folder", () => {
  it("B's asset id, a key that points at B's file and a traversal key are all 404 through A; B's own photo is served", async () => {
    for (const id of ["asset%3Ab-only-1", "asset%3Aa-points-at-b-file", "asset%3Aa-traversal"]) {
      const res = await get(`/api/tenant_a/assets/${id}`);
      expect(res.status, id).toBe(404);
      expect(await res.text(), id).not.toContain("B-PHOTO-BYTES");
    }
    const own = await get("/api/tenant_b/assets/asset%3Ab-only-1");
    expect(own.status).toBe(200);
    expect(await own.text()).toBe("B-PHOTO-BYTES");
  });

  it("the demo sample photo is per tenant", async () => {
    expect((await get("/api/tenant_a/studio/sample")).status).toBe(404);
    expect((await get("/api/tenant_a/studio/sample.jpg")).status).toBe(404);
    expect(await (await get("/api/tenant_b/studio/sample.jpg")).text()).toBe("B-SAMPLE-BYTES");
  });
});

describe("onboarding cannot reach a business that already exists", () => {
  const start = (body: Record<string, unknown>) => post(app, "/api/onboard", body);

  it("refuses to onboard into an existing business by naming its slug, and does not run the onboarder", async () => {
    const before = onboarded.length;
    const res = await start({ name: "Evil Corp", url: "evil.example", slug: "tenant_b" });
    expect(res.status).toBe(409);
    await res.text();
    expect(onboarded.length).toBe(before);
  });

  it("refuses the registry's name and the other reserved names", async () => {
    const before = onboarded.length;
    for (const slug of ["meta", "operator", "auth", "health", "tenants"]) {
      const res = await start({ name: "Evil Corp", url: "evil.example", slug });
      expect([400, 409], slug).toContain(res.status);
      await res.text();
    }
    expect(onboarded.length).toBe(before);
  });

  it("a name or a web address that matches an existing business never lands in that business", async () => {
    for (const body of [
      { name: "Bravo Builders", url: "evil.example" },
      { name: "Bravo Builders", url: "https://evil.example/?bravo.example" },
      { name: "Bravo Builders", url: "https://bravo.example.evil.example/" },
      { name: "Bravo Builders", url: "bravo.example" },
      { name: "tenant b", url: "https://evil.example/#bravo.example" },
      { name: "Tenant A", url: "alpha.example" },
    ]) {
      const before = onboarded.length;
      const res = await start(body);
      await res.text();
      const ran = onboarded.slice(before);
      for (const input of ran) expect(["tenant_a", "tenant_b"], JSON.stringify(body)).not.toContain(input.slug);
    }
  });
});
