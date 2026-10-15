// The cypher tool is where a model writes its own Cypher, so it is where an unguarded sort is most likely to arrive.
// GraphHandle refuses it (src/graph/safety.ts) and the tool hands the model the reason, so it can add the key and retry.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { cypher } from "../../../src/agent/tools/cypher.js";
import { call, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("cypher: sorts must not tie (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
  afterAll(async () => cleanup());

  it("explains a sort that can tie, so the model adds a unique key", async () => {
    const r = await call(cypher, { query: "MATCH (t:Task) RETURN t.id AS id, t.name AS name ORDER BY name" }, makeCtx(g));
    expect(r.data.error).toMatch(/Add , x\.id as the last sort key/);
    expect(r.data.rows).toBeUndefined();
  });

  it("runs the same query once it ends in a unique key", async () => {
    const r = await call(cypher, { query: "MATCH (t:Task) RETURN t.id AS id, t.name AS name ORDER BY name, id" }, makeCtx(g));
    expect(r.data.error).toBeUndefined();
    expect(r.data.rows.length).toBeGreaterThan(0);
    const names = r.data.rows.map((x: { name: string }) => x.name);
    expect(names).toEqual([...names].sort());
  });

  it("explains a division that can be NaN in a sorted query", async () => {
    const r = await call(cypher, { query: "MATCH (o:Observation) RETURN o.id AS id, o.value / o.conf AS r ORDER BY r, id" }, makeCtx(g));
    expect(r.data.error).toMatch(/CASE WHEN d = 0/);
  });

  it("accepts the guarded division", async () => {
    const r = await call(cypher, {
      query: "MATCH (o:Observation) RETURN o.id AS id, CASE WHEN coalesce(o.conf, 0) = 0 THEN null ELSE o.value / o.conf END AS r ORDER BY r, id",
    }, makeCtx(g));
    expect(r.data.error).toBeUndefined();
  });

  it("a query that does not sort is unaffected", async () => {
    const r = await call(cypher, { query: "MATCH (t:Task) RETURN t.id AS id" }, makeCtx(g));
    expect(r.data.error).toBeUndefined();
  });
});
