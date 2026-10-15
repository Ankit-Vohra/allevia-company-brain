# FalkorDB 6.0.2: the queries that crash it

FalkorDB 6.0 is a new Rust engine (released 2026-09-29). On 6.0.2 two query shapes make it panic. The module
aborts, the server restarts, every graph written since the last save is gone, and every agent's connection drops.
The shared server did this three times on 2026-10-15. This note is what was measured, what is guarded, and what
was not reproduced. Everything here was run on throwaway containers; nothing needs real data.

The panic, from the server log:

```
FalkorDB panic: panicked at …/core/src/slice/sort/shared/smallsort.rs:
user-provided comparison function does not correctly implement a total order
  … graph::runtime::ops::sort::SortOp::build_full_sort …
```

Rust's sort panics when it notices a comparator that is not a total order, and it only checks from 21 rows up
(its small-slice insertion sort never looks). Both crashes are that panic.

## 1. A tied sort over rows that hold maps with nulls

Run `scripts/spikes/falkordb-sort-crash.ts` against a throwaway server to see all of this (it refuses the shared
port). The minimal case: 25 `Task` and 25 `Doc` nodes, `asOf` null on every other `Task` and a different date on the
`Doc`s, then

```cypher
MATCH (n:Entity) WITH n, 1.0 AS score
RETURN {id: n.id, asOf: n.asOf} AS m, score ORDER BY score ASC      // crashes, 2 of 2 on fresh graphs
```

| Variant (same data unless noted) | 6.0.2 |
|---|---|
| the query above, or `ORDER BY score DESC` | crashes |
| `ORDER BY score ASC, n.id` (a unique last key) | survives |
| any `LIMIT` (10, or 100 on 50 rows): a top-k, not a full sort | survives |
| scalar columns (`n.id AS id, n.asOf AS asOf`) instead of the map | survives |
| a list column `[n.id, n.asOf]` instead of the map | survives |
| `asOf` set on every node, or on none | survives |
| one date plus nulls (single label) | survives at 50 rows; not safe in general (see below) |
| 18 or 20 rows | survives; 22, 24, 26 rows crash |
| no `Entity` label, no indexes, no vectors, no edges | crashes the same |
| ties on a property key (`ORDER BY r.since`, `t.at`) over our swarm graph, no LIMIT | survived |

What it takes, as far as the runs show: at least 21 rows, a full sort, ties on the key (so the engine orders the
tied rows by comparing the rest of the row), and a **map column in which some rows hold a null where others hold a
value** (every `NODE()` map has `asOf` and `simulated`, which are null on many nodes). The key can be a constant,
`size(labels(n))`, `n.rev`, a vector score, or a string. Which row counts trip Rust's check varies: on the test
graph's vector query, 30 and 50 rows crashed while 21 and 40 did not. A query that sorts tied rows can
therefore pass for months, which is why the fix is a rule, not a hunt:

> **The last key of every `ORDER BY` is unique** (`x.id`, `id(x)`, an alias of one, or the grouping columns of an
> aggregation), so rows never tie and the engine never compares the rest of the row.

The API builder's crash was this: `search`'s vector queries sorted on `score` alone with `NODE()` maps projected, and
43 of 50 scores tie at 1 (orthogonal vectors). `ORDER BY score ASC, node.id` fixed it (d7754b4).

## 2. NaN in a sort key

```cypher
UNWIND range(0, 49) AS i WITH i, toFloat(0) / toFloat(i % 5) AS r
RETURN i, r ORDER BY r ASC                     // crashes (0/0 is NaN; 0/x is 0)
```

