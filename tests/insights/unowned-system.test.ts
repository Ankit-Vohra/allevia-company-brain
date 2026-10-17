// tech.unowned_critical_system: a tool or service that many things rely on (DEPENDS_ON, up to three steps) and that no person, team or
// agent is named to look after, directly or through the tool it is part of. Ranked by PageRank over the tools' own DEPENDS_ON edges.
// Run on a small invented company in a throwaway graph on the test-only FalkorDB.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { closeEdge, upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { ownerJargon } from "../../src/agent/style.js";
import { DETECTORS, DETECTOR_NAMES, runDetectors, type Candidate } from "../../src/insights/detectors.js";
import { runInsights } from "../../src/insights/recommend.js";
import { ordinal, unownedSystemText } from "../../src/insights/text.js";
import { testGraph } from "../helpers/graph.js";
import { whenFree } from "../helpers/tools.js";

const NOW = Date.parse("2026-10-15T04:00:00Z");
let g: GraphHandle;
let cleanup: () => Promise<void>;

const sys = (id: string, name: string, simulated = false) => upsertNode(g, { type: "System", id: `system:${id}`, name, ...(simulated ? { simulated: true } : {}) }, NOW - 5 * 86_400_000);
const dep = (from: string, to: string) => upsertEdge(g, { from, type: "DEPENDS_ON", to: `system:${to}` }, NOW - 4 * 86_400_000);

beforeAll(async () => {
  ({ g, cleanup } = await whenFree(async () => {
    const t = await testGraph();
    g = t.g;
    try {
      await upsertNode(g, { type: "Business", id: "business:shopfront", name: "Shopfront" }, NOW - 9 * 86_400_000);
      await upsertNode(g, { type: "Person", id: "person:dev", name: "Dev" }, NOW - 9 * 86_400_000);
      await upsertNode(g, { type: "Team", id: "team:platform", name: "Platform team" }, NOW - 9 * 86_400_000);

      // the tools. Payment gateway relies on the login service; both are leaned on by the shop's features, its website and its app.
      await sys("auth", "Login service");
      await sys("payments", "Payment gateway");
      await sys("platform", "Platform");
      await sys("cache", "Shared cache");
      await sys("email", "Email service");
      await sys("cdn", "Image CDN");
      await sys("billing", "Invoicing tool");
      await sys("sample", "Sample tool", true);
      await dep("system:payments", "auth");
      for (const f of ["checkout", "refunds", "wishlist"]) {
        await upsertNode(g, { type: "Feature", id: `feature:${f}`, name: f[0]!.toUpperCase() + f.slice(1) }, NOW - 5 * 86_400_000);
        await dep(`feature:${f}`, "payments");
      }
      await upsertNode(g, { type: "Channel", id: "channel:website", name: "Website" }, NOW - 5 * 86_400_000);
      await dep("channel:website", "payments");
      await upsertNode(g, { type: "Product", id: "product:app", name: "The app" }, NOW - 5 * 86_400_000);
      await upsertEdge(g, { from: "product:app", type: "DEPENDS_ON", to: "feature:checkout" }, NOW - 4 * 86_400_000);
      await upsertNode(g, { type: "Task", id: "task:move-payments", name: "Move payments to the new plan", props: { status: "open" } }, NOW - 5 * 86_400_000);
      await dep("task:move-payments", "payments");

      // login service: owned by a person, so it is never flagged however much leans on it
      await upsertEdge(g, { from: "person:dev", type: "OWNS", to: "system:auth" }, NOW - 8 * 86_400_000);
      // the shared cache is part of the platform, which a team owns: owned through its parent
      await upsertEdge(g, { from: "system:cache", type: "PART_OF", to: "system:platform" }, NOW - 8 * 86_400_000);
      await upsertEdge(g, { from: "team:platform", type: "OWNS", to: "system:platform" }, NOW - 8 * 86_400_000);
      for (const f of ["checkout", "refunds", "wishlist"]) await dep(`feature:${f}`, "cache");
      // email: only two things rely on it, however unowned
      for (const f of ["checkout", "refunds"]) await dep(`feature:${f}`, "email");
      // the image CDN: three features lean on it; its owner left (the OWNS edge is closed), so it has none now
      for (const f of ["checkout", "refunds", "wishlist"]) await dep(`feature:${f}`, "cdn");
      await upsertEdge(g, { from: "person:dev", type: "OWNS", to: "system:cdn" }, NOW - 8 * 86_400_000);
      await closeEdge(g, "person:dev", "OWNS", "system:cdn", NOW - 2 * 86_400_000, "left the company");
      // invoicing: leaned on by three, owned only by the business itself (not someone who can be asked), so it still counts
      for (const f of ["checkout", "refunds", "wishlist"]) await dep(`feature:${f}`, "billing");
      await upsertEdge(g, { from: "business:shopfront", type: "OWNS", to: "system:billing" }, NOW - 8 * 86_400_000);
      // a dependency that ended does not count: the wishlist no longer needs the email service... and a third feature once did
      await upsertNode(g, { type: "Feature", id: "feature:legacy", name: "Legacy export" }, NOW - 5 * 86_400_000);
      await dep("feature:legacy", "email");
      await closeEdge(g, "feature:legacy", "DEPENDS_ON", "system:email", NOW - 3 * 86_400_000, "retired");
      // the sample tool: three things rely on it, but its own numbers are sample numbers
      for (const f of ["checkout", "refunds", "wishlist"]) await dep(`feature:${f}`, "sample");
    } catch (e) { await t.cleanup().catch(() => undefined); throw e; }
    return t;
  }));
}, 90_000);
afterAll(async () => { await cleanup?.(); await closeAll(); });

