# Allevia on FalkorDB: blog post draft

Draft for the founder's OK. Nothing here has been published.

**Title options**

1. One brain per business: building Allevia on FalkorDB
2. Why our AI team reads a graph, not a pile of documents
3. 13 agents, one graph each: what four days on FalkorDB taught us

**Image spots** (placeholders below; each from the demo video frames or a fresh screenshot of the live site)

| File | What it should show |
|---|---|
| `images/pixel-office.jpg` | The pixel office: the 13 agents at their desks, grouped by department |
| `images/answer-path.jpg` | Blue Tokai, "Why did online orders drop this week?": the answer with its path lit in gold on the map |
| `images/brain-map.jpg` | Blue Tokai's Brain map with the line "2,187 things · 6,229 links" |
| `images/fact-over-time.jpg` | The "How FalkorDB powers it" scene, "How a fact changes (example)": one fact closed and kept, one current (a diagram, not live data) |
| `images/tokens-8x.jpg` | The "How FalkorDB powers it" scene, the step "604k tokens against 75k" |
| `images/approval-card.jpg` | An approval card waiting for the founder's OK (web or Discord), with the evidence under it |

---

# One brain per business: building Allevia on FalkorDB

Allevia is our entry for Graph Hacks: Context for AI Agents, FalkorDB's hackathon. We built it in four days, 15 to 18
October 2026, in more than 800 commits. Here is what it does, why it sits on a graph, and what went wrong.

## The problem

A founder holds the whole business in their head. Why a price changed. What was promised to which client.

The team doesn't have that context, and neither do the tools. The inbox doesn't know about the analytics. The analytics
don't know about the release that went out on Monday. So every "why" comes back to the founder.

Most AI tools start each chat from nothing, or from a pile of pasted documents.

## What we built

Allevia is a company brain for founders. Each business gets one FalkorDB graph. It is built from the website, the
founder's connected tools, uploaded documents and conversations. Every fact keeps its source and its date.

A team of 13 AI agents in nine departments works from that brain: The Chief, Data Detective, Growth Hacker, Miss
Influencer, Techie, Firefighter, Bug Hunter, Memory Keeper, Wordsmith, Fact Checker, Number Cruncher, Deal Closer and
Taskmaster. The Chief takes each request and decides who does what. Each agent is told what to read in the brain first,
before any outside tool.

