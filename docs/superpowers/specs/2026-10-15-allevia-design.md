# Allevia: design spec

Status: approved by the founder 2026-10-15 ("take this hackathon end to end … take the necessary design calls").
Author: Claude (Opus 5.5), from a brainstorm with the founder on 2026-10-15 00:20–01:20 IST.
Hackathon: WeMakeDevs × FalkorDB "Graph Hacks: Context for AI Agents", 2026-10-15 00:01 → 2026-10-18 23:59 IST.

## 1. What Allevia is

A **company brain for small and medium business owners who are not technical**. Allevia keeps one knowledge graph per
business in FalkorDB. The graph holds the business's documents, decisions, people, products, audiences, brand,
channels, content and its performance, website pages, search data, ad spend and every conversation with the owner.
One orchestrating agent works over that graph and:

1. **Answers "why" with sources.** It walks the graph and shows the path: which decision, based on which numbers, from
   which document, decided by whom, and when.
2. **Diagnoses growth and SEO.** It joins Search Console, GA4, Instagram and signups by channel, then gives ranked
   fixes with the numbers behind each one.
3. **Writes brand-aware content briefs.** It builds them from audience → needs → product → past content that actually
   worked → brand rules → playbook formulas. The owner never writes a prompt.
4. **Advises on ad spend.** Cost per result and budget moves, with evidence. In v1 the ad data is simulated and
   labelled as such.
5. **Acts after one tap.** Anything that changes the outside world becomes an approval card. Each approval and its
   result are stored in the graph.
6. **Remembers.** Every thread, every "remember that…" and every approval or edit persists, and later threads recall
   them through the graph.

Positioning: an **AI growth analyst across all the platforms' separate AI tools**. It is not an "AI marketer instead
of a hire". Research (2026-10-15) found that brand memory and prompt-free content are already sold by Sintra and
Marblism. Nobody found pulls GA4, Search Console and ad data into one memory and answers "why" with evidence. That is
Allevia's gap.

First businesses:
- **Aamdani** (aamdani.ai, a blue-collar jobs platform): real data from the `aamdani-brain` vault plus the read-only
  `aamdani-ops` connectors.
