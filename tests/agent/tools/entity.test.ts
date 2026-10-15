import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { getEntity, history, neighbors } from "../../../src/agent/tools/entity.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("get_entity, neighbors, history (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("get_entity: props, current neighbours by relationship, versions, sources", async () => {
    const r = await call(getEntity, { id: "task:fix-ig-token" }, makeCtx(g));
    expect(r.data).toMatchObject({ id: "task:fix-ig-token", type: "Task", name: "Fix Instagram token refresh", versions: 1 });
    expect(r.data.props).toMatchObject({ status: "in_progress", src: "document:pending" });
    expect(r.data.props).not.toHaveProperty("embedding");
    expect(r.data.neighbors["in:OWNS"]).toEqual({ count: 1, items: [{ id: "person:priya", type: "Person", name: "Priya" }] });
    expect(r.data.neighbors["out:BLOCKS"].items.map((i: { id: string }) => i.id)).toEqual(["task:schedule-reels"]);
    expect(ids(r.nodes)).toEqual(expect.arrayContaining(["task:fix-ig-token", "person:priya", "task:schedule-reels"]));
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "person:priya", type: "OWNS", to: "task:fix-ig-token", until: null })]));
    expect(ids(r.sources)).toContain("document:pending");
  });

  it("get_entity asOf: an owner closed before the date is hidden and old props come from the Version", async () => {
    const then = await call(getEntity, { id: "task:fix-ig-token", asOf: "2026-10-01" }, makeCtx(g));
    expect(then.data.neighbors["in:OWNS"].items.map((i: { id: string }) => i.id)).toEqual(["person:founder"]);
    expect(then.data.props.status).toBe("open");
    expect(then.note).toMatch(/as they were/);
    const later = await call(getEntity, { id: "task:fix-ig-token", asOf: "2026-10-10" }, makeCtx(g));
    expect(later.data.neighbors["in:OWNS"].items.map((i: { id: string }) => i.id)).toEqual(["person:priya"]);
    const before = await call(getEntity, { id: "system:ig-connector", asOf: "2026-08-15" }, makeCtx(g));
    expect(before.data.neighbors["in:DEPENDS_ON"].items.map((i: { id: string }) => i.id)).toContain("system:legacy-poster");
    const now = await call(getEntity, { id: "system:ig-connector" }, makeCtx(g));
    expect(now.data.neighbors["in:DEPENDS_ON"].items.map((i: { id: string }) => i.id)).not.toContain("system:legacy-poster");
  });

  it("get_entity: latest observation per metric, bookkeeping neighbours counted not listed", async () => {
    const r = await call(getEntity, { id: "channel:instagram" }, makeCtx(g));
    const byMetric = Object.fromEntries(r.data.observations.map((o: { metric: string; value: number }) => [o.metric, o.value]));
    expect(byMetric).toEqual({ followers: 1400, signups_from_reels: 55 });
    expect(r.data.hiddenNeighbors).toMatchObject({ Observation: 6 });
    expect(Object.keys(r.data.neighbors)).not.toContain("in:TOUCHED");
    expect(r.data.neighbors["in:KNOWS_ABOUT"].count).toBe(2);
    expect(ids(r.nodes)).toContain("obs:followers:channel:instagram:2026-10-05");
    expect(ids(r.sources)).toContain("document:ig-insights-oct");
  });

  it("get_entity: an unknown id comes back as an error with suggestions", async () => {
    const r = await call(getEntity, { id: "decision:pause-stories" }, makeCtx(g));
    expect(r.data.error).toMatch(/I don.t have "decision:pause-stories" in your records/);
    expect(r.data.suggestions.map((s: { id: string }) => s.id)).toContain("decision:007-pause-daily-stories");
    expect(r.nodes).toEqual([]);
  });

  it("neighbors: typed two-hop expansion over current edges only", async () => {
    const r = await call(neighbors, { id: "system:ig-connector", rels: ["DEPENDS_ON"], direction: "in", depth: 2 }, makeCtx(g));
    expect(r.data.neighbors.map((n: { id: string; hop: number }) => [n.id, n.hop])).toEqual([
      ["channel:instagram", 1], ["system:reel-publisher", 1], ["system:reel-scheduler", 2],
    ]);
    expect(r.data.neighbors[2]).toMatchObject({ rel: "DEPENDS_ON", dir: "in", via: ["system:reel-publisher"] });
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "system:reel-scheduler", type: "DEPENDS_ON", to: "system:reel-publisher" })]));
    expect(ids(r.sources)).toContain("document:systems-notes");
    const capped = await call(neighbors, { id: "channel:instagram", limit: 2 }, makeCtx(g));
    expect(capped.data.neighbors).toHaveLength(2);
    expect(capped.note).toMatch(/Showing 2 of/);
  });

  it("neighbors: turns and observations stay out by default", async () => {
    const r = await call(neighbors, { id: "decision:007-pause-daily-stories" }, makeCtx(g));
    const got = r.data.neighbors.map((n: { id: string }) => n.id);
    expect(got).toEqual(expect.arrayContaining(["person:founder", "channel:instagram", "decision:003-daily-stories", "document:adr-007"]));
    expect(got).not.toContain("turn:t-001");
    expect(got.some((x: string) => x.startsWith("obs:"))).toBe(false);
  });

  it("history: versions and a reassigned owner, oldest first", async () => {
    const r = await call(history, { id: "task:fix-ig-token" }, makeCtx(g));
    const evs = r.data.events.map((e: { event: string; rel?: string; other?: { id: string } }) => [e.event, e.rel ?? "", e.other?.id ?? ""]);
    expect(evs).toEqual([
      ["created", "", ""],
      ["linked", "OWNS", "person:founder"],
      ["unlinked", "OWNS", "person:founder"],
      ["linked", "OWNS", "person:priya"],
      ["changed", "", ""],
    ]);
    // A change is dated by its source, not by when it was written: the in_progress state was written on 6 Oct from
    // PENDING.md as of 12 Oct, so the status changed on 12 Oct (and still sorts after the 5 Oct hand-over).
    const changed = r.data.events.find((e: { event: string }) => e.event === "changed");
    expect(changed).toMatchObject({ at: "2026-10-12T00:00:00.000Z", changed: ["status"], before: { status: "open" }, after: { status: "in_progress" } });
    expect(r.data.events[2].at).toBe("2026-10-05T00:00:00.000Z");
    expect(r.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "person:founder", type: "OWNS", until: Date.parse("2026-10-05") })]));
    expect(r.nodes.some((n: { label: string }) => n.label === "Version")).toBe(true);
  });

  describe("a busy entity (hundreds of neighbours and observations)", () => {
    beforeAll(async () => {
      await g.query("CREATE (:Entity:System {id:'system:hub', name:'Hub', createdAt: 0})");
      await g.query(`MATCH (h:Entity {id:'system:hub'}) UNWIND range(1, 320) AS i
        CREATE (:Entity:Document {id:'document:bulk-'+toString(i), name:'Bulk '+toString(i)})-[:MENTIONS {since: 0}]->(h)`);
      await g.query(`MATCH (h:Entity {id:'system:hub'}) UNWIND range(1, 60) AS i
        CREATE (:Entity:Document {id:'document:old-'+toString(i), name:'Old '+toString(i)})-[:MENTIONS {since: i * 1000, until: i * 1000 + 500}]->(h)`);
      await g.query("MATCH (h:Entity {id:'system:hub'}), (t:Entity {id:'team:tech'}) CREATE (t)-[:OWNS {since: 0}]->(h)");
      const day = (i: number) => new Date(Date.UTC(2026, 3, 1) + i * 86_400_000).toISOString().slice(0, 10);
      const rows = Array.from({ length: 210 }, (_, i) => ({ id: `obs:sessions:system:hub:${day(i)}`, at: day(i), v: i }));
      await g.query(`MATCH (h:Entity {id:'system:hub'}) UNWIND $rows AS r
        CREATE (:Entity:Observation {id: r.id, name: r.id, metric: 'sessions', metricKey: 'sessions', subject: 'system:hub', value: r.v, windowEnd: r.at, asOf: r.at})-[:MEASURES {since: 0}]->(h)`, { rows });
      await g.query(`MATCH (h:Entity {id:'system:hub'})
        CREATE (:Entity:Observation {id: 'obs:uptime:system:hub:2025-01-01', name: 'uptime', metric: 'uptime', metricKey: 'uptime', subject: 'system:hub', value: 99.9, asOf: '2025-01-01'})-[:MEASURES {since: 0}]->(h)`);
    });

    it("get_entity: every relationship group counted in full, each listed briefly; every metric's latest number", async () => {
      const r = await call(getEntity, { id: "system:hub" }, makeCtx(g));
      expect(r.data.neighbors["in:MENTIONS"].count).toBe(320);
      expect(r.data.neighbors["in:MENTIONS"].items).toHaveLength(10);
      expect(r.data.neighbors["in:OWNS"]).toEqual({ count: 1, items: [{ id: "team:tech", type: "Team", name: "Tech team" }] });
      const byMetric = Object.fromEntries(r.data.observations.map((o: { metric: string; value: number }) => [o.metric, o.value]));
      expect(byMetric).toEqual({ sessions: 209, uptime: 99.9 });
      expect(r.nodes.length).toBeLessThanOrEqual(100);
    });

    it("history: only the events shown bring their nodes and edges", async () => {
      const r = await call(history, { id: "system:hub" }, makeCtx(g));
      expect(r.data.events).toHaveLength(50);
      expect(r.note).toMatch(/latest 50 of/);
      expect(r.nodes.length).toBeLessThanOrEqual(51);
      const shown = new Set(r.data.events.map((e: { other?: { id: string } }) => e.other?.id).filter(Boolean));
      for (const n of r.nodes) if (n.id !== "system:hub") expect(shown.has(n.id), n.id).toBe(true);
    });
  });
});
