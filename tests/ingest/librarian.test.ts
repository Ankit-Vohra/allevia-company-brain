// The librarian (spec §6.6) on a small hand-built graph: KNOWS_ABOUT derived from authorship (MENTIONS and SOURCED_FROM of
// authored documents, weighted by commits and recency), DECIDED and OWNS; rank and community stored as node props;
// orphans reported; idempotent; edges it derived are closed when their support goes; edges it did not derive are left alone.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { closeEdge, writeBatch, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import { runLibrarian, knowsAboutWeight } from "../../src/ingest/librarian.js";
import { testGraph } from "../helpers/graph.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-15T00:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

const nodes: NodeInput[] = [
  { type: "Person", id: "person:founder", name: "Founder" },
  { type: "Agent", id: "agent:librarian", name: "librarian" },
  { type: "Agent", id: "agent:allevia-chief", name: "Chief of Staff" },
  { type: "Document", id: "document:d1", name: "Channels note" },
  { type: "Document", id: "document:d2", name: "Search note" },
  { type: "Document", id: "document:d3", name: "Nobody links here" },
  { type: "Chunk", id: "chunk:d1-0", name: "Channels note (1/1)", props: { text: "Instagram and search." } },
  { type: "Channel", id: "channel:instagram", name: "Instagram" },
  { type: "System", id: "system:gsc", name: "Google Search Console" },
  { type: "Feature", id: "feature:old", name: "Old feature" },
  { type: "Decision", id: "decision:x", name: "Reels first" },
  { type: "Task", id: "task:t1", name: "Plan reels" },
  { type: "System", id: "system:lonely", name: "Lonely tool" },
  { type: "Event", id: "event:ingest-run-1", name: "Ingest run", props: { kind: "ingest" } },
];

const authored = (from: string, to: string, commits: number, firstAt: number, lastAt: number): EdgeInput =>
  ({ from, type: "AUTHORED", to, since: firstAt, props: { commits, at: iso(lastAt), firstAt: iso(firstAt) } });

const edges: EdgeInput[] = [
  authored("person:founder", "document:d1", 3, NOW - 40 * DAY, NOW),
  authored("agent:librarian", "document:d1", 1, NOW - 30 * DAY, NOW - 30 * DAY),
  authored("agent:librarian", "document:d2", 1, NOW - 60 * DAY, NOW - 60 * DAY),
  authored("person:founder", "document:d3", 1, NOW - DAY, NOW - DAY),
  { from: "document:d1", type: "HAS_CHUNK", to: "chunk:d1-0" },
  { from: "document:d1", type: "MENTIONS", to: "channel:instagram" },
  { from: "document:d1", type: "MENTIONS", to: "system:gsc" },
  { from: "document:d2", type: "MENTIONS", to: "system:gsc" },
  { from: "document:d2", type: "MENTIONS", to: "feature:old" },
  { from: "document:d1", type: "LINKS_TO", to: "document:d2" },
  { from: "decision:x", type: "SOURCED_FROM", to: "document:d1" },
  { from: "person:founder", type: "DECIDED", to: "decision:x", since: NOW - 30 * DAY },
  { from: "person:founder", type: "OWNS", to: "task:t1", since: NOW },
  { from: "decision:x", type: "AFFECTS", to: "channel:instagram" },
];

describe("knowsAboutWeight", () => {
  it("halves every 30 days and never drops below a tenth", () => {
    expect(knowsAboutWeight(3, NOW, NOW)).toBe(3);
    expect(knowsAboutWeight(1, NOW - 30 * DAY, NOW)).toBeCloseTo(0.5, 9);
    expect(knowsAboutWeight(2, NOW - 3000 * DAY, NOW)).toBeCloseTo(0.2, 9);
    expect(knowsAboutWeight(1, NOW + DAY, NOW)).toBe(1); // a future date counts as now
  });
});

