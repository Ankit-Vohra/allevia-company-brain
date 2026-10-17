# Graph audit (issue #38), 17 October 2026

The hackathon's judging point is that the product is built around the FalkorDB graph and **the graph does real work**. This is
the audit of every feature against that: does it write what it learns into the business's own graph with its source and its
time, does it read back with a real graph query (a traversal, a multi-hop pattern, an algorithm, a vector or full-text search)
and not a flat lookup or a file, and does it keep anything outside the graph that belongs in it. Gaps are ranked by what a judge
looking at the graph or the demo would notice, then fixed in order. The fixes are in the commits listed in "Gap register"; what
is still open is said so.

**How it was done.** Each feature's code was read end to end (file and line cited below), and what the code writes was checked
against the live FalkorDB Cloud graphs with read-only queries: `demo_growth` (Shiftly, the synthetic hero business), `aamdani`
(a real business; counts only, no personal data copied) and `avs_atelier`. Nothing was written to `aamdani`.

## The short verdict

| | |
|---|---|
| **The graph is the product's spine and already does real work** | `search` (full-text plus vector, fused), `find_paths` and `show_path` (`algo.SPpaths`), `important` (`algo.pageRank`), `topics` (`algo.labelPropagation`), `impact_of` (one traversal per hop), `trace_decision` (`SUPERSEDES*1..6`), `who_owns` (`PART_OF*1..3`), `recall` (turn to touched node to approval to action to task), the 20 detectors (read-only Cypher over `MEASURES`, `FAILS`, `RANKS_FOR`, `USES_RULE`, `BASED_ON`, `AFFECTS`) and the Studio lineage (`DERIVED_FROM`) are all queries on the business's graph. Bi-temporal edges and `Version` nodes carry every change of state. |
| **Where it was thin on 16 Oct** | Facts the product creates by acting (a connection, a sent message, a post, a Studio job, a stand-up pick, the path under an answer, a rule a card applied) were written, but as properties and JSON blobs inside one node, so a judge following an edge from one to the next met a dead end. Several edges carried no `src` or `asOf`. `allevia_meta` (the registry graph) had no relationships at all. Three public-data and trend features had never run on a live graph, so they showed nothing. |
| **What changed** | See the register. The answers' paths, the rules and skills a draft used, the stand-up's evidence, Sales attribution, connections and posts with their goals, and Studio spend and lineage are now edges and observations in the business's graph. |

## Live numbers behind the audit (16 to 17 October, FalkorDB Cloud)

| Graph | Nodes | Edges | Notable counts |
|---|---|---|---|
| `aamdani` (real) | 4,082 | 16,808 | 1,647 Observation, 535 Chunk, 395 Document, 240 System, 207 Task, 204 Rule, 99 Decision; `TOUCHED` 4,418, `SOURCED_FROM` 3,326, `MEASURES` 1,711, `KNOWS_ABOUT` 1,492 |
| `demo_growth` (Shiftly) | 624 | 1,958 | 325 Observation, 53 Version, 33 Rule, 18 Finding, 11 Approval, 9 Turn; Sales: 5 Lead, 3 Deal, 2 Meeting, 8 Message |
| `allevia_meta` (registry) | 29 | **0** | Tenant 8, DiscordChannel 10, DiscordPost 6, DiscordArea 2, DiscordInvite 2, DiscordHub 1 |

Before the fixes: `TOUCHED`, `CITED` and `HANDLED_BY` edges had no `src` or `asOf` in either business (0 of 4,418 and 0 of 440),
there were **zero `GUIDED_BY` edges and zero learned rules** in both, no answer's path was stored except inside the turn's event
log, and `APPROVED_BY` 7/7, `RESULTED_IN` 14/14 on `demo_growth` had no `src`.

## Feature by feature

Evidence is `file:line` as read on 17 October 2026 (before the fixes unless a fix is named).

### 1. Onboarding from a website
- **Writes.** Everything goes through `writeBatch`, so edges carry `src`, `asOf`, `since`, `recordedAt`: the form `Document` and `Business -SOURCED_FROM->` it (`src/onboard/onboard.ts:249`), per page a `Page`, a `Document`, `Chunk`s, `Page -PART_OF-> Channel` and `Page -LINKS_TO_PAGE-> Page` (`src/ingest/sources/website/index.ts:40`), brand assets and rules (`brand.ts:231`), SEO `Page -FAILS|PASSES-> Rule` with evidence plus a site-score Observation (`seo.ts:163`), LLM-extracted facts with `conf` 0.5 to 1 (`src/ingest/resolve.ts:27`), the Program/Goal/Checkpoint/Capability set (`enroll.ts`). SEO flips and brand changes close the old edge (`onboard.ts:328,367`); `Page.title/statusCode/metaDescription/name` write Versions (`schema.ts`).
- **Reads.** End-of-run counts (`onboard.ts:624`) and `tenantSite` (`src/checkup/tenant.ts:32`); the live "graph grows" picture is built from the write events, not a read.
- **Outside.** `data/runs/<slug>/…-onboard.json`, `data/onboard/<slug>/screenshots`, extraction cache under `data/cache`. A copy of country, currency and time zone sits on the registry's `Tenant` node as well as the Business.
- **Gaps.** (G5) the librarian never ran for a business onboarded from a website, so no `rank` or `community` (live: `avs_atelier` 0 of 538) and the Brain map fell back to JavaScript PageRank (`src/server/reads.ts:330`); (G17) the onboarding run was not a node; (G26) per-page score, hours, address and price were untracked properties; a vanished page was never closed.

### 2. The brain / ingest
- **Writes.** Vault Documents and Chunks with `LINKS_TO` (`src/ingest/sources/brain.ts:246`), ADR Decisions with `DECIDED` and `SUPERSEDES` (`adr.ts:196`), registry agents and systems (`registry.ts:103`), GitHub tasks with owners (`github.ts:146`), ops Observations. Extraction: entities and relations with `src`, `asOf`, `since`, `conf` (ambiguous mentions 0.55 with `maybeSameAs`, numbers 0.8: `resolve.ts:27`). The librarian derives `KNOWS_ABOUT` with a 2-hop `AUTHORED -> MENTIONS` query (`librarian.ts:76`), closes it when unsupported, and merges duplicates reversibly with `SAME_AS` (`merge.ts:259`). An `Event{ingest}` records each run (`pipeline.ts:600`).
- **Reads.** Entity resolution uses `db.idx.vector.queryNodes` (`pipeline.ts:238`); `algo.pageRank`, `algo.labelPropagation`, `algo.WCC` on a projection (`src/graph/algorithms.ts:147`).
- **Outside.** `data/runs/<slug>/<ts>.json` (librarian report, orphans, failures), the extraction cache, `data/snapshots`.
- **Gaps.** (G17) the ingest `Event` had no edges and the hygiene numbers lived only in JSON; nothing recorded which model or ontology version produced an extracted fact (G26); ingest only exists for the two founder businesses (`tenant-config.ts:53`), so a customer cannot re-ingest (open, product scope).

