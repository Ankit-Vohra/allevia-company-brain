# Submission form: the three FalkorDB answers

Each answer is ready to paste; the backticks can stay or go,
depending on whether the form shows Markdown.

Where each claim comes from: `docs/falkordb-queries.md` (every query, with file and line, held to the code by a test),
`docs/graph-audit.md` (the token measurement, 17 October), `docs/notes/` (the FalkorDB 6.0.2 crash shapes and the
upstream report), `docs/falkordb-cloud.md` (the 4.22 differences), `tests/helpers/cypher-lint.ts` (the lint rules) and
`src/graph/` (client, safety, indexes, algorithms, gate, reference, hygiene).

---

## 1. How did you use FalkorDB in your project?

Allevia is a company brain for founders. Each business gets its own FalkorDB graph (`allevia_<slug>`), beside a registry
graph (`allevia_meta`) and a shared, read-only graph of general know-how (`allevia_reference`). 13 AI agents answer from
it. The problems FalkorDB solved:

- **Keeping businesses apart.** Isolation is the graph boundary: no query filters by tenant, and no agent tool takes a
  graph name.
- **Finding where to start.** Vector indexes (384-dimension multilingual embeddings, made locally) and full-text indexes
  on a `Searchable` label and on text chunks, merged by reciprocal rank. A chunk hit answers as its source document, so
  citations point at sources.
- **Explaining "why".** `algo.SPpaths` joins up the path drawn under each answer. A hop-by-hop walk over `DEPENDS_ON`,
  `AFFECTS` and `BLOCKS` answers "what breaks if this stops". `algo.pageRank` ranks what matters;
  `algo.labelPropagation` groups topics.
- **Remembering change.** Every edge carries two clocks (when it was true, when we recorded it), a source and a date.
  Facts are closed, never deleted; every tool takes `asOf`. `algo.*` can't filter on edge properties, so closed edges
  carry a high `closedCost` that SPpaths prunes with `maxCost`; ranking runs on a cached projection of current edges.
- **Provenance down to the line.** A recorded meeting (Fireflies, Granola or a forwarded transcript) is split into line
  chunks linked to their speakers; each decision is `BASED_ON` its line and each action points back at the line it came
  from, so the founder can open any task and see the exact words that created it.
- **Checking answers.** Metric readings are `Observation` nodes with a source. The server checks that every cited node,
  and every number, came from a tool in that turn.
- **Safe agent Cypher.** The agents' raw Cypher tool runs through `GRAPH.RO_QUERY`, with a procedure allow-list and a
  5-second timeout.

Measured on Aamdani (17 October): one agent reading the graph used 8× fewer tokens than pasting in the documents (75k
against 604k) and took 43% less time.

---

## 2. What did you like about FalkorDB?

- **A graph per business costs nothing extra.** Isolation, per-business export and per-business memory figures
  (`GRAPH.MEMORY USAGE`) came almost free.
- **One engine for search and walks.** Vector, full-text and range indexes are plain Cypher DDL, next to Cypher walks
  and graph algorithms.
- **`GRAPH.RO_QUERY`.** The server itself refuses writes, which is what let us give agents a raw Cypher tool.
- **`costProp` and `maxCost` in `algo.SPpaths`.** They let us skip historical edges inside the search.
- **Speed.** On a 37,240-node, 49,983-edge test graph on a laptop: a four-hop impact walk in 7–36 ms, full-text search
  under 1.2 ms, PageRank in 12 ms once the projection was cached.
- **`GRAPH.EXPLAIN`.** Our tests use it to check that every id lookup uses the index.

---

## 3. What improvements would you like to see in FalkorDB?

All from things we hit this week; the repros and notes are in our repo (`docs/notes/`, `docs/falkordb-cloud.md`,
`tests/graph/`).

- **Let a bad query fail on its own.** On 6.0.2, three query shapes panicked the module and stopped the whole server: a
  full sort over 21+ tied rows holding maps with nulls, a NaN in a sort key, and an aggregate beside a null column
  (issue #3150; its fix, PR #3229, was still open on 18 October).
- **Flag a cut result.** Rows past `RESULTSET_SIZE` are dropped silently.
- **Count what the pattern says.** On 6.0.2, parallel edges collapse under `count`, `collect` or `sum` when the query
  doesn't refer to the edge.
- **Edge-property filters in `algo.*`**, for graphs that keep history.
- **A way to stop a running query.** We found only timeouts; we'd also like per-query timeouts on writes.
- **Complete append-only file entries.** A node created and deleted in one query wrote no effects, so the file failed to
  load on restart.
