// The two source checks in tests/helpers/cypher-lint.ts, on small examples: they flag the shapes that cost an index or
// a parallel edge, and let the right ones through.
import { describe, it, expect } from "vitest";
import { entityCreateWithoutId, interpolatedValues, OWN_RANGE_INDEXES, twoLabelIndexFilters, idAnchorsWithoutEntity, unguardedEdgeAggregates } from "../helpers/cypher-lint.js";

describe("idAnchorsWithoutEntity", () => {
  it("flags an id lookup without the Entity label", () => {
    expect(idAnchorsWithoutEntity("MATCH (d:Document {id:$id}) RETURN d")).toHaveLength(1);
    expect(idAnchorsWithoutEntity("MATCH (:Rule {id:$id})-[:APPLIES_TO]->(x:Entity) RETURN x.id AS id")).toHaveLength(1);
    expect(idAnchorsWithoutEntity("UNWIND $ids AS id MATCH (a:Agent {id:id}) RETURN a.name")).toHaveLength(1);
    expect(idAnchorsWithoutEntity("MATCH (n {id:$id}) RETURN n")).toHaveLength(1);
    expect(idAnchorsWithoutEntity("MATCH (g:Goal) WHERE g.id IN $ids RETURN g.name")).toHaveLength(1);
    expect(idAnchorsWithoutEntity("MATCH (o:Observation) WHERE o.id = $id RETURN o.value")).toHaveLength(1);
    expect(idAnchorsWithoutEntity("MATCH (c:Chunk) WHERE c.id > $after RETURN c.id ORDER BY c.id LIMIT 5")).toHaveLength(1);
  });

  it("passes lookups that carry Entity, and comparisons that are not anchors", () => {
    expect(idAnchorsWithoutEntity("MATCH (d:Entity:Document {id:$id}) RETURN d")).toEqual([]);
    expect(idAnchorsWithoutEntity("MATCH (a:Entity {id:$from}), (b:Entity {id:$to}) RETURN a, b")).toEqual([]);
    expect(idAnchorsWithoutEntity("MATCH (n:Entity) WHERE n.id IN $ids RETURN n")).toEqual([]);
    expect(idAnchorsWithoutEntity("MATCH (d:Document) WHERE d.kind = 'brief' AND d.id <> $id RETURN d")).toEqual([]);
    expect(idAnchorsWithoutEntity("MATCH (s:Entity {id:$id})<-[:MEASURES]-(o:Observation) RETURN o")).toEqual([]);
    expect(idAnchorsWithoutEntity("UNWIND $rows AS r MATCH (n:Entity {id: r.id}) SET n.rank = r.v")).toEqual([]);
    expect(idAnchorsWithoutEntity("MATCH (n:Entity:__EXPR__ {id:$id}) RETURN n")).toEqual([]); // a template label: Entity is written
    expect(idAnchorsWithoutEntity("MATCH (n:__EXPR__ {id:$id}) RETURN n")).toEqual([]);          // may be Entity: not judged
    expect(idAnchorsWithoutEntity("RETURN {id: $a, name: $b} AS x")).toEqual([]);
  });
});

describe("unguardedEdgeAggregates", () => {
  it("flags a count, sum or collect over a relationship nothing refers to", () => {
    expect(unguardedEdgeAggregates("MATCH (:Entity {id:$id})-[:HAD_VERSION]->(v) RETURN count(v) AS c")).toHaveLength(1);
    expect(unguardedEdgeAggregates("MATCH (a:Agent)-[e:PRODUCED]->(f:Finding) RETURN a.id, count(f)")).toHaveLength(1); // bound, never used
    expect(unguardedEdgeAggregates("MATCH (o:Observation)-[:MEASURES]->(s) WITH s, collect(o) AS os RETURN s.id, os")).toHaveLength(1);
    expect(unguardedEdgeAggregates("MATCH (a)-->(b) RETURN count(b)")).toHaveLength(1);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R]->(b)-[:S]->(c) RETURN count(c)")).toHaveLength(2);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R*1..1]->(b) RETURN count(b)")).toHaveLength(1); // one hop is planned like a plain edge
    expect(unguardedEdgeAggregates("MATCH (a)-[r:R*1]->(b) RETURN count(b)")).toHaveLength(1);
  });

  it("passes a relationship that is bound and used (WHERE ID(e) >= 0, or a test on e), and aggregates that ignore repeats", () => {
    expect(unguardedEdgeAggregates("MATCH (:Entity {id:$id})-[e:HAD_VERSION]->(v) WHERE ID(e) >= 0 RETURN count(v) AS c")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[r:OWNS]->(t) WHERE r.until IS NULL RETURN a.id, count(t)")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH ()-[r]->() RETURN count(r) AS c")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R]->(b) RETURN count(DISTINCT b)")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R]->(b) RETURN a.id, max(b.at) AS last")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R*1..3]->(b) RETURN count(b)")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R*]->(b) RETURN count(b)")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R*1..__EXPR__]->(b) RETURN count(b)")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a:Agent) WHERE NOT (a)-[:OWNS]->() RETURN count(a)")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (a)-[:R]->(b) RETURN b.id")).toEqual([]); // no aggregate
    // a pattern matched after the last count is not counted by it
    expect(unguardedEdgeAggregates("MATCH (t:Turn)-[r:TOUCHED]->(x) WHERE ID(r) >= 0 WITH t, count(x) AS n OPTIONAL MATCH (t)-[:IN_SESSION]->(s) RETURN t.id, s.id, n")).toEqual([]);
    expect(unguardedEdgeAggregates("MATCH (t:Turn) OPTIONAL MATCH (t)-[:IN_SESSION]->(s) WITH t, count(s) AS n RETURN t.id, n")).toHaveLength(1);
  });
});