### 3. Website check-up
- **Writes.** All in the graph: a `Document` per run, `Rule{website-check}` nodes, `Page|Channel -FAILS{evidence,impact,tier}-> Rule` with `src` and `asOf`, closed with a reason when fixed (`src/checkup/run.ts:156`), ten Observations on `channel:website` plus per-page mobile speed (`store.ts:122`), AI-visibility Document and Observations (`ai-visibility.ts:198`), DataForSEO `Query`, `RANKS_FOR{position}` and a spend Observation (`dataforseo.ts:164`).
- **Reads.** `proactive/signals.ts:129` reads open `FAILS`; `metric_trend` reads any series; but the findings shown come from the run Document's JSON (`run.ts:180`) and the trend is a JS comparison of the last two runs.
- **Outside.** Job state is an in-memory `Map` keyed by tenant (`jobs.ts:57`); the weekly schedule is derived from the graph.
- **Gaps.** (G4) every tenant has exactly one check-up point and no closed `FAILS`, so there is no trend to show; (G7) AI visibility wrote no edges (`ai-visibility.ts:211`: `const edges = []`), the firms it named were `"Name|count"` strings; (G9, live bug) the check-up renamed onboarding's Pages to their URL path (`store.ts:103,111,138` against `index.ts:61`, 3 `Page[name]` Versions on `avs_atelier`); `RANKS_FOR.position` refreshed in place.

### 4. Apify public data
- **Writes.** A `Document{kind:'public'}` per lookup, Channels `google-maps` and `instagram`, `Competitor` nodes with `COMPETES_WITH` and `SOURCED_FROM`, one Observation per metric per day (conf 0.9, `src` = the Document: `src/publicdata/write.ts:38-124`), `MEASURES` to the Channel or straight to the Competitor.
- **Reads.** `previousReading` is an Observation traversal (`src/agent/tools/publicdata.ts:199`) and the stand-up reads `Observation-MEASURES->Competitor` with the previous reading (`proactive/signals.ts:116`); the cache is the Document's JSON (`publicdata.ts:77`).
- **Outside.** The budget ledger is a file: `data/apify/spend-ledger.json` (`src/publicdata/ledger.ts:26`), unlike DataForSEO's, which is graph-native.
- **Gaps.** (G6) it never ran on a live graph, so a judge saw zero competitors (blocked here by no Apify token: tested against fakes only); ads and a rival's channels were strings and JSON, not nodes; per-business spend was in the file.

### 5. Privacy and tenant isolation
- **Writes / design.** `graphName(slug)` is the only way a business becomes a graph (`src/graph/client.ts:60`); redaction runs at every source boundary (`privacy.ts:26,99`, `brain.ts:233`, `github.ts:134`, `page.ts:233`, `normalize.ts:29`); the registry holds hashed tokens (`src/auth/tokens.ts:67`).
- **Reads.** `scanGraph` pages through every property including Version snapshots (`privacy.ts:154`): a scan, not a traversal.
- **Outside.** Per-slug folders under `data/`, two shared ledgers (Apify, Studio credits), a photo-hash manifest, in-memory per-tenant maps (check-up jobs, turns, Discord sessions). The Apify daily cap is global, so one business can use up everyone's lookups.
- **Gaps.** (G12) the scan ran only in ingest and the CLI, never after onboarding, and chat-written nodes are not redacted; Cloud has no TLS and refuses ACL, so isolation is the application's (`docs/falkordb-cloud.md:22`), open.

### 6. Discord hub mapping
- **Writes.** The mapping is in the registry graph, not a file (`src/discord/hub-store.ts`): `DiscordChannel{channelId,slug,kind}` is the one channel-to-business index, plus `DiscordArea`, `DiscordInvite`, `DiscordPost`. The thread to conversation link is in the tenant graph as `Session.discordThreadId` (`sessions.ts:29`).
- **Reads.** Indexed lookups by `channelId`, `slug`, `key`.
- **Outside.** The business's own graph did not know it had a Discord area; Discord users are not mapped to people (every hub member is treated as the owner: `hub-bot.ts:179`); `setChannels` hard-deletes with `DETACH DELETE` (`hub-store.ts:126`), the only runtime hard delete.
- **Gaps.** (G3) `allevia_meta` had 29 nodes and no edges; (G13) no `channel:discord` in the tenant graph and no link from an Approval to the Discord message it became.

