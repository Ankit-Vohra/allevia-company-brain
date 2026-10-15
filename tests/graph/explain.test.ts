// The plan check (tests/helpers/plan-lint.ts, tests/helpers/query-shapes.ts) that tests/setup/query-shapes.global.ts runs
// on every query the suite sends: on sample plans, and on real GRAPH.EXPLAIN output.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { planScans, scansDespiteIdAnchor } from "../helpers/plan-lint.js";
import { checkShapes, isProductFile, senderFile } from "../helpers/query-shapes.js";
import { testGraph } from "../helpers/graph.js";

const INDEXED = ["Project", "    Filter", "        Node By Index Scan | (d:Entity:Document)"];
const SCANNED = ["Project", "    Filter", "        Node By Label Scan | (d:Document)"];

describe("plan lint", () => {
  it("reads the scans of a plan", () => {
    expect(planScans(["Project", "  Conditional Traverse | (s)<-[r:IN_SESSION]-(t:Turn)", "    Node By Label Scan | (t:Turn)", "    All Node Scan | (n)", "    Node By Index Scan | (s:Entity:Session)"]))
      .toEqual([{ op: "label", alias: "t", labels: ["Turn"] }, { op: "all", alias: "n", labels: [] }, { op: "index", alias: "s", labels: ["Entity", "Session"] }]);
  });

  it("fails a query that looks a node up by id and scans anyway, and only that", () => {
    expect(scansDespiteIdAnchor("MATCH (d:Document {id:$id}) RETURN d", SCANNED)).toEqual(["Node By Label Scan (d:Document)"]);
    expect(scansDespiteIdAnchor("MATCH (d:Entity:Document {id:$id}) RETURN d", INDEXED)).toEqual([]);
    expect(scansDespiteIdAnchor("MATCH (n:Entity) WHERE n.id IN $ids RETURN n", SCANNED)).toHaveLength(1);
    expect(scansDespiteIdAnchor("MATCH (t:Turn) RETURN count(t)", ["Node By Label Scan | (t:Turn)"])).toEqual([]); // a survey: no id anchor, a scan is the job
    expect(scansDespiteIdAnchor("MATCH (n) WHERE n.kind = 'x' RETURN n", ["All Node Scan | (n)"])).toEqual([]);
  });

  it("reads who sent a statement from its stack, and counts only code under src/", () => {
    const stack = [
      "Error",
      "    at /repo/tests/helpers/query-shapes.ts:30:17",
      "    at GraphHandle.query (/repo/src/graph/client.ts:112:5)",
      "    at upsertNode (/repo/src/graph/nodes.ts:95:30)",
      "    at async /repo/tests/graph/upsert.test.ts:12:5",
    ].join("\n");
    expect(senderFile(stack)).toBe("/repo/src/graph/nodes.ts");
    expect(isProductFile("/repo/src/graph/nodes.ts")).toBe(true);
    const fromTest = ["Error", "    at /repo/tests/helpers/query-shapes.ts:30:17", "    at GraphHandle.roQuery (/repo/src/graph/client.ts:120:5)", "    at /repo/tests/server/api.test.ts:40:9"].join("\n");
    expect(isProductFile(senderFile(fromTest))).toBe(false);
    expect(isProductFile(undefined)).toBe(false);
  });

  it("checkShapes reports violations, honours a listed exception, and skips what is not a query", async () => {
    const plans: Record<string, string[]> = { a: SCANNED, b: INDEXED, c: SCANNED };
    const explain = async (q: string): Promise<string[]> => {
      if (q.startsWith("BAD")) throw new Error("syntax");
      return plans[q.slice(-1)]!;
    };
    const shapes = [
      { q: "MATCH (d:Document {id:$id}) RETURN a", file: "src/x.ts" },
      { q: "MATCH (d:Entity:Document {id:$id}) RETURN b", file: "src/y.ts" },
      { q: "MATCH (d:Document {id:$id}) RETURN c", file: "src/agent/z.ts" },
      { q: "CREATE INDEX FOR (n:Entity) ON (n.id)", file: "src/graph/indexes.ts" },
      { q: "BAD (", file: "src/w.ts" },
    ];
    const r = await checkShapes(explain, shapes, [{ file: /^src\/agent\//, why: "deferred" }]);
    expect(r.checked).toBe(3);
    expect(r.unplannable).toBe(1);
    expect(r.violations.map((v) => v.file)).toEqual(["src/x.ts"]);
    expect(r.unusedAllowances).toEqual([]);
  });
});

describe("GRAPH.EXPLAIN on a real graph (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  it("plans an id lookup with the Entity label as an index scan, and without it as a label scan", async () => {
    const withEntity = await g.explain("MATCH (d:Entity:Document {id:$id}) RETURN d.name");
    const without = await g.explain("MATCH (d:Document {id:$id}) RETURN d.name");
    expect(planScans(withEntity).map((s) => s.op)).toEqual(["index"]);
    expect(planScans(without).map((s) => s.op)).toEqual(["label"]);
    expect(scansDespiteIdAnchor("MATCH (d:Entity:Document {id:$id}) RETURN d.name", withEntity)).toEqual([]);
    expect(scansDespiteIdAnchor("MATCH (d:Document {id:$id}) RETURN d.name", without)).toHaveLength(1);
  });

  it("plans a start from the id when the query says so with a WITH, whatever the other side filters on", async () => {
    // the planner starts from the side that has a filter: without the WITH the Turns are scanned
    const loose = await g.explain("MATCH (t:Turn)-[r:IN_SESSION]->(:Entity:Session {id:$id}) WHERE t.showcase = true RETURN t.id");
    const anchored = await g.explain("MATCH (s:Entity:Session {id:$id}) WITH s MATCH (t:Turn)-[r:IN_SESSION]->(s) WHERE t.showcase = true RETURN t.id");
    expect(planScans(loose).some((s) => s.op === "label")).toBe(true);
    expect(planScans(anchored).map((s) => s.op)).toEqual(["index"]);
  });

  it("plans the Observation reads the agent makes on the new indexes: metricKey, subject, asOf", async () => {
    for (const q of [
      "MATCH (o:Observation) WHERE o.metricKey = $m RETURN o.id",
      "MATCH (o:Observation) WHERE o.metricKey IN $ms RETURN o.id",
      "MATCH (o:Observation {subject:$s}) RETURN o.id",
      "MATCH (o:Observation) WHERE o.asOf >= $d RETURN o.id",
      "MATCH (o:Observation) WHERE o.metric IN $ms RETURN o.id",
    ]) expect(planScans(await g.explain(q)).map((s) => s.op), q).toEqual(["index"]);
    // a function of the property cannot use the index: this is why metricKey exists
    expect(planScans(await g.explain("MATCH (o:Observation) WHERE toLower(o.metric) = $m RETURN o.id")).map((s) => s.op)).toEqual(["label"]);
  });
});
