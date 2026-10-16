# The Cypher and graph algorithms Allevia depends on

Every query below is taken from the code (the `file:line` points at it), with what it answers, its parameters, why a
table would not do, and a plan or timing note where it matters. Each `cypher` block in this file is checked by
`tests/graph/queries-doc.test.ts`: it must pass the FalkorDB 6.0.2 crash rules (`src/graph/safety.ts`) and plan with
`GRAPH.EXPLAIN` on a seeded throwaway graph, and every `file:line` here must exist. The blocks show the query with its
interpolated pieces filled in (a relationship type, a label); the code builds them from validated identifiers only and
sends every value as a `$parameter`.

**How these were checked (15 October 2026).** On a throwaway FalkorDB 6.0.2 (`docker run falkordb/falkordb:6.0.2`, the
module arguments from `docker-compose.yml`), never on a live business graph:

- `demo_seed`, the synthetic demo company (`npx tsx scripts/seed-demo.ts demo_seed --register`, 149 nodes): each tool
  below was run and its answer read (results quoted in the sections).
- `bench_hackathon`, a synthetic graph built for timing (37,240 nodes, 49,983 edges: 2,000 systems in a dependency
  DAG, 3,000 tasks, 2,000 documents, 30,000 observations), with the full schema. Timings are wall-clock from Node on a
  laptop, best of 3 unless marked; they are for orders of magnitude, not benchmarks.

| Query | demo_seed | bench_hackathon |
|---|---|---|
| `impact_of` depth 1 / depth 4 | 7 ms / 7 ms | 5-16 ms / 7-36 ms (capped at 60 items) |
| `find_paths` (`algo.SPpaths`, up to 3 paths, 6 hops, both directions) | 26 ms | 135-218 ms |
| `important` (`algo.pageRank`), first call builds the projection | 51 ms | 696 ms cold, 12 ms warm |
| `topics` (`algo.labelPropagation`) | 4 ms | 136 ms |
| `latestFor` one subject (200 daily readings) | | 1-6 ms |
| full-text on `Searchable` | 2 ms (whole `search` tool) | under 1.2 ms |

## 1. One graph per business

| | |
|---|---|
| Code | `src/graph/client.ts:54` (`graphName`), `src/graph/tenants.ts:77` (`ensureTenant`), `src/graph/tenants.ts:91` (registry row) |
| Answers | Which graph a request may touch. Every business is `allevia_<slug>`; `allevia_meta` holds one `Tenant` per business. |
| Why a graph | Isolation is the graph boundary: no query in the product has a `WHERE tenant = …`, and no tool takes a graph name. Moving a business to another server is one key (`DUMP`/`RESTORE`). |

```cypher
MERGE (t:Tenant {slug:$slug}) ON CREATE SET t.createdAt = $now SET t += $props, t.updatedAt = $now
```

Reads go through `GraphHandle.roQuery` (`src/graph/client.ts:129`), which sends `GRAPH.RO_QUERY`: the server itself
refuses a write there. The agents' `cypher` escape hatch, the MCP server and every API read use it.

## 2. Name resolution before any query runs

| | |
|---|---|
| Code | `src/agent/tools/common.ts:383` (`notInRecords`), `src/agent/tools/common.ts:388` (`requireNode`), `src/agent/tools/common.ts:402` (`byExactName`) |
| Answers | "Is this thing in your records, and which node is it?" An id (`system:ig-connector`), a merged duplicate's id, or an exact name in any case ("instagram CONNECTOR"). |
| Parameters | `$id`; for a name, the full-text query below. |
| Why | An unknown name must come back as *"I don't have that in your records"*, never as an empty traversal that reads like "nothing depends on it". |

```cypher
MATCH (n:Entity {id:$id}) OPTIONAL MATCH (c:Entity {id: n.mergedInto})
RETURN n.id AS id, labels(n) AS labels, n.name AS name, c.id AS canonical LIMIT 1
```

Checked: `impact_of {"query":"Payroll gateway"}` returns `I don't have "Payroll gateway" in your records.` (4 ms);
`{"query":"instagram CONNECTOR"}` resolves to `system:ig-connector`. Plan: `Node By Index Scan | (n:Entity)` (range
index on `Entity.id`, with UNIQUE and MANDATORY constraints, `src/graph/migrate.ts:164`).

