// No write path stores NaN or Infinity. A NaN already stored crashes FalkorDB 6.0.2 the next time something sorts it
// (docs/notes/falkordb-nan-crash.md), so the writers refuse one loudly instead: the client rejects a non-finite
// param before it is sent, and upsertNode / upsertEdge / addObservation validate first. A computed ratio that comes
// out NaN (0 / 0) therefore fails its write rather than landing in the graph.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes, VECTOR_DIM } from "../../src/graph/indexes.js";
import { addObservation, upsertEdge, upsertNode, writeBatch, InvalidWrite } from "../../src/graph/upsert.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;
const BAD = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE * 2];
const finiteEmbedding = (): number[] => Array.from({ length: VECTOR_DIM }, (_, i) => (i === 0 ? 1 : 0));

describe("non-finite numbers never reach the graph (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    await upsertNode(g, { type: "Person", id: "person:founder", name: "Founder" }, T0);
    await upsertNode(g, { type: "Task", id: "task:t1", name: "T1" }, T0);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const count = async (cypher: string): Promise<number> => (await g.roQuery<{ c: number }>(cypher))[0]!.c;
  const nodes = () => count("MATCH (n) RETURN count(n) AS c");
  const edges = () => count("MATCH ()-[r]->() RETURN count(r) AS c");

  it("the client refuses a non-finite param anywhere inside it, on writes and reads, and sends nothing", async () => {
    const before = await nodes();
    for (const x of BAD) {
      for (const params of [{ x }, { x: [1, x] }, { x: { a: x } }, { x: [{ a: [x] }] }]) {
        await expect(g.query("CREATE (:Probe {v: $x})", params)).rejects.toThrow(/finite/);
        await expect(g.roQuery("RETURN $x AS x", params)).rejects.toThrow(/finite/);
      }
    }
    expect(await nodes()).toBe(before);
  });

  it("upsertNode refuses a non-finite prop, a list holding one, and a non-finite embedding", async () => {
    const before = await nodes();
    for (const x of BAD) {
      await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "Bad", props: { ratio: x } }, T0)).rejects.toThrow(InvalidWrite);
      await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "Bad", props: { series: [1, x, 3] } }, T0)).rejects.toThrow(InvalidWrite);
      await expect(upsertNode(g, { type: "Task", id: "task:bad", name: "Bad", embedding: [x, ...finiteEmbedding().slice(1)] }, T0)).rejects.toThrow(InvalidWrite);
    }
    expect(await nodes()).toBe(before);
  });

  it("upsertNode refuses a non-finite update to a node that exists, and keeps the stored value", async () => {
    await upsertNode(g, { type: "Task", id: "task:t1", name: "T1", props: { ratio: 0.5 } }, T0);
    for (const x of BAD) await expect(upsertNode(g, { type: "Task", id: "task:t1", name: "T1", props: { ratio: x } }, T0 + 1)).rejects.toThrow(InvalidWrite);
    expect(await g.roQuery("MATCH (n:Task {id:'task:t1'}) RETURN n.ratio AS ratio")).toEqual([{ ratio: 0.5 }]);
  });

  it("upsertEdge refuses a non-finite since, conf or prop; no edge appears", async () => {
    const before = await edges();
    for (const x of BAD) {
      await expect(upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:t1", since: x }, T0)).rejects.toThrow(InvalidWrite);
      await expect(upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:t1", conf: x }, T0)).rejects.toThrow(InvalidWrite);
      await expect(upsertEdge(g, { from: "person:founder", type: "KNOWS_ABOUT", to: "task:t1", props: { weight: x } }, T0)).rejects.toThrow(InvalidWrite);
    }
    expect(await edges()).toBe(before);
  });

  it("addObservation refuses a non-finite value or conf; no Observation and no MEASURES edge appear", async () => {
    const before = await nodes();
    for (const x of BAD) {
      const o = { subject: "task:t1", metric: "ctr", asOf: "2026-10-14", src: "document:x" };
      await expect(addObservation(g, { ...o, value: x }, T0)).rejects.toThrow(InvalidWrite);
      await expect(addObservation(g, { ...o, value: 1, conf: x }, T0)).rejects.toThrow(InvalidWrite);
    }
    expect(await nodes()).toBe(before);
    expect(await count("MATCH (:Observation)-[r:MEASURES]->() RETURN count(r) AS c")).toBe(0);
  });

  it("writeBatch reports each refused item and still writes the rest", async () => {
    const s = await writeBatch(g, {
      nodes: [
        { type: "Task", id: "task:ok", name: "Ok", props: { n: 1 } },
        { type: "Task", id: "task:nan", name: "NaN", props: { n: Number.NaN } },
      ],
      observations: [
        { subject: "task:ok", metric: "views", value: 10, asOf: "2026-10-14", src: "document:x" },
        { subject: "task:ok", metric: "ratio", value: 0 / 0, asOf: "2026-10-14", src: "document:x" },
      ],
      edges: [{ from: "person:founder", type: "KNOWS_ABOUT", to: "task:ok", props: { weight: Number.POSITIVE_INFINITY } }],
    }, T0);
    expect(s.errors.map((e) => e.kind).sort()).toEqual(["edge", "node", "observation"]);
    expect(s.errors.every((e) => /finite|primitive/.test(e.error))).toBe(true);
    expect(await count("MATCH (n {id:'task:ok'}) RETURN count(n) AS c")).toBe(1);
    expect(await count("MATCH (n {id:'task:nan'}) RETURN count(n) AS c")).toBe(0);
    expect(s.observations).toBe(1);
  });

  it("a ratio computed upstream as 0 / 0 fails its write loudly; the guarded value writes", async () => {
    const clicks = 0, impressions = 0;
    const ratio = clicks / impressions; // NaN
    await expect(upsertNode(g, { type: "Task", id: "task:ctr", name: "CTR", props: { ctr: ratio } }, T0)).rejects.toThrow(InvalidWrite);
    expect(await count("MATCH (n {id:'task:ctr'}) RETURN count(n) AS c")).toBe(0);
    await upsertNode(g, { type: "Task", id: "task:ctr", name: "CTR", props: { ctr: impressions > 0 ? clicks / impressions : 0 } }, T0);
    expect(await g.roQuery("MATCH (n {id:'task:ctr'}) RETURN n.ctr AS ctr")).toEqual([{ ctr: 0 }]);
  });

  it("extreme finite numbers are stored and come back finite; a subnormal is stored as 0", async () => {
    // The server's parser refuses a double below 2.2e-308 ("Float overflow '5e-324'"), and a decaying weight can get
    // there (Math.exp(-745) is 5e-324), so the client sends such a value as 0: no different for any use, and the write lands.
    // (The server prints doubles with 15 significant digits, so Number.MAX_VALUE itself reads back as 1.79769313486232e+308,
    // which JavaScript parses as Infinity: nothing real is that large, and the test stays clear of it.)
    await upsertNode(g, { type: "Task", id: "task:big", name: "Big", props: { big: 1e300, tiny: Number.MIN_VALUE, decayed: Math.exp(-745), neg: -1e300, small: 1e-300 } }, T0);
    const [r] = await g.roQuery<Record<string, number>>("MATCH (n {id:'task:big'}) RETURN n.big AS big, n.tiny AS tiny, n.decayed AS decayed, n.neg AS neg, n.small AS small");
    for (const v of Object.values(r!)) expect(Number.isFinite(v)).toBe(true);
    expect(r).toMatchObject({ big: 1e300, tiny: 0, decayed: 0, neg: -1e300, small: 1e-300 });
  });

  it("holds no NaN or Infinity in any stored property, after all of the above", async () => {
    const odd = await count(
      `MATCH (n) UNWIND keys(n) AS k WITH n, k, n[k] AS v
       WHERE toString(v) IN ['nan', 'NaN', 'inf', '-inf', 'Infinity', '-Infinity'] OR (v IS NOT NULL AND v <> v)
       RETURN count(*) AS c`);
    expect(odd).toBe(0);
    const edgeOdd = await count(
      `MATCH ()-[r]->() UNWIND keys(r) AS k WITH r, k, r[k] AS v
       WHERE toString(v) IN ['nan', 'NaN', 'inf', '-inf', 'Infinity', '-Infinity'] OR (v IS NOT NULL AND v <> v)
       RETURN count(*) AS c`);
    expect(edgeOdd).toBe(0);
  });
});
