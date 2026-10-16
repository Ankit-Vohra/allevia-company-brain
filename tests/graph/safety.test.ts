// The two query shapes that crash FalkorDB 6.0.2 (docs/notes/falkordb-nan-crash.md), found by reading the Cypher text:
// an ORDER BY whose last key can tie, and a NaN in a sort key. Pure text analysis, no server.
import { describe, it, expect } from "vitest";
import { assertSafeQuery, blankLiterals, groupInWith, nanRisks, nullableGroupKeys, sortClauses, unsafeSorts } from "../../src/graph/safety.js";
import { UnsafeQuery } from "../../src/graph/errors.js";

describe("sortClauses", () => {
  it("splits the keys of every ORDER BY, up to the next clause", () => {
    const q = "MATCH (n) WITH n ORDER BY n.name DESC, n.id LIMIT 5 RETURN n.id AS id ORDER BY id";
    expect(sortClauses(q).map((c) => c.keys)).toEqual([["n.name DESC", "n.id"], ["id"]]);
  });

  it("keeps commas inside brackets inside one key", () => {
    expect(sortClauses("RETURN x ORDER BY coalesce(r.weight, 1) DESC, a.id LIMIT 3").map((c) => c.keys)).toEqual([["coalesce(r.weight, 1) DESC", "a.id"]]);
  });

  it("ignores ORDER BY inside string literals, backtick names and comments", () => {
    const q = "MATCH (n) WHERE n.name = 'ORDER BY x' /* ORDER BY y */ // ORDER BY z\n RETURN n.`ORDER BY` AS v";
    expect(sortClauses(q)).toEqual([]);
  });

  it("ends a clause at a closing bracket (a CALL subquery) and at a semicolon", () => {
    expect(sortClauses("CALL { MATCH (n) RETURN n ORDER BY n.v LIMIT 1 } RETURN 1").map((c) => c.keys)).toEqual([["n.v"]]);
    expect(sortClauses("MATCH (n) RETURN n ORDER BY n.v;").map((c) => c.keys)).toEqual([["n.v"]]);
  });
});

describe("unsafeSorts: the last sort key must be unique", () => {
  const safe = [
    "MATCH (n) RETURN n.id AS id ORDER BY n.id",
    "MATCH (n) RETURN n ORDER BY n.id DESC",
    "MATCH (n) RETURN n ORDER BY id(n)",
    "MATCH (n) RETURN n, count(*) AS c ORDER BY c DESC, n.id LIMIT 10",
    "MATCH (m) WITH m ORDER BY m.name, m.id RETURN m",
    "MATCH (t:Tenant) RETURN properties(t) AS p ORDER BY t.slug LIMIT 100",
    "MATCH (n) RETURN n.id AS id ORDER BY id",                                        // alias of an id
    "MATCH (n) RETURN n.id AS nid, n.v AS v ORDER BY v DESC, nid",
    "MATCH (a)-[w]->(d) WITH a, d, a.id + '|' + d.id AS k WHERE k > $after RETURN k ORDER BY k LIMIT 10", // pair of ids
    "MATCH (n) RETURN DISTINCT n.id AS id ORDER BY id",
    "MATCH (n) RETURN n ORDER BY n.v, n.id ASC",
    "RETURN 1",                                                                       // no ORDER BY at all
    // a grouped projection: its rows are unique per group, so keys that cover every grouping column are a total order
    "MATCH (n) RETURN n.kind AS kind, count(*) AS c ORDER BY c DESC, kind",
    "MATCH (n) RETURN coalesce(n.kind, 'other') AS kind, max(n.asOf) AS asOf ORDER BY asOf DESC, kind LIMIT 30",
    "MATCH (n) RETURN DISTINCT n.metric AS m ORDER BY m LIMIT 40",
    "MATCH (n) WITH n.a AS a, n.b AS b, count(*) AS c ORDER BY c DESC, a, b RETURN a, b, c",
    "MATCH (o) WHERE NOT o.metric STARTS WITH 'x' RETURN o.k AS k, count(*) AS c ORDER BY c DESC, k",   // STARTS WITH is not a WITH clause
  ];
  for (const q of safe) it(`accepts ${q.slice(0, 70)}`, () => expect(unsafeSorts(q)).toEqual([]));

  const unsafe = [
    "MATCH (n) RETURN n.id AS id, n.v AS v ORDER BY v",
    "MATCH (n) RETURN n, score ORDER BY score ASC",
    "MATCH (n) RETURN n ORDER BY score DESC, n.name",
    "MATCH (n) RETURN n ORDER BY n.id, n.name",                                       // an id earlier would make the order total too; the rule is "the last key", one convention to check
    "MATCH (n) RETURN n ORDER BY n.at DESC LIMIT 5",                                 // LIMIT does not exempt
    "MATCH (n) RETURN n.at AS id, n.v AS v ORDER BY id",                             // an alias that is not an id
    "MATCH (n) WITH n ORDER BY n.name RETURN n ORDER BY n.id",                       // the first of two
    "CALL { MATCH (n) RETURN n ORDER BY n.v LIMIT 1 } RETURN 1",
    "MATCH (n) RETURN n ORDER BY coalesce(n.id, n.name)",
    "UNWIND $ids AS id RETURN id ORDER BY id",                                       // a list the caller may repeat
    // grouped, but a grouping column is left out of the keys: two groups can tie
    "UNWIND $ids AS sid MATCH (o) WITH sid, o.k AS key, head(collect(o.at)) AS x ORDER BY x DESC, key RETURN sid, x",
    "MATCH (n) RETURN n.kind AS kind, count(*) AS c ORDER BY c DESC",
    // DISTINCT on an earlier WITH does not make the RETURN's rows unique
    "MATCH (n) WITH DISTINCT n RETURN n.id AS id, n.v AS v ORDER BY v",
    // the aggregation is in an earlier clause than the one that sorts: put the ORDER BY on the aggregating WITH
    "MATCH (n) WITH n.k AS k, count(*) AS c RETURN k, c ORDER BY c DESC, k",
  ];
  for (const q of unsafe) it(`flags ${q.slice(0, 70)}`, () => expect(unsafeSorts(q).length).toBeGreaterThan(0));

  it("names the offending clause", () => {
    expect(unsafeSorts("MATCH (n) RETURN n ORDER BY n.v DESC, n.name LIMIT 3")).toEqual(["ORDER BY n.v DESC, n.name"]);
  });
});

