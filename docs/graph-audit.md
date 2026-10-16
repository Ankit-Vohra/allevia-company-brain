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

## Gap register, ranked by hackathon impact

Status is filled in as each fix lands (commit hashes in the progress comments on issue #38).

| # | Gap | Impact | Fix | Status |
|---|---|---|---|---|
| G1 | The answer's "How we know" path is only in the event-log JSON; path ids are not checked against what the turn touched | HIGH | Store `Turn.pathIds` and `onPath`/`pathIndex` on the `TOUCHED` edges; `show_path` refuses ids no tool returned this turn; drop unconnected nodes from the drawn path; a read "answers that walked through this node" | open |
| G2 | Rules and skills a draft or answer used are not edges (zero `GUIDED_BY`; skills are strings; no learned rule in either live graph) | HIGH | `Approval\|Recommendation -GUIDED_BY-> Rule` with how/find/replace; skills as `Playbook{kind:'skill'}` nodes with `Turn TOUCHED`, `Agent USES`; `use_skill` rule ids into `guidedBy`; `LEARNED_FROM` with `src`/`asOf`/`conf`; `Rule.confidence` tracked; one real edit-then-approve cycle on `demo_growth` | open |
| G3 | `allevia_meta` has no relationships | HIGH | `Tenant -HAS_AREA-> DiscordArea -HAS_CHANNEL-> DiscordChannel`, `ISSUED`, `POSTED`, `HAS_TOKEN`; soft close instead of `DETACH DELETE` | open |
| G4 | Check-up has one point per tenant, findings read from JSON, no closed `FAILS` | HIGH | Run it more than once on `demo_growth`; read findings from open `FAILS`; trend from `metric_trend` | open |
| G5 | No rank or community for a business onboarded from a website | HIGH | Split rank and communities out of the librarian; call after tidy in onboarding; include `LINKS_TO_PAGE` | open |
| G6 | Connections leave no trace in the graph; public data never ran live and its ledger is a file | HIGH | `System` gets connected date, who, fact count; `Business OWNS System`, `Channel DEPENDS_ON System`, `System PRODUCED Document`; `System.status` tracked; spend as an Observation | open |
| G7 | AI visibility wrote no edges | HIGH | `Competitor` nodes, `Query` nodes with a 0/1 `ai_named` Observation, `Document MENTIONS` both | open |
| G8 | Stand-up picks are not linked to the signals behind them | HIGH | `Document MENTIONS` the evidence with `role` and `pickKey`; festivals as `Event` nodes; log swallowed failures | open |
| G9 | Check-up renames onboarding's Pages to their path (live bug) | MED | Carry the title into the run | open |
| G10 | Provenance: `src` double prefix; Turn, Finding and action-layer edges without `src`/`asOf` | MED-HIGH | `src: ctx.turnId`; `SOURCED_FROM Turn`; stamp `asOf`/`src` in `saveTurn`, approvals, executors, Studio | open |
| G11 | Sales, posts and the plan are not tied to goals, channels and attribution; the demo has no Approval to Message chain; the plan cannot say what moved a goal | HIGH | `Message\|Meeting CAME_VIA Channel`, `Lead CAME_VIA Campaign\|Content`, `Lead\|Deal\|Meeting\|Message ADVANCES Goal`, `Content ADVANCES Goal` from the publish path, a real Approval and Action in the demo, the scorecard reads `ADVANCES` | open |
| G12 | Privacy scan only at ingest; chat nodes not redacted | MED | Scan at the end of onboarding; record as an Event and an Observation | open |
| G13 | Discord not mirrored in the tenant graph | MED | `channel:discord`, `Approval PUBLISHED_ON Channel{messageId}` | open |
| G14 | No structural detector | MED | `tech.unowned_critical_system` over `DEPENDS_ON*1..3` and PageRank | open |
| G15 | Studio: lineage and spend are not graph reads/facts; clip outside the approval chain | MED-HIGH | `asset_lineage` read and tool, spend Observations per job, `Asset GUIDED_BY` rules, clip approved like an image | open |
| G17 | Onboarding and ingest runs are not nodes with edges | MED | `Event{onboard}` and ingest `AFFECTS Business`; hygiene Observations | open |
| G18 | Turns not embedded; `remember` never supersedes | MED | Embed Turns; write `SUPERSEDES` | open |
| G26 | Hours, address, page scores, extractor/ontology untracked | LOW-MED | Track and record | open |

Not fixed (out of scope for a day, said plainly): connection read-only live data (Calendar, Gmail) still does not become facts
except through the connection's snapshot; no post-performance reader (the Instagram media insights action is in the allow-list
but no real account is connected); Cloud has no per-business database users; a customer cannot re-run ingest.