const run = (extra: Record<string, number> = {}): Promise<Candidate[]> => DETECTORS["tech.unowned_critical_system"].run(g, { now: NOW, ...extra });

describe("tech.unowned_critical_system", () => {
  it("is registered with the other detectors", () => {
    expect(DETECTOR_NAMES).toContain("tech.unowned_critical_system");
    expect(DETECTORS["tech.unowned_critical_system"].area).toBe("tech");
  });

  it("flags what many things rely on and nobody is named to look after: the most leaned on first, at most three", async () => {
    const out = await run();
    expect(out.map((c) => c.key)).toEqual([
      "tech.unowned_critical_system:system:payments", "tech.unowned_critical_system:system:billing", "tech.unowned_critical_system:system:cdn",
    ]);
    const [pay] = out;
    // six things rely on the payment gateway: four directly (three features, the website, the task = five), the app through checkout
    expect(pay!.numbers).toMatchObject({ things_relying_on_it: 6, relying_directly: 5 });
    // PageRank sees only the tools' own edges: the login service (which the payment gateway relies on) is first and alone; the rest tie
    expect(pay!.numbers).toMatchObject({ rank_among_tools: 2, tools_ranked: 8 });
    expect(pay).toMatchObject({ area: "tech", agent: "tech-lead", detector: "tech.unowned_critical_system", src: "detector:tech.unowned_critical_system", confidence: 0.8 });
    expect(pay!.score).toBeGreaterThan(0.5);
    expect(pay!.score).toBeLessThanOrEqual(1);
  });

  it("does not flag a tool someone owns, one owned through its parent, one few things rely on, or one whose dependents have all left", async () => {
    const keys = (await run()).map((c) => c.key);
    for (const id of ["auth", "cache", "platform", "email"]) expect(keys, id).not.toContain(`tech.unowned_critical_system:system:${id}`);
  });

  it("an owner who left, and a business that owns it, are not someone to ask: both are flagged", async () => {
    const keys = (await run()).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["tech.unowned_critical_system:system:cdn", "tech.unowned_critical_system:system:billing"]));
  });

  it("the dependency path is the evidence: the tool first, then what relies on it, the nearest first, up to eight", async () => {
    const [pay] = await run();
    expect(pay!.evidence[0]).toBe("system:payments");
    expect(pay!.evidence.slice(1)).toEqual(["channel:website", "feature:checkout", "feature:refunds", "feature:wishlist", "task:move-payments", "product:app"]);
    // more than eight rely on it: still eight
    for (let i = 0; i < 6; i++) {
      await upsertNode(g, { type: "Feature", id: `feature:extra-${i}`, name: `Extra ${i}` }, NOW - 5 * 86_400_000);
      await dep(`feature:extra-${i}`, "payments");
    }
    const [wide] = await run();
    expect(wide!.numbers.things_relying_on_it).toBe(12);
    expect(wide!.evidence).toHaveLength(9);
    expect(wide!.evidence.every((id) => id === "system:payments" || !id.startsWith("product:"))).toBe(true);
  });

  it("a traversal of the graph agrees with what the detector says (a Cypher check of its claim)", async () => {
    const rows = await g.roQuery<{ n: number }>(
      `MATCH p = (x:Entity)-[:DEPENDS_ON*1..3]->(s:System {id:'system:payments'}) WHERE ALL(e IN relationships(p) WHERE e.until IS NULL)
       WITH s, count(DISTINCT x) AS n RETURN n`);
    expect(rows[0]!.n).toBe(12);
    const owners = await g.roQuery<{ n: number }>("MATCH (o:Entity)-[w:OWNS]->(s:System {id:'system:payments'}) WHERE ID(w) >= 0 AND w.until IS NULL RETURN count(o) AS n");
    expect(owners[0]!.n).toBe(0);
  });

  it("says it in the owner's words, with only numbers it counted, and a card that names an owner", async () => {
    const [pay, billing] = await run();
    for (const c of [pay!, billing!]) {
      for (const text of [c.title, c.why, c.impact ?? "", c.suggestedAction!.payload.title, c.suggestedAction!.payload.body]) expect(ownerJargon(text), text).toEqual([]);
      expect(c.title).toMatch(/^Nobody is named to look after .+, and \d+ things? rely on it$/);
      expect(c.why).toContain("no one is named as looking after it");
      expect(c.suggestedAction).toMatchObject({ kind: "github_issue", payload: { target: "Your records", targetId: c.evidence[0] } });
      expect(c.suggestedAction!.payload.body).toContain("- [ ] Pick one person or team to look after it.");
      expect(c.suggestedAction!.payload.body).toContain(`Evidence: ${c.evidence[0]}`);
      expect(c.why).not.toMatch(/\b(dependenc|node|edge|graph|system)\b/i);
    }
    expect(pay!.title).toBe("Nobody is named to look after Payment gateway, and 12 things rely on it");
    expect(pay!.why).toMatch(/^12 things rely on Payment gateway \(11 directly, the rest through something else\), such as /);
    // it ties with five other tools that nothing relies on through another tool, so no place is claimed in words
    expect(pay!.why).toMatch(/and no one is named as looking after it\.$/);
  });

  it("raises nothing on a business with no dependencies recorded, and honours the threshold", async () => {
    expect(await run({ unownedMin: 50 })).toEqual([]);
    const empty = await testGraph();
    try {
      await upsertNode(empty.g, { type: "Business", id: "business:bare", name: "Bare Studio" }, NOW);
      const r = await runDetectors(empty.g, { now: NOW, only: ["tech.unowned_critical_system"] });
      expect(r).toEqual({ candidates: [], ran: ["tech.unowned_critical_system"], errors: [] });
    } finally {
      await empty.cleanup();
    }
  });

  it("becomes a Recommendation by Techie in the tech area, with evidence edges to what relies on the tool", async () => {
    await upsertNode(g, { type: "Agent", id: "agent:allevia-tech-lead", name: "Techie", props: { rosterId: "tech-lead" } }, NOW);
    const r = await runInsights("shopfront", { graph: g, now: NOW, only: ["tech.unowned_critical_system"] });
    expect(r.errors).toEqual([]);
    const rec = r.recommendations.find((x) => x.key === "tech.unowned_critical_system:system:payments")!;
    expect(rec).toMatchObject({ area: "tech", by: "tech-lead", created: true });
    expect(rec.approvalId).toBeDefined();
    const rows = await g.roQuery<{ id: string }>(
      "MATCH (:Recommendation {id:$id})-[e:EVIDENCED_BY]->(x:Entity) WHERE e.until IS NULL RETURN x.id AS id ORDER BY x.id", { id: rec.id });
    expect(rows.map((x) => x.id)).toContain("system:payments");
    expect(rows.map((x) => x.id)).toContain("feature:checkout");
    expect(rows.length).toBe(9);
    const [card] = await g.roQuery<{ kind: string; status: string; title: string }>("MATCH (a:Approval {id:$id}) RETURN a.kind AS kind, a.status AS status, a.title AS title", { id: rec.approvalId });
    expect(card).toEqual({ kind: "github_issue", status: "pending", title: "Name who looks after Payment gateway" });
  });
});

