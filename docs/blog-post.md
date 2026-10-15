# A growth team with receipts: building Allevia on FalkorDB

*Draft for the Graph Hacks blog prize. Allevia is our entry to WeMakeDevs × FalkorDB "Graph Hacks: Context for AI
Agents", 15–18 October 2026.*

Most small business owners have already tried AI. Very few have AI actually doing a job in the business. In the US,
76% of engaged owners use AI, but 14% have it integrated into core operations (Goldman Sachs 10,000 Small
Businesses survey, 2026). In the UAE, 72% say they use AI and transaction data shows 12% paying for a tool. In the UK,
adopters went from 1.4 AI technologies to 1.6 in three years. Use is widening, not deepening.

Owners give the same reasons everywhere: no clear use case, no skills, no time, no trust in the numbers. And
maintenance: tokens expire, APIs change, models retire, and nobody in a six-person business is paid to notice.

Allevia is our attempt at the missing piece: a done-for-you AI growth team. It is set up once, it knows the
business, it does the marketing and analysis work, and every answer comes with the evidence behind it. We built it
in India for owner-run businesses in the US, UK, UAE and Australia, and we built it around one FalkorDB graph per
business.

## Why a graph

Listen to the questions an owner actually asks:

- "Why did we stop posting daily stories?"
- "Who knows how our ad attribution works?"
- "What breaks if the Instagram token expires, and who owns fixing it?"
- "Why are enquiries down this month?"

None of these is a lookup. Each one is a walk: from a decision to the numbers it was based on and the document that
recorded them; from a connector to everything that depends on it and to the person who owns the fix; from a metric
to the pages, queries and posts that moved it. The honest answer to "why" is a path.

Two other properties matter as much as the path itself.

**Time.** A small business changes its mind constantly. The owner of a task changes, a decision supersedes another,
a channel is paused. If the memory overwrites, the agent ends up confidently wrong. In Allevia every relationship
carries valid time (`since`, `until`) and record time (`recordedAt`, `retiredAt`). Nothing is deleted; a
contradicted fact is closed. Entities whose state changes write a `Version` node before the update, so history is
one hop away, and every tool accepts an `asOf` date.

**Provenance.** Every node and edge carries `src`, the document it came from, and `asOf`. Numbers are never
properties that get overwritten; they are `Observation` nodes with a window and a date. When the agent says
"signups fell", it has to point at the observation, and the observation points at its source.

A graph database holds all three naturally. A vector store with metadata would mean rebuilding a graph badly in
application code.

## The agent company

The product is not a chatbot. It is twelve agents in eight departments, drawn as a pixel-art office, because owners
understand "a team" much faster than they understand "an AI tool".

Meera, the Chief of Staff, takes every request. Before planning, the server recalls from the graph what is already
known: earlier threads that touched the same entities, the owner's notes, open approvals. Meera then returns a
structured plan of one to three desks: Kabir (Analytics), Rohan (Marketing), Tara, Dev and Nisha (Content Studio:
write, edit, fact-check), Arjun, Zoya and Imran (Tech: lead, on-call, release), Vikram (Operations), Sara (Library), and Isha (Center of Excellence), who
checks every figure before it reaches the owner.

Each desk runs as its own Claude Agent SDK query with only its own tools, and ends by writing a **Finding** into the
graph: text, citations, and the earlier Findings it built on. That is the handoff. Reviewers named in the roster
check the Findings they cover. Meera writes the answer from the Findings and finishes by calling `show_path` with the
ordered node ids of her explanation; the tool checks each one exists, links consecutive pairs with a shortest path,
and returns the edges that the web app lights up in gold.

Everything is persisted: the Turn, every Finding and review, every node a tool touched, and the full event log, so
replaying a stored thread is just reading it back.

## How the graph shapes every answer

The design rule we held to: **the agents cannot answer without walking the graph.** All 21 tools are graph queries
or graph algorithms:

- `search` fuses full-text and vector results (384-dim multilingual embeddings, computed locally, so Hindi and
  English questions land in the same space) by reciprocal rank;
- `find_paths` and `show_path` use `algo.SPpaths`;
- `important` uses `algo.pageRank` and `topics` uses `algo.labelPropagation`;
- `impact_of` walks `DEPENDS_ON`, `AFFECTS` and `BLOCKS` and scores the result by betweenness;
- `trace_decision`, `who_owns`, `who_knows`, `metric_trend`, `seo_report` and the rest are Cypher;
- `cypher` is a read-only escape hatch: `GRAPH.RO_QUERY`, a 5-second timeout, a procedure allow-list, and capped
  output.

FalkorDB's `algo.*` procedures take labels and relationship types but cannot filter on edge properties, and we need
them to ignore closed (historical) edges. So ranking and community algorithms run on a slim projection: a throwaway
graph holding only the currently valid edges, cached and rebuilt when a write lands. Shortest paths run on the live
graph instead, with closed edges given a cost so high that `SPpaths` prunes them.