## 3. "What breaks if X stops": depth 1 vs depth 4 (`impact_of`)

| | |
|---|---|
| Code | `src/agent/tools/impact.ts:87` (one query per hop), `src/agent/tools/impact.ts:111` (the impact subgraph), `src/agent/tools/impact.ts:127` (is it mapped at all) |
| Answers | What `DEPENDS_ON` X, and what X `AFFECTS` or `BLOCKS`, hop by hop up to `depth` (1-4), each item with the edge that pulled it in, plus X's betweenness on that subgraph. |
| Parameters | `$ids` (the frontier), `$seen` (already found), `$k` (cap, 60 in all), `$asOf` (optional, epoch ms). |
| Why a graph | Depth 1 is what a join gives. On the demo company, the Instagram connector's depth-1 answer is 3 things; depth 4 is 6, and the two that matter for the week (the weekly reel batch at hop 3, the Diwali launch week at hop 4) are invisible to a one-hop look. Each comes with its path: connector ← needs it ← reel publisher ← needs it ← reels scheduler ← needs it ← weekly reel batch ← held up by it ← Diwali launch week. |

One hop (the code sends the two branches as one `UNION ALL`):

```cypher
UNWIND $ids AS fid MATCH (f:Entity {id:fid}) WITH f
MATCH (x:Entity)-[r:DEPENDS_ON]->(f) WHERE r.until IS NULL AND NOT x.id IN $seen
WITH x, head(collect({from: startNode(r).id, type: type(r), to: endNode(r).id})) AS e
RETURN x.id AS id, x.name AS name, e ORDER BY x.name, x.id LIMIT $k
UNION ALL
UNWIND $ids AS fid MATCH (f:Entity {id:fid}) WITH f
MATCH (f)-[r:AFFECTS|BLOCKS]->(x:Entity) WHERE r.until IS NULL AND NOT x.id IN $seen
WITH x, head(collect({from: startNode(r).id, type: type(r), to: endNode(r).id})) AS e
RETURN x.id AS id, x.name AS name, e ORDER BY x.name, x.id LIMIT $k
```

Plan: `Node By Index Scan | (f:Entity)` then `Conditional Traverse | (f)<-[r:DEPENDS_ON]-(x:Entity)`: each hop starts
from the id index and walks only the frontier's edges. A hop per query (not `[:DEPENDS_ON*1..4]`) keeps the first 60
by name at every hop stable on a hub with thousands of dependents, and mixes edge directions (reverse `DEPENDS_ON`,
forward `AFFECTS`/`BLOCKS`), which one variable-length pattern cannot.

