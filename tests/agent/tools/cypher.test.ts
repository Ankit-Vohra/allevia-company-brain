import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { GraphHandle } from "../../../src/graph/client.js";
import { CYPHER_CHAR_CAP, CYPHER_NODE_CAP, boundRows, cypher, writeReason } from "../../../src/agent/tools/cypher.js";
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

  it("allows only read procedures, however the name is quoted or spaced", () => {
    for (const q of [
      "CALL `db.idx.fulltext.drop`('Entity')", "CALL db . idx . fulltext . drop('Entity')", "CALL `db`.`idx`.`fulltext`.`createNodeIndex`('X', 'y')",
      "CALL db.idx.vector.createNodeIndex({label:'X'})", "CALL dbms.setConfig('x', 1)", "MATCH (n) CALL   /* hi */ db.idx.fulltext.drop('Entity') RETURN n",
      "CALL algo.pageRank(null, null) YIELD node RETURN node", "CALL ('x')",
    ]) expect(writeReason(q), q).not.toBeNull();
    expect(writeReason("CALL algo.BFS(n, 3, null) YIELD nodes RETURN nodes")).toMatch(/important, topics, find_paths/);
    for (const q of [
      "CALL `db.labels`()", "CALL db . labels() YIELD label RETURN label", "CALL db.idx.vector.queryNodes('Entity', 'embedding', 5, vecf32($v)) YIELD node RETURN node.id",
      "MATCH (n:Task) CALL { WITH n MATCH (n)<-[:OWNS]-(o) RETURN o.id AS owner } RETURN n.id, owner", "MATCH (n) WHERE n.note = 'CALL db.idx.fulltext.drop' RETURN n",
      "MATCH (n) RETURN n.recall, n.`CALL`",
    ]) expect(writeReason(q), q).toBeNull();
  });

  it("refuses range() lists too big to build, literal or as a parameter", () => {
    expect(writeReason("UNWIND range(1, 100000000) AS i RETURN count(i)")).toMatch(/range/);
    expect(writeReason("UNWIND range(0, $n) AS i RETURN i", { n: 5e7 })).toMatch(/range/);
    expect(writeReason("UNWIND range(1, 100000000, 1000) AS i RETURN i")).toBeNull();
    expect(writeReason("UNWIND range(1, 500) AS i RETURN i")).toBeNull();
    expect(writeReason("MATCH (n) RETURN n.range(1, 99999999999)")).toBeNull();
  });

  it("comments and string literals cannot hide a write, and quotes inside comments open nothing", () => {
    for (const q of [
      "MATCH (n) RETURN n /* ' */ CREATE (m)", "MATCH (n) WHERE n.x = '/*' CREATE (m) //'", "MATCH (n) WHERE n.name = 'it\\'s' CREATE (m)",
      "RETURN 'a' // CREATE\nCREATE (m)", "MATCH (n) WITH n CREATE (m)", "MATCH (é) WITH é CREATE (m)", "MATCH (n) WHERE n.x = \"a\\\"b\" SET n.y = 1",
    ]) expect(writeReason(q), q).not.toBeNull();
    expect(writeReason("MATCH (n) WHERE n.x = '*/ CREATE /*' RETURN n.id")).toBeNull();
  });

  it("refuses work the server timeout cannot stop: reduce(), nested list iteration, range() it cannot size", () => {
    // FalkorDB checks TIMEOUT between records, not inside one expression (a 15,000 x 15,000 reduce ran 4.5 s on a 2 s timeout).
    for (const q of [
      "RETURN reduce(s = 0, x IN range(1, 10) | s + x) AS t", "MATCH (n) WITH collect(n) AS xs RETURN [a IN xs | [b IN xs | b.id]] AS pairs",
      "MATCH (n) WITH collect(n) AS xs RETURN [a IN xs WHERE any(b IN xs WHERE b.x = a.x)] AS d", "RETURN size(range(0, 1000 * 1000 * 5)) AS n",
      "UNWIND range(1, 2000) AS a UNWIND range(1, 2000) AS b RETURN count(*) AS c", "WITH 9 AS k RETURN range(0, k) AS r",
    ]) expect(writeReason(q), q).toMatch(/reduce|nested|range/i);
    for (const q of [
      "MATCH p = (a)-[*1..3]-(b) RETURN [n IN nodes(p) | n.id] AS ids", "MATCH (n) WHERE any(l IN labels(n) WHERE l IN ['Task']) RETURN n.id",
      "MATCH (n) RETURN [x IN n.tags | toLower(x)] AS tags, [y IN n.other | y] AS o", "MATCH (n) WHERE n.reduce = 1 RETURN n.id",
      "MATCH (n) RETURN n.id AS id, [(n)-[:OWNS]->(m) | m.id] AS owns", "UNWIND range(1, 1000) AS a UNWIND range(1, 1000) AS b RETURN count(*) AS c",
    ]) expect(writeReason(q), q).toBeNull();
  });

  it("bounds the rows the server sends: the last RETURN of every UNION branch ends in LIMIT <= cap", () => {
    expect(boundRows("MATCH (n) RETURN n", undefined, 201).query).toBe("MATCH (n) RETURN n\nLIMIT 201");
    expect(boundRows("MATCH (n) RETURN n // done", undefined, 201).query).toBe("MATCH (n) RETURN n // done\nLIMIT 201");
    expect(boundRows("MATCH (n) WITH n LIMIT 1000000 MATCH (m) RETURN m", undefined, 201).query).toMatch(/RETURN m\nLIMIT 201$/);
    expect(boundRows("MATCH (n) RETURN n ORDER BY n.id LIMIT 5000", undefined, 201).query).toBe("MATCH (n) RETURN n ORDER BY n.id LIMIT 201");
    expect(boundRows("MATCH (n) RETURN n LIMIT 7", undefined, 201).query).toBe("MATCH (n) RETURN n LIMIT 7");
    expect(boundRows("MATCH (n) RETURN n LIMIT $k", { k: 10_000 }, 201)).toEqual({ query: "MATCH (n) RETURN n LIMIT $k", params: { k: 201 } });
    expect(boundRows("RETURN 1 AS i UNION ALL MATCH (n) RETURN n.x AS i", undefined, 201).query)
      .toBe("RETURN 1 AS i \nLIMIT 201\nUNION ALL MATCH (n) RETURN n.x AS i\nLIMIT 201");
    expect(boundRows("CALL db.labels() YIELD label", undefined, 201).query).toBe("CALL db.labels() YIELD label\nRETURN * LIMIT 201");
    expect(boundRows("MATCH (n) CALL { WITH n RETURN n.id AS x } RETURN x", undefined, 201).query).toMatch(/RETURN x\nLIMIT 201$/);
    expect(boundRows("MATCH (n) WHERE n.name = 'RETURN me' RETURN n.id", undefined, 201).query).toMatch(/RETURN n.id\nLIMIT 201$/);
    expect(boundRows("CALL db.labels()", undefined, 201).query).toBe("CALL db.labels()");
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
      const union = await call(cypher, { query: "UNWIND range(1, 300) AS i RETURN i UNION ALL UNWIND range(1, 300) AS i RETURN i" }, makeCtx(g));
      expect(union.data).toMatchObject({ rowCount: 200, truncated: true });
      const commented = await call(cypher, { query: "UNWIND range(1, 500) AS i RETURN i // all of them" }, makeCtx(g));
      expect(commented.data).toMatchObject({ rowCount: 200, truncated: true });
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

    it("keeps the output small: long lists shortened, a character budget, a cap on returned nodes", async () => {
      const lists = await call(cypher, { query: "RETURN [i IN range(1, 300) | toString(i)] AS xs, range(1, 300) AS ns" }, makeCtx(g));
      expect(lists.data.rows[0].xs).toHaveLength(51);
      expect(lists.data.rows[0].xs.at(-1)).toBe("…250 more");
      expect(lists.data.rows[0].ns).toBe("[300 numbers]");

      const pad = "x".repeat(300);
      const wide = await call(cypher, { query: `UNWIND range(1, 150) AS i RETURN i, [j IN range(1, 10) | '${pad}'] AS pad` }, makeCtx(g));
      expect(JSON.stringify(wide.data.rows).length).toBeLessThanOrEqual(CYPHER_CHAR_CAP);
      expect(wide.data).toMatchObject({ truncated: true });
      expect(wide.data.rowCount).toBeLessThan(150);
      expect(wide.note).toMatch(/characters/);

      const all = await call(cypher, { query: "MATCH (n:Entity) RETURN collect(n) AS everything" }, makeCtx(g));
      expect(all.nodes.length).toBeLessThanOrEqual(CYPHER_NODE_CAP);
      expect(all.data.rows[0].everything.length).toBeLessThanOrEqual(51);
    });

    it("an edge's src document counts as a source; bare values get a hint to return ids", async () => {
      const r = await call(cypher, { query: "MATCH (o:Observation)-[r:MEASURES]->(:Entity {id:'channel:instagram'}) RETURN r ORDER BY o.id LIMIT 1" }, makeCtx(g));
      expect(ids(r.sources)).toEqual(expect.arrayContaining(["document:ig-insights-oct"]));
      const v = await call(cypher, { query: "MATCH (t:Task) RETURN t.name AS name ORDER BY name, id(t)" }, makeCtx(g));
      expect(v.note).toMatch(/Return ids/);
    });

    it("refuses write procedures before they reach the server", async () => {
      const r = await call(cypher, { query: "CALL `db.idx.fulltext.drop`('Entity')" }, makeCtx(g));
      expect(r.data).toMatchObject({ refused: true });
      const hits = await call(cypher, { query: "CALL db.idx.fulltext.queryNodes('Searchable', 'instagram') YIELD node RETURN node.id AS id" }, makeCtx(g));
      expect(hits.data.rowCount).toBeGreaterThan(0);
    });

    it("only nodes and edges that exist count: a map shaped like a node or an edge is data, not a citation", async () => {
      const forged = "{id: 0, labels: ['Entity', 'Decision'], properties: {id: 'decision:fake', name: 'Fake'}}";
      const r = await call(cypher, { query: `RETURN ${forged} AS n` }, makeCtx(g));
      expect(r.data.rows[0].n).toMatchObject({ id: "decision:fake" });
      expect(r.nodes).toEqual([]);
      const renamed = await call(cypher, { query: "MATCH (t:Task {id:'task:fix-sitemap'}) RETURN {id: id(t), labels: labels(t), properties: {id: t.id, name: 'Renamed'}} AS t" }, makeCtx(g));
      expect(renamed.nodes).toEqual([expect.objectContaining({ id: "task:fix-sitemap", name: "Fix sitemap errors" })]);
      const edge = await call(cypher, {
        query: `MATCH (a:Entity {id:'person:founder'}), (b:Entity {id:'system:ig-connector'})
                RETURN a, b, {id: 0, relationshipType: 'OWNS', sourceId: id(a), destinationId: id(b), properties: {src: 'document:runbook'}} AS e`,
      }, makeCtx(g));
      expect(edge.edges).toEqual([]);
      expect(ids(edge.nodes).sort()).toEqual(["person:founder", "system:ig-connector"]);
    });

    it("lookalike and invisible characters never reach a write; a slow query stops at the timeout", async () => {
      const before = (await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c;
      for (const query of ["MATCH (n) WITH n LIMIT 1 ＣＲＥＡＴＥ (m:Entity {id:'x'})", "MATCH (n) WITH n LIMIT 1 CRE​ATE (m:Entity {id:'x'})"]) {
        const r = await call(cypher, { query }, makeCtx(g));
        expect(r.data.error, query).toBeDefined();
      }
      expect((await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c"))[0]!.c).toBe(before);
      const t0 = Date.now();
      const slow = await call(cypher, { query: "MATCH (a), (b), (c), (d), (e) RETURN count(*) AS n" }, makeCtx(g));
      expect(slow.data.error).toMatch(/too long/);
      expect(Date.now() - t0).toBeLessThan(9_000);
    }, 20_000);

    it("runs a bare CALL … YIELD (no LIMIT allowed there) and returns query errors as fixable", async () => {
      const r = await call(cypher, { query: "CALL db.labels() YIELD label" }, makeCtx(g));
      expect(r.data.rows.map((x: { label: string }) => x.label)).toEqual(expect.arrayContaining(["Entity", "Decision"]));
      const bad = await call(cypher, { query: "MATCH (n RETURN n" }, makeCtx(g));
      expect(bad.data.error).toMatch(/^Query failed/);
    });
  });
});