![The pixel office: Allevia's 13 agents at their desks](images/pixel-office.jpg)

Nothing goes out without the founder's OK. A post, an email, a fix or an ad change arrives as an approval card, on the
web or in Discord.

![An approval card waiting for the founder's OK](images/approval-card.jpg)

The live demo has three businesses:

- **Aamdani**, our own startup, with Gmail, Analytics, Search Console and Instagram connected for real.
- **AVS Atelier**, an architecture and interiors studio, built from its website and Instagram.
- **Blue Tokai Coffee**, a known brand. Its public data is real. Its private side (orders, payments, ad spend) is sample
  numbers, labelled as samples on every screen.

## Why a graph, not just vectors

Listen to what founders ask. "Why did online orders drop this week?" "What breaks if the Instagram token expires?" "Why
did we stop posting daily stories?"

None of these is a lookup. Each answer is a chain: from a number, to the step that fell, to the release that changed it,
to the person who owns the fix. The honest answer to "why" is a path.

Vector search finds text that sounds like the question: a good place to start. But it can't tell you that a payment
error began the day of a release, or that the release changed the payment page. Those are links. Links live in a graph.

So we use both. Search finds where to start. The graph explains.

## How retrieval works

An answer goes through four steps.

**1. Find where to start.** Every business graph has a vector index, which finds text by meaning, and a full-text index,
which finds it by words. Our vectors (embeddings) are multilingual and made on our own server. The indexes cover the
business's things and its text, not the hundreds of number readings it adds each day, so readings never crowd real
things out. The two result lists are merged by reciprocal rank, a simple way to combine two rankings. A matching chunk
of text answers as the document it came from, so citations point at sources.

**2. Walk the graph.** The agents' graph tools are Cypher queries (Cypher is the graph query language) and graph
algorithms. "What breaks if this stops" is one query per hop over `DEPENDS_ON`, `AFFECTS` and `BLOCKS`, so the app can
show one step away next to four. PageRank, a score for how much of the business leads to a thing, ranks what matters.
The links behind an answer are found with FalkorDB's shortest-path procedure:

```cypher
MATCH (a:Entity {id:$from}), (b:Entity {id:$to})
CALL algo.SPpaths({sourceNode: a, targetNode: b, relDirection: 'both', maxLen: $maxLen, pathCount: $pathCount,
  relTypes: $rels, costProp: 'closedCost', maxCost: $maxCost})
YIELD path RETURN path
```

That is from `src/graph/algorithms.ts`.

**3. Check the answer.** Every node the answer cites must have been returned by a tool in that turn. Every number must
appear in the tools' data. An answer that used sample data must say so. A failed check never hides the answer; it shows
as "unverified".

**4. Show the path.** The Chief ends by naming the nodes behind the answer, in order. The server links each pair through
the graph and the app lights that path on the map.

![The answer to "why did online orders drop", with its path lit on the map](images/answer-path.jpg)

On the Blue Tokai demo, "Why did online orders drop this week?" walks from the drop in online-store orders to the UPI
payment step, the payment error, and the checkout release that brought it. Those numbers are samples, and the answer
says so.

## Every team, one brain

Connecting the founder's tools is not about more dashboards. It is so that what one team learns reaches the others.

Allevia connects through Composio, whose catalogue has over 1,600 tools: mail, calendars, analytics, ads, shops, CRMs.
Whatever comes in lands in the same graph, so the ads team, the content team and the website team read the same facts.

On Blue Tokai we asked one question: "What did our ads and posts teach us this month, and what should content, ads and
the website team each do next?" Eight teammates answered together in about 97 seconds:

- **Ads** found the costliest campaign, the new-roast launch, at about 1.7 times the middle campaign's cost per sign-up.
  It was sending people to a checkout that was failing UPI payments. Growth Hacker proposed a pause, and moving the
  money to brand search.
- **Content** drafted a week of posts, each ending with the business's main goal: "Visit your nearest café". Fact
  Checker caught one caption that implied a free tasting.
- **Website** got the payment fix, and a Contact page fix ranked by how much it costs café visits.

All three wait for the founder's OK. The numbers here are Blue Tokai's sample numbers, and the answer says so.

## Memory with two clocks

A business changes its mind all the time. A task changes hands. A decision replaces an older one. If memory overwrites,
the agents end up confidently wrong.

So every edge in Allevia carries two clocks. Valid time (`since`, `until`) says when a fact was true. Record time
(`recordedAt`, `retiredAt`) says when we learned it, and when we learned it had stopped. Every edge also carries its
source (`src`) and its date (`asOf`).

Nothing is deleted. When a fact stops being true, its edge is closed with a date and kept. Every tool takes an `asOf`
date, so "who owned this task on 1 October?" has a real answer. In our synthetic test company, the Instagram token fix
is owned by Priya now; ask as of 1 October and the answer is the founder.

When a task, a decision or a goal changes, its old state is saved as a `Version` node one hop away. Readings are never
overwritten either. Each one is its own `Observation` node, with a time window, a date and a source.

One FalkorDB detail shaped this. The `algo.*` procedures can't filter on edge properties, so they would walk a closed
edge. Our fix: a closed edge carries `closedCost = 1,000,000`, and the shortest-path call sets `maxCost` just under it,
so closed edges are pruned inside the search. PageRank and topic grouping run on a slim, cached copy of the graph with
current edges only. Building that copy ourselves took about 110 ms at 20,000 nodes, against 5.3 seconds for
`GRAPH.COPY`, which also rebuilds every search index.

![How a fact changes (an example): closed and kept, next to the one that holds now](images/fact-over-time.jpg)

## Keeping the brain clean as it grows

A brain that only grows gets slow, costly and noisy. So we measured ours.

On 15 October, Aamdani's first load was 3,799 nodes and 11,897 edges. The next day, use alone added 283 nodes and 4,911
edges: conversations, findings, approvals, and the links from each answer to what it read. By then, 235 facts that had
stopped being true were closed with a date, not deleted.

On 17 October, a business took about 10 KB of memory per thing, links, vectors and indexes included. Aamdani, with 4,084
things, used about 40 MB.

We also found waste. General know-how, such as about 200 playbook rules, had been copied into every business graph. So
on 18 October we built four fixes:

- **A shared reference graph**, `allevia_reference`, read-only and loaded once. A business keeps a small stub of a
  shared rule only when one of its own facts points at it, so citations still resolve.
- **A write gate.** Every new node needs a known type, a source and a date, or it is refused and logged.
- **Entity resolution on write.** A new person, business or product that matches an existing one by name or email is
  linked to it, not created again.
- **A hygiene report.** It lists closed facts, old readings and cold, rarely linked things. It changes nothing; a person
  decides.

Rolling old readings up into weeks, archiving old closed facts, and summarising clusters are planned, not built.

![Blue Tokai's brain: 2,187 things and 6,229 links](images/brain-map.jpg)

## What we measured: 8× fewer tokens

The point of a brain is to read less. We tested that on 17 October, on Aamdani, with two real questions: "What breaks if
the Instagram token expires?" and "Why did we pause daily stories and image posts?"

Each question was answered two ways, with the same model and rules. First, with all 114 of the business's
documents pasted into the prompt. Second, by one agent with only the graph tools.

Pasting the documents meant reading 604,000 tokens (the units a model reads and is billed by) across the two questions,
in 44 seconds. The agent on the graph read 75,000 tokens, in 25 seconds. That is 8× fewer tokens and 43% less time. Its
tools handed it only 1,200 to 2,100 tokens of the business's own records per answer.

The limits, said plainly:

- The full 13-agent team reads more than one agent, because it plans, reviews and checks facts. For the same two
  questions it read 175,000 tokens: 3.5× fewer than pasting, but slower.
- On our small synthetic company, pasting the documents was cheaper. The graph wins as the business grows.
- Five questions on two businesses is a measurement, not a benchmark.

![604k tokens against 75k](images/tokens-8x.jpg)

## What we learned

**A new engine needs guard rails.** We built on FalkorDB 6.0.2, the new Rust engine. On 15 October our shared database
crashed several times. We traced the crashes to three query shapes that panic the server: a full sort over 21 or more
tied rows that hold maps with nulls, a NaN ("not a number", such as 0 divided by 0) in a sort key, and an aggregate (a
count or a sum) next to a column that can be null. The last one was already reported upstream (issue #3150), with a fix
open in PR #3229 when we last checked, on 16 October. A panic takes every graph on the server down with it, so it can't
be caught. We stop it before it is sent: the client refuses those shapes, and a test reads every Cypher string in our
code and fails on them. Our rule: the last key of every `ORDER BY` is unique.

**Counts can come out short.** On 6.0.2, parallel edges between the same two nodes collapse under `count`, `collect` or
`sum` when the query doesn't refer to the edge. We keep parallel edges on purpose: a fact that ended and came back is
two edges. So a lint rule (an automatic check on our code) makes every aggregate bind and use its edge.

**Labels pick the index.** Our id index is on the `Entity` label. A lookup written as `(d:Document {id:$x})` scans every
Document instead. A second lint rule requires `Entity` on every id lookup, and a test checks the plans with
`GRAPH.EXPLAIN`.

**Some limits are silent.** A result over 10,000 rows drops the rest without a word, so every large read pages.

**Persistence needs care.** A node created and deleted in one query wrote nothing to the append-only file (the log the
server replays on restart), so a restarted server could not load it. We now write it in two statements. On 15 October
the append-only file was also corrupt after a crash, and the server restart-looped. The snapshot was intact, and we
recovered from it. The live server now takes a checked backup to S3 every night.

**What isn't there yet.** Two businesses run on real data so far. No Meta or Google Ads accounts are connected, so ad
numbers are samples, and answers say so. Next: roll-ups and archiving to keep each brain small, our own Google and Meta
apps for connections, and a model runtime metered per business.

## Try it

- **Live:** https://13-232-139-42.sslip.io. Sign up for 100 free credits, or open "See the demo".
- **Code:** https://github.com/Ankit-Vohra/allevia-company-brain
- **Every query and algorithm**, with its file and line: `docs/falkordb-queries.md` in the repo.
