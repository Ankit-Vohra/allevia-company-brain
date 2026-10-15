// GraphHandle refuses a query whose text has a crash shape (src/graph/safety.ts) before anything is sent: a crash on
// FalkorDB 6.0.2 restarts the server and drops every unsaved write for every agent. A stub stands in for the server,
// so these tests also prove nothing was sent.
import { describe, it, expect } from "vitest";
import type { Graph } from "falkordb";
import { GraphHandle } from "../../src/graph/client.js";
import { UnsafeQuery } from "../../src/graph/errors.js";

function stub() {
  const sent: Array<{ via: "query" | "roQuery"; cypher: string }> = [];
  const g = {
    query: async (cypher: string) => { sent.push({ via: "query", cypher }); return { data: [{ ok: 1 }] }; },
    roQuery: async (cypher: string) => { sent.push({ via: "roQuery", cypher }); return { data: [{ ok: 1 }] }; },
  } as unknown as Graph;
  return { h: new GraphHandle("allevia_stub", g), sent };
}

const TIES = "MATCH (n:Entity) RETURN n.id AS id, n.at AS at ORDER BY at DESC";
const NAN = "MATCH (n:Entity) RETURN n.id AS id, n.a / n.b AS r ORDER BY r, id";

describe("GraphHandle guards against the crash shapes", () => {
  it("sends a query that ends its sort in a unique key", async () => {
    const { h, sent } = stub();
    expect(await h.roQuery("MATCH (n:Entity) RETURN n.id AS id ORDER BY n.at DESC, n.id")).toEqual([{ ok: 1 }]);
    expect(await h.query("MATCH (n:Entity) WITH n ORDER BY n.at, id(n) LIMIT 5 SET n.seen = true")).toEqual([{ ok: 1 }]);
    expect(sent.map((s) => s.via)).toEqual(["roQuery", "query"]);
  });

  it("refuses a sort that can tie, on reads and on writes, and sends nothing", async () => {
    const { h, sent } = stub();
    await expect(h.roQuery(TIES)).rejects.toThrow(UnsafeQuery);
    await expect(h.query(TIES)).rejects.toThrow(UnsafeQuery);
    await expect(h.roQuery(TIES)).rejects.toThrow(/Add , x\.id as the last sort key/);
    expect(sent).toEqual([]);
  });

  it("refuses an unguarded division in a sorted query, and sends nothing", async () => {
    const { h, sent } = stub();
    await expect(h.roQuery(NAN)).rejects.toThrow(UnsafeQuery);
    await expect(h.roQuery(NAN)).rejects.toThrow(/CASE WHEN d = 0/);
    expect(sent).toEqual([]);
  });

  it("sends the guarded form of the same query", async () => {
    const { h, sent } = stub();
    await h.roQuery("MATCH (n:Entity) RETURN n.id AS id, CASE WHEN n.b = 0 OR n.b IS NULL THEN null ELSE n.a / n.b END AS r ORDER BY r, id");
    expect(sent).toHaveLength(1);
  });

  it("is bypassed only by an explicit option, for crash experiments on a throwaway server", async () => {
    const { h, sent } = stub();
    await h.roQuery(TIES, undefined, { unchecked: true });
    await h.query(NAN, undefined, { unchecked: true });
    expect(sent).toHaveLength(2);
  });

  it("keeps the refusal short enough for the cypher tool, which shows the model the first 300 characters", async () => {
    const { h } = stub();
    const e = await h.roQuery(TIES).catch((x: Error) => x);
    expect((e as Error).message.slice(0, 300)).toMatch(/last sort key/);
  });
});
