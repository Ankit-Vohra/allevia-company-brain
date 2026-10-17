// graph:hygiene (src/graph/hygiene.ts): a read-only report. Each count on a small graph built for it: business knowledge apart
// from the copied general know-how and stubs, old closed facts and versions, chunks of superseded documents, old readings, and
// cold things (old, at most one link, low PageRank), with the graph unchanged afterwards.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { addObservation, closeEdge, upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { formatHygiene, graphHygiene } from "../../src/graph/hygiene.js";
import { referenceNode, refStubNode } from "../../src/ingest/sources/reference.js";
import { ruleId } from "../../src/ingest/sources/playbook-data.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const OLD = NOW - 400 * 86_400_000;
const AS = { src: "document:seed", asOf: "2026-10-01" };
const LONG_AGO = { src: "document:seed", asOf: "2025-08-01" };

describe("graph:hygiene (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: "business:cafe", name: "Cafe", ...AS }, OLD);
    // general know-how: one copied rule, one stub
    await upsertNode(g, referenceNode(ruleId("hook", "Cost Confession"))!, NOW);
    await upsertNode(g, refStubNode(ruleId("seo-check", "missing-title"))!, NOW);
    // cold: old, no link; not cold: old but linked twice, or recent
    await upsertNode(g, { type: "Task", id: "task:forgotten", name: "Forgotten task", ...AS }, OLD);
    await upsertNode(g, { type: "Task", id: "task:linked", name: "Linked task", ...AS }, OLD);
    await upsertNode(g, { type: "Task", id: "task:fresh", name: "Fresh task", ...AS }, NOW);
    await upsertEdge(g, { from: "business:cafe", type: "OWNS", to: "task:linked", ...AS }, OLD);
    await upsertEdge(g, { from: "task:linked", type: "DEPENDS_ON", to: "task:fresh", ...AS }, OLD);
    // a closed fact from long ago, and an old Version (a status that changed long ago)
    await upsertEdge(g, { from: "business:cafe", type: "OWNS", to: "task:fresh", ...LONG_AGO }, OLD);
    await closeEdge(g, "business:cafe", "OWNS", "task:fresh", OLD + 86_400_000, "done");
    await upsertNode(g, { type: "Task", id: "task:shipped", name: "Shipped task", props: { status: "open" }, ...LONG_AGO }, OLD);
    await upsertNode(g, { type: "Task", id: "task:shipped", name: "Shipped task", props: { status: "done" }, src: "document:seed", asOf: "2025-08-20" }, OLD + 1000);
    await upsertEdge(g, { from: "business:cafe", type: "OWNS", to: "task:shipped", ...AS }, NOW);
    await upsertEdge(g, { from: "task:shipped", type: "DEPENDS_ON", to: "task:linked", ...AS }, NOW);
    // documents: v2 supersedes v1 (v1's passage), and a passage its document no longer holds
    await upsertNode(g, { type: "Document", id: "document:menu-v1", name: "Menu v1", ...AS }, NOW);
    await upsertNode(g, { type: "Document", id: "document:menu-v2", name: "Menu v2", ...AS }, NOW);
    await upsertNode(g, { type: "Chunk", id: "chunk:menu-v1-0", name: "Menu v1, part 1", ...AS }, NOW);
    await upsertNode(g, { type: "Chunk", id: "chunk:menu-v2-0", name: "Menu v2, part 1", ...AS }, NOW);
    await upsertNode(g, { type: "Chunk", id: "chunk:menu-v2-old", name: "Menu v2, an older part", ...AS }, NOW);
    await upsertEdge(g, { from: "document:menu-v1", type: "HAS_CHUNK", to: "chunk:menu-v1-0", ...AS }, NOW);
    await upsertEdge(g, { from: "document:menu-v2", type: "HAS_CHUNK", to: "chunk:menu-v2-0", ...AS }, NOW);
    await upsertEdge(g, { from: "document:menu-v2", type: "HAS_CHUNK", to: "chunk:menu-v2-old", ...AS }, NOW);
    await closeEdge(g, "document:menu-v2", "HAS_CHUNK", "chunk:menu-v2-old", NOW);
    await upsertEdge(g, { from: "document:menu-v2", type: "SUPERSEDES", to: "document:menu-v1", ...AS }, NOW);
    // readings: one old, one recent
    await addObservation(g, { subject: "business:cafe", metric: "visits", value: 10, asOf: "2026-01-05", src: "document:seed" }, NOW);
    await addObservation(g, { subject: "business:cafe", metric: "visits", value: 12, asOf: "2026-10-10", src: "document:seed" }, NOW);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("reports each count, and changes nothing", async () => {
    const size = async () => (await g.roQuery<{ c: number }>("MATCH (n) OPTIONAL MATCH (n)-[r]->() RETURN count(DISTINCT n) + count(r) AS c"))[0]!.c;
    const before = await size();
    const r = await graphHygiene(g, NOW);
    expect(await size()).toBe(before);
    expect(r.business).toMatchObject({ Business: 1, Task: 4, Document: 2, Chunk: 3, Observation: 2 });
    expect(r.business.Rule).toBeUndefined();
    expect(r.general).toEqual({ Rule: 1 });
    expect(r.stubs).toBe(1);
    expect(r.edges.closedOld).toBe(1);
    expect(r.edges.closed).toBeGreaterThanOrEqual(2); // the old OWNS and the closed HAS_CHUNK
    expect(r.versions).toMatchObject({ total: 1, old: 1 });
    expect(r.chunks).toEqual({ total: 3, superseded: 1, unheld: 1 });
    expect(r.readings).toEqual({ total: 2, old: 1 });
    expect(r.cold.rankStored).toBe(false);
    expect(r.cold.examples.map((e) => e.id)).toEqual(["task:forgotten"]);
    expect(r.cold.count).toBe(1);
    expect(formatHygiene("cafe", r)).toMatch(/cold things .*: 1\n {4}task:forgotten \(Task\) "Forgotten task": 0 links, last touched 2025-/);
  });

  it("with PageRank stored, a well-ranked old thing is not cold", async () => {
    await g.query("MATCH (n:Entity {id:'business:cafe'}) SET n.rank = 1.0");
    await g.query("MATCH (n:Entity {id:'task:forgotten'}) SET n.rank = 0.5");
    const r = await graphHygiene(g, NOW);
    expect(r.cold.rankStored).toBe(true);
    expect(r.cold.count).toBe(0);
  });
});