Float division by zero is `NaN` (0.0/0.0) or `±Infinity` (x/0.0); integer division by zero is an error ("Division
by zero"). `sqrt(-1)` and `log(-1)` are NaN too. Infinity sorts fine; NaN does not.

| Variant | 6.0.2 |
|---|---|
| 50 rows, one NaN in five, `ORDER BY g ASC` | crashes |
| the same with `ORDER BY g ASC, i`, or in `WITH … ORDER BY g` | crashes (**a unique key does not help**) |
| the same `DESC` | survived (not safe: the check depends on the arrangement) |
| every value NaN | survives (all equal) |
| 6 rows, or `ORDER BY g ASC LIMIT 10` | survives |
| mixed `Infinity` and numbers | survives |
| `WHERE g = g` before the sort, or a `CASE WHEN d = 0 … THEN null` guard | survives |

NaN is only a problem in a **sort key**. `avg`, `percentileCont`, `max`, `min` over NaN, `NaN = NaN` (false),
`NaN <> 1` (true) and `NaN < 1` (false) are harmless, and so is NaN in a plain `RETURN`.

## Not reproduced

- **OPTIONAL MATCH … WITH count() chains.** `a85239c` replaced one in the capability ladder, saying FalkorDB had
  crashed on it. The verbatim old query, three shorter versions and thirty other `OPTIONAL MATCH … WITH … collect()`
  shapes (after `WITH … WHERE`, with `collect(DISTINCT …)`, over empty sets, on a 141-node graph) did not crash 6.0.2.
  It may have been one of the sorts above, running at the same time. If someone has the exact query, add it to the
  script.
- `DISTINCT`, `collect(DISTINCT …)`, grouping on a nullable key and string sorts over 21+ mixed rows: no crash.

## What the repo does

1. **Every `ORDER BY` in `src/` ends in a unique key** (25 fixed; two grouped sorts now sort on the aggregating
   `WITH`). `tests/graph/cypher-sources.test.ts` reads every string literal in `src/` and fails on a sort that can
   tie or a sorted value that can be NaN. `src/graph/safety.ts` holds the rule.
2. **`GraphHandle.query` and `roQuery` refuse a query with either shape** before sending it (`UnsafeQuery`, with the
   fix first; the `cypher` tool shows the model the first 300 characters). `{ unchecked: true }` skips the check, for
   crash experiments on a throwaway server only; the static test fails if `src/` uses it.
3. **Writes cannot store NaN or Infinity.** The client rejects a non-finite number anywhere in a param (nested lists
   and maps too); `upsertNode`, `upsertEdge` and `addObservation` validate first; a per-node algorithm's NaN score is
   dropped instead of sorted or written (`finiteRows`). The Cypher in `src/` has no division, `sqrt`, `log` or `^`
   at all (a static test keeps it so), so nothing in the database computes a NaN either.
   `tests/graph/nan-writes.test.ts` covers every write path.
4. **A subnormal double is sent as 0.** The server's parser refuses one ("Float overflow '5e-324'"), and a decaying
   weight can reach it (`Math.exp(-745)`). (Separately: the server prints doubles with 15 digits, so
   `Number.MAX_VALUE` reads back as `1.79769313486232e+308`, which JavaScript parses as Infinity. Nothing real is
   that large.)
5. **`tests/regression/degenerate-graph.test.ts`** builds a graph of ties, zeros and gaps (24 identical neighbours on
   every relationship the ontology allows, with the null mix above, identical vectors, zero spend and impressions,
   subjects with no numbers) and runs all 21 tools, the server reads, the 14 detectors, the brief, memory, approvals,
   the capability ladder, the librarian and the privacy scan over it, then each crash shape's safe form. It also
   checks that each unsafe form is refused. It never sends an unsafe query to the shared server.

**Why the guard reads text and does not catch the crash.** After the panic the process is gone: nothing can be
caught or retried, and the writes are already lost. The only place to stop it is before the query is sent. The check
is a text analysis, not a parser: it knows the shapes this codebase writes, errs toward refusing, and cannot tell
that `UNWIND $ids AS id … ORDER BY id` may repeat an id (it refuses that too). The CASE guard test (does the WHEN test
the denominator?) is a heuristic.

**Writing a query.** End the sort with `, x.id` (or `id(x)` for an edge). Sort a grouped result on the `WITH` that
aggregates, with every grouping column in the keys. Do not divide in Cypher: compute the ratio in TypeScript, where a
zero denominator is a `null`. If you must, `CASE WHEN d = 0 OR d IS NULL THEN null ELSE x / d END`, or `WHERE x = x`
before the sort.

## Is 4.22 (the stable line) an option?

Measured on `falkordb/falkordb:v4.22.0` with the same settings as the shared server, the full suite on the tree
described above.

**It survives every crash shape**: `scripts/spikes/falkordb-sort-crash.ts` shows all three cases that kill 6.0.2
surviving on 4.22, and so did the tied vector search (k = 30 and 50), the constant-key sort over 141 mixed entities and
all five NaN sorts. The syntax the repo uses all works: `CREATE VECTOR INDEX`, full-text, `db.idx.*`, `RO_QUERY`,
`TIMEOUT`, `algo.pageRank / betweenness / WCC / labelPropagation`.

**1395 of 1409 tests pass** (the two live-model tests are skipped). The 14 that fail are four causes:

| Cause on 4.22 | Tests | A contained fix (sketched, not applied) |
|---|---|---|
| `ORDER BY length(p)` after a RETURN that does not project `p` fails (`Unable to locate a value with alias p`) | 6: `trace_decision` (3), `who_owns`, provenance, the MCP `trace_decision` | project it: `length(p) AS len … ORDER BY len, o.id` (`decisions.ts` x2, `people.ts`); the same query works on both |
| `algo.SPpaths` returns the right shortest paths **longest first** (`[3,3,2,2,1]`; 6.0.2 `[1,2,2,3,3]`; `pathCount: 1` is right on both) | 4: `algorithms` (2), `find_paths`, projection perf | sort by length ascending in `shortestPaths` (`graph/algorithms.ts`); a no-op on 6.0.2 |
| `OPTIONAL MATCH (ag)-[:PRODUCED]->(rec)` after an OPTIONAL MATCH that left `rec` null fails (`expected Node`) | 3: `readRow` in `actions/approvals.ts` (an approval with no recommendation), seen through the Discord bot and two server tests | read the producer in a second plain query, as `capabilities/ladder.ts` already does |
| the same family, silently: `agentStats` is a 6-step OPTIONAL MATCH … WITH chain and returns zeros | 1: `server/ask` agent stats | one plain grouped read per figure, merged in TypeScript |

Each is a few lines in `src/graph` or one query, and none needs a change to the model. Two behaviours are not
failures but matter more:

- **No query timeout on 4.22 over a dense graph.** On the test swarm (1.5k nodes, 26k edges), `neighbors` with
  `depth: 2` from a hub (a variable-length `[*1..2]` with `ALL(r IN relationships(p) WHERE …)`) ran for over 355 s and
  was still going (until the container was restarted), though the tool sends `TIMEOUT 8000`; `algo.SPpaths` from a hub
  to a node one edge away did the same. 6.0.2 answers the depth-2 expansion in about 2 s and stops a path search at
  its timeout. 4.22 appears to build every path before it filters, and to check its timeout between records, not
  inside one. A single question about a hub could therefore hold one of the four worker threads for good (four such
  questions would freeze reads) without crashing the server. Sparse graphs are fine; a real company graph has hubs
  (a Business or Channel that most things point at).
- Seeding the swarm took 3 s on 4.22, so the cost is in reads of dense neighbourhoods only.

**Recommendation: stay on 6.0.2 with the guards, for now.** Every crash shape found on 6.0.2 is refused before it is
sent (`GraphHandle`), held out of `src/` by the static scan, and the regression runs all tools over a graph built to
trip them. Moving to 4.22 trades a crash that is now guarded for four rewrites to re-verify and a failure mode with no
guard (a query that never ends on a hub), which a hackathon demo is less able to survive than a restart with the
append-only file now on. The catch: the guards are only as good as the shapes found, and one crash another agent
reported (an OPTIONAL MATCH followed by `collect()` after `WITH … WHERE`) did not reproduce, so it is not covered. If
another shape turns up that the text check cannot see, 4.22 is the way out: all four fixes above are small, and the
dense-graph cliff can be bounded by capping `depth` and `maxLen` on hubs.

## Reproducing

```
docker run -d --name crashlab --restart unless-stopped -p 127.0.0.1:6391:6379 falkordb/falkordb:6.0.2
CRASHLAB_URL=redis://127.0.0.1:6391 npx tsx scripts/spikes/falkordb-sort-crash.ts
ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6391 npx vitest run --no-file-parallelism   # the whole suite, on the throwaway
docker rm -f crashlab
```

The Cypher in `scripts/spikes/` (older probes) uses a raw client and is not guarded.
