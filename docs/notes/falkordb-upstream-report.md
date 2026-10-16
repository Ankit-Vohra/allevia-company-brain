# FalkorDB 6.0.2 panic: what to post upstream (issue #29)

**Nothing here has been posted.** Written 2026-10-16 for the founder to post from the personal GitHub account, if at all.

## Read this first: it is already filed, and well covered

The panic (`src/reply.rs:655:58`, `Option::unwrap()` on `None`, a null column next to an aggregate in `RETURN`) is
**FalkorDB/FalkorDB issue [#3150](https://github.com/FalkorDB/FalkorDB/issues/3150)**, open since 2026-09-30. It has five
reporters, repros on 6.0.0, 6.0.1 and 6.0.2, the same panic with and without `--compact` and through `GRAPH.RO_QUERY`,
a root-cause guess (a grouping key's slot is reused by an aggregate's accumulator, so the key column comes back
unbound), and a fix in **[#3229](https://github.com/FalkorDB/FalkorDB/pull/3229)** (open, review required, 2026-10-16).
The latest release, v6.0.2 (2026-10-08), does not contain the fix.

So a new issue would be a duplicate. What this report found that the thread does not have is small:

1. The simplest query with the aggregate **first**, a plain missing property as the null, and no `WITH` in front:
   `MATCH (c:A) RETURN count(c) AS n, c.phone AS p`. (The thread's null-after-aggregate cases need a `WITH ... AS hops`.)
2. A control that points at the cause: `RETURN count(1) AS n, null AS p` is fine, the same with a matched variable in
   scope (`MATCH (c:A) RETURN count(c) AS n, null AS p`) panics.
3. A list of shapes that survive, and the same queries on `v4.22.0`, all fine.

**Recommendation:** post Draft A (short) as a comment on #3150, or skip posting and just subscribe to #3229. Draft B is a
stand-alone issue for the one case that matters: #3150 is closed before a release carries the fix and 6.0.x still
panics for us. To post, paste into the GitHub comment box, or save to a file and run
`gh issue comment 3150 -R FalkorDB/FalkorDB --body-file <file>`.

## What was run

Every run: a fresh throwaway container (`docker run -d -p 127.0.0.1:6396:6379 -e "REDIS_ARGS=--appendonly no --save ''" <image>`),
one node created with `GRAPH.QUERY g "CREATE (:A {id:'c'})"` (so `c.phone` and `c.title` are missing), the query sent with
`GRAPH.RO_QUERY`, then `PING`. A panic shows as `Error: Server closed the connection` and a dead container, which was
started again before the next query. Only throwaway containers were used for these runs.

| | Image | `graph` module | Redis | Platform |
|---|---|---|---|---|
| affected | `falkordb/falkordb:6.0.2` | 60002 | 8.10.2 | Linux aarch64 (Docker on Apple Silicon) |
| not affected | `falkordb/falkordb:v4.22.0` | 42200 | 8.10.2 | Linux aarch64 |

| Query | 6.0.2 | 4.22.0 |
|---|---|---|
| `RETURN null AS x, count(1) AS n` (`GRAPH.QUERY`, no data; the thread's own one-liner) | panic | not run |
| `MATCH (c:A) RETURN count(c) AS n, c.phone AS p` | panic | ok |
| same, sent with `GRAPH.QUERY`, and with `--compact` | panic | ok (RO, with and without `--compact`) |
| `MATCH (c:A) RETURN count(c) AS n, null AS p` | panic | ok |
| `MATCH (c:A) RETURN collect(c.id) AS n, c.phone AS p` | panic | ok |
| `MATCH (c:A) RETURN max(c.id) AS n, c.phone AS p` | panic | ok |
| `MATCH (c:A) RETURN 'a' AS a, null AS p, max(c.id) AS m` | panic | ok |
| `MATCH (c:A) RETURN c.id AS id, c.title AS t, count(c) AS n` | panic | not run |
| node with `address:'1 High St'`: `MATCH (c:A) RETURN c.address AS a, c.phone AS p, max(c.id) AS m` | panic | ok |
| `MATCH (c:A) RETURN c.phone AS p, count(c) AS n` | ok | ok |
| `MATCH (c:A) RETURN count(c) AS n, c.id AS id` | ok | not run |
| `MATCH (c:A) RETURN count(c) AS n, coalesce(c.phone, '') AS p` | ok | not run |
| `MATCH (c:A) WITH c.phone AS p, count(c) AS n RETURN n, p` | ok | not run |
| `MATCH (c:A) WITH c, c.phone AS p RETURN count(c) AS n, p` | ok | not run |
| `RETURN count(1) AS n, null AS p`; `UNWIND [1] AS x RETURN count(x) AS n, null AS p` | ok | not run |
| two nodes (`{id:'c'}`, `{id:'d', title:'x'}`): `MATCH (c:A) RETURN c.id AS id, c.title AS t, count(c) AS n` | ok | not run |

The panic log: with `--compact` the frame under `execute_query` is `falkordb::reply::reply_compact`, without it
`falkordb::reply::reply_verbose`, both at `src/reply.rs:655:58`.

## Draft A: comment for #3150 (recommended)

> Still reproduces on the released `falkordb/falkordb:6.0.2` (graph module 60002, Redis 8.10.2, linux/arm64 under Docker
> on Apple Silicon); `v4.22.0` (module 42200) answers all of the queries below.
>
> Two data points that may help with #3229:
>
> 1. The simplest case with the aggregate **first** and a plain missing property as the null, no `WITH`:
>
>    ```
>    GRAPH.QUERY g "CREATE (:A {id:'c'})"
>    GRAPH.QUERY g "MATCH (c:A) RETURN count(c) AS n, c.phone AS p"     -- server exits
>    ```
>
> 2. Whether a matched variable is in scope changes the result, even with the null after the aggregate:
>
>    | query (one node `(:A {id:'c'})`) | 6.0.2 | 4.22.0 |
>    |---|---|---|
>    | `RETURN count(1) AS n, null AS p` | ok | not run |
>    | `MATCH (c:A) RETURN count(c) AS n, null AS p` | **panic** | ok |
>    | `MATCH (c:A) RETURN count(c) AS n, c.phone AS p` | **panic** | ok |
>    | `MATCH (c:A) RETURN max(c.id) AS n, c.phone AS p` | **panic** | ok |
>    | `MATCH (c:A) RETURN collect(c.id) AS n, c.phone AS p` | **panic** | ok |
>    | `MATCH (c:A) RETURN c.phone AS p, count(c) AS n` | ok | ok |
>    | `MATCH (c:A) WITH c, c.phone AS p RETURN count(c) AS n, p` | ok | not run |
>
> That fits the slot explanation above (it is not where the null sits in `RETURN`). The second and third rows look like
> useful regression tests for #3229. Until a release carries it we refuse the shape in our own query layer and rewrite
> it with a `WITH`.

## Draft B: a stand-alone issue (only if #3150 is closed before a release has the fix)

**Title:** `6.0.2: RETURN with an aggregate and a null column kills the server (src/reply.rs:655:58), including a null after the aggregate`

> ## Summary
>
> On `falkordb/falkordb:6.0.2` a `RETURN` that has an aggregate and a column that evaluates to null panics the module
> and the whole server exits. `GRAPH.QUERY` and `GRAPH.RO_QUERY` both do it, with `--compact` (`reply_compact`) and
> without it (`reply_verbose`). `v4.22.0` returns the same queries normally. This is the panic in #3150; I am filing it
> separately only because #3150 is closed and I could not find a release that contains the fix.
>
> ## Environment
>
> - `falkordb/falkordb:6.0.2`, graph module 60002, Redis 8.10.2, linux/arm64 (Docker on Apple Silicon), default config
>   apart from `--appendonly no --save ''`.
> - Control: `falkordb/falkordb:v4.22.0`, module 42200.
>
> ## Steps to reproduce
>
> ```
> docker run -d --name falkor-repro -p 127.0.0.1:6396:6379 -e "REDIS_ARGS=--appendonly no --save ''" falkordb/falkordb:6.0.2
> redis-cli -p 6396 GRAPH.QUERY g "CREATE (:A {id:'c'})"
> redis-cli -p 6396 GRAPH.RO_QUERY g "MATCH (c:A) RETURN count(c) AS n, c.phone AS p"
> # Error: Server closed the connection        (c.phone is missing, so p is null)
> docker logs falkor-repro | grep -A 12 panic
> ```
>
> ## Expected
>
> One row, `n = 1, p = null`, as on `v4.22.0`.
>
> ## Actual
>
> ```
> # <module> FalkorDB panic: panicked at src/reply.rs:655:58:
> called `Option::unwrap()` on a `None` value
>    8: core::option::unwrap_failed
>    9: falkordb::reply::reply_verbose        (reply_compact when sent with --compact)
>   10: falkordb::graph_core::execute_query
> ```
>
> ## Which shapes
>
> (the table from Draft A, plus: `MATCH (c:A) RETURN 'a' AS a, null AS p, max(c.id) AS m` panics, and
> `MATCH (c:A) RETURN count(c) AS n, coalesce(c.phone, '') AS p` does not)
>
> ## Impact
>
> One query takes the process down for every graph: every client is dropped and writes since the last snapshot are lost.
> A read-only user can do it through `GRAPH.RO_QUERY`.

## Notes for the founder

- **Our own guard stays.** `src/graph/safety.ts` rule 3 refuses the shape before it is sent and the `cypher` tool
  rewrites agent queries into the `WITH` form (merge 190111a, per the comment on issue #29). Keep it even after a fixed
  release: the shape depends on slots, so a regression would look the same.
- **FalkorDB Cloud runs 4.22**, which did not panic on any of these, so the live data should not be exposed to this
  panic today. The exposure is the local 6.0.2 server and the 6.0.2 test server.
- **A second thing is not reported anywhere and not drafted here:** the restart loops on 2026-10-15 where the AOF base
  failed to load with `Stream listpack integrity check failed` on a `telemetry{<graph>}` key. A search of the upstream
  issues found nothing for it (only #955 "Crash on Telemetry", an old open bug, and #1367 "Disable telemetry TTL"). There
  is no repro and no copy of the corrupt file in the repo, so a report would be a guess. If it happens again, copy
  `appendonlydir` aside before touching it and report with the file. Until then `npm run cli -- db:telemetry` and the
  10-minute sweep keep those keys out of the dump.
