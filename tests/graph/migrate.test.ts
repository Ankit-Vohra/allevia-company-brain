// Bringing a graph written by older code up to the current schema (src/graph/migrate.ts, run by ensureIndexes): the
// Searchable label, the Observation metricKey, merging duplicate ids, and the UNIQUE / MANDATORY constraints on Entity.id.
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { closeAll, MAX_PAGE, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes, listIndexes } from "../../src/graph/indexes.js";
import { backfillMetricKey, backfillSearchable, ensureConstraints, findDuplicateIds, mergeDuplicateNodes } from "../../src/graph/migrate.js";
import { addObservation, upsertNode } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const one = async <T>(g: GraphHandle, cypher: string, params?: Record<string, unknown>): Promise<T> => (await g.roQuery<T>(cypher, params))[0]!;
const labelsOf = async (g: GraphHandle, id: string): Promise<string[]> => (await one<{ l: string[] }>(g, "MATCH (n:Entity {id:$id}) RETURN labels(n) AS l", { id })).l;

describe("migrating a graph written before the current schema (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ g, cleanup } = await testGraph()));
  afterEach(async () => cleanup());
  afterAll(async () => closeAll());

  it("labels searchable nodes Searchable, leaves plumbing without it, and is a no-op the second time", async () => {
    await g.query(`CREATE (:Entity:Decision {id:'decision:a', name:'A'}), (:Entity:Task {id:'task:a', name:'T'}),
      (:Entity:Observation {id:'obs:m:s:d', name:'o'}), (:Entity:Chunk {id:'chunk:a:0', name:'c'}), (:Entity:Version {id:'version:a@1', name:''})`);
    expect(await backfillSearchable(g)).toBe(2);
    expect(await backfillSearchable(g)).toBe(0);
    expect(await labelsOf(g, "decision:a")).toContain("Searchable");
    expect(await labelsOf(g, "task:a")).toContain("Searchable");
    for (const id of ["obs:m:s:d", "chunk:a:0", "version:a@1"]) expect(await labelsOf(g, id)).not.toContain("Searchable");
  });

  it("gives every Observation the lowercase metricKey of its metric, in pages", async () => {
    await g.query("UNWIND range(1, $n) AS i CREATE (:Entity:Observation {id: 'obs:m' + i, metric: CASE WHEN i % 2 = 0 THEN 'Reach_Total' ELSE 'signups' END})", { n: MAX_PAGE + 100 });
    await g.query("CREATE (:Entity:Observation {id:'obs:keep', metric:'X', metricKey:'already'})");
    expect(await backfillMetricKey(g)).toBe(MAX_PAGE + 100);
    expect(await backfillMetricKey(g)).toBe(0);
    expect(await one(g, "MATCH (o:Observation) WHERE o.metricKey IS NULL RETURN count(o) AS c")).toEqual({ c: 0 });
    expect(await one(g, "MATCH (o:Entity:Observation {id:'obs:m2'}) RETURN o.metricKey AS k")).toEqual({ k: "reach_total" });
    expect(await one(g, "MATCH (o:Entity:Observation {id:'obs:keep'}) RETURN o.metricKey AS k")).toEqual({ k: "already" });
  });

  it("brings an old graph (Entity indexes only, no constraints) to the whole schema in one ensureIndexes", async () => {
    await g.query("CREATE INDEX FOR (n:Entity) ON (n.id)");
    await g.query(`CREATE (:Entity:Decision {id:'decision:a', name:'Pause stories'}),
      (:Entity:Observation {id:'obs:Signups:business:b:2026-10-01', metric:'Signups', subject:'business:b', asOf:'2026-10-01', value:3})`);
    await ensureIndexes(g);
    await ensureIndexes(g); // idempotent
    expect(await labelsOf(g, "decision:a")).toContain("Searchable");
    expect(await one(g, "MATCH (o:Observation) RETURN o.metricKey AS k")).toEqual({ k: "signups" });
    expect(await listIndexes(g)).toEqual(expect.arrayContaining([
      { label: "Observation", prop: "metric", type: "RANGE" }, { label: "Observation", prop: "metricKey", type: "RANGE" },
      { label: "Observation", prop: "subject", type: "RANGE" }, { label: "Observation", prop: "asOf", type: "RANGE" },
      { label: "Searchable", prop: "name", type: "FULLTEXT" }, { label: "Searchable", prop: "embedding", type: "VECTOR" },
    ]));
    expect((await g.constraints()).map((c) => `${c.type}:${c.status}`).sort()).toEqual(["MANDATORY:OPERATIONAL", "UNIQUE:OPERATIONAL"]);
    // the data the old graph held is still found by the new index
    const hits = await g.roQuery<{ id: string }>("CALL db.idx.fulltext.queryNodes('Searchable', 'pause') YIELD node RETURN node.id AS id");
    expect(hits.map((h) => h.id)).toEqual(["decision:a"]);
  });

  describe("Entity.id constraints", () => {
    it("refuse a second node with an id, whatever its type, and leave MERGE and updates alone", async () => {
      await ensureIndexes(g);
      await upsertNode(g, { type: "Decision", id: "decision:a", name: "A" });
      await expect(g.query("CREATE (:Entity:Decision {id:'decision:a', name:'again'})")).rejects.toThrow(/unique constraint/i);
      await expect(g.query("CREATE (:Entity:Task {id:'decision:a', name:'other type'})")).rejects.toThrow(/unique constraint/i);
      await expect(g.query("CREATE (:Entity:Task {name:'no id'})")).rejects.toThrow(/mandatory|constraint/i);
      expect((await upsertNode(g, { type: "Decision", id: "decision:a", name: "A renamed" })).updated).toBe(true);
      await g.query("MERGE (n:Entity:Decision {id:'decision:a'}) SET n.seen = true");
      expect(await one(g, "MATCH (n:Entity {id:'decision:a'}) RETURN count(n) AS c")).toEqual({ c: 1 });
    });

    it("turn a create race into one node and one winner: the losers re-read and update", async () => {
      await ensureIndexes(g);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        upsertNode(g, { type: "Decision", id: "decision:race", name: `Racer ${i % 2}` })));
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await one(g, "MATCH (n:Entity {id:'decision:race'}) RETURN count(n) AS c")).toEqual({ c: 1 });
    });

    it("report an id already used by another type as that clash, not as a second node", async () => {
      await ensureIndexes(g);
      await g.query("CREATE (:Entity:Task {id:'decision:clash', name:'a task under a decision id'})");
      await expect(upsertNode(g, { type: "Decision", id: "decision:clash", name: "D" })).rejects.toThrow(/already exists as Task, not Decision/);
    });

    it("merge duplicate ids into the oldest node before creating the constraint: edges and properties come along", async () => {
      await g.query("CREATE INDEX FOR (n:Entity) ON (n.id)");
      await g.query(`CREATE (a:Entity:Task {id:'task:a', name:'first', owner:'asha'}), (b:Entity:Task {id:'task:a', name:'second', due:'friday', note:'x'}),
        (p:Entity:Person {id:'person:p', name:'P'}), (d:Entity:Decision {id:'decision:d', name:'D'}),
        (p)-[:OWNS {since: 5, src:'note'}]->(b), (b)-[:DEPENDS_ON {since: 7}]->(:Entity:Task {id:'task:z', name:'Z'}), (b)<-[:BLOCKS {since: 9}]-(d),
        (p)-[:OWNS {since: 1}]->(a)`);
      expect(await findDuplicateIds(g)).toEqual([{ id: "task:a", count: 2 }]);
      await ensureIndexes(g);
      expect(await findDuplicateIds(g)).toEqual([]);
      const keeper = await g.roQuery<{ p: Record<string, unknown> }>("MATCH (n:Entity {id:'task:a'}) RETURN properties(n) AS p");
      expect(keeper).toHaveLength(1);
      expect(keeper[0]!.p).toMatchObject({ name: "first", owner: "asha", due: "friday", note: "x" }); // the oldest wins, the other fills what it lacks
      expect(await labelsOf(g, "task:a")).toContain("Searchable");
      const owns = await g.roQuery<{ since: number }>("MATCH (:Entity {id:'person:p'})-[r:OWNS]->(:Entity {id:'task:a'}) RETURN r.since AS since ORDER BY since, id(r)");
      expect(owns.map((r) => r.since)).toEqual([1, 5]); // both edges kept: parallel edges are history, not duplicates to drop
      expect(await one(g, "MATCH (:Entity {id:'task:a'})-[r:DEPENDS_ON]->(:Entity {id:'task:z'}) WHERE ID(r) >= 0 RETURN count(r) AS c")).toEqual({ c: 1 });
      expect(await one(g, "MATCH (:Entity {id:'decision:d'})-[r:BLOCKS]->(:Entity {id:'task:a'}) WHERE ID(r) >= 0 RETURN count(r) AS c")).toEqual({ c: 1 });
      expect((await g.constraints()).map((c) => `${c.type}:${c.status}`).sort()).toEqual(["MANDATORY:OPERATIONAL", "UNIQUE:OPERATIONAL"]);
    });

    it("retries a constraint that FAILED on duplicates an earlier run left behind", async () => {
      await g.query("CREATE INDEX FOR (n:Entity) ON (n.id)");
      await g.query("CREATE (:Entity:Task {id:'task:a', name:'1'}), (:Entity:Task {id:'task:a', name:'2'})");
      await g.createConstraint("UNIQUE", "Entity", "id");
      for (let i = 0; i < 100 && (await g.constraints()).some((c) => c.status === "PENDING"); i++) await new Promise((r) => setTimeout(r, 20));
      expect((await g.constraints())[0]!.status).toBe("FAILED");
      const report = await ensureConstraints(g);
      expect(report.merged).toBe(1);
      expect(report.problems).toEqual([]);
      expect(report.status).toMatchObject({ UNIQUE: "OPERATIONAL", MANDATORY: "OPERATIONAL" });
    });

    it("do not guess when one id is two types: nothing merged, the constraint is skipped, the problem is reported", async () => {
      await g.query("CREATE INDEX FOR (n:Entity) ON (n.id)");
      await g.query("CREATE (:Entity:Task {id:'x:1', name:'a task'}), (:Entity:Decision {id:'x:1', name:'a decision'})");
      await expect(mergeDuplicateNodes(g, "x:1")).rejects.toThrow(/two types under one id/);
      const report = await ensureConstraints(g);
      expect(report.merged).toBe(0);
      expect(report.status.UNIQUE).toBe("skipped");
      expect(report.problems.join(" ")).toMatch(/duplicate id x:1/);
      expect(await one(g, "MATCH (n:Entity {id:'x:1'}) RETURN count(n) AS c")).toEqual({ c: 2 }); // untouched
      // the ingest is not blocked: ensureIndexes finishes, and says so on stderr
      await expect(ensureIndexes(g)).resolves.toBeUndefined();
    });

    it("name the nodes without an id instead of failing the MANDATORY constraint", async () => {
      await g.query("CREATE INDEX FOR (n:Entity) ON (n.id)");
      await g.query("CREATE (:Entity:Task {id:'task:ok', name:'ok'}), (:Entity:Task {name:'no id'})");
      const report = await ensureConstraints(g);
      expect(report.status.MANDATORY).toBe("skipped");
      expect(report.problems).toEqual(["1 Entity nodes have no id"]);
      expect(report.status.UNIQUE).toBe("OPERATIONAL");
    });

    it("are in place on an empty graph the moment ensureIndexes returns", async () => {
      await ensureIndexes(g);
      expect((await g.constraints()).map((c) => `${c.type}:${c.status}`).sort()).toEqual(["MANDATORY:OPERATIONAL", "UNIQUE:OPERATIONAL"]);
    });
  });

  it("writes an observation with its metricKey, found by the new index", async () => {
    await ensureIndexes(g);
    await upsertNode(g, { type: "Business", id: "business:b", name: "B" });
    const id = await addObservation(g, { subject: "business:b", metric: "Reach_Total", value: 12, asOf: "2026-10-01", src: "document:snap" });
    expect(await one(g, "MATCH (o:Observation {metricKey:'reach_total'}) RETURN o.id AS id")).toEqual({ id });
    const plan = (await g.explain("MATCH (o:Observation) WHERE o.metricKey = $m RETURN o.id")).join("\n");
    expect(plan).toMatch(/Node By Index Scan \| \(o:Observation\)/);
    const bySubject = (await g.explain("MATCH (o:Observation {subject:$s}) WHERE o.asOf >= $d RETURN o.id")).join("\n");
    expect(bySubject).toMatch(/Node By Index Scan \| \(o:Observation\)/);
  });
});
