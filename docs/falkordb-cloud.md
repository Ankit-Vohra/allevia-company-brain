# Moving Allevia's database to FalkorDB Cloud

Status (2026-10-16): **all four graphs are copied to the cloud and verified. The app has not been switched.** It still
runs on the local server (127.0.0.1:6390), which stays untouched as the backup.

Short answer: Allevia works on the free cloud instance after four small query changes that also work on our 6.0.2.
One real gap is left: on the cloud, nothing stops a slow **write**. Decide on that (section 4) before you switch.

## 1. What the cloud instance is

| | Local (today) | FalkorDB Cloud, free |
|---|---|---|
| Version | FalkorDB 6.0.2 (module 60002) | FalkorDB 4.22 (module 42200), Redis 8.10.2, aarch64 |
| Memory | no limit | 100 MB, `noeviction` (writes fail when it is full) |
| Query threads | 4 (2 on the test server) | 2 |
| Write time limit (`TIMEOUT_DEFAULT`) | 15 s | **0 = none** |
| Largest `TIMEOUT` a read may ask for (`TIMEOUT_MAX`) | 120 s | 0 = no ceiling |
| Memory one query may use | 512 MB | 50 MB |
| Queries waiting before refusing | 500 | 50 (the client already retries a refusal) |
| Cached query plans | 256 | 25 |
| Rows per result | 10,000 | 10,000 |
| Connection | local | `redis://` over the internet: **no TLS** |
| Backups | nightly (`scripts/ops/backup-db.sh`) | **none** |
| Access | everything | graph commands only: plain `GET`/`SET` and `ACL` are refused (`NOPERM`); `GRAPH.CONFIG SET`, `DUMP`, `MODULE LIST`, `INFO` are allowed |

The connection URL is `ALLEVIA_FALKORDB_CLOUD_URL` in your env file. It holds the password: never paste it into a chat,
an issue or a commit. Every command below reads it by name (`env:ALLEVIA_FALKORDB_CLOUD_URL`), and Allevia never prints
it (`db:check` shows `redis://***@<remote>:<port>`).

## 2. How the data was copied

A server's own dump (`DUMP`/`RESTORE`, RDB) carries the module's encoding version, so a 6.0.2 dump does not load on
4.22. So the copy is logical:

```sh
npm run cli -- db:export <tenant|meta> <file> [--from <url|env:NAME>]
npm run cli -- db:import <file> --to <url|env:NAME> [--graph <name>] [--replace] [--max-memory-mb 80]
```

- **Export** writes one JSON-lines file: a header (labels in their order, indexes, constraints, counts), one line per
  node (labels, every property, which keys are Floats and which are vectors) and per edge (type, properties, both
  ends), and an end line with a digest. Read with `GRAPH.RO_QUERY` in pages of 500. If the counts or the write stamp move
  while it reads, it reads again, so stop writers for the final copy.
- **Import** refuses a graph that already exists unless `--replace`, and refuses a cut-short or edited file before it
  writes anything. It writes in batches of `UNWIND … CREATE`, then builds the indexes and constraints with the same
  code the app uses (`ensureIndexes` / `ensureSchema`), then **reads the copy back**: digest, counts per label set and
  relationship type, a checksum of every `id`, and 30 nodes re-read by id with every property and vector compared.
  With `--max-memory-mb` it reads the server's memory after every batch and stops (and drops what it wrote) past the
  limit.
- Code: `src/graph/transfer.ts`, `src/cli/db-transfer.ts`; tests: `tests/graph/transfer.test.ts` (on the test server).

What was copied (all four `verify: ok`, counts equal to the local server):

| Graph | Nodes | Edges | Indexes | Constraints | Server memory after it |
|---|---|---|---|---|---|
| (empty instance) | | | | | 3.4 MB |
| allevia_demo_seed | 281 | 694 | 10 | UNIQUE + MANDATORY Entity.id, OPERATIONAL | 9.3 MB |
| allevia_meta | 13 | 0 | 6 | none (as local) | |
| allevia_avs_atelier | 471 | 2,021 | 10 | UNIQUE + MANDATORY Entity.id, OPERATIONAL | 18.9 MB (meta + avs) |
| allevia_aamdani | 3,799 | 11,897 | 10 | UNIQUE + MANDATORY Entity.id, OPERATIONAL | 39.9 MB (peak 47.6 MB) |

