import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { cypher, writeReason } from "../../../src/agent/tools/cypher.js";
import { call, ids, makeCtx, seededGraph } from "../../helpers/tools.js";

describe("cypher", () => {
  it("rejects write keywords in any casing, outside string literals", () => {
    for (const q of [
      "CREATE (n:Entity {id:'x'})", "match (n) sEt n.x = 1", "MATCH (n) DETACH DELETE n", "merge (n:Entity {id:'x'})",
      "MATCH (n) REMOVE n.x", "MATCH (n) WITH n cReAtE (m)", "match (n) foreach (x in [1] | set n.y = x)",
      "LOAD CSV FROM 'file:///x' AS r RETURN r", "CALL db.idx.fulltext.createNodeIndex('Entity', 'x')",
      "CALL db.idx.fulltext.drop('Entity')", "MATCH (n) DELETE\nn", "MATCH (n) RETURN n // fine\n;DROP INDEX x",
    ]) expect(writeReason(q), q).not.toBeNull();
    for (const q of [
      "MATCH (n) WHERE n.name = 'CREATE something' RETURN n", "MATCH (n) WHERE n.createdAt > 0 RETURN n.id", "MATCH (n) RETURN n.offset",
      "MATCH (n:`SET`) RETURN n", "MATCH (n) RETURN n /* no DELETE here */", "CALL db.idx.fulltext.queryNodes('Entity', 'x') YIELD node RETURN node",
      "MATCH (n) WHERE n.text CONTAINS \"merge requests\" RETURN n",
    ]) expect(writeReason(q), q).toBeNull();
  });

  describe("integration", () => {
    let g: GraphHandle;
    let cleanup: () => Promise<void>;
    beforeAll(async () => ({ g, cleanup } = await seededGraph()), 60_000);
    afterAll(async () => cleanup());

    it("refuses writes and leaves the graph alone", async () => {
      const before = (await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c;
      for (const query of ["MATCH (n) DETACH DELETE n", "mAtCh (n) WITH n LIMIT 1 cReAtE (m:Entity {id:'x'})"]) {
        const r = await call(cypher, { query }, makeCtx(g));
        expect(r.data).toMatchObject({ refused: true, error: expect.stringMatching(/read-only/) });
        expect(r.nodes).toEqual([]);
      }
      expect((await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c).toBe(before);
    });

    it("caps rows at 200 with or without a LIMIT", async () => {
      const r = await call(cypher, { query: "UNWIND range(1, 500) AS i RETURN i" }, makeCtx(g));
      expect(r.data).toMatchObject({ rowCount: 200, truncated: true, columns: ["i"] });
      expect(r.note).toMatch(/Capped at 200/);
      const big = await call(cypher, { query: "UNWIND range(1, 500) AS i RETURN i LIMIT 300" }, makeCtx(g));
      expect(big.data.rowCount).toBe(200);
      const small = await call(cypher, { query: "UNWIND range(1, 5) AS i RETURN i;" }, makeCtx(g));
      expect(small.data).toMatchObject({ rowCount: 5, truncated: false });
    });

    it("maps nodes, edges and paths to refs; id strings of real entities count as nodes", async () => {
      const r = await call(cypher, { query: "MATCH (d:Decision)-[r:SUPERSEDES]->(o) RETURN d, r, o" }, makeCtx(g));
      expect(r.data.rows[0].d).toMatchObject({ id: "decision:007-pause-daily-stories", type: "Decision", props: { status: "accepted" } });
      expect(r.data.rows[0].d.props).not.toHaveProperty("embedding");
      expect(r.data.rows[0].r).toMatchObject({ from: "decision:007-pause-daily-stories", type: "SUPERSEDES", to: "decision:003-daily-stories" });
      expect(ids(r.nodes).sort()).toEqual(["decision:003-daily-stories", "decision:007-pause-daily-stories"]);
      expect(r.edges).toEqual([expect.objectContaining({ from: "decision:007-pause-daily-stories", type: "SUPERSEDES", to: "decision:003-daily-stories", until: null })]);
      expect(ids(r.sources)).toEqual(expect.arrayContaining(["document:adr-007", "document:adr-003"]));

      const p = await call(cypher, { query: "MATCH p = (:Entity {id:'system:reel-scheduler'})-[:DEPENDS_ON*]->(:Entity {id:'system:ig-connector'}) RETURN p" }, makeCtx(g));
      expect(p.data.rows[0].p.path).toEqual(["system:reel-scheduler", "system:reel-publisher", "system:ig-connector"]);
      expect(p.edges).toHaveLength(2);

      const t = await call(cypher, { query: "MATCH (t:Task) WHERE t.status = $s RETURN t.id AS id, t.name AS name ORDER BY id", params: { s: "open" } }, makeCtx(g));
      expect(t.data.rows).toEqual([{ id: "task:fix-sitemap", name: "Fix sitemap errors" }, { id: "task:schedule-reels", name: "Schedule two reels a week" }]);
      expect(ids(t.nodes).sort()).toEqual(["task:fix-sitemap", "task:schedule-reels"]);
      expect(ids(t.sources)).toContain("document:pending");
    });

    it("runs a bare CALL … YIELD (no LIMIT allowed there) and returns query errors as fixable", async () => {
      const r = await call(cypher, { query: "CALL db.labels() YIELD label" }, makeCtx(g));
      expect(r.data.rows.map((x: { label: string }) => x.label)).toEqual(expect.arrayContaining(["Entity", "Decision"]));
      const bad = await call(cypher, { query: "MATCH (n RETURN n" }, makeCtx(g));
      expect(bad.data.error).toMatch(/^Query failed/);
    });
  });
});
