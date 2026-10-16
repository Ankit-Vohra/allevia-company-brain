# FalkorDB 6.0.2: a RETURN that aggregates beside a null key panics the server (issue #29)

2026-10-15 22:31 IST the shared FalkorDB (`allevia-falkordb`, :6390) crashed while the public-data tool tests ran, and the
restart then looped on a corrupt append-only file. The trigger was a test's own read query. This note gives the minimal
repro, what was ruled in and out, and the guard.

## The panic

```
<module> FalkorDB panic: panicked at src/reply.rs:655:58:
called `Option::unwrap()` on a `None` value
   9: falkordb::reply::reply_compact
  10: falkordb::graph_core::execute_query
```

The module panics while it builds the compact reply (the format every client here uses), so the whole server process
dies, for every graph and every agent, and any write not yet saved is lost.

## Minimal repro (throwaway server only)

```
docker run -d --name falkor-repro -p 127.0.0.1:6396:6379 -e "REDIS_ARGS=--appendonly no --save ''" falkordb/falkordb:6.0.2
redis-cli -p 6396 GRAPH.QUERY g "CREATE (:A {id:'c'})"
redis-cli -p 6396 GRAPH.RO_QUERY g "MATCH (c:A) RETURN count(c) AS n, c.phone AS p" --compact   # c.phone is missing: the server dies
```

`GRAPH.QUERY` and `GRAPH.RO_QUERY` both die. Never run this against :6390.

## What crashed and what did not

All on the same data: a node with `address` (string), `hours` (list), `phoneListed` (boolean) and no `phone`, sometimes a
second node with only `address`. Scripts: one probe per query, `PING` after each, the container restarted after a panic.

| Query (RETURN clause) | Result |
|---|---|
| `count(c) AS n, c.phone AS p` | panic |
| `count(c) AS n, null AS p` | panic |
| `'a' AS a, null AS p, max(c.id) AS m` | panic |
| `c.id AS id, c.title AS t, count(c) AS n` (one row, `title` missing) | panic |
| `c.address AS a, c.phone AS p, max(c.id) AS m` (two rows, `phone` missing on both) | panic |
| `c.address AS a, c.hours AS h, count(p) AS n, c.phone AS x` (after OPTIONAL MATCH) | panic |
| `collect(c.id) AS n, c.phone AS p`, `max(c.id) AS n, c.phone AS p` | panic |
| same as above but `c.title` present on another row | no panic |
| `c.phone AS p, count(c) AS n` (one key, aggregate last) | no panic |
| `count(c) AS n, c.address AS a` (key never null) | no panic |
| `count(c) AS n, labels(c) AS l`, `properties(c)`, `{p: c.phone}`, `[c.phone]`, `coalesce(c.phone, '')` | no panic |
| `WITH c.address AS a, c.phone AS p, max(c.id) AS m RETURN a, p, m` | no panic |
| `WITH c, c.phone AS p RETURN count(c) AS n, p` (key bound earlier, returned as a bare variable) | no panic |

So the trigger is a grouping key in an aggregating RETURN that evaluates to null. Whether a given shape crashes also
depends on the column order, the number of rows and which rows have the value, so a query can pass every test and
crash on the first node that lacks a property. Grouping in a WITH and returning bare variables never crashed, in any
order tried. Map and list literals, `labels()`, `type()`, `properties()`, ids and `coalesce()` are never null.

## The guard

- `src/graph/safety.ts` rule 3, `nullableGroupKeys(cypher)`: in a RETURN that has an aggregate, every other column must
  be a bare variable, an id (`x.id`, `id(x)`), `labels()`/`type()`/`properties()` of a variable, a non-null literal, a
  map or list literal, or a `coalesce(...)`. `assertSafeQuery` (which every `GraphHandle` query goes through) refuses
  anything else with the fix: `WITH x, count(y) AS n RETURN x.prop AS prop, n`.
- `tests/graph/cypher-sources.test.ts` holds every Cypher string in `src/` to the rule; `tests/graph/safety.test.ts`
  holds the rule to the table above.
- The `cypher` tool (queries the agents write) runs `groupInWith(query)` first, which moves a flagged RETURN into a WITH
  and returns the same columns, so an agent's natural `RETURN n.kind AS k, count(*) AS c` still works.
- 13 queries in `src/` had the shape and were moved into the safe form (same rows, same columns). Several could crash
  production on ordinary data: `trace_decision` on a Decision with no summary or date, `readExisting` when a
  Recommendation has no `whyTemplate`, Today's note on an Approval with no title, the recall of a Memory with no kind.
  Seven test queries were fixed the same way.

The rule is conservative: it also refuses some shapes that happened not to crash (`c.phone AS p, count(c) AS n`), because
the same shape crashed with other rows.
