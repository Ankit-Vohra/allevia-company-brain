# FalkorDB best practices, and where Allevia stands

18 October 2026. Each business has its own brain: one FalkorDB graph per business (`allevia_<slug>`), a registry graph
(`allevia_meta`) and a shared, read-only reference graph (`allevia_reference`). The server is self-hosted FalkorDB 6.0.2
on allevia-dev. This page lists each FalkorDB practice that keeps a brain fast, small, correct and recoverable as it grows.
For each one it gives the source, where Allevia already follows it, and what is still missing.

Sources were read on 18 October 2026. `docs` means https://docs.falkordb.com and `#nnnn` means an issue at
https://github.com/FalkorDB/FalkorDB/issues/nnnn. The live numbers come from read-only commands on allevia-dev:
`GRAPH.MEMORY USAGE`, `GRAPH.SLOWLOG`, `INFO`, `GRAPH.CONFIG GET` and `GRAPH.RO_QUERY`.

## The short version

**Already in place:**
- one graph per business;
- parameterised queries;
- an `Entity.id` range index, with UNIQUE and MANDATORY constraints;
- full-text and vector indexes on the right labels;
- limits on time, memory, queue depth and result size, set at load time;
- paging under `RESULTSET_SIZE`;
- writes batched with UNWIND;
- facts that are closed, not deleted;
- the snapshot and the append log both on;
- nightly backups, both whole-server and per business;
- a guard against the 6.0.2 crash shapes.

**Added on this branch:**
- weekly roll-ups of old readings;
- an archive for passages and facts that are no longer used, with an exact undo;
- size budgets per business;
- a supernode check;
- `db:health`, which shows memory, persistence, budgets, supernodes, missing indexes, and the slow log with each plan;
- two lint rules: values must be passed as params, and a guard against a 6.0.2 index bug found today.

**Still open:** these need a decision or server access, and are listed at the end:
- the live append log has never been compacted;
- there is no memory ceiling;
- the plan cache is smaller than the number of query shapes;
- the archive needs a home in S3 that outlives the 35-day lifecycle;
- three known 6.0.x bugs need watching.

## 1. Indexes

