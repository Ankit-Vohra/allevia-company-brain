// FalkorDB 6.0.2: a node pattern with two labels that both have range indexes (Entity.id, and Observation's asOf, subject,
// metric, metricKey) loses every row when the query filters on an indexed property of each label. The plan is one
// `Node By Index Scan | (o:Observation:Entity)` that returns nothing. docs/notes/falkordb-two-label-index-scan.md.
// The first test pins the bug (when it fails, the server is fixed: drop the lint rule); the others pin the two shapes
// the code uses instead. tests/graph/cypher-sources.test.ts keeps that shape out of src/.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { addObservation, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const AS = { src: "document:seed", asOf: "2026-10-01" };
const ID = "obs:sessions:channel:web:2026-10-01";

describe("two range-indexed labels in one pattern (FalkorDB 6.0.2)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Channel", id: "channel:web", name: "Website", ...AS });
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01"]) {
      await addObservation(g, { subject: "channel:web", metric: "sessions", value: 10, asOf: day, src: "document:seed" });
    }
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const count = async (q: string, p: Record<string, unknown> = {}) => (await g.roQuery<{ c: number }>(q, p))[0]?.c;

  it("loses the row when Entity.id and an Observation index are both filtered (the bug)", async () => {
    expect(await count("MATCH (o:Entity:Observation {id:$id}) RETURN count(o) AS c", { id: ID })).toBe(1);
    expect(await count("MATCH (o:Entity:Observation {id:$id}) WHERE o.asOf = $d RETURN count(o) AS c", { id: ID, d: "2026-10-01" })).toBe(0);
    expect(await count("MATCH (o:Entity:Observation) WHERE o.id > $after AND o.asOf < $cut RETURN count(o) AS c", { after: "", cut: "2026-10-02" })).toBe(0);
  });

  it("finds it anchored by id on Entity alone, with the type as a label test", async () => {
    expect(await count("MATCH (o:Entity {id:$id}) WHERE o:Observation AND o.asOf = $d RETURN count(o) AS c", { id: ID, d: "2026-10-01" })).toBe(1);
  });

  it("finds them anchored on the Observation index alone, paged on the internal id", async () => {
    expect(await count("MATCH (o:Observation) WHERE id(o) > $after AND o.asOf < $cut RETURN count(o) AS c", { after: -1, cut: "2026-10-02" })).toBe(3);
  });
});