describe("when the tools lean on each other", () => {
  let h: GraphHandle;
  let done: () => Promise<void>;
  beforeAll(async () => {
    ({ g: h, cleanup: done } = await whenFree(async () => {
      const t = await testGraph();
      try {
        const at = NOW - 5 * 86_400_000;
        for (const [id, name, simulated] of [["db", "Main database", false], ["api", "Shop API", false], ["search", "Search service", false], ["queue", "Job queue", false], ["sample", "Sample tool", true]] as const) {
          await upsertNode(t.g, { type: "System", id: `system:${id}`, name, ...(simulated ? { simulated: true } : {}) }, at);
        }
        await upsertNode(t.g, { type: "Person", id: "person:dev", name: "Dev" }, at);
        await upsertEdge(t.g, { from: "person:dev", type: "OWNS", to: "system:api" }, at);
        for (const from of ["api", "search"]) await upsertEdge(t.g, { from: `system:${from}`, type: "DEPENDS_ON", to: "system:db" }, at);
        for (const f of ["a", "b", "c"]) {
          await upsertNode(t.g, { type: "Feature", id: `feature:${f}`, name: `Feature ${f.toUpperCase()}` }, at);
          for (const to of ["api", "queue", "sample"]) await upsertEdge(t.g, { from: `feature:${f}`, type: "DEPENDS_ON", to: `system:${to}` }, at);
        }
      } catch (e) { await t.cleanup().catch(() => undefined); throw e; }
      return t;
    }));
  }, 60_000);
  afterAll(async () => { await done?.(); });

  it("a tool the other tools lean on ranks first, and says so when it stands alone", async () => {
    const out = await DETECTORS["tech.unowned_critical_system"].run(h, { now: NOW });
    expect(out.map((c) => c.key)).toEqual(["tech.unowned_critical_system:system:db", "tech.unowned_critical_system:system:queue", "tech.unowned_critical_system:system:sample"]);
    // the database: the API and the search service rely on it, and the three features through the API
    expect(out[0]!.numbers).toEqual({ things_relying_on_it: 5, relying_directly: 2, rank_among_tools: 1, tools_ranked: 5 });
    expect(out[0]!.why).toBe("5 things rely on Main database (2 directly, the rest through something else), such as Shop API, Search service and Feature A, and no one is named as looking after it. It is the most leaned on of your 5 tools and services.");
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    // the queue: three features, tied with the tools nothing else relies on: no place claimed
    expect(out[1]!.numbers).toMatchObject({ things_relying_on_it: 3, relying_directly: 3 });
    expect(out[1]!.why).toBe("3 things rely on Job queue, such as Feature A, Feature B and Feature C, and no one is named as looking after it.");
    // owned by someone: the API is not flagged however much leans on it
    expect(out.map((c) => c.key)).not.toContain("tech.unowned_critical_system:system:api");
  });

  it("a tool that is itself sample data is marked as sample", async () => {
    const out = await DETECTORS["tech.unowned_critical_system"].run(h, { now: NOW });
    expect(out.map((c) => [c.key.split(":").pop(), c.simulated ?? false])).toEqual([["db", false], ["queue", false], ["sample", true]]);
  });

  it("without a way to run PageRank (a read-only handle) the count orders them, and no place is given", async () => {
    const out = await DETECTORS["tech.unowned_critical_system"].run({ roQuery: h.roQuery.bind(h) }, { now: NOW });
    expect(out.map((c) => c.key.split(":").pop())).toEqual(["db", "queue", "sample"]);
    for (const c of out) expect(c.numbers.rank_among_tools).toBeUndefined();
  });
});

describe("the words", () => {
  it("counts in ordinals", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });

  it("leaves out where it stands when it has no ranking, and says 'the most leaned on' for the first", () => {
    const base = { id: "system:x", name: "The thing", relying: 4, directly: 4, names: [{ name: "A", hops: 1 }, { name: "B", hops: 1 }, { name: "C", hops: 1 }, { name: "D", hops: 1 }] };
    expect(unownedSystemText(base).why).toBe("4 things rely on The thing, such as A, B and C, and no one is named as looking after it.");
    expect(unownedSystemText({ ...base, rank: 1, of: 9 }).why).toContain("It is the most leaned on of your 9 tools and services.");
    expect(unownedSystemText({ ...base, rank: 2, of: 9 }).why).toContain("It is the 2nd most leaned on of your 9 tools and services.");
    expect(unownedSystemText({ ...base, relying: 1, directly: 1, names: [{ name: "A", hops: 1 }] }).title).toBe("Nobody is named to look after The thing, and 1 thing relies on it");
  });
});
