import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes, listIndexes, VECTOR_DIM, vectorPropFor } from "../../src/graph/indexes.js";
import { upsertNode } from "../../src/graph/upsert.js";
import { searchableTypesPredicate } from "../../src/graph/read.js";
import { testGraph } from "../helpers/graph.js";

const unit = (i: number) => Array.from({ length: VECTOR_DIM }, (_, j) => (j === i ? 1 : 0));

describe("ensureIndexes (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await testGraph()));
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("creates every index on a fresh graph and is idempotent", async () => {
    await ensureIndexes(g);
    await ensureIndexes(g);
    const idx = await listIndexes(g);
    expect(idx).toEqual(expect.arrayContaining([
      { label: "Entity", prop: "id", type: "RANGE" },
      { label: "Entity", prop: "name", type: "FULLTEXT" },
      { label: "Entity", prop: "summary", type: "FULLTEXT" },
      { label: "Chunk", prop: "text", type: "FULLTEXT" },
      { label: "Entity", prop: "embedding", type: "VECTOR" },
      { label: "Chunk", prop: "textEmbedding", type: "VECTOR" },
    ]));
  });

  it("refuses labels and props that are not plain identifiers", async () => {
    await expect(ensureIndexes(g, [{ label: "Entity) DETACH DELETE (n", prop: "id", type: "RANGE" }])).rejects.toThrow(/identifier/);
    await expect(ensureIndexes(g, [{ label: "Entity", prop: "id x", type: "RANGE" }])).rejects.toThrow(/identifier/);
  });

  it("serves full-text and vector queries; chunk vectors stay out of the entity index", async () => {
    expect(vectorPropFor("Chunk")).toBe("textEmbedding");
    expect(vectorPropFor("Decision")).toBe("embedding");
    await upsertNode(g, { type: "Decision", id: "decision:discord-brain", name: "Discord brain", summary: "Use the subscription agent", embedding: unit(0) });
    await upsertNode(g, { type: "Chunk", id: "chunk:d1:0", name: "Discord brain §1", props: { text: "signups jumped after reels" }, embedding: unit(0) });
    const ft = await g.roQuery<{ id: string }>("CALL db.idx.fulltext.queryNodes('Entity', 'subscr*') YIELD node RETURN node.id AS id");
    expect(ft.map((r) => r.id)).toEqual(["decision:discord-brain"]);
    const ct = await g.roQuery<{ id: string }>("CALL db.idx.fulltext.queryNodes('Chunk', 'signup*') YIELD node RETURN node.id AS id");
    expect(ct.map((r) => r.id)).toEqual(["chunk:d1:0"]);
    const ev = await g.roQuery<{ id: string }>("CALL db.idx.vector.queryNodes('Entity', 'embedding', 5, vecf32($q)) YIELD node RETURN node.id AS id", { q: unit(0) });
    expect(ev.map((r) => r.id)).toEqual(["decision:discord-brain"]);
    const cv = await g.roQuery<{ id: string }>("CALL db.idx.vector.queryNodes('Chunk', 'textEmbedding', 5, vecf32($q)) YIELD node RETURN node.id AS id", { q: unit(0) });
    expect(cv.map((r) => r.id)).toEqual(["chunk:d1:0"]);
  });

  it("keeps chunks, versions and observations out of filtered entity search", async () => {
    // rename: writes a Version holding the old name, which must not surface as a search hit
    expect((await upsertNode(g, { type: "Decision", id: "decision:discord-brain", name: "Discord agent brain", summary: "Use the subscription agent" })).versioned).toBe(true);
    const raw = await g.roQuery<{ id: string; labels: string[] }>("CALL db.idx.fulltext.queryNodes('Entity', 'brain') YIELD node RETURN node.id AS id, labels(node) AS labels");
    expect(raw.map((r) => r.id).sort()).toEqual(["chunk:d1:0", "decision:discord-brain"]); // the Version has no searchable name
    const hits = await g.roQuery<{ id: string }>(
      `CALL db.idx.fulltext.queryNodes('Entity', 'brain') YIELD node WITH node WHERE ${searchableTypesPredicate("node")} RETURN node.id AS id`);
    expect(hits.map((r) => r.id)).toEqual(["decision:discord-brain"]);
  });
});
