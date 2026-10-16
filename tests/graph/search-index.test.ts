// Full-text and vector search on the Searchable label (src/graph/indexes.ts): it returns what the Entity-wide index
// returned for the types search serves, and none of the per-reading names that crowd it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { LEGACY_ENTITY_INDEXES, dropLegacyEntityIndexes, ensureIndexes, listIndexes, VECTOR_DIM } from "../../src/graph/indexes.js";
import { SEARCHABLE } from "../../src/graph/schema.js";
import { addObservation, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const unit = (i: number) => Array.from({ length: VECTOR_DIM }, (_, j) => (j === i ? 1 : 0));

describe("search indexes on Searchable (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await ensureIndexes(g, LEGACY_ENTITY_INDEXES); // no longer part of the schema: made here to compare with them
    await upsertNode(g, { type: "Business", id: "business:aamdani", name: "Aamdani", summary: "jobs platform" });
    await upsertNode(g, { type: "Decision", id: "decision:pause-stories", name: "Pause Aamdani daily stories", summary: "output stayed poor", embedding: unit(1) });
    await upsertNode(g, { type: "Channel", id: "channel:instagram", name: "Instagram", summary: "Aamdani account" });
    await upsertNode(g, { type: "Page", id: "page:jobs", name: "Jobs page", summary: "listing of jobs" });
    await upsertNode(g, { type: "Turn", id: "turn:t1", name: "Why did we pause daily stories?" }); // search can be asked for a Turn by name
    // readings: one display name per reading, each containing the business name
    for (let d = 1; d <= 25; d++) {
      await addObservation(g, { subject: "business:aamdani", metric: "followers", value: d, asOf: `2026-09-${String(d).padStart(2, "0")}`, src: "document:snap" });
    }
    await upsertNode(g, { type: "Decision", id: "decision:pause-stories", name: "Pause Aamdani daily stories", summary: "output stayed poor" }); // a no-op update
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const ids = async (label: string, q: string): Promise<string[]> =>
    (await g.roQuery<{ id: string }>(`CALL db.idx.fulltext.queryNodes('${label}', $q) YIELD node RETURN node.id AS id ORDER BY id`, { q })).map((r) => r.id);

  it("labels the types search can be asked for, not readings, versions or chunks, on create and on update", async () => {
    const labelled = await g.roQuery<{ t: string; c: number }>(
      "MATCH (n:Searchable) WITH [l IN labels(n) WHERE NOT l IN ['Entity', 'Searchable']][0] AS t, count(n) AS c ORDER BY t RETURN t, c");
    expect(labelled).toEqual([{ t: "Business", c: 1 }, { t: "Channel", c: 1 }, { t: "Decision", c: 1 }, { t: "Page", c: 1 }, { t: "Turn", c: 1 }]);
    expect((await g.roQuery<{ c: number }>("MATCH (o:Observation) WHERE o:Searchable OR o:Version OR o:Chunk RETURN count(o) AS c"))[0]).toEqual({ c: 0 });
  });

  it("keeps the readings' names out of the index that entity search reads", async () => {
    const all = await ids("Entity", "Aamdani");
    expect(all.length).toBeGreaterThan(25); // the Entity index holds every reading's name
    expect(await ids("Searchable", "Aamdani")).toEqual(["business:aamdani", "channel:instagram", "decision:pause-stories"]);
  });

  it("returns what the Entity index returned once filtered to the searchable types: names, summaries, prefixes, alternatives", async () => {
    // the default types, and a bookkeeping type asked for by name (a Turn)
    for (const types of [SEARCHABLE, ["Turn"]]) {
      for (const q of ["Aamdani", "stories", "pause", "jobs", "poor", "inst*", "Aamdani|jobs", "followers", "account", "zzz"]) {
        const old = (await g.roQuery<{ id: string }>(
          "CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node WITH node WHERE any(l IN labels(node) WHERE l IN $types) AND NOT node:Chunk RETURN node.id AS id ORDER BY id",
          { q, types })).map((r) => r.id);
        const now = (await g.roQuery<{ id: string }>(
          "CALL db.idx.fulltext.queryNodes('Searchable', $q) YIELD node WITH node WHERE any(l IN labels(node) WHERE l IN $types) RETURN node.id AS id ORDER BY id",
          { q, types })).map((r) => r.id);
        expect(now, `query ${q} over ${types.length} types`).toEqual(old);
      }
    }
    expect((await g.roQuery<{ id: string }>("CALL db.idx.fulltext.queryNodes('Searchable', 'stories') YIELD node WHERE node:Turn RETURN node.id AS id")).map((r) => r.id)).toEqual(["turn:t1"]);
  });

  it("returns the same nearest entity from the vector index on Searchable as from the Entity one", async () => {
    const by = async (label: string) => (await g.roQuery<{ id: string }>(
      `CALL db.idx.vector.queryNodes('${label}', 'embedding', 3, vecf32($q)) YIELD node, score RETURN node.id AS id ORDER BY score ASC, id`, { q: unit(1) })).map((r) => r.id);
    expect(await by("Searchable")).toEqual(["decision:pause-stories"]);
    expect(await by("Entity")).toEqual(await by("Searchable"));
  });

  it("drops the Entity-wide search indexes on request and leaves the Searchable ones", async () => {
    const { g: g2, cleanup: c2 } = await testGraph();
    try {
      await ensureIndexes(g2);
      await ensureIndexes(g2, LEGACY_ENTITY_INDEXES);
      expect((await listIndexes(g2)).filter((i) => i.label === "Entity").map((i) => i.prop).sort()).toEqual(["embedding", "id", "name", "summary"]);
      expect(await dropLegacyEntityIndexes(g2)).toBe(3);
      expect(await dropLegacyEntityIndexes(g2)).toBe(0);
      const left = await listIndexes(g2);
      expect(left.filter((i) => i.label === "Entity")).toEqual([{ label: "Entity", prop: "id", type: "RANGE" }]);
      expect(left).toEqual(expect.arrayContaining([{ label: "Searchable", prop: "name", type: "FULLTEXT" }, { label: "Searchable", prop: "embedding", type: "VECTOR" }]));
    } finally {
      await c2();
    }
  });
});