Empty answers are told apart (the blog's "not in the graph" vs "no impact"):

```cypher
MATCH (s:Entity {id:$id}) OPTIONAL MATCH (s)-[r:DEPENDS_ON|AFFECTS|BLOCKS]-(:Entity) WHERE ID(r) >= 0 AND r.until IS NULL
RETURN count(r) AS c
```

`c = 0` is `not_mapped` ("in your records, but no dependencies are recorded; that is not the same as nothing depending
on it"); `c > 0` with nothing found is `nothing_depends`. The Brain page's "What breaks if something stops" panel
(`src/server/routes/graph-work.ts:38`, `GET /api/:t/graph/at-work`) shows depth 1 against depth 4 from these exact
calls.

## 4. How two things connect (`find_paths`, `show_path`): `algo.SPpaths`

| | |
|---|---|
| Code | `src/graph/algorithms.ts:65`, called from `src/agent/tools/paths.ts:21` (`find_paths`) and `src/agent/tools/paths.ts:95` (`show_path`, the path drawn under every answer) |
| Answers | Up to 3 shortest current paths between two nodes, any direction, at most 6 hops (`show_path`: 4). |
| Parameters | `$from`, `$to`, `$maxLen`, `$pathCount`, `$rels` (all semantic relationship types; memory plumbing such as `TOUCHED`/`CITED` is left out), `$maxCost`. |
| Why a graph | "How is Priya connected to the Instagram connector?" has no join to write: the answer is a path of unknown length through unknown types. |

```cypher
MATCH (a:Entity {id:$from}), (b:Entity {id:$to})
CALL algo.SPpaths({sourceNode: a, targetNode: b, relDirection: 'both', maxLen: $maxLen, pathCount: $pathCount,
  relTypes: $rels, costProp: 'closedCost', maxCost: $maxCost})
YIELD path RETURN path
```

`algo.*` cannot filter on edge properties, so an edge that ended carries `closedCost = 1e6` (set when it is closed) and
`maxCost` is `1e6 - 1`: SPpaths prunes closed edges inside the search and still finds the shortest current path. With
`asOf`, the same call runs on a projection of the edges valid then (section 6). Checked: Priya → Instagram connector
gives `person:priya -[KNOWS_ABOUT]-> channel:instagram -[DEPENDS_ON]-> system:ig-connector` and two longer paths (26 ms).
Plan: two `Node By Index Scan` anchors, then `ProcedureCall`.

## 5. Most connected (`important`): `algo.pageRank`

| | |
|---|---|
| Code | `src/graph/algorithms.ts:131`, from `src/agent/tools/ranking.ts:39`; the librarian stores it as `rank` (`src/ingest/librarian.ts:180`) |
| Answers | The most central things in the business, optionally one label and/or one relationship type ("core systems" = `System` over `DEPENDS_ON`). |
| Why a graph | Importance here is "how much of the business leads to it", a property of the whole link structure, not of any row. |

```cypher
CALL algo.pageRank('Searchable', null) YIELD node, score
WITH node.id AS id, score AS v WHERE id IS NOT NULL
WITH collect([id, v]) AS xs UNWIND range(0, size(xs) - 1, $page) AS i RETURN xs[i..i + $page] AS part
```

Rows are packed into lists (`$page` = 5,000) because a result holds at most `RESULTSET_SIZE` rows and drops the rest
silently. It runs on the projection (section 6), where `Searchable` marks the business types, so readings, versions and
chunks do not dominate. Checked on demo_seed: Instagram connector, Systems map, Schedule two reels a week, Reel
publisher, Instagram.

## 6. Groups of related things (`topics`): `algo.labelPropagation`, and the projection under every algorithm

| | |
|---|---|
| Code | `src/graph/algorithms.ts:155`, from `src/agent/tools/ranking.ts:94`; stored communities read at `src/agent/tools/ranking.ts:85`; projection reads at `src/graph/projection.ts:149` and `src/graph/projection.ts:167`, writes at `src/graph/projection.ts:254` |
| Answers | Clusters of documents and the things they mention or link, each named by its best-connected members. |

```cypher
CALL algo.labelPropagation({relationshipTypes: $rels}) YIELD node, communityId
WITH node.id AS id, communityId AS v WHERE id IS NOT NULL
WITH collect([id, v]) AS xs UNWIND range(0, size(xs) - 1, $page) AS i RETURN xs[i..i + $page] AS part
```

The algorithms cannot see `until`, so they run on a slim projection graph (`allevia_<slug>__cur_…`) of the current
edges only: ids, type labels, `since`/`until`, no vectors or text, so it builds without the index rebuild a
`GRAPH.COPY` costs. It is cached until a write lands (an in-process counter plus a Redis stamp beside the graph, so a CLI
ingest invalidates the server's copy). Its node read, paged on the internal id:

```cypher
MATCH (n:Entity) WHERE id(n) >= $from RETURN id(n) AS nid, n.id AS id, labels(n) AS labels ORDER BY nid LIMIT $limit
```

Checked: demo_seed gives two groups ("Instagram, Salary reveal…, Instagram insights, September 2026" and "Instagram
connector, Reel publisher, Publisher runbook"). On bench_hackathon the first build is 696 ms for 37k nodes and 50k
edges; later calls reuse it (12 ms).

## 7. Facts with two clocks: the bi-temporal edge

| | |
|---|---|
| Code | `src/graph/edges.ts:91` (the upsert, one statement), `src/graph/edges.ts:149` (`closeEdge`), `src/graph/read.ts:20` (`currentEdge`), `src/agent/tools/common.ts:264` (`edgeAt`) |
| Answers | Writes a fact without ever deleting one: a re-assert refreshes provenance; a fact that ended keeps its edge with `until` (valid time) and `retiredAt` (when we learned it); a contradicted claim is stored closed with a reason. |
| Edge properties | `since`, `until`, `recordedAt`, `retiredAt`, `src`, `asOf`, `asOfMs`, `retiredAsOfMs`, `conf`, `closedCost`, `closeReason` |
| Why a graph | "Who owned this task on 1 October?" is a question about an edge at a time. The edge, not a row, carries when it was true and where it came from. |

Current and as-of reads differ only in the edge predicate:

```cypher
MATCH (o:Entity)-[r:OWNS]->(:Entity {id:$id})
WHERE (r.since IS NULL OR r.since <= $asOf) AND (r.until IS NULL OR r.until > $asOf)
RETURN o.id AS owner, r.since AS since, r.until AS until ORDER BY r.since, id(r) LIMIT 10
```

(`src/agent/tools/people.ts:27`; without `asOf` the predicate is `r.until IS NULL`.) Checked: `who_owns
task:fix-ig-token` is Priya now, the founder from 2026-09-25 to 2026-10-05, and `asOf 2026-10-01` gives the founder.

The closing write (`closeEdge`):

```cypher
MATCH (:Entity {id:$from})-[r:OWNS]->(:Entity {id:$to}) WHERE r.until IS NULL
SET r.until = CASE WHEN r.since > $end THEN r.since ELSE $end END, r.retiredAt = coalesce(r.retiredAt, $now),
    r.retiredAsOfMs = coalesce(r.retiredAsOfMs, $endedAsOf), r.closedCost = $cost, r.closeReason = $reason
RETURN count(r) AS c
```

**Parallel edges.** A fact that ended and came back is two edges between the same pair (one closed, one open).
FalkorDB 6.0.2 collapses parallel edges that nothing in the query refers to under `count`/`collect`/`sum`, so every
aggregate over a traversal binds and uses the edge (`WHERE ID(e) >= 0`, or a test on it). `tests/graph/parallel-edges.test.ts`
reproduces the collapse on the server, `tests/graph/cypher-sources.test.ts` holds every query in `src/` to the rule, and
`tests/agent/tools/impact-records.test.ts` checks a closed-and-reopened `DEPENDS_ON` is one dependent now, none in the
gap, one before.

## 8. Versions and functional edges

| | |
|---|---|
| Code | `src/graph/nodes.ts:126` (create, one `MERGE` with a per-call token), `src/graph/nodes.ts:184` (the Version, written in the same statement as the update), `src/graph/nodes.ts:48` (has this source's view been recorded), `src/graph/schema.ts:181` (`FUNCTIONAL_RELS`), `src/graph/edges.ts:84` (the slot inside the edge upsert) |
| Answers | What a task, decision, goal or reading looked like before it changed, one hop away; and "a task has one current owner", "an asset has one parent", "a business is in one program" enforced at write time. |

```cypher
MATCH (n:Entity {id:$id}) WHERE coalesce(n.rev, 0) = $rev
CREATE (n)-[h:HAD_VERSION]->(v:Entity:Version) SET v += $version, h += $hv
SET n += $props, n.rev = $rev + 1, n.updatedAt = $now
RETURN count(n) AS c
```

Compare-and-set on `rev`: two writers never both version the same state. A Version holds the old state as JSON plus
`since`/`until` in source time. For a functional relationship, a new holder closes the old one in the same statement
(OWNS into a Task: the founder's edge was closed when Priya's arrived). Reading the history:

```cypher
MATCH (n:Entity {id:$id})-[h:HAD_VERSION]->(v:Version) WHERE ID(h) >= 0
RETURN v.since AS since, v.until AS until, v.changed AS changed ORDER BY v.since, v.id
```

Checked: `task:fix-ig-token` has one Version (status `open`, 2026-09-25 to 2026-10-06).

## 9. Search: full-text and vector, fused, then a hop to the source

| | |
|---|---|
| Code | `src/agent/tools/search.ts:60` and `:66` (entities), `:62` and `:68` (chunks, then their Document), `src/agent/tools/common.ts:335` (`ftEntities`), indexes at `src/graph/indexes.ts:30` |
| Answers | Find things by words or meaning; a chunk hit answers as its parent Document, so citations point at sources. |
| Parameters | `$q` (terms, `t|t*`), `$v` (384-d multilingual e5 vector, computed locally), `$k`, `$types`. |

```cypher
CALL db.idx.fulltext.queryNodes('Searchable', $q) YIELD node, score
WITH node, score WHERE any(l IN labels(node) WHERE l IN $types) AND NOT node:Chunk
RETURN node.id AS id, node.name AS name, score ORDER BY score DESC, node.id LIMIT $k
```

```cypher
CALL db.idx.vector.queryNodes('Chunk', 'textEmbedding', $k, vecf32($v)) YIELD node, score
OPTIONAL MATCH (d:Document)-[:HAS_CHUNK]->(node)
RETURN node.id AS chunk, d.id AS doc, score ORDER BY score ASC, node.id
```

The four lists are merged by reciprocal rank (k = 60). The indexes sit on the `Searchable` label, not on every `Entity`,
so the 400-odd readings a business adds a day never crowd real things out. Every sort ends in `node.id`: FalkorDB 6.0.2
panics sorting tied rows (`docs/notes/falkordb-nan-crash.md`).

## 10. Numbers: the newest reading per metric

| | |
|---|---|
| Code | `src/agent/tools/observations.ts:31` (`latestFor`), `src/agent/tools/observations.ts:51` (`totalsFor`) |

```cypher
UNWIND $ids AS sid MATCH (o:Observation {subject: sid}) WHERE o.metricKey IN $metrics
WITH sid, o MATCH (o)-[r:MEASURES]->(s:Entity {id:sid}) WHERE ID(r) >= 0
WITH sid, o, r, coalesce(o.windowEnd, o.asOf) AS at
WITH sid, o.metricKey AS key, o, r, at ORDER BY at DESC, o.id DESC
WITH sid, key, head(collect({id: o.id, value: o.value, at: at})) AS x ORDER BY x.at DESC, key, sid
RETURN sid AS s, collect(x)[0..$per] AS xs
```

Plan: `Node By Index Scan | (o:Observation)` (range indexes on `Observation.subject` and `metricKey`), then one
traverse per reading. A number is never a property that gets overwritten: it is an `Observation` with a window, a date,
a source and `conf`, linked `MEASURES` to what it measures.

## 11. Memory: what a turn writes, and what the next one recalls

| | |
|---|---|
| Code | `src/agent/memory.ts:221` (`saveTurn`), `src/agent/memory.ts:249` (`CITED`, only for ids a tool returned this turn), `src/agent/memory.ts:298` (`KNOWS_ABOUT` grows once per turn), `src/agent/memory.ts:335` (recall before planning), `src/agent/tools/memory.ts:42` and `:49` (the `recall` tool) |
| Answers | Who asked, which agents worked (`HANDLED_BY`), what each produced (`Finding`, `PART_OF` the Turn, `CITED`, `BASED_ON` another agent's Finding: the handoff), what the owner asked to keep (`Memory` `ABOUT` things, `STATED` by them), and later: "what did we say about this before?" |
| Why a graph | Recall is a traversal from the things in the new question to the turns, findings and notes that touched them. |

```cypher
UNWIND $pairs AS p
MATCH (a:Entity {id:p.a}), (x:Entity {id:p.x})
MERGE (a)-[r:KNOWS_ABOUT]->(x)
ON CREATE SET r.since = $now, r.recordedAt = $now
WITH r, ($turn IN coalesce(r.turns, []) OR r.lastTurn = $turn) AS counted
SET r.weight = CASE WHEN counted THEN coalesce(r.weight, 1) ELSE coalesce(r.weight, 0) + 1 END, r.lastTurn = $turn
```

```cypher
MATCH (x:Entity) WHERE x.id IN $ids WITH x MATCH (t:Turn)-[:TOUCHED|CITED]->(x) WHERE coalesce(t.status, 'ok') = 'ok'
WITH DISTINCT t RETURN t.id AS id, t.question AS q, t.answer AS a, t.at AS at ORDER BY t.at DESC, t.id LIMIT 8
```

## 12. Provenance behind a cited answer

| | |
|---|---|
| Code | `src/agent/tools/common.ts:214` (`sourceRows`), `src/agent/tools/decisions.ts:38` and `:42` (`trace_decision`), Studio lineage at `src/studio/variants.ts:55` and `src/studio/revise.ts:157` |
| Answers | For every node a tool returns, the Document behind it: itself, its `SOURCED_FROM` targets, the Document named by its `src`, or a Chunk's parent. `trace_decision` walks Decision → `BASED_ON` evidence → its sources, `DECIDED` by whom, `SUPERSEDES` both ways. |

```cypher
UNWIND $ids AS oid MATCH (n:Entity {id:oid}) WITH oid, n MATCH (n)-[:SOURCED_FROM]->(d:Document)
WITH oid, d ORDER BY d.asOf DESC, d.id
WITH oid, collect(DISTINCT d)[0..$per] AS ds UNWIND ds AS d
RETURN oid AS of, d.id AS id, coalesce(d.title, d.name) AS title, d.asOf AS asOf
```

Checked: "pause daily stories" traces `decision:007-pause-daily-stories`, based on `document:ig-insights-sep` and the
reading `obs:signups_from_reels:channel:instagram:2026-09-30` (itself sourced to that report), decided by the founder,
superseding `decision:003-daily-stories`. The server then checks each `[[citation]]` in the answer was returned by a
tool in that turn (`src/agent/checks.ts`), and only those become `CITED` edges.

`DERIVED_FROM` is the Studio's lineage: every variant of a photo is an `Asset` `DERIVED_FROM` the original (with `step`
and `treatment`), and a revision `DERIVED_FROM` the variant it adjusted, with the owner's words kept. It is functional
(one parent per asset). Today it is written and shown per asset; no agent tool walks the whole chain yet. The walk is:

```cypher
MATCH p = (a:Entity {id:$id})-[:DERIVED_FROM*1..6]->(origin:Asset)
WHERE ALL(r IN relationships(p) WHERE r.until IS NULL)
RETURN [n IN nodes(p) | n.id] AS lineage ORDER BY length(p) DESC, origin.id LIMIT 1
```

## 13. The hero use case: "Why did sign-ups drop this week, and what should we do?"

| | |
|---|---|
| Code | `src/agent/tools/metrics.ts:131` (every step's level in one query), `src/agent/tools/metrics.ts:42` (`levelShift`, the day a level stepped), `src/agent/tools/paths.ts:58` (`show_path`, the ids it keeps), `src/agent/memory.ts:352` (what earlier answers' cards did), and the queries of sections 3, 4 and 11 |
| Answers | Which step of the sign-up flow fell and on which day; which screen it happens on; which crash is on that screen and which release brought it; what else breaks one step away against four; what we decided and where the cards from last time stand. |
| Why a graph | The cause is a path of unknown length through different kinds of things (a number, a flow step, a screen, a crash, a release, a person). A table would need a join written for this one question; the walk is the same for the next. |

The model, written by the ingest mappers (`src/ingest/sources/ops-map/app-health.ts`, `users.ts`) from the tracker's own fields, each edge with
its source, its date and how sure the source is: a flow step is a `Feature` (`kind: funnel_step`) that `DEPENDS_ON` the step
before it and on the `Page` (`kind: app_screen`) it happens on; a crash is an `Event` that `AFFECTS` that screen (`how: crashed_on`); a
release `AFFECTS` the crash (`how: introduced`, `conf` 0.9, only when the tracker names the release that first carried it);
the screen is `OWNS`ed by a person. Nothing is guessed: a crash with no route in its `where` gets no screen, and one with no first
release gets no release (Aamdani's records are like that, and the answer says so).

**What fell, and when.** Step by step, with no subject, one query ranks every step's latest reading on the server; the series
of each is read through the `Observation` indexes (section 10). The date the level stepped is a one-change-point fit in code
(`levelShift`: the single split of the series that leaves the least spread inside its two halves, reported only when the two
levels differ by 25% or more and each side has 3 readings), returned as `shift: {at, before, after, pctChange}` so the desk copies
numbers instead of computing them:

```cypher
MATCH (o:Observation)-[r:MEASURES]->(s:Entity) WHERE o.metricKey = $m AND ID(r) >= 0
WITH s, o, coalesce(o.windowEnd, o.asOf) AS at WHERE ($from IS NULL OR at >= $from) AND ($to IS NULL OR at <= $to)
WITH s, o, at ORDER BY at DESC, o.id DESC
WITH s, head(collect(o.value)) AS last ORDER BY last DESC, s.id
WITH collect(s.id) AS ids RETURN size(ids) AS subjects, ids[0..$k] AS top
```

**The chain, as one pattern.** What `find_paths` (`algo.SPpaths`, section 4) walks between a flow step and a release, written out for the
twin (`demo_growth`: Shiftly, synthetic). Do not alias a column with the name of a pattern variable (`RETURN scr.id AS scr`): FalkorDB 4.22
answers with a type error.

```cypher
MATCH (step:Entity {id:$step})-[d:DEPENDS_ON]->(scr:Page)<-[c:AFFECTS]-(crash:Event)<-[i:AFFECTS]-(rls:Event)
WHERE d.until IS NULL AND c.until IS NULL AND i.until IS NULL AND c.how = 'crashed_on' AND i.how = 'introduced'
RETURN scr.id AS screenId, crash.id AS crashId, rls.id AS releaseId, rls.releasedAt AS releasedAt, i.conf AS conf
ORDER BY crash.firstSeen, crash.id LIMIT 5
```

Checked on `demo_growth`: `feature:seekers-signup-phone-number-entered` → `page:screen/app/auth/sign-up` ← `event:sentry-issue-shiftly-41` ← `event:release-shiftly-2-8-0`
(2026-10-07, conf 0.9), the screen owned by Farhan. The answer's path is drawn by `show_path` over exactly these ids; it leaves out the cards
the team just proposed and Allevia's own staff, which are not part of why.

**What else breaks: depth 1 against depth 4** is `impact_of` (section 3) on the broken screen: one step away the next step and the ad campaign that sends
people in; four steps away the later steps, the job-alert texts, the employer applicant inbox and the first-hire promise.

**Last time.** Recall (section 11) now also reads what each earlier answer's cards did:

```cypher
UNWIND $ids AS tid MATCH (t:Entity {id:tid}) WITH t MATCH (t)-[rt:TOUCHED]->(a:Approval) WHERE ID(rt) >= 0 AND a.status IS NOT NULL
OPTIONAL MATCH (a)-[r1:RESULTED_IN]->(ac:Action) WHERE ID(r1) >= 0
OPTIONAL MATCH (ac)-[r2:RESULTED_IN]->(k:Task) WHERE ID(r2) >= 0
WITH t, a, head(collect(k.id)) AS task, head(collect(k.status)) AS taskStatus
RETURN t.id AS turn, a.id AS id, a.kind AS kind, a.title AS title, a.status AS status, a.decidedAt AS decidedAt, task, taskStatus
ORDER BY turn, id LIMIT 24
```

so a repeat of the question a day later says "the fix task you approved is open, the message is saved with your edit" instead of asking for the same cards.
`algo.pageRank` (section 5) ranks what is most connected on the Brain page; it is not part of this turn.

## 14. What is not used, and why

- No `GRAPH.COPY` for projections (it rebuilds vector and full-text indexes); no `algo.betweenness` on the tenant
  graph for `impact_of` (betweenness of a 60-node subgraph is computed in memory).
- Variable-length bounds are literals after a clamp (`*1..6`), not parameters.
- Projections and `algo.*` never see closed edges; a time-travel path runs on a per-call projection of the edges valid
  at `asOf`.
- The crash rules (every `ORDER BY` ends in a unique key; no unguarded division before a sort) are refused client-side
  before a query is sent, and held over all of `src/` by `tests/graph/cypher-sources.test.ts`.