describe("entityCreateWithoutId", () => {
  it("flags a CREATE of an Entity node whose id is set only afterwards (a mandatory constraint fails on FalkorDB Cloud)", () => {
    expect(entityCreateWithoutId("MATCH (n:Entity {id:$id}) CREATE (n)-[h:HAD_VERSION]->(v:Entity:Version) SET v += $version")).toHaveLength(1);
    expect(entityCreateWithoutId("CREATE (v:Entity:Version) SET v.id = $id")).toHaveLength(1);
  });
  it("passes a CREATE that carries the id, and the migration probe", () => {
    expect(entityCreateWithoutId("MATCH (n:Entity {id:$id}) CREATE (n)-[h:HAD_VERSION]->(v:Entity:Version {id: $vid}) SET v += $version")).toEqual([]);
    expect(entityCreateWithoutId("CREATE (n:Entity:Task) DELETE n")).toEqual([]);
    expect(entityCreateWithoutId("MATCH (a:Entity {id:$a}), (b:Entity {id:$b}) CREATE (a)-[:R]->(b)")).toEqual([]);
  });
});

describe("twoLabelIndexFilters", () => {
  it("flags Entity:Observation filtered on Entity.id and an indexed Observation property", () => {
    expect(twoLabelIndexFilters("MATCH (o:Entity:Observation {id:$id}) WHERE o.asOf = $d RETURN o")).toHaveLength(1);
    expect(twoLabelIndexFilters("MATCH (o:Entity:Observation) WHERE o.id > $after AND o.asOf < $cutoff RETURN o")).toHaveLength(1);
    expect(twoLabelIndexFilters("MATCH (o:Entity:Observation {id:$id, subject:$s}) RETURN o")).toHaveLength(1);
  });

  it("passes one anchor per label, and a CREATE that sets the properties", () => {
    expect(twoLabelIndexFilters("MATCH (o:Entity:Observation {id:$id}) WHERE o.value > 0 RETURN o")).toEqual([]);
    expect(twoLabelIndexFilters("MATCH (o:Observation) WHERE id(o) > $after AND o.asOf < $cutoff RETURN o")).toEqual([]);
    expect(twoLabelIndexFilters("MATCH (o:Entity {id:$id}) WHERE o:Observation AND o.asOf = $d RETURN o")).toEqual([]);
    expect(twoLabelIndexFilters("UNWIND $rows AS r CREATE (o:Entity:Observation {id: r.id}) SET o.metric = r.metric")).toEqual([]);
  });

  it("knows every label that has range indexes of its own (src/graph/indexes.ts)", async () => {
    const { INDEXES } = await import("../../src/graph/indexes.js");
    const own: Record<string, string[]> = {};
    // CreditEntry is not an Entity: its key and month indexes never meet the Entity.id index in one pattern
    for (const i of INDEXES) if (i.type === "RANGE" && i.label !== "Entity" && i.label !== "CreditEntry") own[i.label] = [...(own[i.label] ?? []), i.prop];
    expect(own).toEqual(OWN_RANGE_INDEXES);
  });
});

describe("interpolatedValues", () => {
  it("flags a value written into the text", () => {
    expect(interpolatedValues("MATCH (n:Entity) WHERE n.name = '__EXPR__' RETURN n")).toHaveLength(1);
    expect(interpolatedValues("MATCH (n:Entity) WHERE n.rank > __EXPR__ RETURN n")).toHaveLength(1);
    expect(interpolatedValues("MATCH (n:Entity) RETURN n ORDER BY n.id LIMIT __EXPR__")).toHaveLength(1);
    expect(interpolatedValues("MATCH (n:Entity) WHERE n.id IN __EXPR__ RETURN n")).toHaveLength(1);
  });

  it("passes labels, fragments and params", () => {
    expect(interpolatedValues("MATCH (n:__EXPR__ {id:$id}) RETURN n")).toEqual([]);
    expect(interpolatedValues("MATCH (n:Entity) WHERE __EXPR__ AND n.kind = 'x' RETURN __EXPR__ AS n")).toEqual([]);
    expect(interpolatedValues("MATCH (m:Memory) WHERE m.kind = 'preference' __EXPR__ RETURN m")).toEqual([]);
    expect(interpolatedValues("RETURN {ch: __EXPR__, e: __EXPR__} AS x LIMIT $limit")).toEqual([]);
  });
});