**Practice.**
- Range-index every property used for equality or range filters and as a traversal start.
- Full-text and vector indexes are per (label, property).
- `<>` never uses an index.
- Check plans with `GRAPH.EXPLAIN`: `Node By Index Scan` is good, `Node By Label Scan` or `All Node Scan` is a scan.
- On 6.x, use the DDL `CREATE FULLTEXT INDEX`, not the `db.idx.fulltext.createNodeIndex` procedure (#2540).
- Sources: docs/cypher/indexing/range-index, docs/cypher/indexing/fulltext-index, docs/cypher/indexing/vector-index,
  docs/commands/graph.explain.

**Allevia.**
- Indexes:
  - range on `Entity.id` and on the Observation properties that readings are read by;
  - full-text on `Searchable.name/summary` and `Chunk.text`;
  - 384-d cosine vectors on `Searchable.embedding` and `Chunk.textEmbedding`;
  - all of these are in `src/graph/indexes.ts:30`.
- Indexes are created with DDL only (`src/graph/indexes.ts:108`).
- Every id lookup carries the `Entity` label, so the planner uses the index. A lint rule enforces this
  (`tests/helpers/cypher-lint.ts`, `tests/graph/cypher-sources.test.ts`).
- When the test suite ends, it EXPLAINs every query shape it ran (`tests/setup/query-shapes.global.ts`).

**Gaps.**
- Indexes are created back to back on one label. On 6.x that can leave the last one unpopulated while `db.indexes()`
  reports it as OPERATIONAL (#3389, open).
  - New: `db:health` lists the indexes that are missing.
  - Not done: a count check that each index really answers.
- **Found today: a 6.0.2 planner bug.**
  - Trigger: a pattern carries `Entity` and `Observation` and filters on `Entity.id` and on an indexed Observation
    property.
  - Effect: the query returns **no rows** and no error.
  - Details: `docs/notes/falkordb-two-label-index-scan.md`.
  - Guard: no product query has this shape. A new lint rule keeps it out (`tests/helpers/cypher-lint.ts:129`), and
    `tests/graph/two-label-index.test.ts` pins the bug.
  - Related upstream issue: #3248, where a range index and a full-text index on one attribute return no rows.
- No relationship indexes. The docs suggest them for traversals that pass through supernodes. Not needed at today's sizes.

## 2. Constraints

**Practice.**
- `GRAPH.CONSTRAINT CREATE … UNIQUE|MANDATORY`. UNIQUE needs a range index on the same property first.
- Constraints are built asynchronously. They end OPERATIONAL, or FAILED (and are then not enforced) when existing data
  breaks them.
- Source: docs/commands/graph.constraint-create.

**Allevia.**
- UNIQUE and MANDATORY on `Entity.id`, added after duplicates are merged (`src/graph/migrate.ts:162`).
- Their status is read back (`src/graph/client.ts:176`).

**Gaps.**
- 6.0.x inserts under a UNIQUE constraint are 35–120× slower and grow quadratically (#3330). It is fixed on main but not
  released.
- This only matters for big imports: a copy of aamdani (3,992 nodes) imported in 4 s.

## 3. Time, size and queue limits

**Practice.**
- Set `TIMEOUT_DEFAULT`/`TIMEOUT_MAX`, `RESULTSET_SIZE`, `QUERY_MEM_CAPACITY` and `MAX_QUEUED_QUERIES`.
- Set them at load time with `FALKORDB_ARGS`, because `GRAPH.CONFIG SET` does not survive a restart.
- The official image's default `FALKORDB_ARGS` is replaced as a whole when you set your own.
- Source: docs/getting-started/configuration, docs/commands/graph.config-set.

**Allevia.**
- All of these are set at load time. Values: 15 s default, 120 s max, 512 MiB per query, 500 queued, 10,000 rows.
- They are defined in `src/graph/server-config.ts:21` and passed in `docker-compose.yml`. `db:check` and now `db:health`
  report any drift.
- Reads that grow with the graph page by 5,000 rows (`src/graph/client.ts:46`).
- A busy server's refusal is retried with backoff (`src/graph/client.ts:89`).
- Live check: `GRAPH.CONFIG GET *` matches `SERVER_CONFIG`.

**Gaps.** None.

## 4. Memory

**Practice.**
- `GRAPH.MEMORY USAGE <graph>` gives a per-graph breakdown in MB. Indexes are often the biggest part.
- Use `maxmemory` with `noeviction` for a system of record: an `allkeys-*` policy can evict a whole graph, because a graph
  is one key.
- Memory freed by deletes is reused and not handed back at once (#1867).
- Sources: docs/commands/graph.memory, docs/operations/docker, https://redis.io/docs/latest/develop/reference/eviction/.

**Allevia.**
- `db:usage` warns from 80% (`src/graph/usage.ts`).
- `db:health` prints the server's memory and each graph's own.

**Live (18 Oct).**
- 82.5 MB used (peak 88), `maxmemory` 0 (no limit), `noeviction`.
- aamdani 12 MB, bluetokai 7 MB; the others are under 1 MB.

**Gaps.**
- **No `maxmemory`.** A runaway would grow until the 8 GB box swaps or the OS kills redis.
- Proposed: `maxmemory 3gb` with `noeviction`, so writes fail cleanly instead. This is a server setting, for the main
  session to apply.

## 5. Persistence: the snapshot and the append log

**Practice.**
- Use both RDB and AOF, with `appendfsync everysec`.
- Keep `aof-use-rdb-preamble yes`. With `no`, `BGREWRITEAOF` crashes (#2710).
- Watch `rdb_last_bgsave_status`, the AOF size, and rewrite status. A hung BGSAVE child let one user's AOF grow to 1.87 GB
  (#3204).
- On 6.x the append log records effects, not query text.
- Sources: docs/operations/durability, https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/.

**Allevia.**
- `--appendonly yes --appendfsync everysec` (`docker-compose.yml:19`).
- Live: RDB save points `3600 1 300 100 60 10000`, preamble `yes`, last snapshot ok.
- New: `db:health` reads `INFO persistence` and warns on:
  - no append log;
  - a failed snapshot;
  - no snapshot in a day;
  - an append log that has never been compacted.
  The checks are in `src/graph/health.ts:165`.

**Gap: the live append log has never been compacted.**
- It is 26 MB on a 119-byte base, with 0 rewrites since start. On a restart the server replays every write since the log
  began.
- Auto-rewrite waits until the log reaches 64 MB.
- One `BGREWRITEAOF`, run off-peak, folds the log into a snapshot preamble.
- This is a server command. See "Applying on the live server" below.

## 6. Backups

**Practice.**
- Scheduled snapshots, copied off the box. Test restores.
- `GRAPH.COPY` clones one graph with its indexes. Replication is not a backup.
- Sources: docs/operations/durability, docs/commands/graph.copy.

**Allevia.**
- `scripts/ops/backup-server.sh` runs nightly. It takes a `SAVE` checked with `redis-check-rdb`, plus a `db:export` of
  every business, and sends both to S3 (35-day lifecycle).
- A daily disk snapshot is also taken (7 kept).
- `db:export`/`db:import` are logical and versioned, and verified by digest (`src/graph/transfer.ts`).
- Any destructive tidy takes a checked `tenant:export` first. This covers `graph:reference-split` and, new,
  `graph:compact`.

**Gaps.**
- The script uses `SAVE`, which blocks. That is fine at 82 MB; `BGSAVE` and a wait would avoid the block as data grows.
- The new compaction archives (`~/allevia-db-backups/archive/`) are not uploaded yet, and the bucket's 35-day lifecycle
  would delete them anyway.
- They need a prefix that the lifecycle does not touch, or a separate bucket. That is a founder decision about cost.

## 7. The slow log, EXPLAIN and PROFILE

**Practice.**
- `GRAPH.SLOWLOG <graph>` keeps the 10 slowest queries over 10 ms, with their params.
- `GRAPH.EXPLAIN` plans without running.
- `GRAPH.PROFILE` runs the query, writes included, so it is never used on live data.
- Sources: docs/commands/graph.slowlog, docs/commands/graph.explain, docs/commands/graph.profile.

**Allevia.**
- New: `db:health` reads each graph's slow log and EXPLAINs each query again. It names any label or full scan
  (`src/graph/health.ts:128`).
- Params are left out of the output, because they can hold a name or an email.

**Live slow log (18 Oct).** The slowest entries, all reads:

| Query | Time | Why it is slow |
|---|---|---|
| Path between two nodes for lineage (`algo.SPpaths`) | 1.9 s | It passes through hubs |
| Map overview: degree of every node | 0.9 s on aamdani | It must count every link |
| Neighbour lookups by id | 0.6–0.7 s on bluetokai | They are index lookups, logged during a busy minute (export and rank writes) |

**Gaps.**
- The map query could read a stored degree, or use `indegree()`/`outdegree()`, instead of counting every link on each
  call. It is on the demo path, so it was left alone. It is a follow-up.

## 8. Parameterised queries and the plan cache

**Practice.**
- Pass values as params (`CYPHER k=v …`; the npm client builds this).
- The plan cache is keyed on the query text: `CACHE_SIZE`, default 25, LRU, set at load time.
- Building a query from strings churns the cache and opens the door to injection.
- Sources: docs/commands/graph.query, docs/getting-started/configuration.

**Allevia.**
- Every query goes through `GraphHandle` with params (`src/graph/client.ts:133`).
- Params are cleaned: finite numbers only, plain map keys (`src/graph/client.ts:65`).
- New: a lint rule refuses a value written into Cypher text (`tests/helpers/cypher-lint.ts:151`). It found one in
  `src/agent/skills/company.ts` (`LIMIT ${n}`), now a param.
- A scan for Cypher built with `+` found none.

**Gap.**
- `CACHE_SIZE` is 256, and the product sends about 1,100 distinct shapes (`src/graph/server-config.ts:16`), so cold
  shapes are planned again.
- Measure the `Cached execution` share before raising it. It is a load-time setting, so changing it needs a restart.

## 9. Batching writes

**Practice.**
- Writes to one graph run one at a time, so batch them with `UNWIND $rows`, in moderate chunks.
- A single query that deleted 380,000 edges crashed 4.16 (#2134).
- Source: docs/design/concurrency, docs/cypher/unwind.

**Allevia.**
- `src/graph/batch.ts`, the import in `src/graph/transfer.ts`, the reference split, and the new compaction all batch.
  Compaction uses 200 rows a statement.

**Gaps.** None.

## 10. Supernodes

**Practice.**
- There is no official recipe.
- FalkorDB stores links as sparse matrices, so a pattern that passes through a hub expands all of its links.
- Guards:
  - typed patterns;
  - `indegree()`/`outdegree()` to spot hubs;
  - relationship indexes to start from a link instead of a hub.
- Sources: docs/design, docs/cypher/indexing/range-index, docs/cypher/functions.

**Allevia.**
- New: `db:health` and `graph:hygiene` list the 5 best-linked nodes with their links by type
  (`src/graph/health.ts:80`).
- A node is flagged when it has 1,000 links, or 10% of all links in a graph of 1,000 or more.

**Live (copy of 18 Oct).**

| Node | Links | Mostly |
|---|---|---|
| aamdani `person:founder` | 1,336 | KNOWS_ABOUT 745, AUTHORED 295 |
| bluetokai `document:sample-shopify-export` | 844 | 835 SOURCED_FROM from daily readings |

**Gaps.**
- Readings are the main source of unbounded links, and the weekly roll-up thins them (§13).
- The founder's KNOWS_ABOUT links come from extraction. They need a rule about what "knows about" is worth recording.
  That is a follow-up.

## 11. Property types, null and NaN

**Practice.**
- Storable types: strings, integers, floats, booleans, points, temporal types (4.14+), arrays of scalars, and `vecf32`.
- `SET n.p = null` removes the property.
- There is no NaN literal. A NaN in a sort crashed 6.0.2.
- Source: docs/datatypes, docs/cypher/set.

**Allevia.**
- Dates are ISO strings, which sort correctly. Times are milliseconds.
- Non-finite numbers are refused before sending (`src/graph/client.ts:65`).
- The crash shapes are refused by `src/graph/safety.ts:367` and pinned in `docs/notes/falkordb-nan-crash.md`.

**Gaps.** None.

## 12. Deletes versus soft closes

**Practice.**
- In FalkorDB, `DELETE` behaves like `DETACH DELETE`.
- Delete in chunks.
- There is no soft-delete feature. A flag or a time range is the pattern.
- Source: docs/cypher/delete.

**Allevia.**
- Facts are bi-temporal. A fact that ends is closed (`until`) and never deleted (`src/graph/edges.ts:1`).
- A changed value keeps a Version.

**Gaps.**
- Closed facts and Versions piled up for good.
- New: `graph:compact` moves facts closed more than 180 days ago, and Versions that ended that long ago, to an archive file.
  Recent history still answers "as of" questions.

## 13. Keeping each brain small (phase 2 of product-plan §9)

New in `src/graph/compact.ts`, run as `graph:compact <tenant>`. It is a dry run unless `--apply`.

**Roll-up.**
- Daily readings older than 90 days fold into one reading per subject, metric and ISO week.
- `value` follows the same rule the agent's totals use (`aggregateKind` in `src/graph/observations.ts`):
  - a flow read with a daily window (clicks, spend) gets the week's total, and its window becomes the week;
  - a rate (CTR, position) gets the mean;
  - a snapshot (followers) gets the last value, and stays without a window.
- The roll-up also keeps sum, min, max, first, last and the sample count. The agent's totals count it as the days it
  holds, so a total or a mean over any range is the same before and after (tested in `tests/graph/compact.test.ts`).
- It MEASURES the same subject and is SOURCED_FROM the same documents.
- A week stays daily in each of these cases:
  - a reading in it is cited by an answer, evidenced by a recommendation, or a decision is based on it;
  - it has one reading;
  - its readings mix units, or mix readings with and without a window;
  - it is not wholly old.

**Passages.**
- A chunk goes to the archive when no current document holds it: its document was superseded or retired, or the document
  let it go on a re-read.
- A cited chunk stays.
- A chunk that was never held stays, because it is worth a look, not a delete.

**Closed facts and old Versions.** Over 180 days, as in §12.

**Safety.**
1. `--apply` first takes a checked `tenant:export`.
2. Then it writes an archive file with every node and link it will remove, and a digest.
3. Only then does it change the graph.

`graph:compact-undo <archive> --apply` puts everything back and removes the roll-ups. A second restore is refused.

## 14. One graph per business

**Practice.**
- One graph per tenant is FalkorDB's model.
- Each graph is one key, on one shard.
- `GRAPH.LIST` shows every graph name, even to users whose ACL restricts them (#2652). Keep sensitive data out of graph
  names.
- On Rust a graph costs about 41 KiB fixed, against about 462 KiB on C 4.20 (#2499).
- Source: docs/commands/graph.list, docs/operations/cluster.

**Allevia.**
- `graphName()` is the only way a business becomes a graph name, and it is checked (`src/graph/client.ts:61`).
- There is a registry graph, per-business export, import and erase, and shared know-how in one read-only graph.
- New: `db:health` sets a size budget per business (`src/graph/health.ts:27`). The defaults are 25,000 things,
  100,000 links and 100 MB, which is about six times aamdani today. You can override them with
  `ALLEVIA_BRAIN_BUDGET_NODES`, `ALLEVIA_BRAIN_BUDGET_EDGES` and `ALLEVIA_BRAIN_BUDGET_MB`.
- The budget warns from 80% and is "over" at 100%. It is a review trigger: nothing is refused.

## 15. The 6.x Rust engine

**Facts.**
- 6.0 (29 September) is the Rust rewrite. 4.22.x (C) is still maintained.
- The unpinned `latest` tag moved to Rust.
- Never mix 4.x and 6.x in one replica set.
- Source: https://github.com/FalkorDB/FalkorDB/releases/tag/v6.0.0.

**Allevia.** The image is pinned to `falkordb/falkordb:6.0.2`.

**Bugs to watch.**

| Bug | Status | Allevia's position |
|---|---|---|
| A null column before an aggregate panics the server, read-only queries too (#3150) | Fix in PR #3229, not released | Guarded by `nullableGroupKeys` (`src/graph/safety.ts:275`) |
| Slow inserts under a UNIQUE constraint (#3330) | Fixed on main, not released | See §2 |
| Indexes that report OPERATIONAL while unpopulated (#3389) | Open | See §1 |
| The two-label index scan returns no rows | Found today | See §1 |

**Upgrade.** Move to the first 6.0.x release that carries #3229 and #3330, after the test suite passes on it.

## Measured: dry runs and an apply on copies of the live brains

Copies were made with `db:export` from the live server (reads only) and loaded with `db:import` into the test server on
6391. Both digests were verified.

**At the real thresholds (90 / 180 days): nothing to do yet.** The readings only run from 18 September to 17 October, so
no week is wholly older than 90 days, no fact ended more than 180 days ago, and no current document has let go of a
passage. Compaction prevents growth; it is not a clean-up of anything that is there today.

**At short windows (14 / 7 days)**, to measure the mechanism:

| Copy | Things | Links | Readings | Graph memory |
|---|---|---|---|---|
| aamdani before | 3,992 | 17,151 | 1,682 | 12 MB |
| aamdani after | 3,760 (−232) | 16,617 (−534) | 1,458 (280 daily → 56 weekly) | 12 MB |
| bluetokai before | 2,117 | 7,228 | 1,506 | 7 MB |
| bluetokai after | 1,700 (−417) | 6,325 (−903) | 1,089 (519 daily → 102 weekly) | 6 MB |

- aamdani also had 8 old Versions archived.
- Memory barely moves at first. `GRAPH.MEMORY USAGE` reports whole MB, and FalkorDB reuses the freed slots rather than
  handing them back.
- Undo then re-export gives the original digests (`e17cb1ec9c30`, `16daac0fdd03`): the round trip is exact.

**A year out (an estimate).** aamdani writes about 56 readings a day.
- Without roll-ups that is about 20,000 reading nodes a year, each with 2–3 links.
- With them: about 5,000 (90 days of dailies) plus about 2,900 weekly ones a year.
- The SOURCED_FROM links into each source document stop growing with every day.

## Applying on the live server (for the main session, after the founder agrees)

Run on allevia-dev from `~/jarvis` once this branch is deployed. Each step starts with a dry run.

```bash
npm run -s cli -- db:health
```

```bash
npm run -s cli -- graph:hygiene aamdani
```

```bash
npm run -s cli -- graph:compact aamdani
```

```bash
npm run -s cli -- graph:compact aamdani --apply
```

To undo, use the archive path the apply prints:

```bash
npm run -s cli -- graph:compact-undo ~/allevia-db-backups/archive/<file>.archive.jsonl --apply
```

Server settings (not code; one at a time; take a backup first):

```bash
ssh allevia-dev 'docker exec -e REDISCLI_AUTH="$(cat ~/.config/allevia/falkordb.pass)" allevia-falkordb-1 redis-cli --no-auth-warning BGREWRITEAOF'
```

```bash
ssh allevia-dev 'docker exec -e REDISCLI_AUTH="$(cat ~/.config/allevia/falkordb.pass)" allevia-falkordb-1 redis-cli --no-auth-warning CONFIG SET maxmemory 3gb'
```

`CONFIG SET maxmemory` does not survive a restart. To keep it, add `--maxmemory 3gb` to `REDIS_ARGS` in
`~/allevia-public/falkordb.override.yml`.