Then the server checks the answer. Every `[[node-id]]` cited must have been returned by a tool in this turn. Every
number must appear in tool data (allowing rounding, percentages, "55k" and "₹1.2 lakh"). If any touched node is
simulated (our ad data is, until real ad accounts are connected), the answer must say "simulated". If the newest data
is over a week old, it must say "as of" a date. A failed check never blocks the answer; it shows as "unverified" and
is stored on the Turn.

Tenancy is the simplest part, because FalkorDB makes it one: each business is its own graph, `allevia_<slug>`, with a
registry in `allevia_meta`. A request is bound to one graph, and no tool accepts a graph name.

## Memory that compounds

The track we cared most about was memory, because it is what makes a team better than a tool. Three kinds live in
the same graph: episodic (sessions, turns, approvals, actions), semantic (the company graph and the owner's notes)
and procedural (playbook rules vendored from open-source projects, plus rules the team learned).

The learning loop is deliberately boring. When the owner edits a draft before approving it, say "villa" to "home",
the edit is diffed into a `Rule {kind: 'learned'}` with a `LEARNED_FROM` edge to that approval, and later drafts
apply it and record `USES_RULE`. The number we track is the first-pass approval rate: the share of drafts the
owner approves without touching. It is computed from the approvals in the graph, one observation per day, so the
curve is history rather than a dashboard figure.

## What we learned building on FalkorDB 6.0

We started on FalkorDB 6.0.2, the new Rust engine released on 29 September. Most of it was a pleasure:
vector and full-text indexes with plain Cypher DDL, `GRAPH.RO_QUERY` that really refuses writes, the algorithms we
needed, and multi-graph tenancy for free. A few things are worth passing on.

**Two query shapes crashed the server, and we found the rule behind them.** On day one the shared database restarted
three times. The log said Rust's sort had found a comparator that "does not correctly implement a total order". We
measured it on throwaway containers. A full sort (no `LIMIT`) over 21 or more rows that tie on the sort key, where
the returned rows contain maps with a null in some rows and a value in others, panics; Rust only checks the total
order from 21 elements up, which is why a query could pass for months. A `NaN` in a sort key does the same. The fix
that holds is a rule, not a hunt: **the last key of every `ORDER BY` is unique**, and no Cypher in our code divides.
We then made the rule hard to break: the client refuses either shape before sending it (after a panic there is
nothing left to catch), a static test reads every Cypher string in `src/` and fails on a sort that can tie, writes
reject non-finite numbers, and a regression test runs every tool, detector and API read over a graph built entirely
of ties, zeros and gaps. The measurements and a reproduction script are in the repo
(`docs/notes/falkordb-nan-crash.md`), ready for the FalkorDB team.

**We compared with 4.22 before deciding.** The stable line survives every crash shape, and 1,395 of our 1,409 tests
passed on it at the time. But on a dense graph, a depth-2 expansion from a hub ran for minutes past its timeout on
4.22, while 6.0.2 answered in about two seconds and stopped path searches at their timeout. A crash we can guard
against seemed safer for a demo than a query that never ends, so we stayed on 6.0.2 with append-only persistence on.

**Smaller things:** results are capped at 10,000 rows and the rest is dropped silently, so every bulk read pages;
`TIMEOUT` is checked between records, not inside one expression, so the `cypher` tool also refuses `reduce()` and
bounds `range()`; and the old `db.idx.fulltext.createNodeIndex` form is gone in 6.0 (the `CREATE FULLTEXT INDEX`
DDL works). None of this put us off. It is what building on a brand-new engine looks like, and the engine was fast
and expressive enough that the guards were worth writing.

## The honest numbers

- **Tests:** 1,493 passing (two live-model tests skipped by default), all against a real FalkorDB in throwaway
  graphs.
- **Graphs:** on 15 October, Aamdani's graph (a jobs platform, built from its operating vault, read-only connectors
  and GitHub) held about 3,700 nodes and 11,300 edges; AVS Atelier's (an architecture studio, built from its website
  URL alone) about 460 nodes and 2,000 edges. The privacy scan over Aamdani's graph reports zero findings.
- **Evals:** 43 questions with expected citations, tools, agents and trap questions, scored automatically. In the
  first live runs, Aamdani passed 8 of 12 on every check and expectation, with 96% of expectations hit; AVS Atelier
  passed 2 of 5, with 89%. Mean latency was about 37 seconds for Aamdani and 48 for AVS. The failures are useful:
  most are disclosure checks firing correctly, such as an answer that touched simulated ad data without saying so,
  or quoted the public website without saying the data was public. The reports keep every failure and its cause.

## What's next

Next are delegated connections (GA4, Search Console, Google Business Profile), a paid model runtime so the team can
serve customers who are not us, and the first founding customers. The graph stays at the centre: every new source is
more context, and every approval makes the next answer a little better.