So the four businesses take about **37 MB of the 100 MB** (demo about 6, meta + AVS about 10, Aamdani about 21).
`GRAPH.MEMORY USAGE` says Aamdani 11 MB, AVS 2 MB; the rest is Redis and index overhead. Headroom: roughly 2.5x
today's data before the 80 MB line.

**Watching it:** `npm run cli -- db:usage` prints the memory used against the plan's limit (from `INFO memory`; set
`ALLEVIA_DB_LIMIT_MB=100` if a server does not report its own), each graph's own share (`GRAPH.MEMORY USAGE`), and warns from
80% (exit 3, to the error stream; critical from 95%, and it names leftover `allevia_test_…` graphs to drop first). It is
read-only. On 17 October 2026 it read 64 MB used of 100 MB (peak 99 MB earlier), six graphs of their own 19 MB. A full plan
refuses every write (`noeviction`), so look before a big import, an onboarding or a long test run.

The local export files were taken 2026-10-16; the live app has kept writing to 6390 since. Re-copy just before the
switch (section 5).

## 3. Compatibility, checked on the demo copy

`scripts/maint/db-compat.ts` runs the product's own code against one graph and prints a table:

```sh
npx tsx scripts/maint/db-compat.ts --url env:ALLEVIA_FALKORDB_CLOUD_URL --graph allevia_demo_seed [--writes]
```

Result on the cloud demo copy: **47 of 47 checks pass** (after the fixes below). Same run on a 6.0.2 copy: 47 of 47.

| Area | What | 4.22 cloud |
|---|---|---|
| Schema | range index on Entity.id and the Observation keys | works |
| | full-text index on `:Searchable` (name, summary) and `:Chunk` (text) | works (scores differ from 6.0.2: 0.5 vs 1 for the same hit; ranking order held in our checks) |
| | vector index, 384-d cosine, on `:Searchable.embedding` and `:Chunk.textEmbedding` | works |
| | UNIQUE and MANDATORY on Entity.id | work, both OPERATIONAL; a duplicate id and a missing id are refused with the same messages as 6.0.2 |
| | `ensureSchema` re-run (migrate, indexes, constraints) | works, idempotent |
| Agent tools | search, get_entity (+ asOf), neighbors, find_paths, trace_decision, who_owns, who_knows, impact_of depth 1 and 4, important (PageRank), topics (label propagation), metric_trend, content_performance, seo_report, ad_report, playbook, history (+ asOf), recall, cypher, get_brand_asset, show_path | all work (trace_decision after fix 1) |
| | vector recall (`db.idx.vector.queryNodes`), full-text (`db.idx.fulltext.queryNodes`) | work |
| | `algo.SPpaths`, `algo.pageRank`, `algo.labelPropagation`, `algo.WCC` | work |
| Route | `GET /api/:t/graph/at-work` | works (demo: 0.6 s; Aamdani: 1.2 s) |
| Writes | upsertNode (with vector), versioned update, upsertEdge, addObservation, closeEdge (bi-temporal), remember, propose_action, then a bi-temporal read of the closed edge | all work |
| Timeouts | per-query `TIMEOUT` on a heavy read (300 ms on a 4-hop traversal) | **works**: cut off at 334 ms ("Query timed out"). The earlier note that 4.22 has no timeout on dense graphs did not hold for reads here. |
| | `TIMEOUT` on a write | **ignored** (as on 6.0.2), and the server has no `TIMEOUT_DEFAULT`: see section 4 |
| Plans | query-shape check: `GRAPH.EXPLAIN` of every query the run sent (211 shapes), held to "an id lookup uses the index" | 0 violations (after fixes 2 and 4) |
| Aamdani (read-only) | search, PageRank, topics, graph-at-work, vector and full-text search on the real-size graph | all work; PageRank fits the 50 MB per-query memory |

Incompatibilities found, with the exact errors, and what was done:

