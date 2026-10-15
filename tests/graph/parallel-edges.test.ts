// FalkorDB 6.0.2 collapses parallel edges between the same two nodes when nothing in the query refers to the edge, so a
// count, sum or collect over such a traversal undercounts. Allevia keeps parallel edges on purpose (a fact that ended and
// was asserted again is a closed edge and an open one), so every aggregate over a traversal binds and uses the edge
// (`WHERE ID(e) >= 0`, or a test on e): tests/graph/cypher-sources.test.ts holds src/ to it with the lint in
// tests/helpers/cypher-lint.ts. This holds the lint to the server: it flags exactly the shapes the server undercounts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { closeEdge, upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { unguardedEdgeAggregates } from "../helpers/cypher-lint.js";
import { testGraph } from "../helpers/graph.js";

describe("parallel edges (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    // two parallel R edges a -> b, written the way the product writes them: the first ended, the second opened again
    await g.query(`CREATE (a:Entity:Task {id:'task:a', name:'A'}), (b:Entity:Task {id:'task:b', name:'B', v: 5}),
      (a)-[:R {since: 1, until: 2}]->(b), (a)-[:R {since: 3}]->(b)`);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const A = "(a:Entity {id:'task:a'})";
  // [query, what a person means by it]
  const shapes: Array<[string, number]> = [
    [`MATCH ${A}-[:R]->(b) RETURN count(b) AS c`, 2],
    [`MATCH ${A}-[e:R]->(b) RETURN count(b) AS c`, 2],
    [`MATCH ${A}-[e:R]->(b) WHERE ID(e) >= 0 RETURN count(b) AS c`, 2],
    [`MATCH ${A}-[e:R]->(b) RETURN count(e) AS c`, 2],
    [`MATCH ${A}-[e:R]->(b) WHERE e.since >= 1 RETURN count(b) AS c`, 2],
    [`MATCH ${A}-[e:R]->(b) WHERE e.until IS NULL RETURN count(b) AS c`, 1],
    [`MATCH ${A}-[:R]->(b) RETURN size(collect(b.id)) AS c`, 2],
    [`MATCH ${A}-[e:R]->(b) WHERE ID(e) >= 0 RETURN size(collect(b.id)) AS c`, 2],
    [`MATCH ${A}-[:R]->(b) RETURN sum(b.v) AS c`, 10],
    [`MATCH ${A}-[e:R]->(b) WHERE ID(e) >= 0 RETURN sum(b.v) AS c`, 10],
    [`MATCH ${A}-[:R*1..1]->(b) RETURN count(b) AS c`, 2],
    [`MATCH ${A}-[:R*1..2]->(b) RETURN count(b) AS c`, 2],
    [`MATCH ${A}-[:R]->(b) RETURN count(DISTINCT b) AS c`, 1],
    [`MATCH ${A}-[:R]->(b) RETURN max(b.v) AS c`, 5],
  ];

  it("are collapsed by a traversal nothing refers to: the reason for the guard (if this fails, FalkorDB changed)", async () => {
    expect((await g.roQuery<{ c: number }>(shapes[0]![0]))[0]!.c).toBe(1);
    expect((await g.roQuery<{ c: number }>(shapes[1]![0]))[0]!.c).toBe(1); // bound, but never used
    expect((await g.roQuery<{ c: number }>(shapes[2]![0]))[0]!.c).toBe(2);
  });

  it.each(shapes)("%s", async (q, truth) => {
    const got = (await g.roQuery<{ c: number }>(q))[0]!.c;
    const flagged = unguardedEdgeAggregates(q).length > 0;
    // the lint flags a shape exactly when the server gets it wrong
    expect(flagged).toBe(got !== truth);
    if (!flagged) expect(got).toBe(truth);
  });

  it("keeps the bi-temporal history the writers make: a fact closed and asserted again is two edges, one current", async () => {
    await upsertNode(g, { type: "Person", id: "person:p", name: "P" });
    await upsertNode(g, { type: "Task", id: "task:t", name: "T" });
    await upsertEdge(g, { from: "person:p", type: "OWNS", to: "task:t", since: 100 }, 1_000);
    await closeEdge(g, "person:p", "OWNS", "task:t", 2_000);
    await upsertEdge(g, { from: "person:p", type: "OWNS", to: "task:t", since: 3_000 }, 3_000);
    const all = "MATCH (:Entity {id:'person:p'})-[e:OWNS]->(t:Entity {id:'task:t'}) WHERE ID(e) >= 0 RETURN count(t) AS c";
    const current = "MATCH (:Entity {id:'person:p'})-[e:OWNS]->(t:Entity {id:'task:t'}) WHERE e.until IS NULL RETURN count(t) AS c";
    const unguarded = "MATCH (:Entity {id:'person:p'})-[:OWNS]->(t:Entity {id:'task:t'}) RETURN count(t) AS c";
    expect((await g.roQuery<{ c: number }>(all))[0]!.c).toBe(2);
    expect((await g.roQuery<{ c: number }>(current))[0]!.c).toBe(1);
    expect((await g.roQuery<{ c: number }>(unguarded))[0]!.c).toBe(1); // the history would read as one edge
  });
});