describe("runLibrarian (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    const s = await writeBatch(g, { nodes, edges }, NOW - 100 * DAY);
    expect(s.errors).toEqual([]);
    // what agent memory writes for Allevia's own staff: the librarian must not touch it
    await g.query("MATCH (a:Entity {id:'agent:allevia-chief'}), (x:Entity {id:'system:gsc'}) CREATE (a)-[:KNOWS_ABOUT {weight: 5, since: 1, recordedAt: 1}]->(x)");
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const knows = async () => Object.fromEntries((await g.roQuery<{ k: string; w: number; basis: string[]; docs: number }>(
    "MATCH (a)-[r:KNOWS_ABOUT]->(x) WHERE r.until IS NULL RETURN a.id + ' > ' + x.id AS k, r.weight AS w, r.basis AS basis, r.docs AS docs ORDER BY k"))
    .map((r) => [r.k, r]));

  it("derives KNOWS_ABOUT from authored documents, DECIDED and OWNS, weighted by commits and recency", async () => {
    const rep = await runLibrarian(g, { now: NOW });
    const k = await knows();
    expect(Object.keys(k)).toEqual([
      "agent:allevia-chief > system:gsc", // untouched
      "agent:librarian > channel:instagram", "agent:librarian > decision:x", "agent:librarian > feature:old", "agent:librarian > system:gsc",
      "person:founder > channel:instagram", "person:founder > decision:x", "person:founder > system:gsc", "person:founder > task:t1",
    ]);
    expect(k["person:founder > system:gsc"]!.w).toBe(3);
    expect(k["agent:librarian > system:gsc"]!.w).toBe(0.75); // 1 commit 30 days ago + 1 commit 60 days ago
    expect(k["agent:librarian > system:gsc"]!.docs).toBe(2);
    expect(k["person:founder > decision:x"]!.w).toBe(4);     // 3 (its source document) + DECIDED 30 days ago (2 x 0.5)
    expect(k["person:founder > decision:x"]!.basis).toEqual(["authored", "decided"]);
    expect(k["person:founder > task:t1"]).toMatchObject({ w: 1, basis: ["owns"] });
    expect(k["agent:allevia-chief > system:gsc"]!.w).toBe(5);
    expect(rep.knowsAbout).toMatchObject({ edges: 8, created: 8, closed: 0, actors: 2 });
  });

  it("stores rank and community on searchable nodes, not on chunks", async () => {
    const rows = await g.roQuery<{ id: string; rank: number | null; community: number | null }>(
      "MATCH (n:Entity) RETURN n.id AS id, n.rank AS rank, n.community AS community ORDER BY id");
    const by = new Map(rows.map((r) => [r.id, r]));
    expect(typeof by.get("system:gsc")!.rank).toBe("number");
    expect(by.get("system:gsc")!.rank!).toBeGreaterThan(by.get("system:lonely")!.rank!);
    expect(typeof by.get("document:d1")!.community).toBe("number");
    expect(typeof by.get("channel:instagram")!.community).toBe("number");
    expect(by.get("system:lonely")!.community).not.toBe(by.get("document:d1")!.community);
    expect(by.get("chunk:d1-0")!.rank).toBeNull();
  });

  it("reports orphans: knowledge nothing links to (authorship does not count), leaving out actors and its own ingest events", async () => {
    const rep = await runLibrarian(g, { now: NOW });
    expect(rep.orphans.sample).toEqual(["document:d3", "system:lonely"]);
    expect(rep.orphans).toMatchObject({ count: 2, byType: { Document: 1, System: 1 } });
  });

  it("is idempotent, and closes a derived edge whose support is gone", async () => {
    const again = await runLibrarian(g, { now: NOW });
    expect(again.knowsAbout).toMatchObject({ created: 0, closed: 0 });
    expect(await closeEdge(g, "document:d2", "MENTIONS", "feature:old", NOW)).toBe(1);
    const after = await runLibrarian(g, { now: NOW + 1000 });
    expect(after.knowsAbout).toMatchObject({ created: 0, closed: 1 });
    expect(Object.keys(await knows())).not.toContain("agent:librarian > feature:old");
    expect((await knows())["agent:allevia-chief > system:gsc"]!.w).toBe(5);
  });
});