describe("nanRisks: a NaN in a sort key crashes the server", () => {
  const risky = [
    "UNWIND $xs AS x RETURN x, x.a / x.b AS r ORDER BY r, x.id",
    "RETURN 0.0 / 0.0 AS r ORDER BY r",
    "MATCH (n) RETURN n.id AS id, toFloat(n.a) / toFloat(n.b) AS ratio ORDER BY ratio DESC, id",
    "MATCH (n) RETURN n.id AS id, sqrt(n.v) AS s ORDER BY s, id",
    "MATCH (n) RETURN n.id AS id, log(n.v) AS s ORDER BY s, id",
    "MATCH (n) RETURN n.id AS id, n.v ^ 0.5 AS s ORDER BY s, id",
    "MATCH (n) RETURN n.id AS id, CASE WHEN n.on THEN n.a / n.b ELSE 0 END AS r ORDER BY r, id",  // the CASE does not test the denominator
    "MATCH (n) RETURN n.id AS id, CASE WHEN n.a > 0 THEN n.a / n.b ELSE 0 END AS r ORDER BY r, id", // it tests the numerator
    "UNWIND range(1, 5) AS i WITH {id: toString(i)} AS n, CASE WHEN i % 5 = 0 THEN 0.0 / 0.0 ELSE 1.0 END AS g RETURN n.id AS id, g ORDER BY g, id", // a zero literal is NaN whatever the CASE says
    "UNWIND range(0, 9) AS i WITH {id: toString(i)} AS n, toFloat(0) / toFloat(i % 5) AS g RETURN n.id AS id, g ORDER BY g, id",
  ];
  for (const q of risky) it(`flags ${q.slice(0, 80)}`, () => expect(nanRisks(q).length).toBeGreaterThan(0));

  const fine = [
    "MATCH (n) RETURN n.id AS id, CASE WHEN n.b = 0 OR n.b IS NULL THEN null ELSE n.a / n.b END AS r ORDER BY r, id",
    "MATCH (n) RETURN n.id AS id, CASE WHEN n.b > 0 THEN n.a / n.b ELSE 0 END AS r ORDER BY r, id",
    "MATCH (n) WHERE n.b <> 0 RETURN n.id AS id, n.a / n.b AS r ORDER BY r, id",   // a filter on the denominator
    "MATCH (n) WHERE n.v = n.v RETURN n.id AS id, n.v AS v ORDER BY v, id",         // x = x drops NaN
    "MATCH (n) RETURN n.id AS id, n.a / 2 AS half ORDER BY half, id",               // a non-zero literal denominator
    "UNWIND range(0, 9) AS i WITH {id: toString(i)} AS n, CASE WHEN i % 5 = 0 THEN null ELSE toFloat(0) / toFloat(i % 5) END AS g RETURN n.id AS id, g ORDER BY g, id", // the CASE tests the denominator's i
    "MATCH (n) RETURN n.id AS id, n.a / n.b AS r",                                  // not sorted: NaN in RETURN is harmless
    "MATCH (n) WHERE n.url = 'https://a/b' RETURN n.id AS id ORDER BY id",          // a slash in a string
    "MATCH (n) RETURN n.id AS id /* a / b */ ORDER BY id",
    "MATCH (n) RETURN n.id AS id, avg(n.v) AS a, percentileCont(n.v, 0.5) AS m, max(n.v) AS mx ORDER BY id", // aggregates over NaN do not crash
  ];
  for (const q of fine) it(`accepts ${q.slice(0, 80)}`, () => expect(nanRisks(q)).toEqual([]));
});