- **AVS Atelier** (avsatelier.in, the founder's architecture firm): set up from only its website URL. This proves
  "any SMB".

### Non-goals for the hackathon (phase 3, see §14)
- Self-serve OAuth for strangers. Google verification and Meta review take weeks, so connecting accounts stays
  founder-assisted.
- Billing.
- WhatsApp.
- Publishing to social accounts. Allevia drafts; publishing stays in the existing marketing system.
- Real ad-account writes.

## 2. Hackathon fit

| Judging focus | Where Allevia does it |
|---|---|
| Graph shapes what the agent does | Every tool is a graph query or algorithm. The agent cannot answer without walking the graph, and the answer's path is checked against it (§7.4). |
| Track 3 Company Brain: docs, tickets and chats in one graph | Vault docs, decisions, PENDING, GitHub issues and Allevia's own threads all live in one graph per business (§5) |
| Who owns what, who knows what | `OWNS` from PENDING owners, assignees and the registry. `KNOWS_ABOUT` from git authorship of the vault (`agent:<name>:` commits) and from authored decisions (§5.3) |
| Tracing decisions to their source | `Decision -BASED_ON-> Observation/Document`, `Person -DECIDED-> Decision`, quotes with dates. The `trace_decision` tool and the lit path (§7) |
| Keeping knowledge current | Bi-temporal edges (`since/until` plus `recordedAt/retiredAt`), `Version` history on changing entities, idempotent re-sync, a librarian that closes contradicted facts (§5.4, §6.6) |
| Answers with clear sources | Every claim cites a node. The server checks that each citation was actually read in this turn and that every number appears in a tool result (§7.4) |
| Track 2 Memory and coordination | Episodic (Session/Turn), semantic (company graph plus Memory notes) and procedural (Playbook/Rule plus LearnedRule) memory. Batch agents and the chat agent share state through the graph. One graph per tenant (§8) |
| Track 1 Act on connected data | Graph algorithms as tools (paths, PageRank, betweenness, WCC, label propagation). Recommendations from graph evidence, then approval, then an executed action (§9) |
| FalkorDB features | Multi-graph tenancy, Cypher, `GRAPH.RO_QUERY` guard, `algo.*`, vector plus full-text indexes, FalkorDB Browser for exploring, MCP |

"New work" rule: all code in this repo is new and written during the event. We reuse libraries (npm packages),
vendored **data** from MIT/Apache playbook repos (with LICENSE and NOTICE), and Jarvis's connectors **called as a
service over MCP**. None of their code is copied.

## 3. Verified technical ground (spikes, 2026-10-15 01:00–01:15 IST)

- **FalkorDB 6.0.2** (Docker image `falkordb/falkordb:6.0.2`; local container `allevia-falkordb` on 127.0.0.1:6390,
  Browser on 127.0.0.1:3090; Homebrew Redis owns 6379).
  - Works: `GRAPH.RO_QUERY` (and it rejects writes), `algo.SPpaths`, `algo.BFS`, `algo.pageRank`, `algo.betweenness`,
    `algo.WCC`, `algo.labelPropagation`.
  - Works: vector index (`CREATE VECTOR INDEX … OPTIONS {dimension, similarityFunction:'cosine'}`,
    `db.idx.vector.queryNodes`, where score is a distance and lower means closer).
  - Works: full-text index (`CREATE FULLTEXT INDEX FOR (n:L) ON (n.p)`, `db.idx.fulltext.queryNodes`), range
    indexes, params, multi-graph `list()`.
  - `shortestPath()` is allowed only in `WITH`/`RETURN`.
  - The old `db.idx.fulltext.createNodeIndex('L','p')` form fails on 6.0.
- **Node client** `falkordb@6.8.0`: `selectGraph`, `query`, `roQuery`, `{params}`.
- **Claude Agent SDK** `@anthropic-ai/claude-agent-sdk@0.3.300` on the **founder's subscription** (no API key).
  - Verified: in-process MCP tools (`createSdkMcpServer`/`tool`), `settingSources: []` (none of the founder's hooks,
    skills or CLAUDE.md), `tools: []` plus an allow-list, `includePartialMessages` streaming and `outputFormat`
    JSON-schema results.
  - Haiku round trip with one tool call took 7.7 s.
- **Local embeddings**: `@huggingface/transformers@4.3.1` with `Xenova/multilingual-e5-small` (q8, 384 dims, 144 MB
  cached in `./models`). It handles both English and Hindi queries, costs $0, and needs no network after the first
  download.

## 4. Architecture

```
               ┌───────────── surfaces ─────────────┐
 Web app (Vite+React)   Discord bot (demo server)   MCP server (Jarvis, Claude Code)
        │ SSE                    │                          │ stdio / HTTP
        └──────────────┬─────────┴──────────────┬───────────┘
                       ▼                        ▼
               Hono API server  ──────►  Agent runtime (Claude Agent SDK, subscription)
                       │                    │  tools = graph queries + algorithms + memory + propose_action
                       │                    ▼
                       │            ┌──────────────────────────────┐
                       ├──────────► │ FalkorDB: one graph / tenant │ ◄── ingestion pipeline (CLI + schedules)
                       │            │ allevia_<tenant>, allevia_meta│      sources: vault, registry, GitHub,
                       │            └──────────────────────────────┘      ops-MCP-over-SSH snapshots, website
                       ▼                                                    crawl, Instagram, playbooks, sim ads
        Insights / brief / approvals / executors (GitHub issue, content draft, simulated ad pause, Discord post)
```

- **Language**: TypeScript end to end on Node 24, ESM, run with `tsx` (same as the founder's marketing repo).
- **Packages**: one backend package (`src/`) plus `web/` (Vite) in the same repo.
- **Graph naming**: `allevia_meta` holds tenants, users and settings. Each business has its own `allevia_<slug>`
  graph. Tests use `allevia_test_<random>` and drop it afterwards.
- **Config**: `~/.config/allevia/allevia.env` (secrets, mode 600, outside the repo) plus process env. `.env.example`
  documents every name.
- **Model**: `ALLEVIA_MODEL` defaults to `sonnet` for chat and `haiku` for bulk extraction. `opus` is opt-in.
  `AgentRuntime` is an interface; the only implementation tonight is `ClaudeAgentSdkRuntime`. A later API-key or
  Gemini runtime plugs in without touching the tools.

## 5. The graph

### 5.1 Conventions
- Every node carries the base label **`Entity`** plus one type label (for example `Entity:Decision`). Each has a
  stable, deterministic `id` of the form `<type>:<slug>` (for example `decision:008-discord-brain-agent-subscription`,
  `person:founder`, `channel:instagram`, `page:www.aamdani.ai/jobs`). Re-ingestion uses `MERGE` on `id`, so it is
  idempotent.
- Common properties are `name`, `summary`, `createdAt`, `updatedAt` (epoch ms), `src` (Document id of the latest
  source), `asOf` (ISO date of the latest source), `simulated` (bool, only for synthetic data) and `embedding`
  (vecf32[384], on searchable types).
- Indexes:
  - Range index on `Entity.id`.
  - Full-text index on `Entity.name` and `Entity.summary`, and on `Chunk.text`.
  - Vector index (cosine, 384 dims) on `Entity.embedding` and `Chunk.embedding`.

### 5.2 Node types
| Label | What | Key props |
|---|---|---|
| Business | the tenant itself | domain, industry, city, stage |
| Person | founder, team, external | role |
| Agent | AI agents (Jarvis, librarian, claude-code, Allevia) | kind |
| Team | department or team | |
| Product, Feature | what the business sells or does | |
| Audience | segment or persona (seekers, employers, homeowners…) | |
| Need | a pain or need of an audience | |
| BrandRule | voice, visual or do/don't rule | kind, text |
| BrandAsset | colour, font, logo | kind, value |
| Channel | Instagram, Facebook, YouTube, website, Google Search, Meta Ads, Google Ads, Discord… | platform, handle, status |
| Content | reel, post, story, short, article | format, publishedAt, permalink, caption, hook |
| Campaign | ad or marketing campaign | objective, status, simulated |
| Page | website URL | url, path, title, metaDescription, h1, wordCount, statusCode |
| Query | search query | text |
| Metric | metric definition | key, unit, definition |
| Observation | one metric value for one subject and window | metric, value, unit, windowStart, windowEnd, asOf, simulated |
| Document | a source: vault note, decision file, report, issue, web page, snapshot, playbook file | kind, path/url, title, asOf, hash |
| Chunk | a passage of a Document | text, ord |
| Decision | a recorded decision (ADR) | status, decidedAt |
| Task | PENDING line or GitHub issue | kind, status, ref |
| System | connector, tool, service, scheduled job | kind, status |
| Event | timeline event (Google algorithm update, launch, pause) | kind, at |
| Playbook | an imported know-how pack | source, license, url |
| Rule | a procedural unit: hook formula, SEO check, profile-rubric item, benchmark, voice pattern, ad rule | kind, text, severity, match, weight |
| Recommendation | a proposed improvement with evidence | area, status, score, confidence |
| Approval | a one-tap card | kind, status, payload, editedPayload, decidedAt |
| Action | an executed side effect | kind, status, result, at |
| Session, Turn | threads and Q&A turns (episodic memory) | channel, question, answer, at, checks |
| Memory | something the owner said to keep | kind (preference/fact/instruction), text |
| Version | an earlier state of a changing entity | props (JSON), since, until, src |

### 5.3 Relationship types
- **Company:** `MEMBER_OF`, `OWNS`, `KNOWS_ABOUT {weight}`, `AUTHORED {at}`, `DECIDED {at}`, `BASED_ON`, `SUPERSEDES`,
  `AFFECTS`, `DEPENDS_ON`, `BLOCKS`, `PART_OF`.
- **Knowledge:** `MENTIONS`, `LINKS_TO` (wiki-links), `SOURCED_FROM` (any → Document), `HAS_CHUNK`.
- **Market:** `TARGETS`, `HAS_NEED`, `SOLVES`, `PUBLISHED_ON`, `PROMOTES`, `LINKS_TO_PAGE`, `RANKS_FOR`, `USES_RULE`
  (content → hook formula), `MEASURES` (Observation → subject).
- **Procedure:** `INCLUDES` (Playbook → Rule), `APPLIES_TO`, `FAILS {evidence}` and `PASSES` (Page/Content → Rule),
  `LEARNED_FROM` (Rule → Approval).
- **Action layer:** `PROPOSES` (Recommendation → Approval), `EVIDENCED_BY` (Recommendation → anything),
  `APPROVED_BY`/`REJECTED_BY` (Approval → Person), `RESULTED_IN` (Approval → Action).
- **Memory:** `ASKED` (Person → Turn), `IN_SESSION`, `TOUCHED` and `CITED` (Turn → Entity), `ABOUT` (Memory → Entity),
  `STATED` (Person → Memory), `HAD_VERSION` (Entity → Version), `CONTRADICTS`.

Every relationship carries `since`, `until` (null means currently true), `recordedAt`, `retiredAt`, `src`, `asOf` and,
where it applies, `conf` (0–1).

### 5.4 Time and change (bi-temporal)
- **Relationship facts** carry valid time (`since`/`until`) and record time (`recordedAt`/`retiredAt`).
  - `upsertEdge` re-asserts the same fact with no new row.
  - `closeEdge` sets `until` and `retiredAt`. Nothing is ever deleted.
  - "Functional" relationships close the old edge when a new one arrives: a Task's `OWNS` owner, a Decision's
    `SUPERSEDES`, a Channel's current status.
- **Changing entities** (status, title, follower count…): before an update overwrites tracked properties,
  `upsertNode` writes `(e)-[:HAD_VERSION]->(:Version {props, since, until, src})`. Current props are then always the
  live view, and history is one hop away.
- **Numbers** are always `Observation` nodes with their window and `asOf`, never overwritten properties.
- Every tool accepts `asOf` for **time travel**: it filters edges where `since <= t < coalesce(until, ∞)`.

### 5.5 Who knows what
`KNOWS_ABOUT(actor → entity)` is derived as follows:
- Vault git history (`git log --follow` per file): commits starting `agent:<name>:` are credited to that Agent; other
  commits go to the founder. Each authored Document passes its `MENTIONS` on to its authors, weighted by commit count
  and recency.
- `DECIDED` and `OWNS` add weight too.

## 6. Ingestion

### 6.1 Pipeline
`Source → RawDoc[] → privacy filter → (deterministic mapper | LLM extraction) → GraphWrite[] → upsert → post-process`.

- Steps 1–3 are idempotent.
- The LLM extraction cache is keyed by the SHA-256 of the redacted text plus the ontology version, under
  `data/cache/extract/` (gitignored). Re-runs cost nothing and pick up only changed docs.
- Each run writes a report to `data/runs/<tenant>/<timestamp>.json` (counts per type, closed facts, skipped files,
  privacy redactions) and records it in the graph as an `Event {kind:'ingest'}`.
- The vault is read from the Mac's clone at `~/aamdani-brain` as it is. Allevia never pulls or writes it, and it
  records the clone's HEAD commit in the run report.

### 6.2 Sources
| Source | How | Writes |
|---|---|---|
| `aamdani-brain` vault (local clone, read-only) | markdown parse: frontmatter, headings, wiki-links, chunks (~800 chars on heading boundaries) | Document, Chunk, `LINKS_TO`; LLM extraction to typed entities and relationships with `SOURCED_FROM`/`MENTIONS` |
| `00-command/PENDING.md` | table/line parser | Task (id N#), `OWNS` (founder/agent), status, linked issues |
| `60-decisions/*.md` | ADR parser plus LLM | Decision, `BASED_ON`, `AFFECTS`, `DECIDED`, `SUPERSEDES` |
| `70-reports/daily/*.md` (Jarvis morning briefs) | LLM extraction of dated numbers | Observation (with `asOf` = report date) |
| `registry/**.yaml` | YAML mapper | Agent, Team, System (connectors, tools), `DEPENDS_ON`, `OWNS`, `MEMBER_OF` |
| vault git history | `git log` | `AUTHORED`, then `KNOWS_ABOUT` |
| GitHub issues (aamdani repos, via `gh`) | REST | Task(kind=issue), labels, assignee `OWNS`, `MENTIONS` by name match |
| `aamdani-ops` MCP over SSH (read tools only) | MCP client over `ssh … ops-mcp-launch.sh` stdio | snapshot JSON in `data/snapshots/<tenant>/<date>/` → Observation, Content, Page, Query, Channel |
| Website crawl (both tenants) | Playwright (Chromium) crawler, same-origin, ≤ 60 pages, robots-aware | Page, `LINKS_TO`, BrandAsset (colours/fonts/logo), SEO `FAILS`/`PASSES`, LLM: Product/Feature/Audience/Need/BrandRule |
| Instagram (AVS, only if a token is set) | Instagram API with Instagram Login | Content, Observation |
| Playbooks (vendored, MIT/Apache) | JSON/MD mappers | Playbook, Rule, `INCLUDES`, `APPLIES_TO` (filtered to the tenant's industry) |
| Simulated ads | deterministic generator, seeded | Campaign, Observation (`simulated:true` everywhere) |

The ops snapshot uses `users_summary`, `new_users`, `acquisition_sources`, `signup_funnel`, `search_console`,
`analytics_ga4`, `reels_performance`, `account_reach`, `published_content`, `facebook_reels`, `youtube_stats`,
`marketplace`, `connectors_status` (names and status only), `brain_pending` and `review_cards`. It skips
`clarity_insights` (10 reads a day), `server_health` and `cron_status` (infrastructure). It runs only tools whose names
pass a read-only allow-list.

### 6.3 Privacy filter (founder decision: "real numbers, filtered notes")
Three layers, each tested:
1. **Path policy.**
   - Allow-list: `00-command/{OPERATING-MANUAL,PENDING,founder-preferences,*priorit*}`, `10-company/**`,
     `20-growth/**`, `30-content/**`, `60-decisions/**`, `70-reports/daily/**`, `70-reports/weekly/**`,
     `70-reports/jarvis-eval-*`, `agents/**`, `registry/**`, `CLAUDE.md`, `README.md`.
   - Always denied, even inside allowed folders: anything matching `/security|audit|access|secret|credential|incident|backup|password|token|ssh|aws|server|infra|finance|bank|kyc/i`.
   - `15-tech/`, `40-finance/` and `50-ops/` are excluded entirely.
2. **Section policy.** Markdown sections whose heading matches the same pattern are dropped (for example "AUDIT FIXES
   — PROD ROUND 2").
3. **Redaction.** These are replaced with `[redacted:<kind>]` before any LLM or graph write:
   - IPv4 addresses, AWS ids (`i-…`, `sg-…`, `vpc-…`, `arn:aws:…`), emails, phone numbers.
   - Token and secret shapes, `NAME=value` assignments for `*KEY/*TOKEN/*SECRET/*PASSWORD`, URLs with credentials,
     local secret paths (`~/Documents/aamdani-secrets`, `~/.config/…`, `/home/…/secrets`).
   - CIN, D-U-N-S, Apple Team IDs and Supabase project refs.

`allevia privacy-scan <tenant>` scans every string property in the graph for the same patterns and must report 0.
It is part of the test suite and the morning checks.

### 6.4 LLM extraction
- Claude via the Agent SDK with `outputFormat` set to a JSON schema built from the ontology (allowed labels, allowed
  relationship patterns), so it cannot invent types. Model `haiku` by default.
- Each extracted entity has `name`, `type` and `summary`. Each relationship has its endpoints, `type`, `evidence` (a
  short quote) and `conf`.
- Entity resolution: normalise names, then match against existing ids by exact slug, then by full-text and vector
  similarity (≥ 0.92) within the same label. Anything ambiguous is created with `conf < 0.6` and a `MENTIONS` edge, not
  merged.

### 6.5 Embeddings
Chunks and named entities get e5-small embeddings (`passage:` prefix; queries use `query:`). The batch size is 32. The
model loads once per process.

### 6.6 Librarian (post-ingest job)
- Derives `KNOWS_ABOUT`.
- Closes functional edges contradicted by newer sources.
- Flags `CONTRADICTS` between owner Memory notes and the facts they disagree with, and raises a "clarify"
  Recommendation.
- Stores PageRank (Document/Entity importance) and community ids (label propagation over `MENTIONS`/`LINKS_TO`) as
  properties for the UI.
- Reports orphans (WCC singletons) as "knowledge nobody links to".

## 7. The agent

### 7.1 Runtime
- `ClaudeAgentSdkRuntime` calls `query()` with:
  - `settingSources: []` and `tools: []`.
  - `allowedTools` set to the Allevia MCP tools only.
  - `permissionMode: 'dontAsk'` and `includePartialMessages: true`.
  - `cwd` set to an empty per-process scratch directory.
  - `env` without `ANTHROPIC_API_KEY`, so it runs on the subscription.
- Tools are built per request and bound to the tenant graph.
- Subagents are declared with the SDK `agents` option:
  - `analyst`: growth, SEO and ads; its tools are analysis queries, algorithms and propose_action.
  - `creative`: content briefs; its tools are content performance, audience/brand/playbook lookups and propose_action.

  The orchestrator decides when to delegate.

### 7.2 Tools (all return `{data, nodes:[{id,label,name}], edges:[{from,type,to}], sources:[{id,title,asOf}]}`)
| Tool | Cypher / algorithm |
|---|---|
| `search` | full-text plus vector (entities and chunks), fused by reciprocal rank |
| `get_entity` | node, current neighbours by type, versions count, `asOf` filter |
| `neighbors` | typed one- to two-hop expansion with a limit |
| `find_paths` | `algo.SPpaths` between two entities (relationship-type filter, up to 3 paths) |
| `trace_decision` | decision → evidence → sources → deciders → what it affects → what superseded it |
| `who_owns` / `who_knows` | `OWNS` (current) and ranked `KNOWS_ABOUT` |
| `impact_of` | downstream `DEPENDS_ON`/`AFFECTS` traversal plus betweenness score ("what breaks if…") |
| `important` | PageRank over a label or relationship subgraph |
| `topics` | label-propagation communities with top members |
| `metric_trend` | Observations for a metric and subject over time, with deltas |
| `content_performance` | Content × hook Rule × Observation × Audience, ranked by outlier multiple |
| `seo_report` | Pages × failed Rules × Search Console/GA4 Observations |
| `ad_report` | Campaign × spend/results Observations (always says `simulated`) |
| `playbook` | Rules for a topic or industry (hooks, checks, benchmarks) |
| `history` | Versions and closed edges of an entity (time travel) |
| `recall` | past Turns and Memories that touched the given entities |
| `cypher` | **`GRAPH.RO_QUERY` only**, with a 5 s timeout, a 200-row cap, and no `CALL db.*` writes |
| `remember` | writes a Memory (`ABOUT` entities, `STATED` by the asker, `src` = this Turn) |
| `propose_action` | creates a Recommendation and a pending Approval (github_issue / content_draft / pause_ad / discord_post); never executes |
| `show_path` | the final step: the agent passes the ordered node ids of its explanation. The tool checks they exist, links each consecutive pair with a shortest path, and returns the edges for the UI |

### 7.3 Threads and memory (founder, 2026-10-15: one thread per conversation, as in Jarvis)
- A new question starts a new **Session** (web: "New thread"; Discord: a new message in the channel starts a thread).
  Replies continue the thread through SDK `resume`, so the context stays small.
- **Cross-thread memory comes from the graph.** Before the first turn of a thread, the server runs `search` on the
  question, then gathers:
  - `recall` over the touched entities: the last 5 relevant Turns and all Memories `ABOUT` them.
  - Open Approvals and Recommendations on them.
  - The owner's preferences (Memory kind=preference).

  It compiles these into a ≤ 1,500-token "what we already know" brief in the system prompt, with ids, so the agent
  can cite them.
- After every turn, the server writes the Turn with `TOUCHED` (every node any tool returned) and `CITED` edges, the
  checks, and the full event log as JSON. The event log is what makes **replay** possible (§11.3).

### 7.4 Answer contract and checks ("make no mistakes")
- The answer is streamed markdown. Each claim cites `[[node-id]]`, and the answer ends with a `show_path` call.
- The server checks every turn:
  - **Citations**: every `[[id]]` was returned by a tool in this turn.
  - **Numbers**: every number in the answer, apart from dates and list ordinals, appears in a tool result from this
    turn.
  - **Simulated data**: if any touched node is `simulated`, the answer contains the word "simulated".
  - **Freshness**: if the newest `asOf` used is more than 7 days old, the answer must say "as of <date>".
- Failed checks are shown in the UI as a yellow "unverified" badge, stored on the Turn, and counted in evals. They
  are never hidden.
- Answer style follows Jarvis's (answer first, bullets, numbers with dates, one next action). Hindi in, Hindi out.

## 8. Memory model (Track 2)
- **Episodic**: Session, Turn, Approval and Action. Each is linked to the entities it touched.
- **Semantic**: the company graph, plus Memory notes from the owner.
- **Procedural**: Playbook and Rule (imported), plus learned rules (`Rule {kind:'learned'}`). When the owner edits a
  draft before approving it, the diff is stored and summarised into a learned rule `LEARNED_FROM` that Approval. Later
  briefs apply it.
- **Shared state between agents**:
  - The chat agent, the analyst job (Recommendations), the librarian (reconciliation) and the brief writer read and
    write the same tenant graph.
  - Handoffs are explicit: a Recommendation created by the analyst job is what the chat agent shows and the approval
    executor acts on.
- **Isolation**: one graph per tenant. A tool can only reach the graph bound to its request.

## 9. Insights, approvals and actions
- **Detectors** are deterministic Cypher with thresholds. They produce candidate findings and evidence ids, so the
  numbers come from the graph and not from the model:
  - SEO: pages failing high-severity rules, not indexed, sitemap errors, impressions with CTR < 1 %.
  - Content: hook formulas with an outlier multiple ≥ 2× against the median, format mix, posting gaps.
  - Funnel: the biggest drop-off step.
  - Ads (simulated): CPA ≥ 1.5× the account median.
  - Knowledge: orphan docs, stale PENDING items, decisions with no evidence.
- **Recommend**: the analyst subagent turns each candidate into a Recommendation (title, why, evidence ids, expected
  impact, confidence), and where an action fits it calls `propose_action`.
- **Approvals**: web cards and Discord buttons call the same service. States: pending, then approved / edited /
  rejected, then executed or failed.
- **Executors**:
  - `github_issue`: creates the issue in the tenant's configured repo; the demo uses `Ankit-Vohra/allevia` with the
    label `allevia-action`.
  - `content_draft`: writes a Content node with `status=draft` plus a markdown brief. It never publishes.
  - `pause_ad`: simulated, changes the simulated Campaign status.
  - `discord_post`: posts to the demo server.
  Every execution writes an Action with its result.
- **Morning brief**: what changed since yesterday (new Observations, closed facts, new Recommendations, pending
  Approvals). Shown on the web Home and posted to Discord on request or on a schedule.

## 10. Surfaces
- **Web app** (Vite + React 19, Allevia brand tokens from `allevia-ai-website/tokens.css`: "ledger paper, indigo ink,
  one gold mark"; Newsreader + IBM Plex):
  - **Home** (brief, recommendations, approvals count, freshness per source).
  - **Ask** (thread list, chat with tool-call chips and citation chips; the graph on the right lights the path in gold
    with travelling particles).
  - **Brain** (explorer: search, node panel with properties, sources, history timeline and neighbours; PageRank and
    topic overlays).
  - **Insights** (recommendations with an evidence mini-graph).
  - **Approvals** (cards with edit, approve or reject; history).
  - **Onboard** (name + website URL + optional Instagram handle, streamed progress, the graph growing live).
  - Business switcher. Mobile-usable.
- **Discord bot** (discord.js, demo server only): a message in the channel opens a thread and answers there; `/ask`,
  `/brief` and `/approvals`; approval cards with Approve and Reject buttons. Replies link to the web path view.
- **Allevia MCP server** (stdio and Streamable HTTP): read-only tools (`search`, `get_entity`, `find_paths`,
  `trace_decision`, `who_knows`, `metric_trend`, `recall`, `cypher`). This is how Jarvis plugs in during phase 2. No
  Jarvis changes are made during the hackathon.
- **CLI** (`npm run cli -- <cmd>`): `db:check`, `ingest <tenant> [--sources …]`, `onboard`, `insights`, `brief`, `ask`,
  `eval`, `privacy-scan`, `serve`, `discord`, `mcp`.

## 11. Deployment and demo
1. **Local (tonight)**: Colima plus FalkorDB 6.0.2; `npm run cli -- serve` serves the API and the built web app.
2. **Deploy-ready**: a Dockerfile (multi-stage, serves `web/dist`) and `docker-compose.yml` (FalkorDB plus the app)
   for judges' local setup. The host is decided with the founder; the default proposal is Railway.
3. **Public demo without the subscription** (Anthropic's terms do not allow strangers on a personal plan):
   - Read-only mode: the graph explorer, insights and approvals history work live.
   - **Ask replays recorded showcase threads** with their full event log (tool calls, path animation).
   - Live chat turns on only when a model key is configured.
   - The demo video is recorded locally with live answers.

## 12. Quality
- **Unit tests** (vitest): id and slug helpers, privacy (each pattern), markdown and wiki-link parsing, PENDING and
  ADR parsers, the registry mapper, temporal upsert semantics, the hook classifier, SEO rules on fixture HTML, the
  citation and number checkers, Cypher read-only guard, and the simulated-ads generator (deterministic).
- **Integration tests** against the real FalkorDB, in throwaway graphs: fixture vault → ingest → `find_paths`,
  `trace_decision`, `who_knows`, `history`, `asOf`; tenant isolation; RO guard.
- **Agent tests**: the tool loop with a scripted fake runtime, SSE plumbing and Turn persistence. One real-model smoke
  test.
- **Evals**:
  - `evals/aamdani.yaml` has about 30 questions; `evals/avs.yaml` has about 10.
  - Each question lists expected ids or labels to cite, regexes that must match, tools that must be used, and the
    path endpoints.
  - Scoring is automatic: citation validity, number grounding, expected-hit rate, latency.
  - The runner writes `docs/evals/<date>.md`.
- **Reviews**: a code-review pass after each milestone; the privacy scan must report 0; typecheck plus tests before
  every commit.

## 13. Licensing and attribution
Vendored playbook **data** lives in `vendor/playbooks/<repo>/`, with the source LICENSE and a NOTICE entry (repo URL,
commit, files):

| Source | Licence | What we take |
|---|---|---|
| Jakeschincariol/instagram-agent-skill | MIT | `hooks.json`, profile `rubric.json` |
| every-app/open-seo | MIT | the audit issue registry, ported to TS data |
| AgriciDaniel/claude-seo | MIT | `google-updates.json` |
| nowork-studio/notfair-plugin | MIT | industry templates and policy registry |
| conorbronsdon/avoid-ai-writing | MIT | voice patterns |
| anthropics/knowledge-work-plugins | Apache-2.0 | marketing / small-business skill ideas, adapted |

Before vendoring, each repo's licence is re-checked at that commit. **No-licence repos** (getnao/sylph and others) are
used for ideas only, and nothing is copied from them.

## 14. Phases
- **P1, hackathon (Oct 15–18):**
  - Everything above.
  - The last day goes to deployment, showcase recording, the demo video, the blog post (side prize), and the
    README/submission.
  - One morning check-in with the founder: reset the Discord token, AVS Instagram token, deployment host and public
    model.
- **P2, Aamdani daily use:**
  - Scheduled sync on the AWS box or a separate small host.
  - Jarvis gets the Allevia MCP (read-only).
  - The morning brief moves to the graph.
  - The learning loop is wired into the marketing approvals.
- **P3, product:**
  - Composio/Nango-style OAuth for GA4, Search Console, Instagram and Meta/Google Ads (the official MCPs).
  - Google OAuth verification before 100 users.
  - DPDP duties from 2026-11-13.
  - Paid model access (Anthropic's terms).
  - Rupee pricing.
  - A WhatsApp channel.

## 15. Risks
| Risk | Mitigation |
|---|---|
| Subscription limits during the overnight build and evals | Haiku for extraction, Sonnet for chat, extraction cache, small eval batches; noted in the morning report if hit |
| Wrong answers lose trust (research: first-session accuracy decides retention) | Deterministic detectors for numbers, citation and number checks, "unverified" badges, evals |
| Privacy leak in a public demo | Three-layer filter, graph privacy scan = 0, `data/` gitignored, read-only public mode |
| Live box disturbed | Read-only MCP over SSH, allow-listed tools, no writes, no restarts, Clarity skipped |
| Judges see "existing project" | New repo, new code, connectors called over MCP, vendored data credited |
| FalkorDB 6.0 gaps (A*, Louvain not yet ported) | Use SPpaths, BFS, PageRank, betweenness, WCC and labelPropagation, all verified |

## 16. Addendum, 2026-10-15 01:40 IST: the agent company (founder's direction before sleeping)

Founder: "ensure the ui is very interesting, every agent is visible, its knowledge and understanding is visible … if a
request is given then it should be visible on steps followed what each agent did … like we also have for reel and
content generation … make different departments: analytics, tech, center of excellence (numbers and overall), ops,
marketing, content and so on". He pointed to pixel-agents-hq/pixel-agents and harishkotra/agent-office (both MIT) as
the visual reference.

### 16.1 Departments and agents (`shared/roster.ts`)
There are 8 departments and 10 agents. Each agent has a name, a title, tools, a model tier and a pixel sprite palette.

| Department | Agents |
|---|---|
| Leadership | Meera, Chief of Staff (orchestrator) |
| Center of Excellence | Isha, CoE Lead (numbers and overall health; reviews analysts' figures) |
| Analytics | Kabir, Data Analyst |
| Marketing | Rohan, Growth Marketer |
| Content Studio | Tara, Content Strategist → Dev, Brand & Copy Editor → Nisha, Fact Checker (Aamdani's reel-expert pattern) |
| Tech | Arjun, Tech Lead |
| Operations | Vikram, Ops Manager |
| Library | Sara, Librarian |

Each agent is an `Agent` node `MEMBER_OF` its department's `Team` in every tenant graph.

### 16.2 How a request runs
This replaces the SDK-subagent idea in §7.1. We orchestrate ourselves, so every step is attributable and visible.
1. **Recall**: the graph brief of what we already know (§7.3).
2. **Plan**: the Chief of Staff returns structured output `{steps:[{agent, task, after?}], rationale}`. A single-desk
   question gets a 1-step plan, so no work is wasted.
3. **Work**: each planned agent runs as its own Agent SDK `query()` with only its tools and its persona. Agents with no
   pending `after` run in parallel. Each ends by writing a **Finding**: text plus citations, and `basedOn` earlier
   Findings, which is the handoff.
4. **Review**: reviewers named in the roster check the Findings of the agents they cover. Copy Editor and Fact Checker
   review content; CoE reviews numbers. The verdicts are ok, fix (one revision round) or reject.
5. **Answer**: the Chief of Staff synthesises from the Findings, streams the answer, calls `show_path`, and may
   `propose_action`.
6. **Persist**: the Turn (`HANDLED_BY` each agent), Findings (`PRODUCED`, `PART_OF`, `CITED`, `BASED_ON`), reviews
   (`REVIEWED`), and the full event log for replay.
   - Each agent's `KNOWS_ABOUT` weights grow from the entities its Findings cited, so its knowledge visibly builds up
     over time.

Every step streams as `AgentEvent`s (`shared/contracts.ts`): plan, agent_start/status, tool_call/result (attributed),
handoff, finding, review, proposal, text, path, final.

### 16.3 UI additions
- **Office** (the home of the app): a pixel-art floor plan drawn in the Allevia palette ("ledger paper, indigo ink, one
  gold mark") with one room per department and each agent at a desk. The sprites are drawn by us, because the reference
  repos' character art comes from a third-party pack, so it is not covered by their MIT licence.
  - Idle agents breathe. Active agents type, with a speech bubble showing their current step.
  - A handoff animates as a gold "file" flying from desk to desk.
  - Findings pin to the agent's desk.
  - Clicking an agent opens its **profile**: role, tools, playbooks it uses, a **knowledge map** (its `KNOWS_ABOUT`
    subgraph), recent Findings, stats (requests handled, proposals made, checks passed).
- **Ask** shows a **work log**: a per-agent timeline of each step with the nodes it touched. The graph path lights up as
  the answer streams. The same view replays stored threads.
- **Content Studio** flow: requests like "3 reel ideas for employers" visibly pass Tara → Dev → Nisha before Meera
  answers.