### 7. Chat and the agents' tools
- **Writes.** Only `propose_action` and `remember` write (`src/agent/tools/actions.ts:25`, `tools/memory.ts`).
- **Reads.** Real graph queries or algorithms: `search` (full-text + vector, reciprocal rank fusion, `search.ts:61`), `find_paths` and `show_path` (`algo.SPpaths`, `src/graph/algorithms.ts:48`), `important` (`algo.pageRank`, `ranking.ts:39`), `topics` (`algo.labelPropagation`, `ranking.ts:94`), `trace_decision` (`BASED_ON`, `DECIDED`, `AFFECTS`, `SUPERSEDES*1..6`: `decisions.ts:33`), `who_owns` (`PART_OF*1..3`: `people.ts:35`), `impact_of` (one traversal per hop, `impact.ts:15`), `get_entity`, `neighbors`, `history`, `recall`, `playbook`, and a guarded read-only `cypher`. Graph reads with the arithmetic in JS: `metric_trend`, `content_performance`, `seo_report`, `ad_report`. Not from the graph: `research` (the web) and the live connection reads (`calendar_free_slots`, `gmail_inbox`, `ga4_report`, `gsc_report`, `ads_report`: `connections.ts:116-335`), `use_skill` (reads `skills/**/SKILL.md` plus the business's own memories).
- **Outside.** The Apify, Studio-credit and connection-call ledgers (files).
- **Gaps.** (G10) `src` was `turn:turn:…` on every card and memory (`actions.ts:45`, `tools/memory.ts:151`: `ctx.turnId` already starts with `turn:`), a dangling provenance pointer; live reads left no node, so a turn that used Gmail had nothing to point at; MCP served 11 of the 15 read-only tools (`src/mcp/server.ts:31`), and each MCP call left no trace.

### 8. Memory and recall
- **Writes.** `saveTurn` (`src/agent/memory.ts:234`): the Turn with its full event log, `IN_SESSION`, `ASKED`, `HANDLED_BY`, `TOUCHED` (everything a tool returned), `CITED` (only when a tool returned it and it exists), `GUIDED_BY`; per agent a `Finding` (`PART_OF` the turn, `PRODUCED`, `CITED`, `BASED_ON` another Finding: the handoff), `REVIEWED` with the verdict; `KNOWS_ABOUT` weights grown once per turn (`:298`).
- **Reads.** `recallBrief` (`:348`) is the best-linked read in the product: `Turn-[TOUCHED|CITED]->seed`, `Turn-[TOUCHED]->Approval-[RESULTED_IN]->Action-[RESULTED_IN]->Task`, `Memory-[ABOUT]->seed`, `Recommendation-[BASED_ON|EVIDENCED_BY|AFFECTS]->seed-[PROPOSES]->Approval`, seeded by the hybrid `search`.
- **Outside.** The replay log is a JSON blob on the Turn (inside the graph, opaque to a query).
- **Gaps.** (G1) the answer's path existed only inside that JSON; (G10) Turn and Finding nodes and their edges had no `src` or `asOf`; (G18) Turns were never embedded, so "have we been asked something like this" was full-text on the name; `remember` never wrote `SUPERSEDES` or `CONTRADICTS`, so a changed preference left the old one active.

### 9. Learned rules
- **Writes.** `learnFromEdit` (`src/actions/learning.ts:311`): `Rule{kind:'learned'}`, `LEARNED_FROM` the approval, `PRODUCED` by the copy editor, `APPLIES_TO` the agent and channel, `CONTRADICTS` plus a status Version when reversed. The Approval's own status is bi-temporal.
- **Reads.** "Which approvals did this rule come from" is `Rule-[LEARNED_FROM]->Approval`; "which rule changed this draft" works only after the post: `Content-[USES_RULE]->Rule` is written by `markRulesApplied` (`learning.ts:266`).
- **Gaps.** (G2) a pending card had no edge to the rule that shaped it, only `payload.rulesApplied` in its JSON; the rule and its edges had no `src`, `asOf` or `conf`; `confidence` and `appliedCount` were overwritten; both live tenants had **zero** learned rules, so the loop could not be seen.

### 10. Skills per business
- **Writes.** Shipped skills are 70 `SKILL.md` files (`src/agent/skills/catalog.ts:86`), not nodes. A business's own are graph-native and well sourced: `Memory{kind:'skill'|'skill_rule'}` `ABOUT` the agent, `STATED` by the owner, `SOURCED_FROM` the directive Document (`business.ts:66`).
- **Reads.** `loadBusinessSkills` is a graph read merged with the catalog each turn (`ask.ts`).
- **Gaps.** (G2) which skill a turn used was `Turn.skills` strings and a `skill_used` event in the JSON log: no skill node, no edge from a Turn, an agent or a rule to it; the rules `use_skill` showed were never `GUIDED_BY`; `Agent.skillsOff` was untracked.

### 11. The proactive stand-up
- **Writes.** The run is a node (`Document{kind:'standup'}`, `PRODUCED` by the Chief, `MENTIONS` its cards and attendees: `src/proactive/standup.ts:101`); each pick is a `Recommendation` with up to 8 `EVIDENCED_BY`, an `ADVANCES` goal and a `PROPOSES` approval (`draft.ts:179,229`). Today's note is a `Document{kind:'brief'}`, with goal-status Versions (`src/insights/brief.ts:342,357`).
- **Reads.** `gatherSignals` (`signals.ts:85`) reads goals and observations, approvals decided since the last run, competitor observations with the previous reading, `FAILS` rules and open recommendations with their evidence and goals: real filtered reads, with the ranking logic in JS.
- **Outside.** The festival calendar is a code constant (`calendar.ts:20`), so festival picks had no evidence; items, skipped opportunities and lessons are JSON on the Document.
- **Gaps.** (G8) the stand-up Document linked cards but not the signals that triggered it; swallowed `.catch(() => undefined)` hid missing evidence and goal edges (`draft.ts:183,239`).

### 12. Insights detectors
- **Writes.** `Recommendation` (detector, key, numbers), `EVIDENCED_BY` with `asOf` (closed when it stops applying), `ADVANCES`, a pending Approval; a recommendation that stops firing becomes `resolved` via a Version (`src/insights/recommend.ts:79-188`). Deterministic ids dedupe (`insightRecId`).
- **Reads.** 20 read-only Cypher detectors (`detectors.ts:1087`): one- and two-hop patterns over `MEASURES`, `FAILS`, `RANKS_FOR`, `USES_RULE`, `BASED_ON`, `AFFECTS`; thresholds and medians in JS; none used an algorithm or the dependency structure.
- **Gaps.** (G14) no structural detector (a critical system nobody owns); no `src` on the recommendation's edges.

### 13. Growth plan and goals
- **Writes.** Enrolment writes Program, Goal (`src` = the template), Metric, `ENROLLED_IN`, `PURSUES`, `TRACKS`, `PART_OF`, `OWNS`; progress is windowed Observations that `MEASURE` the goal; `Goal.status` and `Goal.target` are tracked (Versions). `ADVANCES` comes from recommendations, approvals and content.
- **Reads.** `goalPulse` (`brief.ts:106`), `readGoal`, the scorecard (`src/program/scorecard.ts:30`). `ADVANCES` was written but never read back for the plan.
- **Gaps.** (G11) the plan could not say what moved a goal; chat proposals and `github_issue` tasks did not link a goal; the owner's target change had no `src`, `asOf` or actor and no `Decision` explaining it.

### 14. Connections via Composio and Google
- **Writes.** A connection is a `System{kind:'connector'}` node (`src/connections/composio.ts:281`); each read updates `lastPullAt`, `lastError`, `dataThrough` (`firstread.ts:33`). Search Console, Instagram, GA4 and Ads write a snapshot `Document{kind:'snapshot',provider}` and Observations `MEASURES` a Channel, `SOURCED_FROM` the snapshot (`firstread.ts:45`, `src/connections/google/specs.ts`). The capability ladder writes `Capability` nodes `DEPENDS_ON` the System or Channel (`src/capabilities/ladder.ts:234`).
- **Reads.** `readFacts` is nine label scans and group-bys with the logic in JS (`ladder.ts:75`); the Connections page decides "connected" from the sealed file, not the graph.
- **Outside.** The sealed vault per business (tokens: correctly outside the graph), `audit.jsonl` (time, connector, operation, ok, ms, actor; cut to its newest half past 1 MB, so history is lost: `audit.ts:53`), in-memory pending sign-ins.
- **Gaps.** (G6b) nothing linked a fact to its connection (the snapshot only had a `provider` property), `System.status` was overwritten with no Version, no `Business -OWNS-> System`, no `Channel -DEPENDS_ON-> System`, no connected date or fact count on the Composio path; Calendar, Stripe, Shopify and Gmail readers wrote no facts; live reads returned no node.

### 15. Sales (leads, deals, meetings, messages)
- **Writes.** `recordEnquiry` writes Person, Lead and an inbound Message with `ENQUIRED_BY`, `CAME_VIA` a Channel (the same `channel:<name>` node the publisher uses), `MESSAGE_IN`, `SENT_BY`, `PART_OF` Business, all with `src` and `asOf` (`src/sales/graph.ts:94`). Stage changes are bi-temporal: `Lead.stage`, `Deal.stage`, `Meeting.status/start` are tracked, `moveStage` goes through `upsertNode`, so each move is a Version (live: 6 Lead and 3 Deal Versions). An approved email or invite makes `Action -RESULTED_IN-> Message|Meeting` (`src/sales/after.ts:27`, `src/actions/executors.ts:412`).
- **Reads.** `whatMoved` is a real Version traversal (`graph.ts:378`); `crm_read` lead and meetings views follow `MESSAGE_IN` and `MEETING_FOR`; `pipeline`, `unanswered` are group-bys.
- **Outside.** Nothing (the sample inbox and calendar are in memory, correctly, for the demo).
- **Gaps.** (G11b) `Message` and `Meeting` had no `Channel` edge (a property only); nothing linked a Lead to the Campaign or Content that brought it; no Lead, Deal or Message `ADVANCES` a Goal; `Message.status` was untracked and the Gmail and Calendar ids were not kept; **the demo had no Approval, Action or `RESULTED_IN` for any Sales record** (the seed wrote `src: "approval:demo-mehta-reply"` as a string for a node that did not exist).

### 16. Studio and creative
- **Writes.** The most graph-native feature: intake writes `Asset{original}` with the owner `AUTHORED` (`src/studio/intake.ts:46`); `saveVariant` writes `Asset{variant}` with `DERIVED_FROM{step,treatment}` and the job's `model`, `prompt`, `hfJobId`, `hfCredits` (`variants.ts:37-97`); Nisha's check writes the badge and `Nisha -REVIEWED-> Asset{verdict}` (`fidelity.ts:158`); approval writes `Recommendation -PROPOSES-> Approval`, `EVIDENCED_BY` the original and variants (`approve.ts:57`), `Content -USES_ASSET-> chosen variant`, `GUIDED_BY` the brand rules, `PROMOTES`, `DEPICTS`, and credits and cost Observations. Posters and reels add `DERIVED_FROM` the artwork, `USES_ASSET` a BrandAsset, `PROMOTES`, `GUIDED_BY` (`src/creative/deliverable.ts:78`).
- **Reads.** No product code traversed `DERIVED_FROM`; the Studio page read JSON (`Approval.payload.studio`, `Asset.studioEvents`).
- **Outside.** The Higgsfield spend ledger `data/studio/credit-ledger.json` (global; failed jobs and the daily cap only there: `src/studio/credits.ts:4,47`), image bytes under `data/assets` (fine: the graph holds `storageKey`), drafts as files, the vision cache.
- **Gaps.** (G15) lineage written but not read as a graph; spend was not a graph fact (`credits_charged` was the flat plan credit and `usd_cost` a fixed $0.50 estimate at conf 0.5; real spend `hfCredits` only on the Asset); `promptSources` was a list property, not `GUIDED_BY` edges; the 5-second clip had no approval, no content and no spend record; `DERIVED_FROM` and `REVIEWED` and `PRODUCED` edges here had no `src`/`asOf`.

### 17. Posting after approval
- **Writes.** The post is a `Content` node `content:publish-<approval>` (`src/publish/record.ts:18,62`): platform, account, caption, `assetId`, status, `publishAt`, `approvedHash`, `postUrl`; `USES_ASSET` at scheduling, `PUBLISHED_ON` the Channel after success, `Agent PRODUCED`, `Approval -RESULTED_IN-> Action -RESULTED_IN-> Content`.
- **Reads.** The queue is the graph (`dueIds`, `pendingIds`, `stuckIds`: `record.ts:99`, claims are one atomic statement, `scheduler.ts:75`), which is the right place for it; `recentPosts` is a flat property scan.
- **Gaps.** (G11c) no `ADVANCES` to a goal (the publish path never copied the recommendation's goals), no performance Observations, status overwritten (`claim()` used a raw `SET`), a dry run wrote nothing to see.

### 18. Approvals and executors
- **Writes.** `runPropose` writes Recommendation, Approval, `PROPOSES`, `EVIDENCED_BY` and `PRODUCED` with `src`/`asOf` and reuses a waiting card (`src/agent/tools/actions.ts:25`); `decideApproval` tracks `Approval.status` (a Version per change: 15 on `demo_growth`), records `decidedBy`, `firstPass`, `editDistance` and `APPROVED_BY`/`REJECTED_BY` (`src/actions/approvals.ts:145`); an edit teaches a rule (above); `executeApproval` writes `Action{kind,status,result}` with `Approval -RESULTED_IN-> Action`, `Action -AFFECTS->` a target and `Action -RESULTED_IN->` what it made (`executors.ts:392`). Result nodes: `github_issue` a Task, `content_draft` a Content, `pause_ad` a Campaign, `publish_post` a Content; `discord_post` and `connection_action` none.
- **Reads.** `readRow` joins Recommendation to Approval to Action in one query (`approvals.ts:80`).
- **Gaps.** (G10b) action-layer edges without `src` or `asOf` (live: `APPROVED_BY` 7 with 0, `RESULTED_IN` 14 with 0); `Action AFFECTS` fell back to the first evidence node, which can be a guess; `ADVANCES` only from the insights and stand-up paths, not from chat, Studio or creative cards.

### 19. "How we know" (the path under every answer)
- **Writes / reads.** `show_path` checks the ids exist, joins consecutive ids by a direct current edge or `algo.SPpaths` (up to 4 hops), re-runs on business relationships only if the shortest path ran through the team's own cards, and excludes memory plumbing (`src/agent/tools/paths.ts:60-122`, `common.ts:32`). Every edge drawn is a real current edge; a path is never made up. Without a `show_path` call the orchestrator falls back to the cited, touched ids (`orchestrator.ts:1199`).
- **Weak points.** The ids are the model's choice (the prompt, not code, keeps them to what a tool returned this turn); pairs with no connection within 4 hops were returned as nodes with no edge and drawn anyway; `checks.ts` has no path check; **the path lived only in `Turn.events`**, so "which answers walked through this node" could not be asked. (G1)

## The brain keeps growing: real numbers (`graph:story`)

`npm run cli -- graph:story <business>` (and the Brain page's "It keeps growing", `GET /api/:t/graph/story`) counts the nodes and edges of a
business's own graph per day or week and by kind. It reads two clocks that every write stamps (`createdAt` / `recordedAt`: when the team
learned it; `asOf`: the date of the source), so the figures are the graph's own and nothing is drawn by hand
([queries: How the brain grew](falkordb-queries.md)). The real business (`aamdani`), counted by when the team learned it, on 17 October:

| Day | New nodes | New edges | Total nodes | Total edges | Of which, new nodes by kind |
|---|---|---|---|---|---|
| 15 Oct (first ingest) | 3,799 | 11,897 | 3,799 | 11,897 | facts and sources 2,535, company 498, work and decisions 423, memory 231, ideas and approvals 32, pictures and posts 70, changes kept 10 |
| 16 Oct (a day of use) | 283 | 4,911 | 4,082 | 16,808 | facts 67, company 48, work 1, memory 127, ideas and approvals 27, pictures 3 |

After the first big load, one day of use added **283 nodes (+7.4%) and 4,911 edges (+41.3%)**: conversations and the findings behind them,
the cards the team drafted and what the owner did with them, and the links from each answer to what it touched (most of the edges are
`TOUCHED` and `CITED`: the brain's memory of its own work). 235 facts that stopped being true are closed with a date, never deleted.

By the date of the source, the same graph shows its history building up week by week (3,833 dated nodes and 10,527 dated edges): 41 nodes
in the week of 7 Sept, 84 in the next, then 198, 309, 1,233 and 1,968 in the week of 12 Oct, as documents, decisions, readings and
tasks from the founder's vault, the ops snapshots and GitHub were read in. The demo business (`demo_growth`) holds 713 nodes and 2,602
edges: its first load on 15 Oct (368 nodes, 703 edges) plus 271 nodes and 1,759 edges from the audit's own runs.

What this does not show, said plainly: the real business has two days of record time, so "it keeps growing" is a day-over-day measurement,
not months of one; and `demo_growth`'s use since the seed is largely this audit's own test runs. The website's claim should be worded
as what a graph can honestly say: it grows with every question, decision and approval, and the count is one command.

## An answer follows a few hops, not a reread: tokens and time per answer

Measured on 17 October 2026 with `scripts/bench-efficiency.ts`, on the Claude subscription (no API key), the same model (Sonnet) and answer
rules in every arm. Three ways to answer the same question:

- **stuff**: one model call whose prompt holds all of the business's documents and nothing else (no tools, no graph). For the real
  business that is the vault's 114 markdown files (the documents the brain was built from); for Shiftly, every document, chunk, record and
  reading in its graph written out as text (it has no files outside the graph).
- **solo**: one agent with the graph tools (`search`, `get_entity`, `neighbors`, `find_paths`, `trace_decision`, `who_owns`, `who_knows`,
  `impact_of`, `important`, `topics`, `metric_trend`, `history`, `recall`, `cypher`) and no documents in the prompt.
- **team**: the product as it ships: `ask()` with nothing saved and the tools read-only (Meera plans, desks work, reviewers check, Meera
  answers, the server checks every citation and number).

"Read" is every token the model had in front of it, from the Agent SDK's own usage numbers for each run (fresh, cached and stored prompt
tokens: a multi-call answer re-reads its cached prefix each call, so it is counted each time); "evidence" is what the tools handed the model
(the compact JSON the runtime sends, 4 characters a token) or, for the stuffed arm, the corpus (the same estimate). Time is the wall clock of
the whole answer. "Says" counts the expected facts found by one regex per question (the same ones the eval sets use); a crude check on
purpose.

| Business | Question | stuff: read, time | solo: read, time, tool calls, evidence | team: read, time, tool calls |
|---|---|---|---|---|
| Real (private) | What breaks if the Instagram token expires? | 300,006, 22.0 s | 38,520, 12.9 s, 2, 2,059 | 106,118, 43.8 s, 7 (a rerun: 93,885, 36.4 s, 5) |
| Real (private) | Why did we pause daily stories and image posts? | 303,659, 22.0 s | 36,523, 12.6 s, 4, 1,234 | 68,383, 25.9 s, 3 |
| Shiftly | Why did sign-ups drop this week, and what should we do? | 15,770, 11.1 s (3 of 4 facts) | 57,521, 17.0 s, 7, 3,849 | 250,403, 38.8 s, 19 |
| Shiftly | What else breaks if the sign-up screen keeps crashing? | 15,771, 10.5 s | 35,450, 14.2 s, 3, 1,761 | 115,032, 47.7 s, 3 |
| Shiftly | Did pausing the Meta ads cause the sign-up drop? | 15,772, 10.5 s | 40,781, 14.2 s, 7, 2,392 | 138,296, 50.9 s, 9 |

Totals: real business, two questions: stuff 603,665 read in 44 s; solo 75,043 read in 25 s (**8x fewer tokens, 43% less time**); team 174,501
in 70 s (3.5x fewer tokens, 59% more time). Shiftly, three questions: stuff 47,313 in 32 s; solo 133,752 in 45 s; team 503,731 in 137 s.
The vault is about 173,000 tokens at four characters a token; the model's own count for the stuffed call was 300,000 read each time.

What it says, honestly:

1. **The graph wins on scale, not on a tiny corpus.** Stuffing costs the whole corpus for every question and grows with the business
   (6,000 tokens for the demo, 173,000 for a real business that has run for a month); a few hops read one to four thousand tokens of the
   business's own records whatever its size. On the real business one agent used 8 times fewer tokens and about 40% less time. On a business
   small enough to fit in a prompt, stuffing is the cheaper way to answer, and the audit says so.
2. **The 13-person team is not the cheap path.** It plans, delegates, reviews and fact-checks, so it reads 2 to 7 times what one agent does
   and is slower than stuffing on a single question. What it buys is the part stuffing cannot give: every claim cites a node, each number is
   checked against a tool's data, a simulated number is called simulated, the path is drawn from the graph, and an approval card comes out.
3. **Quality, crudely.** Every solo answer contained every expected fact; the stuffed prompt missed one of four on the hero question (it
   never named the sign-up screen; its answer was otherwise good: on a corpus that small, a stuffed prompt answers well); four of five team answers passed. The fifth was a real defect that only this benchmark found: on the real
   business the team wrote the answer, looked one more thing up (which turns the earlier text into a "working note"), and then wrote only "I've
   written the answer above and have nothing to add". The owner would have seen that line. Fixed in `AnswerStream.finish` with a test; the
   rerun of that question passed (36 s, 93,885 read, 5 tool calls).
4. **Five questions on two businesses is a measurement, not a benchmark suite.** The stuffed baseline is the vault's documents; the graph also
   holds the ops snapshots, the registry and GitHub, so a fairer baseline for a real operator would be larger still. `Turn.tokensIn`,
   `tokensOut`, `modelCalls` and `toolCalls` are now saved on every turn, so a business's own cost per answer is a Cypher query from here on.

## Photo to premium ad: lineage and cost as a graph read

The Studio now turns a rough product photo into a premium, UGC-style ad picture and a 5 second vertical clip (`src/studio/premium.ts`,
`clip.ts`), both options on the same approval card, and writes the chain into the business's graph (`src/studio/lineage.ts`): the clip
`DERIVED_FROM` the picture `DERIVED_FROM` the owner's photo, each Higgsfield job a `Document{kind:'generation'}` the asset is
`SOURCED_FROM`, each cost an `Observation{studio_credits_spent}` that `MEASURES` the asset, the brand and fidelity rules it was built from
`GUIDED_BY` edges, Nisha's verdict a `REVIEWED` edge, the card and the post read back through `EVIDENCED_BY` and `USES_ASSET`.
`npm run cli -- graph:lineage <tenant> <assetId>` and `GET /api/:t/assets/:id/lineage` read it. The live check on `demo_growth` (a degraded real
photograph of an espresso cup): the premium picture 6.5 credits (`gpt_image_2` through `higgsfield product-photoshoot`, mode
`lifestyle_scene`), Nisha: "Product unchanged", the clip 5 credits (`seedance_2_0_mini`, 720x1280, 5.04 s), 11.5 of the 20 credits agreed;
files in `docs/creative-live/premium-ad/`, the spend in `docs/higgsfield-spend.md`.

## What was run live on FalkorDB Cloud 4.22 (17 October)

The tests run on a local 6.0.2; each of these was run against the real database, on `demo_growth` or on a throwaway business that was
deleted afterwards (`aamdani` was only read).

| Flow | What happened |
|---|---|
| Hero question on `demo_growth` (web API) | 81 s, 7 agents, citations and numbers valid, an 8-node path stored on the Turn (`Turn.pathIds`, `onPath` on `TOUCHED`), 5 skills touched, `Recommendation SOURCED_FROM Turn`, 154 provenance-stamped `TOUCHED` edges, "answers through release 2.8.0" returns 2 turns |
| Sales enquiry to a booking card | Neel found the newest enquiry, offered three real times from the calendar, and reused the two waiting cards (a reply and a call hold) instead of drafting them again, 37 s |
| Poster with the owner's logo | Asked the three purpose questions first (no poster without a purpose); with the logo filed through the product's own upload and a brief, a poster option with the whole logo and the owner's words, waiting for OK, 45 s |
| Bad photo to options and a premium ad | Real Studio, real vision: Tara, the free clean-up, Nisha, Dev, then the premium ad picture (6.5 credits) and the clip (5 credits), one card on web and Discord ([Home screenshot](screenshots/premium-ad-card-web.png)) |
| Edit then approve teaches a rule | Approving the poster with "apply" changed to "sign up" wrote `rule:learned-say-sign-up-not-apply` with `LEARNED_FROM` carrying `src`, `asOf`, `conf` |
| Stand-up | On a fresh seed: two picks, each with `MENTIONS{role:'evidence', pickKey}` edges to its lead and deal; festival `Event` nodes exist on `demo_growth`; a second run the same day set all six opportunities aside because they were already waiting |
| Structural detector (read-only on the real business) | `tech.unowned_critical_system`: 3 candidates in 5.4 s over 240 ranked tools; the top one has 22 things relying on it and nobody named |
| Website check-up (a test business) | Ran, read its earlier run and said what changed ("252 ms to 388 ms, worse"), top five fixes |
| Onboarding from a website (throwaway business, then deleted) | 12 pages, 354 nodes, 1,184 edges, 0 write errors; 379 of 390 entities ranked and grouped (333 groups); `Event{onboard}` and `Event{privacy-scan}` `AFFECTS` the business; `graph_nodes`, `merged_count`, `privacy_scan_hits` readings sourced from the run; 125 extracted edges say which model read them; 12 `seo_page_score` readings |
| Registry graph | `linkRegistry()` took `allevia_meta` from 0 to 21 relationships |
| Connections listing, growth plan, brief, approvals, Brain, check-up status | 200 on `demo_growth`, `aamdani` and `avs_atelier` (read-only on the last two) |
| Posting after OK | Tested with a fake Composio and a dry run (`tests/publish`); no account is connected, so it was not run live |
| Discord code path | Tests with fake ports (the audit's 233 plus 12 new for the registry and the join); nothing was posted to the real hub |

## Gap register, ranked by hackathon impact

Status as of 17 October 2026, with the commit that fixed it and what was checked live on FalkorDB Cloud 4.22 (the tests run on a local 6.0.2).

| # | Gap | Impact | Fix | Status |
|---|---|---|---|---|
| G1 | The answer's "How we know" path is only in the event-log JSON; path ids are not checked against what the turn touched | HIGH | Store `Turn.pathIds` and `onPath`/`pathIndex` on the `TOUCHED` edges; `show_path` refuses ids no tool returned this turn; drop unconnected nodes from the drawn path; a read "answers that walked through this node" | **Fixed** (`069d16a`). `Turn.pathIds`, `onPath`/`pathIndex` on `TOUCHED`; `show_path` refuses ids no tool returned this turn and draws nothing it could not link; `answersThrough` reads it back. Live: a stored 8-node path, and "answers that walked through release 2.8.0" returns 2 turns. |
| G2 | Rules and skills a draft or answer used are not edges (zero `GUIDED_BY`; skills are strings; no learned rule in either live graph) | HIGH | `Approval\|Recommendation -GUIDED_BY-> Rule` with how/find/replace; skills as `Playbook{kind:'skill'}` nodes with `Turn TOUCHED`, `Agent USES`; `use_skill` rule ids into `guidedBy`; `LEARNED_FROM` with `src`/`asOf`/`conf`; `Rule.confidence` tracked; one real edit-then-approve cycle on `demo_growth` | **Fixed** (`c13ec81`). Cards `GUIDED_BY` the rule they applied (`how`, `find`, `replace`; tests), skills are `Playbook{kind:'skill'}` nodes with `Agent USES`, `Turn TOUCHED` and `Finding GUIDED_BY` (live: 5 skills on one hero answer), `LEARNED_FROM` carries `src`/`asOf`/`conf`, `Rule.confidence` is tracked. Live: one real edit-then-approve on `demo_growth` taught `rule:learned-say-sign-up-not-apply`. A card made *after* that rule (stand-up draft) is covered by tests, not run live. |
| G3 | `allevia_meta` has no relationships | HIGH | `Tenant -HAS_AREA-> DiscordArea -HAS_CHANNEL-> DiscordChannel`, `ISSUED`, `POSTED`, `HAS_TOKEN`; soft close instead of `DETACH DELETE` | **Fixed** (`2f1115a`). `HAS_AREA`, `HAS_CHANNEL`, `POSTED`, `ISSUED`, `HAS_TOKEN`; a dropped channel is closed, not deleted. Live: `linkRegistry()` took `allevia_meta` from 0 to 21 relationships (10 channels, 7 posts, 2 areas, 2 invites). |
| G4 | Check-up has one point per tenant, findings read from JSON, no closed `FAILS` | HIGH | Run it more than once on `demo_growth`; read findings from open `FAILS`; trend from `metric_trend` | **Fixed in code** (`cd4ca5d`). Findings, fixed-since-last-time and the trend are read from open and closed `FAILS` edges and the `checkup_*` readings; `serp_position` keeps rank history. Live: a second check-up on a test business read its earlier run ("252 ms to 388 ms, worse"). `demo_growth`'s site (demo.example) cannot be opened, so it still has no trend. |
| G5 | No rank or community for a business onboarded from a website | HIGH | Split rank and communities out of the librarian; call after tidy in onboarding; include `LINKS_TO_PAGE` | **Fixed** (`062e4db`). The rank-and-groups step is its own function, run at the end of onboarding, `LINKS_TO_PAGE` feeds the groups. See the live onboarding check below. |
| G6 | Connections leave no trace in the graph; public data never ran live and its ledger is a file | HIGH | `System` gets connected date, who, fact count; `Business OWNS System`, `Channel DEPENDS_ON System`, `System PRODUCED Document`; `System.status` tracked; spend as an Observation | **Fixed** (`3a03847`, `b96595c`). A connection's `System` carries `connectedAt`, `connectedBy`, `factCount`, `lastPullAt`; `Business OWNS System`, `Channel DEPENDS_ON System`, `System PRODUCED Document`; Calendar, Gmail, Stripe and Shopify reads are snapshot Documents; live reads are `Document{kind:'live_read'}`. Public-data spend is an Observation; a rival's ads and Instagram are nodes. Tested against fakes only: no Composio account is connected and there is no Apify token. |
| G7 | AI visibility wrote no edges | HIGH | `Competitor` nodes, `Query` nodes with a 0/1 `ai_named` Observation, `Document MENTIONS` both | **Fixed** (`6a921dc`). Competitor nodes, a `Query` per question with a 0/1 `ai_named` reading, `Document MENTIONS` both (tests). |
| G8 | Stand-up picks are not linked to the signals behind them | HIGH | `Document MENTIONS` the evidence with `role` and `pickKey`; festivals as `Event` nodes; log swallowed failures | **Fixed** (recovered from the stand-up builder's unfinished worktree, `50b29b9`). `Document(standup) MENTIONS{role,pickKey}` the evidence and the signals, festivals as `Event` nodes, swallowed failures logged. Live: a stand-up on a fresh seed left 3 evidence edges to the leads and deal behind its two picks. |
| G9 | Check-up renames onboarding's Pages to their path (live bug) | MED | Carry the title into the run | **Fixed** (`cd4ca5d`). One page-name rule; a check-up never renames a Page. |
| G10 | Provenance: `src` double prefix; Turn, Finding and action-layer edges without `src`/`asOf` | MED-HIGH | `src: ctx.turnId`; `SOURCED_FROM Turn`; stamp `asOf`/`src` in `saveTurn`, approvals, executors, Studio | **Fixed** (`ead8a28`, `415bc99`). `src: ctx.turnId` everywhere (the creative writers too), `SOURCED_FROM Turn`, `src`/`asOf` on Turn, Finding and their edges. Live: 154 of a turn's `TOUCHED` edges carry `src`. |
| G11 | Sales, posts and the plan are not tied to goals, channels and attribution; the demo has no Approval to Message chain; the plan cannot say what moved a goal | HIGH | `Message\|Meeting CAME_VIA Channel`, `Lead CAME_VIA Campaign\|Content`, `Lead\|Deal\|Meeting\|Message ADVANCES Goal`, `Content ADVANCES Goal` from the publish path, a real Approval and Action in the demo, the scorecard reads `ADVANCES` | **Fixed** (`d66ccf5`, `de42cb5`, `50b29b9`). `Message/Meeting CAME_VIA Channel`, `Lead CAME_VIA Campaign/Content`, `Lead/Deal/Meeting/Message ADVANCES Goal`, `Content ADVANCES Goal` from the publish path, `Message.status` tracked, the demo's Approval to Action to Message chains, the plan reads what is aimed at each goal and why a target is what it is. Live on a fresh seed: 7 message and 2 meeting channel links, 2 lead attributions, 13 `ADVANCES`, 6 Approval to Action to Message/Meeting chains. The existing `demo_growth` graph got the chains and channel links but not the attributions: `seed-demo demo_growth` rebuilds it complete. |
| G12 | Privacy scan only at ingest; chat nodes not redacted | MED | Scan at the end of onboarding; record as an Event and an Observation; put chat writes through the same filter | **Fixed** (`8600c16`, then `src/ingest/clean.ts`). The privacy scan runs at the end of onboarding and is recorded as an `Event` and a reading. What a chat turn writes now goes through the same detectors as ingest before it is saved: the Turn (question, answer, event log), its Findings and the thread's name, `remember`'s notes, `propose_action` cards (title, reasoning, the words of the payload), made posters and scripts (`creative/`), and the owner's standing instructions. The question's vector is made from the cleaned text. A node that had something taken out carries `redactions` (a count, never the values) and the tool tells the model and the owner. Left alone on purpose: ids, digests, numbers, and what an executor needs on a card (recipients, guests, a connected tool's arguments, the account a post goes to). A scan of a business that only chatted comes back empty (`tests/agent/chat-privacy.test.ts`). One consequence: a phone number or address the owner wants in a post or an email has to be typed in by hand when they edit the card. |
| G13 | Discord not mirrored in the tenant graph | MED | `channel:discord`, `Approval PUBLISHED_ON Channel{messageId}` | **Fixed** (`2f1115a`). `channel:discord` in the business's graph, `Approval PUBLISHED_ON {messageId}`, a joining member is a `Person` (last four digits of the Discord id only). |
| G14 | No structural detector | MED | `tech.unowned_critical_system` over `DEPENDS_ON*1..3` and PageRank | **Fixed** (recovered, `50b29b9`). `tech.unowned_critical_system`: PageRank over the tools' `DEPENDS_ON` edges plus a 3-step dependents count, nobody `OWNS` it. Live, read-only on the real business: 3 candidates in 5.4 s from 240 ranked tools (the most leaned-on system has 22 things relying on it and no owner). |
| G15 | Studio: lineage and spend are not graph reads/facts; clip outside the approval chain | MED-HIGH | `asset_lineage` read and tool, spend Observations per job, `Asset GUIDED_BY` rules, clip approved like an image | **Mostly fixed** (`c1d9515`). `asset_lineage` read (`graph:lineage`, `GET /api/:t/assets/:id/lineage`), a `Document{generation}` per job and a `studio_credits_spent` reading per asset, `Asset GUIDED_BY` rules, the clip approved on the same card. Open: the Studio page does not yet draw the lineage, and the older variant B path still keeps its prompt sources as a list property. |
| G17 | Onboarding and ingest runs are not nodes with edges | MED | `Event{onboard}` and ingest `AFFECTS Business`; hygiene Observations | **Fixed** (`8600c16`). `Event{onboard}` and the ingest `Event` `AFFECTS Business`, `orphan_count`, `merged_count`, `graph_nodes`, `privacy_scan_hits` readings, `extractedBy` and `ontologyVersion` on extracted edges. |
| G18 | Turns not embedded; `remember` never supersedes | MED | Embed Turns; write `SUPERSEDES` | **Fixed** (`7365397`). Turns are embedded (best effort), `recall` finds earlier questions by vector, `remember` writes `SUPERSEDES`, chat proposals `ADVANCES` a goal. |
| G26 | Hours, address, page scores, extractor/ontology untracked | LOW-MED | Track and record | **Mostly fixed** (`f8626fe`). `seo_page_score` readings, a vanished page's `PART_OF` closed after a complete crawl. Hours, address and price are still plain properties: open. |

Not fixed, said plainly: hours, address and price are plain properties; the Studio page does not draw
the lineage it now has; no post-performance reader (the Instagram media-insights action is in the allow-list but no real account is
connected, so "what did that post do" has no data); Calendar and Gmail read-only live data becomes facts only through the connection's
snapshot; Cloud has no per-business database users (isolation is the application's); a customer cannot re-run ingest; the existing
`demo_growth` graph should be rebuilt with `seed-demo demo_growth` to carry the complete Sales attribution (not done here: it would drop
the live audit cards).

## Found while checking, and fixed

- **The team's answer replaced by a deflection** (the efficiency benchmark, real business): "I've written the answer above ..." or "not linked in the records, so there is no path to show" became the whole answer when the Chief wrote its answer, looked one more thing up, and closed with that line. `AnswerStream.finish` now keeps the earlier answer. Two tests.
- **Founder-business examples in every owner's check-up** ("Interiors for homes and offices in Raipur", "AVS Atelier", "walnut panelling"): neutral examples now.
- **A privacy marker in a card and a panel** ("Supabase prod ([redacted:supabase-ref], Mumbai)" on the Brain page and in the new detector's card): shown as "Supabase prod (Mumbai)".
- **`turn:turn:` provenance** on every card and memory, in the creative writers too (still present in the recorded public-demo file, which is a recording).
- **A rival's channel and ads could be mistaken for the owner's** by four channel readers and the silent-channel detector: filtered.
- **The test infrastructure**: the local test FalkorDB's Colima VM died twice under four builders plus tests ("Invalid virtual machine state"), taking the database with it for about 15 minutes each time; restarted with `colima stop --force` and `colima start` (the test container comes back by itself). Keep to two builders and targeted tests.
- **The hygiene scan** failed on the website prototype's `.glb` file and on two planted test values; fixed in the scan and the tests.