// Every query below was run on a throwaway FalkorDB 6.0.2 (docs/notes/falkordb-reply-compact-panic.md): the ones in
// `crashed` took the server down when the key was missing; the ones in `safe` did not, with the same data.
describe("nullableGroupKeys: a RETURN that aggregates beside a key that can be null", () => {
  const crashed = [
    "MATCH (c:Entity {id:'c'}) RETURN count(c) AS n, c.phone AS p",
    "MATCH (c:Entity {id:'c'}) OPTIONAL MATCH (c)-[p:PART_OF]->(:Business {id:'b'}) RETURN c.address AS a, c.hours AS h, count(p) AS n, c.phone AS x",
    "MATCH (a:Approval {id:'a1'}) RETURN a.id AS id, a.title AS t, count(a) AS n",
    "MATCH (c:Entity:Channel) RETURN c.address AS a, c.phone AS p, max(c.id) AS m",
    "MATCH (c:Entity:Channel) RETURN collect(c.id) AS n, c.phone AS p",
    "MATCH (c:Entity:Channel) RETURN 'a' AS a, null AS p, max(c.id) AS m",
  ];
  const safe = [
    "MATCH (c:Entity:Channel) WITH c.address AS a, c.phone AS p, max(c.id) AS m RETURN a, p, m",
    "MATCH (c:Entity:Channel) WITH c, c.phone AS p RETURN count(c) AS n, p",
    "MATCH (c:Entity:Channel) RETURN count(c) AS n, labels(c) AS l, {p: c.phone} AS m, coalesce(c.phone, '') AS q",
    "MATCH (b:Business) OPTIONAL MATCH (x)-[r:PART_OF]->(b) RETURN b.id AS id, count(x) AS c ORDER BY c DESC, id LIMIT 1",
    "MATCH (c:Entity) RETURN c.id AS id, c.phone AS p",                       // no aggregate
    "MATCH (c:Entity) WITH c, count(*) AS n RETURN c.phone AS p, n",           // aggregate only in the WITH
    "MATCH (c:Entity) RETURN DISTINCT c AS c, count(*) AS n",
  ];
  it("flags each shape that crashed", () => {
    for (const q of crashed) expect(nullableGroupKeys(q).length, q).toBeGreaterThan(0);
  });
  it("lets the safe shapes through", () => {
    for (const q of safe) expect(nullableGroupKeys(q), q).toEqual([]);
  });
  it("groupInWith rewrites an agent's query into the safe shape, keeping the columns and the sort", () => {
    expect(groupInWith("MATCH (n:Entity) RETURN n.asOf AS d, count(*) AS c ORDER BY c DESC, d LIMIT 5"))
      .toBe("MATCH (n:Entity) WITH n.asOf AS d, count(*) AS c ORDER BY c DESC, d LIMIT 5 RETURN d, c");
    expect(groupInWith("MATCH (o:Observation) RETURN DISTINCT o.metric, sum(o.value) AS total"))
      .toBe("MATCH (o:Observation) WITH DISTINCT o.metric AS `o.metric`, sum(o.value) AS total RETURN `o.metric`, total");
    expect(groupInWith("MATCH (n) WHERE n.name = 'a, b' RETURN n.kind AS k, collect(n.id) AS ids"))
      .toBe("MATCH (n) WHERE n.name = 'a, b' WITH n.kind AS k, collect(n.id) AS ids RETURN k, ids");
    for (const q of crashed) expect(nullableGroupKeys(groupInWith(q)), q).toEqual([]);
    for (const q of safe) expect(groupInWith(q)).toBe(q);
  });

  it("assertSafeQuery refuses one, naming the fix", () => {
    expect(() => assertSafeQuery(crashed[0]!)).toThrow(UnsafeQuery);
    expect(() => assertSafeQuery(crashed[0]!)).toThrow(/^Group in a WITH first/);
  });
});

describe("assertSafeQuery", () => {
  it("throws UnsafeQuery, with the fix first, for a tie-prone sort", () => {
    expect(() => assertSafeQuery("MATCH (n) RETURN n ORDER BY n.v")).toThrow(UnsafeQuery);
    try {
      assertSafeQuery("MATCH (n) RETURN n ORDER BY n.v");
    } catch (e) {
      expect((e as Error).message).toMatch(/^Add , x\.id as the last sort key/);
      expect((e as Error).message.length).toBeLessThan(300); // the cypher tool shows the model the first 300 characters
    }
  });

  it("throws UnsafeQuery for a NaN-prone sort, naming the guard", () => {
    expect(() => assertSafeQuery("MATCH (n) RETURN n.id AS id, n.a / n.b AS r ORDER BY r, id")).toThrow(/CASE WHEN .* = 0/);
  });

  it("lets safe queries, DDL and writes without a sort through", () => {
    for (const q of ["MATCH (n) RETURN n ORDER BY n.id", "CREATE INDEX FOR (n:Entity) ON (n.id)", "MERGE (n:Entity {id:$id}) SET n += $props"]) {
      expect(() => assertSafeQuery(q)).not.toThrow();
    }
  });
});

describe("blankLiterals", () => {
  it("blanks strings, backtick names and comments, keeping every offset", () => {
    const q = "A 'x' `y` /* z */ B // w\nC";
    const b = blankLiterals(q);
    expect(b).toHaveLength(q.length);
    expect(b.replace(/\s+/g, " ")).toBe("A B C");
  });
});
