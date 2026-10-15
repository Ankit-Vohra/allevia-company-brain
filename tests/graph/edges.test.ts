// Edge time (spec §5.4): a functional slot has at most one holder at any moment, whatever order the facts arrive in;
// replaying a source adds nothing; an older source never beats a newer one.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { ensureIndexes } from "../../src/graph/indexes.js";
import { upsertNode, upsertEdge, closeEdge, writeBatch, type EdgeInput, type NodeInput } from "../../src/graph/upsert.js";
import { edgeValidAt } from "../../src/graph/read.js";
import { testGraph } from "../helpers/graph.js";

const T0 = 1_760_000_000_000;
const day = (d: string) => Date.parse(d);
const PEOPLE = ["person:p1", "person:p2", "person:p3", "person:p4"];

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

describe("edge time (integration)", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await ensureIndexes(g);
    for (const id of PEOPLE) await upsertNode(g, { type: "Person", id, name: id }, T0);
    for (const id of ["system:s1", "system:s2"]) await upsertNode(g, { type: "System", id, name: id }, T0);
  });
  afterAll(async () => {
    await cleanup();
    await closeAll();
  });

  const task = async (id: string) => upsertNode(g, { type: "Task", id, name: id }, T0);
  const owners = (t: string) => g.roQuery<{ o: string; since: number; until: number | null }>(
    "MATCH (o)-[r:OWNS]->(:Entity {id:$t}) RETURN o.id AS o, r.since AS since, r.until AS until ORDER BY since, until, o", { t });

  // Probes every boundary, every midpoint between two boundaries, and a point before and after them all.
  async function expectOneHolderAtATime(t: string): Promise<void> {
    const edges = await owners(t);
    const marks = [...new Set(edges.flatMap((e) => (e.until === null ? [e.since] : [e.since, e.until])))].sort((a, b) => a - b);
    const probes = [marks[0]! - 1, ...marks, ...marks.slice(1).map((m, i) => (marks[i]! + m) / 2), marks.at(-1)! + 1];
    for (const at of probes) {
      const holders = edges.filter((e) => edgeValidAt(e, at)).map((e) => e.o);
      expect(holders.length, `holders of ${t} at ${at}: ${holders.join(", ")}`).toBeLessThanOrEqual(1);
    }
  }

  it("a late owner shortens a closed owner instead of overlapping it", async () => {
    await task("task:late");
    const own = (o: string, since: number, now: number) => upsertEdge(g, { from: o, type: "OWNS", to: "task:late", since }, now);
    await own("person:p1", T0 + 100, T0 + 100);
    expect(await own("person:p3", T0 + 300, T0 + 300)).toEqual({ created: true, closed: 1 }); // p1 held [100, 300)
    expect(await own("person:p2", T0 + 200, T0 + 400)).toEqual({ created: true, closed: 1 }); // p2 arrives late, since 200
    expect(await owners("task:late")).toEqual([
      { o: "person:p1", since: T0 + 100, until: T0 + 200 },
      { o: "person:p2", since: T0 + 200, until: T0 + 300 },
      { o: "person:p3", since: T0 + 300, until: null },
    ]);
    await expectOneHolderAtATime("task:late");
    const [p1, p2] = await g.roQuery<{ ret: number; why: string }>(
      "MATCH (o)-[r:OWNS]->(:Entity {id:'task:late'}) WHERE o.id IN ['person:p1', 'person:p2'] RETURN r.retiredAt AS ret, r.closeReason AS why ORDER BY o.id");
    expect(p1!.ret).toBe(T0 + 300); // when we first learned it ended
    expect(p2).toEqual({ ret: T0 + 400, why: "arrived before a later holder" });
  });

  it("a late owner inside a closed, unfilled stretch ends where the old owner ended", async () => {
    await task("task:gap");
    await upsertEdge(g, { from: "person:p1", type: "OWNS", to: "task:gap", since: T0 + 100 }, T0 + 100);
    expect(await closeEdge(g, "person:p1", "OWNS", "task:gap", T0 + 250)).toBe(1);
    expect(await upsertEdge(g, { from: "person:p2", type: "OWNS", to: "task:gap", since: T0 + 200 }, T0 + 300)).toEqual({ created: true, closed: 1 });
    expect(await owners("task:gap")).toEqual([
      { o: "person:p1", since: T0 + 100, until: T0 + 200 },
      { o: "person:p2", since: T0 + 200, until: T0 + 250 },
    ]);
    await expectOneHolderAtATime("task:gap");
  });

  it("builds the same timeline, one holder at a time, whatever order the owners arrive in", async () => {
    const facts = PEOPLE.map((o, i) => ({ o, since: T0 + 100 * (i + 1) }));
    const expected = facts.map((f, i) => ({ o: f.o, since: f.since, until: facts[i + 1]?.since ?? null }));
    const orders = permutations(facts);
    expect(orders).toHaveLength(24);
    for (const [k, order] of orders.entries()) {
      const t = `task:order-${k}`;
      await task(t);
      for (const [i, f] of order.entries()) await upsertEdge(g, { from: f.o, type: "OWNS", to: t, since: f.since }, T0 + 1000 + i);
      expect(await owners(t), `arrival order ${order.map((f) => f.o).join(" ")}`).toEqual(expected);
      await expectOneHolderAtATime(t);
      // and replaying the facts, in any order, changes nothing
      for (const f of [...order].reverse()) {
        expect(await upsertEdge(g, { from: f.o, type: "OWNS", to: t, since: f.since }, T0 + 2000)).toEqual({ created: false, closed: 0 });
      }
      expect(await owners(t)).toEqual(expected);
    }
  });

  it("re-sending a closed owner's fact is a re-assert, not a new edge", async () => {
    await task("task:replay");
    const p1 = { from: "person:p1", type: "OWNS" as const, to: "task:replay", since: T0 + 100 };
    await upsertEdge(g, p1, T0 + 100);
    await upsertEdge(g, { from: "person:p3", type: "OWNS", to: "task:replay", since: T0 + 300 }, T0 + 300);
    expect(await upsertEdge(g, p1, T0 + 400)).toEqual({ created: false, closed: 0 });
    expect(await upsertEdge(g, p1, T0 + 500)).toEqual({ created: false, closed: 0 });
    expect(await owners("task:replay")).toEqual([
      { o: "person:p1", since: T0 + 100, until: T0 + 300 },
      { o: "person:p3", since: T0 + 300, until: null },
    ]);
    // an owner who comes back later is a new stretch, and replaying that is a re-assert too
    const back = { ...p1, since: T0 + 600 };
    expect(await upsertEdge(g, back, T0 + 600)).toEqual({ created: true, closed: 1 });
    expect(await upsertEdge(g, back, T0 + 700)).toEqual({ created: false, closed: 0 });
    expect(await upsertEdge(g, p1, T0 + 700)).toEqual({ created: false, closed: 0 });
    expect(await owners("task:replay")).toEqual([
      { o: "person:p1", since: T0 + 100, until: T0 + 300 },
      { o: "person:p3", since: T0 + 300, until: T0 + 600 },
      { o: "person:p1", since: T0 + 600, until: null },
    ]);
  });

  it("re-running a historical ingest gives identical counts and edges", async () => {
    // Four documents, the way ingest writes them: edges carry since = the document's date.
    const doc = (n: number, asOf: string, nodes: NodeInput[], edges: Array<[string, EdgeInput["type"], string]>) => ({
      nodes: nodes.map((x) => ({ ...x, src: `document:doc${n}`, asOf })),
      edges: edges.map(([from, type, to]): EdgeInput => ({ from, type, to, src: `document:doc${n}`, asOf, since: day(asOf) })),
    });
    const t = (id: string, status: string): NodeInput => ({ type: "Task", id, name: id, props: { status } });
    const docs = [
      doc(1, "2026-09-01", [t("task:h1", "open"), t("task:h2", "open")],
        [["person:p1", "OWNS", "task:h1"], ["person:p1", "OWNS", "task:h2"], ["task:h1", "BLOCKS", "task:h2"], ["system:s1", "DEPENDS_ON", "system:s2"]]),
      doc(2, "2026-09-10", [t("task:h1", "in_progress")], [["person:p2", "OWNS", "task:h1"], ["person:p1", "KNOWS_ABOUT", "system:s1"]]),
      doc(3, "2026-09-20", [t("task:h1", "done")], [["person:p1", "OWNS", "task:h1"], ["person:p3", "OWNS", "task:h2"]]),
      doc(4, "2026-09-05", [t("task:h1", "blocked")], [["person:p4", "OWNS", "task:h1"]]), // an older document, read last
    ];
    const snapshot = async () => ({
      counts: (await g.roQuery("MATCH (n:Entity) WHERE n.id IN ['task:h1', 'task:h2'] OR n.of IN ['task:h1', 'task:h2'] RETURN count(n) AS nodes"))[0],
      versions: (await g.roQuery<{ since: number; until: number; props: string }>(
        "MATCH (:Entity {id:'task:h1'})-[:HAD_VERSION]->(v) RETURN v.since AS since, v.until AS until, v.props AS props ORDER BY since, until, id(v)"))
        .map((v) => ({ since: v.since, until: v.until, status: JSON.parse(v.props).status as string })),
      edges: await g.roQuery(
        `MATCH (a:Entity)-[r]->(b:Entity) WHERE type(r) <> 'HAD_VERSION' AND (a.id IN $ids OR b.id IN $ids)
         RETURN a.id AS a, type(r) AS t, b.id AS b, r.since AS since, r.until AS until, r.src AS src, r.asOf AS asOf
         ORDER BY a, t, b, since, id(r)`, { ids: ["task:h1", "task:h2", "system:s1", "system:s2"] }),
    });
    // Read weeks after the fact, so record time (now) is later than every document date.
    const NOW = day("2026-10-15");
    for (const [i, d] of docs.entries()) expect((await writeBatch(g, d, NOW + i)).errors).toEqual([]);
    const first = await snapshot();
    expect(first.edges.filter((e) => e.t === "OWNS" && e.b === "task:h1")).toEqual([
      { a: "person:p1", t: "OWNS", b: "task:h1", since: day("2026-09-01"), until: day("2026-09-05"), src: "document:doc1", asOf: "2026-09-01" },
      { a: "person:p1", t: "OWNS", b: "task:h1", since: day("2026-09-20"), until: null, src: "document:doc3", asOf: "2026-09-20" },
      { a: "person:p2", t: "OWNS", b: "task:h1", since: day("2026-09-10"), until: day("2026-09-20"), src: "document:doc2", asOf: "2026-09-10" },
      { a: "person:p4", t: "OWNS", b: "task:h1", since: day("2026-09-05"), until: day("2026-09-10"), src: "document:doc4", asOf: "2026-09-05" },
    ]);
    await expectOneHolderAtATime("task:h1");
    await expectOneHolderAtATime("task:h2");
    // Versions are dated by the documents; the older document read last is a backdated one
    expect(first.versions).toEqual([
      { since: day("2026-09-01"), until: day("2026-09-10"), status: "open" },
      { since: day("2026-09-05"), until: day("2026-09-20"), status: "blocked" },
      { since: day("2026-09-10"), until: day("2026-09-20"), status: "in_progress" },
    ]);
    for (const [i, d] of docs.entries()) {
      const s = await writeBatch(g, d, NOW + 1000 + i);
      expect(s).toMatchObject({ nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, errors: [] });
    }
    expect(await snapshot()).toEqual(first);
  });

  it("an older source never overwrites a newer edge fact at equal confidence", async () => {
    const dep = (asOf: string, src: string, conf: number, note: string, extra: Partial<EdgeInput> = {}) =>
      upsertEdge(g, { from: "system:s2", type: "DEPENDS_ON", to: "system:s1", src, asOf, conf, props: { note }, ...extra }, T0);
    const stored = async () => (await g.roQuery(
      "MATCH (:Entity {id:'system:s2'})-[r:DEPENDS_ON]->(:Entity {id:'system:s1'}) RETURN r.src AS src, r.asOf AS asOf, r.conf AS conf, r.note AS note, r.until AS until"));
    expect((await dep("2026-10-12", "document:new", 0.8, "new")).created).toBe(true);
    await dep("2026-10-10", "document:old", 0.8, "old");
    expect(await stored()).toEqual([{ src: "document:new", asOf: "2026-10-12", conf: 0.8, note: "new", until: null }]);
    await dep("2026-10-12", "document:same-day", 0.8, "same day"); // not older: takes over
    expect(await stored()).toEqual([{ src: "document:same-day", asOf: "2026-10-12", conf: 0.8, note: "same day", until: null }]);
    await dep("2026-10-13", "document:newer", 0.8, "newer");
    expect(await stored()).toEqual([{ src: "document:newer", asOf: "2026-10-13", conf: 0.8, note: "newer", until: null }]);
    await dep("2026-10-01", "document:weaker", 0.5, "weaker");
    expect((await stored())[0]).toMatchObject({ src: "document:newer" });
    await dep("2026-10-01", "document:stronger", 0.9, "stronger"); // a stronger source wins, however old
    expect(await stored()).toEqual([{ src: "document:stronger", asOf: "2026-10-01", conf: 0.9, note: "stronger", until: null }]);
  });

  it("an older source never reopens an edge that ended after its date", async () => {
    const knows = (asOf: string, now: number, since?: number) =>
      upsertEdge(g, { from: "person:p2", type: "KNOWS_ABOUT", to: "system:s2", src: `document:${asOf}`, asOf, ...(since ? { since } : {}) }, now);
    const edges = () => g.roQuery<{ since: number; until: number | null; asOf: string }>(
      "MATCH (:Entity {id:'person:p2'})-[r:KNOWS_ABOUT]->(:Entity {id:'system:s2'}) RETURN r.since AS since, r.until AS until, r.asOf AS asOf ORDER BY since, id(r)");
    await knows("2026-10-01", day("2026-10-01"), day("2026-10-01"));
    expect(await closeEdge(g, "person:p2", "KNOWS_ABOUT", "system:s2", day("2026-10-10"))).toBe(1);
    // dated before the ending: a re-assert of what we already know, with or without its own since
    expect(await knows("2026-10-05", day("2026-10-15"))).toEqual({ created: false, closed: 0 });
    expect(await knows("2026-10-05", day("2026-10-15"), day("2026-10-05"))).toEqual({ created: false, closed: 0 });
    expect(await edges()).toEqual([{ since: day("2026-10-01"), until: day("2026-10-10"), asOf: "2026-10-05" }]);
    // dated after the ending: the fact holds again
    expect(await knows("2026-10-12", day("2026-10-16"), day("2026-10-12"))).toEqual({ created: true, closed: 0 });
    expect(await knows("2026-10-05", day("2026-10-17"))).toEqual({ created: false, closed: 0 }); // stale: refreshes nothing
    expect(await edges()).toEqual([
      { since: day("2026-10-01"), until: day("2026-10-10"), asOf: "2026-10-05" },
      { since: day("2026-10-12"), until: null, asOf: "2026-10-12" },
    ]);
  });

  it("an older source never closes a holder backed by a newer source: its claim is stored closed and empty", async () => {
    await task("task:contra");
    const own = (o: string, since: string, asOf: string) =>
      upsertEdge(g, { from: o, type: "OWNS", to: "task:contra", since: day(since), asOf, src: `document:${o}` }, day("2026-10-15"));
    await own("person:p1", "2026-09-01", "2026-09-30"); // a 09-30 source: p1 has owned it since 09-01
    expect(await own("person:p2", "2026-09-10", "2026-09-15")).toEqual({ created: true, closed: 0 }); // a 09-15 source says p2
    expect(await owners("task:contra")).toEqual([
      { o: "person:p1", since: day("2026-09-01"), until: null },
      { o: "person:p2", since: day("2026-09-10"), until: day("2026-09-10") },
    ]);
    const [why] = await g.roQuery("MATCH (:Entity {id:'person:p2'})-[r:OWNS]->(:Entity {id:'task:contra'}) RETURN r.closeReason AS why");
    expect(why).toEqual({ why: "contradicted by a newer source" });
    await expectOneHolderAtATime("task:contra");
    // a replay changes nothing; a newer source still hands over as usual
    expect(await own("person:p2", "2026-09-10", "2026-09-15")).toEqual({ created: false, closed: 0 });
    expect(await own("person:p3", "2026-10-05", "2026-10-05")).toEqual({ created: true, closed: 1 });
    expect((await owners("task:contra")).filter((r) => r.until === null || r.until > r.since)).toEqual([
      { o: "person:p1", since: day("2026-09-01"), until: day("2026-10-05") },
      { o: "person:p3", since: day("2026-10-05"), until: null },
    ]);
  });

  it("settles conflicting sources the same way whatever order they arrive in", async () => {
    // p1 per a 09-30 source (since 09-01), p2 per an older 09-15 source (since 09-10), p3 per a 10-05 source
    const facts = [
      { o: "person:p1", since: day("2026-09-01"), asOf: "2026-09-30" },
      { o: "person:p2", since: day("2026-09-10"), asOf: "2026-09-15" },
      { o: "person:p3", since: day("2026-10-05"), asOf: "2026-10-05" },
    ];
    const expected = [
      { o: "person:p1", since: day("2026-09-01"), until: day("2026-10-05") },
      { o: "person:p2", since: day("2026-09-10"), until: day("2026-09-10") }, // contradicted: held at no moment
      { o: "person:p3", since: day("2026-10-05"), until: null },
    ];
    for (const [k, order] of permutations(facts).entries()) {
      const t = `task:sources-${k}`;
      await task(t);
      for (const f of order) await upsertEdge(g, { from: f.o, type: "OWNS", to: t, since: f.since, asOf: f.asOf }, day("2026-10-15"));
      expect(await owners(t), `arrival order ${order.map((f) => f.o).join(" ")}`).toEqual(expected);
      await expectOneHolderAtATime(t);
      for (const f of order) {
        expect(await upsertEdge(g, { from: f.o, type: "OWNS", to: t, since: f.since, asOf: f.asOf }, day("2026-10-16"))).toEqual({ created: false, closed: 0 });
      }
      expect(await owners(t)).toEqual(expected);
    }
  });

  it("a functional fact replayed without its own since lands on the same edge (since = its source date)", async () => {
    await task("task:nosince");
    const own = (o: string, asOf: string, now: number) => upsertEdge(g, { from: o, type: "OWNS", to: "task:nosince", asOf }, now);
    await own("person:p1", "2026-09-01", day("2026-10-15"));
    await own("person:p2", "2026-09-10", day("2026-10-15") + 1);
    const before = await owners("task:nosince");
    expect(before).toEqual([
      { o: "person:p1", since: day("2026-09-01"), until: day("2026-09-10") },
      { o: "person:p2", since: day("2026-09-10"), until: null },
    ]);
    for (const now of [day("2026-10-16"), day("2026-10-17")]) {
      expect(await own("person:p1", "2026-09-01", now)).toEqual({ created: false, closed: 0 });
      expect(await own("person:p2", "2026-09-10", now + 1)).toEqual({ created: false, closed: 0 });
    }
    expect(await owners("task:nosince")).toEqual(before);
  });

  it("a re-assert refreshes the edge whose window covers its since, not the current one", async () => {
    const knows = (since: string, asOf: string, now: number) =>
      upsertEdge(g, { from: "person:p3", type: "KNOWS_ABOUT", to: "system:s1", since: day(since), asOf, src: `document:${asOf}` }, now);
    const edges = () => g.roQuery("MATCH (:Entity {id:'person:p3'})-[r:KNOWS_ABOUT]->(:Entity {id:'system:s1'}) RETURN r.since AS since, r.until AS until, r.src AS src ORDER BY since, id(r)");
    await knows("2026-09-01", "2026-09-01", day("2026-09-01"));
    await closeEdge(g, "person:p3", "KNOWS_ABOUT", "system:s1", day("2026-09-10"));
    await knows("2026-09-20", "2026-09-20", day("2026-09-20"));
    // a newer source restating that the fact held on 09-05
    expect(await knows("2026-09-05", "2026-09-25", day("2026-09-25"))).toEqual({ created: false, closed: 0 });
    expect(await edges()).toEqual([
      { since: day("2026-09-01"), until: day("2026-09-10"), src: "document:2026-09-25" },
      { since: day("2026-09-20"), until: null, src: "document:2026-09-20" }, // the current edge keeps its own source
    ]);
  });
});