1. **Sorting on a path that is not returned.** `… RETURN … ORDER BY length(p), o.id` fails on 4.22 with
   `_AR_EXP_UpdateEntityIdx: Unable to locate a value with alias p within the record` (trace_decision's SUPERSEDES
   chain, who_owns's inherited owners). Fixed: they return `length(p) AS hops` and sort on `hops`. Works on both.
   (A Cypher query the agent writes itself with this shape will get that error on 4.22 and has to rephrase.)
2. **Index lookup by another node's property.** `MATCH (d:Entity {id:id}) … MATCH (c:Entity {id: d.mergedInto})` is
   planned on 4.22 as a hash join over a scan of every Entity (6.0.2 uses the index). Fixed with a `WITH` in between
   (`WITH d, d.mergedInto AS into MATCH (c:Entity {id: into})`): an index lookup on both.
3. **Plain Redis keys refused.** `NOPERM User falkordb has no permissions to run the 'get' command` (and `set`): the
   write stamps that tell the server "the graph changed, rebuild your cached projection" cannot be shared between
   processes. Handled: said once, not on every read, and cached projections then live 60 s instead of 5 min, so a
   write by the bot or a CLI ingest shows in PageRank/topics within a minute. Writes made inside the same process
   still refresh at once.
4. **Not 4.22-only, found on the way:** with real data, two lookups started from a scan of `:Version` / `:Approval`
   instead of the id index on both versions (the test suite's plan check runs on an empty graph and did not see it).
   Fixed with a `WITH` after the id lookup (get_entity asOf; pending-approval lookups in the agent, studio and creative
   code).
5. **`GRAPH.EXPLAIN` on 4.22 needs every `$param` bound** (`Missing parameters`), and plans `{id: null}` as a scan. The
   compat script binds stand-in values. The test suite's own plan check keeps running on the 6.0.2 test server.

All code changes keep the FalkorDB safety rules (`src/graph/safety.ts`): every ORDER BY still ends on a unique key, and
the cypher-source, query-shape and full test suites pass on the 6.0.2 test server.

## 4. The gap: a slow write cannot be stopped

On 6.0.2 our server setting `TIMEOUT_DEFAULT 15000` ends any write that runs past 15 s and rolls it back. On the cloud
instance `TIMEOUT_DEFAULT` is 0, 4.22 ignores a per-query `TIMEOUT` on writes (checked: a 300 ms limit, the write ran
6.8 s to the end), and FalkorDB has no command to kill a running query.

This is not theory. During this check a deliberately heavy test write (a 4-hop path count that creates nothing) was
run once against the Aamdani copy by mistake. It is still running on the cloud as of this writing, will likely take
2 to 3 hours, holds one of the two query threads, and blocks other writes to `allevia_aamdani` until it ends. It
changes no data. Check it with `npm run cli -- db:busy --on env:ALLEVIA_FALKORDB_CLOUD_URL`. The compat script now runs that probe only on graphs of
400 nodes or fewer.

Allevia's own writes are small and anchored (batched `UNWIND`, id lookups), so a runaway write is unlikely, but nothing
stops one on the cloud. Options, your call:

- **Set the limit at runtime:** `GRAPH.CONFIG SET TIMEOUT_DEFAULT 15000` and `GRAPH.CONFIG SET TIMEOUT_MAX 120000`.
  The cloud user may run `GRAPH.CONFIG SET` (checked with a no-op). Not done: it changes the instance's settings, and
  it is lost when the provider restarts the instance. Whether 4.22 applies `TIMEOUT_DEFAULT` to writes is not yet
  proven (6.0.2 does); one write test on the demo graph after setting it would show.
- **A paid tier or self-hosted 6.x**: FalkorDB Cloud's paid tiers let you choose the version and settings and come with
  TLS and backups. Running `falkordb/falkordb:6.0.2` with our `docker-compose.yml` settings on a small VM (Railway,
  Fly, EC2) keeps everything as it is today (the setup is in `docs/submission-checklist.md`).

## 5. Switching the app to the cloud

Do this when you are ready; nothing below has been done.

1. **Wait for a quiet server.** No query should be running:
   ```sh
   npm run cli -- db:busy --on env:ALLEVIA_FALKORDB_CLOUD_URL
   ```
   `0 running, 0 waiting` means quiet. (Decide on section 4 first.)
2. **Stop the writers**, so the final copy is complete: stop the supervised bot and server (`scripts/ops/run-bot.sh`,
   `scripts/ops/run-server.sh`: Ctrl-C or SIGTERM the supervisor) and any CLI ingest.
3. **Back up local** (the fallback if anything goes wrong): `scripts/ops/backup-db.sh`, and also
   ```sh
   for t in meta aamdani avs_atelier demo_seed; do npm run cli -- db:export $t ~/allevia-db-backups/pre-cloud-$t.jsonl; done
   ```
4. **Copy the current data over the earlier copies**:
   ```sh
   for t in meta aamdani avs_atelier demo_seed; do
     npm run cli -- db:import ~/allevia-db-backups/pre-cloud-$t.jsonl --to env:ALLEVIA_FALKORDB_CLOUD_URL --replace --max-memory-mb 80
   done
   ```
   Each must end in `verify: ok`. Stop if one does not.
5. **Point the app at the cloud.** In `~/.config/allevia/allevia.env`, set `ALLEVIA_FALKORDB_URL` to the same value as
   `ALLEVIA_FALKORDB_CLOUD_URL` (copy the line in an editor; do not echo it in a terminal that is recorded).
6. **Start the bot and the server again** with the run scripts. Both read the env file at start.
7. **Check:** `npm run cli -- db:check` shows `FalkorDB at redis://***@<remote>:…: ok` and the three tenants with the
   counts from step 4; open the Brain page and ask one question in Discord.
8. **Backups from now on**: the cloud has none, and the nightly script backs up the local server. Until that changes,
   export the cloud every night:
   `npm run cli -- db:export <t> <file> --from env:ALLEVIA_FALKORDB_CLOUD_URL` for each of the four.

Expect each agent tool call to take about 80 to 300 ms instead of 2 to 20 ms (section 6): a few seconds more per
answer, small next to the model's own time.

## 6. Latency

From this Mac (Mumbai) to the cloud instance, median of 9 runs, demo graph; local is the 6.0.2 test server on the same
Mac.

| Query | Local 6.0.2 | Cloud 4.22 |
|---|---|---|
| ping | 0.3 ms | 24.5 ms |
| one node by id | 0.3 ms | 25.5 ms |
| count nodes | 0.3 ms | 25.5 ms |
| search tool (vector + full-text + sources) | 2.1 ms | 82 ms |
| impact_of depth 4 | 2.4 ms | 159 ms |
| metric_trend | 1.5 ms | 107 ms |
| important (PageRank, cached projection) | 3.5 ms | 178 ms |
| find_paths | 22.6 ms | 156 ms |
| important, first call (builds the projection) | 81 to 356 ms | 2.8 to 3.3 s |
| import of Aamdani (3,799 nodes, 11,897 edges, verified) | 4.4 s | 53 s |

The cost is the round trip (about 25 ms) times the queries a tool sends one after another. On the Aamdani copy the
tools took 150 to 480 ms, measured while the stray write above held one of the two threads.

## 7. Going back to the local server

The local server was not changed and keeps its own nightly backups.

1. Stop the bot and the server.
2. If anything was written while on the cloud and you want to keep it, export it from the cloud and load it locally:
   ```sh
   npm run cli -- db:export <t> <file> --from env:ALLEVIA_FALKORDB_CLOUD_URL
   npm run cli -- db:import <file> --to redis://127.0.0.1:6390 --replace
   ```
   (`--replace` overwrites the local graph: export the local one first if in doubt.) Otherwise skip this step: local
   still holds everything up to the switch.
3. In the env file, set `ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6390` (or remove the line: that is the default).
4. Start the bot and the server; `npm run cli -- db:check` shows `FalkorDB at redis://127.0.0.1:6390: ok`.

## 8. If the free tier is not enough

Stay on the free tier only while the data is small and a slow write is an acceptable risk. Move when any of these is
true: the data passes about 70 MB used (`INFO memory` or the compat script's memory line), you need TLS, you need
backups the provider keeps, or a runaway write happens. Then use a paid FalkorDB Cloud tier on 6.x with
`TIMEOUT_DEFAULT`/`TIMEOUT_MAX` set as in `src/graph/server-config.ts`, or self-host `falkordb/falkordb:6.0.2`. The
same `db:export` / `db:import` moves the data, and nothing in the code depends on 4.22.
