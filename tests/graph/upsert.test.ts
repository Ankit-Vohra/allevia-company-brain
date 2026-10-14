import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import {
  upsertNode, upsertEdge, closeEdge, addObservation, writeBatch, MissingEndpoint, DisallowedRelationship, InvalidWrite,
} from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;

describe("temporal upsert (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Person", id: "person:founder", name: "Founder" }, T0);
    await upsertNode(g, { type: "Agent", id: "agent:jarvis", name: "Jarvis" }, T0);
    await upsertNode(g, { type: "Document", id: "document:pending", name: "PENDING.md", props: { kind: "vault" } }, T0);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const count = async (cypher: string, params?: Record<string, unknown>) =>
    (await g.roQuery<{ c: number }>(cypher, params))[0]!.c;

  it("1. upserting the same node twice makes one node, created only the first time, no Version", async () => {
    const n = { type: "Task" as const, id: "task:sitemap", name: "Fix sitemap", props: { status: "open", title: "Fix sitemap" }, src: "document:pending", asOf: "2026-10-14" };
    expect(await upsertNode(g, n, T0)).toEqual({ created: true, versioned: false, updated: false });
    expect(await upsertNode(g, n, T0 + 10)).toEqual({ created: false, versioned: false, updated: false });
    expect(await count("MATCH (n:Entity {id:'task:sitemap'}) RETURN count(n) AS c")).toBe(1);
    expect(await count("MATCH (:Entity {id:'task:sitemap'})-[:HAD_VERSION]->(v) RETURN count(v) AS c")).toBe(0);
    const [row] = await g.roQuery<Record<string, unknown>>("MATCH (n:Entity:Task {id:'task:sitemap'}) RETURN n.createdAt AS c, n.updatedAt AS u, n.src AS src, n.asOf AS asOf, n.status AS status");
    expect(row).toEqual({ c: T0, u: T0, src: "document:pending", asOf: "2026-10-14", status: "open" });
  });

  it("2. a tracked prop change writes a Version with the old props and updates the node", async () => {
    const r = await upsertNode(g, { type: "Task", id: "task:sitemap", name: "Fix sitemap", props: { status: "done" }, src: "document:pending", asOf: "2026-10-15" }, T0 + 100);
    expect(r).toEqual({ created: false, versioned: true, updated: true });
    const [v] = await g.roQuery<{ props: string; since: number; until: number; labels: string[]; of: string }>(
      "MATCH (:Entity {id:'task:sitemap'})-[:HAD_VERSION]->(v) RETURN v.props AS props, v.since AS since, v.until AS until, labels(v) AS labels, v.of AS of");
    expect(v!.labels).toEqual(expect.arrayContaining(["Entity", "Version"]));
    expect(v!.of).toBe("task:sitemap");
    expect(v!.since).toBe(T0);
    expect(v!.until).toBe(T0 + 100);
    expect(JSON.parse(v!.props)).toMatchObject({ status: "open", title: "Fix sitemap", asOf: "2026-10-14" });
    const [cur] = await g.roQuery<Record<string, unknown>>("MATCH (n:Entity {id:'task:sitemap'}) RETURN n.status AS status, n.updatedAt AS u, n.asOf AS asOf");
    expect(cur).toEqual({ status: "done", u: T0 + 100, asOf: "2026-10-15" });
    // a second change: the new Version's since is when the previous state began
    await upsertNode(g, { type: "Task", id: "task:sitemap", name: "Fix sitemap", props: { status: "reopened" } }, T0 + 200);
    const vs = await g.roQuery<{ since: number; until: number }>("MATCH (:Entity {id:'task:sitemap'})-[:HAD_VERSION]->(v) RETURN v.since AS since, v.until AS until ORDER BY v.until");
    expect(vs).toEqual([{ since: T0, until: T0 + 100 }, { since: T0 + 100, until: T0 + 200 }]);
  });

  it("2b. an untracked change updates in place without a Version; a first-time tracked value is not a change", async () => {
    await upsertNode(g, { type: "Task", id: "task:untracked", name: "X" }, T0);
    expect(await upsertNode(g, { type: "Task", id: "task:untracked", name: "X", summary: "new summary", props: { status: "open" } }, T0 + 5))
      .toEqual({ created: false, versioned: false, updated: true });
    expect(await count("MATCH (:Entity {id:'task:untracked'})-[:HAD_VERSION]->(v) RETURN count(v) AS c")).toBe(0);
  });

  it("3. upserting the same edge twice leaves exactly one current edge", async () => {
    await upsertNode(g, { type: "System", id: "system:gsc", name: "Search Console" }, T0);
    await upsertNode(g, { type: "System", id: "system:ops-mcp", name: "Ops MCP" }, T0);
    const e = { from: "system:gsc", type: "DEPENDS_ON" as const, to: "system:ops-mcp", src: "document:pending", asOf: "2026-10-14", conf: 0.9, props: { note: "pull" } };
    expect(await upsertEdge(g, e, T0)).toEqual({ created: true, closed: 0 });
    expect(await upsertEdge(g, { ...e, conf: 0.95 }, T0 + 50)).toEqual({ created: false, closed: 0 });
    const rows = await g.roQuery<Record<string, unknown>>(
      "MATCH (:Entity {id:'system:gsc'})-[r:DEPENDS_ON]->(:Entity {id:'system:ops-mcp'}) RETURN r.since AS since, r.until AS until, r.recordedAt AS rec, r.src AS src, r.asOf AS asOf, r.conf AS conf, r.note AS note");
    expect(rows).toEqual([{ since: T0, until: null, rec: T0, src: "document:pending", asOf: "2026-10-14", conf: 0.95, note: "pull" }]);
  });

  it("4. a functional edge with a new target closes the old one and keeps both", async () => {
    expect(await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:sitemap" }, T0)).toEqual({ created: true, closed: 0 });
    expect(await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "task:sitemap" }, T0 + 300)).toEqual({ created: true, closed: 1 });
    const rows = await g.roQuery<{ owner: string; until: number | null; retiredAt: number | null }>(
      "MATCH (o)-[r:OWNS]->(:Entity {id:'task:sitemap'}) RETURN o.id AS owner, r.until AS until, r.retiredAt AS retiredAt ORDER BY r.recordedAt");
    expect(rows).toEqual([
      { owner: "person:founder", until: T0 + 300, retiredAt: T0 + 300 },
      { owner: "agent:jarvis", until: null, retiredAt: null },
    ]);
    // OWNS is not functional for non-Task targets: two current owners of a System is fine
    await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "system:gsc" }, T0);
    expect(await upsertEdge(g, { from: "agent:jarvis", type: "OWNS", to: "system:gsc" }, T0)).toEqual({ created: true, closed: 0 });
  });

  it("4b. SUPERSEDES is functional on the target; functional:true makes the source the slot", async () => {
    for (const d of ["decision:d1", "decision:d2", "decision:d3"]) await upsertNode(g, { type: "Decision", id: d, name: d }, T0);
    await upsertEdge(g, { from: "decision:d2", type: "SUPERSEDES", to: "decision:d1" }, T0);
    expect((await upsertEdge(g, { from: "decision:d3", type: "SUPERSEDES", to: "decision:d1" }, T0 + 1)).closed).toBe(1);
    await upsertNode(g, { type: "Channel", id: "channel:instagram", name: "Instagram" }, T0);
    await upsertEdge(g, { from: "channel:instagram", type: "DEPENDS_ON", to: "system:gsc", functional: true }, T0);
    expect((await upsertEdge(g, { from: "channel:instagram", type: "DEPENDS_ON", to: "system:ops-mcp", functional: true }, T0 + 1)).closed).toBe(1);
    expect(await count("MATCH (:Entity {id:'channel:instagram'})-[r:DEPENDS_ON]->() WHERE r.until IS NULL RETURN count(r) AS c")).toBe(1);
  });

  it("5. closeEdge sets until and retiredAt and never deletes", async () => {
    await upsertEdge(g, { from: "person:founder", type: "KNOWS_ABOUT", to: "system:gsc", props: { weight: 3 } }, T0);
    const before = await count("MATCH ()-[r]->() RETURN count(r) AS c");
    expect(await closeEdge(g, "person:founder", "KNOWS_ABOUT", "system:gsc", T0 + 400, "left the project")).toBe(1);
    expect(await closeEdge(g, "person:founder", "KNOWS_ABOUT", "system:gsc", T0 + 500)).toBe(0);
    expect(await count("MATCH ()-[r]->() RETURN count(r) AS c")).toBe(before);
    const [r] = await g.roQuery<Record<string, unknown>>(
      "MATCH (:Entity {id:'person:founder'})-[r:KNOWS_ABOUT]->(:Entity {id:'system:gsc'}) RETURN r.until AS until, r.retiredAt AS ret, r.closeReason AS why, r.weight AS w");
    expect(r).toEqual({ until: T0 + 400, ret: T0 + 400, why: "left the project", w: 3 });
    // re-asserting a closed fact opens a new current edge; history stays
    expect((await upsertEdge(g, { from: "person:founder", type: "KNOWS_ABOUT", to: "system:gsc" }, T0 + 600)).created).toBe(true);
    expect(await count("MATCH (:Entity {id:'person:founder'})-[r:KNOWS_ABOUT]->(:Entity {id:'system:gsc'}) RETURN count(r) AS c")).toBe(2);
  });

  it("6. a missing endpoint throws MissingEndpoint", async () => {
    const p = upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:nope" });
    await expect(p).rejects.toBeInstanceOf(MissingEndpoint);
    await expect(upsertEdge(g, { from: "person:ghost", type: "OWNS", to: "task:nope" })).rejects.toThrow(/person:ghost.*task:nope/);
  });

  it("7. a disallowed pattern throws DisallowedRelationship", async () => {
    await upsertNode(g, { type: "Page", id: "page:www.aamdani.ai/jobs", name: "Jobs" }, T0);
    await expect(upsertEdge(g, { from: "page:www.aamdani.ai/jobs", type: "DECIDED", to: "person:founder" }))
      .rejects.toBeInstanceOf(DisallowedRelationship);
    await expect(upsertEdge(g, { from: "person:founder", type: "NOT_A_REL" as never, to: "task:sitemap" })).rejects.toBeInstanceOf(InvalidWrite);
  });

  it("validates node input", async () => {
    await expect(upsertNode(g, { type: "Decision", id: "task:sitemap", name: "wrong type" })).rejects.toThrow(/Task/);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", props: { "bad-key": 1 } })).rejects.toBeInstanceOf(InvalidWrite);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", props: { createdAt: 1 } })).rejects.toThrow(/reserved/);
    await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "x", embedding: [1, 2, 3] })).rejects.toThrow(/384/);
    await expect(upsertNode(g, { type: "Nope" as never, id: "x:y", name: "x" })).rejects.toBeInstanceOf(InvalidWrite);
    await expect(upsertEdge(g, { from: "task:sitemap", type: "BLOCKS", to: "task:sitemap" })).rejects.toThrow(/itself/);
  });

  it("stores an Observation with MEASURES, SOURCED_FROM and versioned corrections", async () => {
    await upsertNode(g, { type: "Document", id: "document:snapshot-2026-10-14", name: "ops snapshot" }, T0);
    const o = { subject: "channel:instagram", metric: "followers", value: 1200, unit: "count", windowEnd: "2026-10-14", asOf: "2026-10-14", src: "document:snapshot-2026-10-14" };
    const id = await addObservation(g, o, T0);
    expect(id).toBe("obs:followers:channel:instagram:2026-10-14");
    expect(await addObservation(g, o, T0 + 1)).toBe(id);
    const rows = await g.roQuery<Record<string, unknown>>(
      "MATCH (o:Entity:Observation {id:$id})-[:MEASURES]->(s) OPTIONAL MATCH (o)-[:SOURCED_FROM]->(d) RETURN s.id AS s, d.id AS d, o.value AS v, o.metric AS m, o.unit AS u", { id });
    expect(rows).toEqual([{ s: "channel:instagram", d: "document:snapshot-2026-10-14", v: 1200, m: "followers", u: "count" }]);
    await addObservation(g, { ...o, value: 1250 }, T0 + 2);
    const [v] = await g.roQuery<{ props: string }>("MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN v.props AS props", { id });
    expect(JSON.parse(v!.props).value).toBe(1200);
    expect(await count("MATCH (o:Entity {id:$id}) WHERE o.value = 1250 RETURN count(o) AS c", { id })).toBe(1);
  });

  it("keeps an Observation whose source document is not ingested yet, and passes simulated through", async () => {
    const id = await addObservation(g, { subject: "channel:instagram", metric: "ad_spend", value: 500.5, asOf: "2026-10-13", src: "document:later", simulated: true }, T0);
    expect(id).toBe("obs:ad_spend:channel:instagram:2026-10-13");
    const [r] = await g.roQuery<Record<string, unknown>>(
      "MATCH (o:Entity {id:$id}) OPTIONAL MATCH (o)-[s:SOURCED_FROM]->() RETURN o.src AS src, o.simulated AS sim, count(s) AS links", { id });
    expect(r).toEqual({ src: "document:later", sim: true, links: 0 });
    await expect(addObservation(g, { subject: "channel:none", metric: "x", value: 1, asOf: "2026-10-13", src: "document:later" })).rejects.toBeInstanceOf(MissingEndpoint);
  });

  it("writeBatch writes nodes, then edges, then observations and collects per-item errors", async () => {
    const stats = await writeBatch(g, {
      nodes: [
        { type: "Product", id: "product:app", name: "Aamdani app" },
        { type: "Feature", id: "feature:jobs", name: "Jobs" },
        { type: "Task", id: "task:sitemap", name: "Fix sitemap", props: { status: "blocked" } },
        { type: "Task", id: "task:bad", name: "bad", props: { "x-y": 1 } },
      ],
      edges: [
        { from: "feature:jobs", type: "PART_OF", to: "product:app" },
        { from: "feature:jobs", type: "PART_OF", to: "product:missing" },
        { from: "person:founder", type: "OWNS", to: "task:sitemap" },
      ],
      observations: [{ subject: "feature:jobs", metric: "signups", value: 42, asOf: "2026-10-14", src: "document:pending" }],
    }, T0 + 1000);
    expect(stats).toMatchObject({ nodesCreated: 2, nodesUpdated: 1, versions: 1, edgesCreated: 2, edgesClosed: 1, observations: 1 });
    expect(stats.errors.map((e) => e.kind)).toEqual(["node", "edge"]);
    expect(stats.errors[1]!.error).toMatch(/product:missing/);
  });
});
