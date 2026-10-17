// The API's read endpoints over seedMini: tenant validation, JSON errors without stacks, CORS for the Vite dev origin
// only, and the shapes the web app reads (web/src/types-ext.ts): overview, threads, search, node, graph views, agents,
// recommendations, approvals, brief, onboarding and plans when those modules are absent.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { upsertNode } from "../../src/graph/upsert.js";
import type {
  AgentDetailDto, AgentSummaryDto, ApprovalDto, GraphDataDto, NodeDetailDto, OverviewDto, RecommendationDto, SearchHitDto,
  SessionDetailDto, SessionSummaryDto, TenantDto,
} from "../../src/server/types.js";
import { AGENTS } from "../../shared/roster.js";
import { SEED_NOW } from "../fixtures/seed-graph.js";
import { harness, post, TENANT, type Harness } from "./harness.js";

describe("server: reads (integration)", () => {
  let h: Harness;
  beforeAll(async () => { h = await harness(); }, 90_000);
  afterAll(async () => h.cleanup());

  const json = async <T>(path: string, status = 200): Promise<T> => {
    const res = await h.app.request(path);
    expect(res.status, `${path} -> ${res.status}: ${await res.clone().text()}`).toBe(status);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    return (await res.json()) as T;
  };

  it("health says ok, how many businesses, and whether this is the public demo", async () => {
    expect(await json("/api/health")).toEqual({ ok: true, publicMode: false, tenants: 1 });
    const down = h.make({ listTenants: async () => { throw new Error("ECONNREFUSED 127.0.0.1:6390"); } });
    const res = await down.request("/api/health");
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("6390");
  });

  it("lists businesses with their region from the Business node (currency, locale, time zone)", async () => {
    const [t] = await json<TenantDto[]>("/api/tenants");
    expect(t).toEqual({
      id: "mini", name: "Mini Jobs", domain: "mini.example", industry: "jobs", city: "Raipur",
      country: "India", currency: "INR", locale: "en-IN", timeZone: "Asia/Kolkata",
    });
  });

  it("refuses a business that is not in the registry, and unknown endpoints, as JSON 404s", async () => {
    for (const path of ["/api/nope/overview", "/api/Mini/overview", "/api/mini_/sessions", "/api/allevia_meta/agents", "/api/mini/nothing-here"]) {
      const res = await h.app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toHaveProperty("error");
    }
  });

  it("an unexpected failure is a plain JSON 500: no stack, no internals", async () => {
    const broken = h.make({ openGraph: async () => { throw new Error("FalkorDB exploded in /srv/acme/internal.ts:12"); } });
    const res = await broken.request("/api/mini/overview");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: expect.stringMatching(/went wrong/) });
    expect(body).not.toMatch(/exploded|acme|internal|\.ts|at /);
  });

  it("answers CORS only for the Vite dev origin", async () => {
    const ok = await h.app.request("/api/health", { headers: { origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await h.app.request("/api/health", { headers: { origin: "https://elsewhere.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await h.app.request("/api/mini/approvals/x", { method: "OPTIONS", headers: { origin: "https://elsewhere.example", "access-control-request-method": "POST" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("overview: counts by label, freshness per source kind, top recommendations, approvals waiting", async () => {
    const o = await json<OverviewDto>("/api/mini/overview");
    expect(o.tenant.id).toBe("mini");
    expect(o.counts.Document).toBe(11);
    expect(o.counts.Agent).toBeGreaterThanOrEqual(AGENTS.length);
    expect(o.freshness).toEqual(expect.arrayContaining([
      { source: "Reports", asOf: "2026-10-10", status: "ok" },
      { source: "Simulated ads", asOf: "2026-10-14", status: "ok", note: "simulated" },
      { source: "Decisions", asOf: "2026-09-20", status: "stale" },
    ]));
    expect(o.recommendations.length).toBeLessThanOrEqual(3);
    expect(o.recommendations[0]!.id).toBe("recommendation:double-down-on-salary-reels");
    expect(o.approvalsPending).toBe(1);
    expect(o.brief).toBe("");
  });

  it("brief: 404 until a brief Document exists, then the latest one", async () => {
    expect(await json("/api/mini/brief", 404)).toHaveProperty("error");
    await upsertNode(h.g, { type: "Document", id: "document:brief-2026-10-15", name: "Morning brief, 15 Oct", props: { kind: "brief", text: "Signups up [[channel:instagram]]." }, asOf: "2026-10-15" }, SEED_NOW);
    expect(await json("/api/mini/brief")).toEqual({ id: "document:brief-2026-10-15", title: "Morning brief, 15 Oct", asOf: "2026-10-15", text: "Signups up [[channel:instagram]]." });
    expect((await json<OverviewDto>("/api/mini/overview")).brief).toBe("Signups up [[channel:instagram]].");
  });

  it("threads: list, one thread with its turns, and a missing replay is a 404", async () => {
    const list = await json<SessionSummaryDto[]>("/api/mini/sessions");
    const s = list.find((x) => x.id === "session:s-001")!;
    expect(s).toEqual({ id: "session:s-001", title: "Thread about stories", channel: "web", turns: 1, startedAt: "2026-10-14T09:00:00.000Z", lastAt: "2026-10-14T09:00:00.000Z" });
    const d = await json<SessionDetailDto>("/api/mini/sessions/session%3As-001");
    expect(d.turns).toHaveLength(1);
    expect(d.turns[0]).toMatchObject({ id: "turn:t-001", question: "Why did we pause daily stories?", agents: ["chief-of-staff", "librarian"], ms: 0 });
    expect(d.turns[0]!.checks).toMatchObject({ citationsValid: true, numbersGrounded: true, invalidCitations: [] });
    await json("/api/mini/sessions/session%3Anope", 404);
    await json("/api/mini/turns/turn%3At-001/replay", 404); // the seeded turn has no event log
  });

  it("search: ranked hits with the node ref and a snippet; an empty query is an empty list", async () => {
    const hits = await json<SearchHitDto[]>("/api/mini/search?q=instagram%20token%20refresh");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(25);
    expect(hits.map((x) => x.node.id)).toContain("task:fix-ig-token");
    expect(hits[0]).toMatchObject({ node: { id: expect.any(String), label: expect.any(String), name: expect.any(String) }, score: expect.any(Number) });
    expect(await json("/api/mini/search?q=")).toEqual([]);
    await json(`/api/mini/search?q=${"x".repeat(201)}`, 400);
  });

  it("node: props without embeddings, current neighbours both ways, versions and sources", async () => {
    const d = await json<NodeDetailDto>("/api/mini/node/decision%3A007-pause-daily-stories");
    expect(d.node).toMatchObject({ id: "decision:007-pause-daily-stories", label: "Decision", name: "Pause daily stories" });
    expect(Object.keys(d.props)).not.toEqual(expect.arrayContaining(["embedding"]));
    expect(d.props).not.toHaveProperty("rev");
    expect(d.props.status).toBe("accepted");
    expect(d.neighbors).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "out", edge: expect.objectContaining({ type: "SUPERSEDES", to: "decision:003-daily-stories" }), node: expect.objectContaining({ id: "decision:003-daily-stories" }) }),
      expect.objectContaining({ direction: "in", edge: expect.objectContaining({ type: "DECIDED", from: "person:founder" }) }),
    ]));
    expect(d.sources.map((s) => s.id)).toContain("document:adr-007");

    const task = await json<NodeDetailDto>("/api/mini/node/task%3Afix-ig-token");
    expect(task.versions).toHaveLength(1);
    expect(task.versions[0]!.props).toMatchObject({ status: "open" });
    // the reassigned owner: only the current OWNS edge is a neighbour
    expect(task.neighbors.filter((n) => n.edge.type === "OWNS").map((n) => n.node.id)).toEqual(["person:priya"]);
    await json("/api/mini/node/nope%3Anothing", 404);
  });

  it("graph focus: the node and what is within depth hops, edges only between returned nodes", async () => {
    const one = await json<GraphDataDto>("/api/mini/graph?focus=system%3Aig-connector&depth=1");
    const ids = new Set(one.nodes.map((n) => n.id));
    expect(one.nodes[0]).toMatchObject({ id: "system:ig-connector", label: "System", name: "Instagram connector" });
    expect([...ids]).toEqual(expect.arrayContaining(["system:ig-connector", "system:reel-publisher", "channel:instagram"]));
    expect([...ids]).not.toContain("system:reel-scheduler"); // two hops away
    expect([...ids]).not.toContain("system:legacy-poster");  // its DEPENDS_ON edge is closed
    for (const e of one.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
    const two = await json<GraphDataDto>("/api/mini/graph?focus=system%3Aig-connector&depth=9");
    expect(two.nodes.map((n) => n.id)).toContain("system:reel-scheduler");
    expect(two.nodes.length).toBeLessThanOrEqual(150);
    await json("/api/mini/graph", 400);
    await json("/api/mini/graph?focus=nope%3Ax", 404);
  });

  it("graph overview: at most 400 business nodes with rank 0–1 and a community, and the edges between them", async () => {
    const o = await json<GraphDataDto>("/api/mini/graph/overview");
    expect(o.nodes.length).toBeGreaterThan(20);
    expect(o.nodes.length).toBeLessThanOrEqual(400);
    const ids = new Set(o.nodes.map((n) => n.id));
    expect(o.nodes.some((n) => ["Version", "Chunk", "Observation", "Turn", "Session"].includes(n.label))).toBe(false);
    for (const n of o.nodes) {
      expect(n.rank).toBeGreaterThanOrEqual(0);
      expect(n.rank).toBeLessThanOrEqual(1);
      expect(Number.isInteger(n.community)).toBe(true);
    }
    expect(Math.max(...o.nodes.map((n) => n.rank ?? 0))).toBe(1); // no stored rank in seedMini: computed, top node = 1
    expect(new Set(o.nodes.map((n) => n.community)).size).toBeGreaterThan(1);
    expect(o.edges.length).toBeGreaterThan(0);
    for (const e of o.edges) {
      expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
      expect(["TOUCHED", "CITED", "HAD_VERSION"]).not.toContain(e.type);
    }
    expect((await json<GraphDataDto>("/api/mini/graph/overview?limit=5")).nodes).toHaveLength(5);
  });

  it("agents: every roster agent with stats from the graph", async () => {
    const list = await json<AgentSummaryDto[]>("/api/mini/agents");
    expect(list.map((a) => a.id)).toEqual(AGENTS.map((a) => a.id));
    const strategist = list.find((a) => a.id === "content-strategist")!;
    expect(strategist.stats).toMatchObject({ proposals: 1, requests: 0, findings: 0, reviewsGiven: 0, checksPassed: 0, checksTotal: 0 });
    expect(list.find((a) => a.id === "librarian")!.stats.requests).toBe(1); // turn:t-001 HANDLED_BY Memory Keeper
  });

  it("agent profile: roster info, playbooks it reads, the knowledge map and recent findings", async () => {
    const before = await json<AgentDetailDto>("/api/mini/agents/content-strategist");
    expect(before.id).toBe("content-strategist");
    expect(before.knowledge.nodes[0]).toEqual({ id: "agent:allevia-content-strategist", label: "Agent", name: "Miss Influencer · Content Strategist", weight: 1 });
    expect(before.playbooks.map((p) => p.id)).toEqual(expect.arrayContaining(["playbook:reel-hooks"]));
    expect(before.stats.proposals).toBe(1);
    await json("/api/mini/agents/nobody", 404);
  });

  it("recommendations: proposed (an approval waits), with evidence, its agent, area and approval id", async () => {
    const recs = await json<RecommendationDto[]>("/api/mini/recommendations");
    const r = recs.find((x) => x.id === "recommendation:double-down-on-salary-reels")!;
    expect(r).toMatchObject({
      title: "Double down on salary reels", why: "The salary reveal reel did 6x the median views", area: "content", status: "proposed",
      by: "content-strategist", approvalId: "approval:t-001-1", confidence: 0.8, score: 0.8, impact: "",
    });
    expect(r.evidence.map((n) => n.id).sort()).toEqual(["content:reel-salary-reveal", "rule:hook-curiosity-gap"]);
    expect(r.evidenceEdges).toEqual(expect.arrayContaining([{ from: "content:reel-salary-reveal", type: "USES_RULE", to: "rule:hook-curiosity-gap", since: expect.any(Number), until: null }]));
    expect(r.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("recommendations carry the money at stake with its note when one is stored", async () => {
    await upsertNode(h.g, {
      type: "Recommendation", id: "recommendation:fix-jobs-meta", name: "Fix the /jobs meta description", summary: "High-severity SEO fail",
      props: { status: "open", area: "seo", score: 0.6, confidence: 0.7, value: JSON.stringify({ amount: 12000, currency: "INR", per: "month", note: "at today's CTR" }) },
    }, SEED_NOW);
    const r = (await json<RecommendationDto[]>("/api/mini/recommendations")).find((x) => x.id === "recommendation:fix-jobs-meta")!;
    expect(r).toMatchObject({ area: "seo", status: "open", by: "chief-of-staff", value: { amount: 12000, currency: "INR", per: "month", note: "at today's CTR" } });
    expect(r.approvalId).toBeUndefined();
  });

  it("approvals: the card with its kind, payload, proposer and recommendation", async () => {
    const list = await json<ApprovalDto[]>("/api/mini/approvals");
    expect(list.find((a) => a.id === "approval:t-001-1")).toEqual({
      id: "approval:t-001-1", kind: "content_draft", status: "pending", title: "Double down on salary reels", by: "content-strategist",
      recommendationId: "recommendation:double-down-on-salary-reels", payload: { title: "Double down on salary reels", body: "" },
      // the idea's reason, as one line, for the card on Home
      preview: { why: "The salary reveal reel did 6x the median views" },
      createdAt: expect.stringMatching(/^2026-/),
      credits: 1, // saying OK to a draft uses 1 credit (shared/credits.ts)
    });
  });

  it("onboarding and pricing say clearly when their modules are not installed", async () => {
    const none = h.make({ loadOnboard: async () => null, loadPlans: async () => null });
    const res = await post(none, "/api/onboard", { name: "Kestrel & Oak", url: "kestrel.example" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/onboarding is not installed/i) });
    expect((await none.request("/api/plans?currency=GBP")).status).toBe(501);
    const bad = await post(none, "/api/onboard", { url: "kestrel.example" });
    expect(bad.status).toBe(400);
  });

  it("pricing comes from shared/plans when present", async () => {
    const app = h.make({ loadPlans: async () => ({ PLANS: [{ id: "starter", price: { GBP: 49 } }] }) });
    expect(await (await app.request("/api/plans?currency=gbp")).json()).toEqual({ currency: "GBP", plans: [{ id: "starter", price: { GBP: 49 } }] });
    expect((await app.request("/api/plans?currency=pounds")).status).toBe(400);
  });

  it("the tenant fixture is the registered one", () => expect(TENANT.slug).toBe("mini"));
});
