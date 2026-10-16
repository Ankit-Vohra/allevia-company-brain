# Allevia

**A done-for-you AI growth team for small businesses, with a company brain in FalkorDB behind every answer.**

Twelve AI staff in eight departments share one knowledge graph per business. They answer "why" with the path through
the graph that proves it, remember what the owner taught them, and turn findings into one-tap approvals. Built in
India for owner-run businesses in the US, UK, UAE and Australia.

Entry for **Graph Hacks: Context for AI Agents** (WeMakeDevs × FalkorDB, 15–18 Oct 2026), all three tracks. The
first two businesses on it are real: **Aamdani** (a Hindi-first jobs platform, from its operating vault and read-only
connectors) and **AVS Atelier** (an architecture studio, from nothing but its website URL).

![The office mid-request: Meera recalls what the graph already knows, the work log streams on the right](docs/screenshots/live-office-midrun.png)

---

## The problem

Most small businesses have tried AI. Very few have AI doing a job in the business.

- **US:** 76% of engaged owners use AI, but only 14% have it fully integrated into core operations (Goldman Sachs
  10,000 Small Businesses, n=1,256, 2026). Census BTOS puts any-function use at 17–20% of firms, under 20% below
  five staff.
- **UK:** 29% of firms use AI, and adopters went from 1.4 to 1.6 technologies in three years: "widening, not
  deepening" (ONS, TechMarketView).
- **UAE:** 72% say they use AI; transaction data from 6,000 firms shows 12% pay for an AI tool (Pemo).

The gap between "I've tried ChatGPT" and "an AI does a job here" is 50 points or more in each market. Owners name the same
blockers: no clear use case, no skills, no time, no trust in the numbers, and nobody to keep it running when a token
expires or a model changes. Tools that sell brand memory and prompt-free content exist. We found none that joins
Search Console, GA4, Instagram and the company's own decisions into one memory and answers "why" with evidence.

Allevia's answer: set it up once for the owner (the plan is a 15-minute setup, then a team in India keeps it
running), give the owner a team instead of a tool, and make every answer carry its receipts. Sources and pricing method:
[product design](docs/superpowers/specs/2026-10-15-allevia-product-design.md) §0 and §4.

## What it does

- **A twelve-person company in a pixel office.** Meera (Chief of Staff) plans each request and sends it to the right
  desks: Isha (Center of Excellence, checks every number), Kabir (Analytics), Rohan (Marketing), Tara, Dev and Nisha
  (Content Studio: strategist, copy editor, fact checker), Arjun, Zoya and Imran (Tech: tech lead, on-call engineer for
  Sentry errors and crashes, QA and release manager for builds and the app stores), Vikram (Operations) and Sara
  (Library). Every
  agent is an `Agent` node in the graph, every step streams to the office and the work log, and every handoff is
  visible. The roster is [`shared/roster.ts`](shared/roster.ts).
- **Every answer comes with its graph path.** The answer cites node ids; the server checks each citation was returned
  by a tool in this turn, each number appears in tool data, simulated data is called simulated, stale data says
  "as of", and non-API data says where it came from. A failed check shows an "unverified" badge; it is never hidden
  ([`src/agent/checks.ts`](src/agent/checks.ts)). The final step draws the path through the graph that supports the
  answer, and the web app lights it up.
- **Memory that compounds.** Threads, findings, approvals and the owner's notes are written back to the graph, and the
  next thread recalls them from it. When the owner edits a draft before approving it ("villa" to "home"), the edit
  becomes a learned `Rule` linked to that approval, later drafts apply it, and the first-pass approval rate is tracked
  day by day on the Allevia 90 scorecard ([`src/actions/learning.ts`](src/actions/learning.ts),
  [`src/program/scorecard.ts`](src/program/scorecard.ts)).
- **One-tap approvals.** Anything that would change the outside world becomes an approval card: a GitHub issue, a
  content draft, a (simulated) ad pause, a Discord post. Approve, edit or reject, from the web or Discord. GitHub
  issues and Discord posts are dry runs unless `ALLEVIA_ACTIONS_LIVE=1`; drafts are never published.
- **Insights without model guesswork.** 20 deterministic Cypher detectors (SEO, content, funnel, simulated ads,
  knowledge gaps, and on-call and release health for the app) produce findings with evidence ids and numbers from the
  graph; Today's note (the morning brief) is a goal pulse built from them, with an "On call" section only when Zoya or
  Imran has something open ([`src/insights/`](src/insights)).
- **Answers a busy owner can act on.** The Chief of Staff leads with the answer, numbers the steps, ranks at most five
  items and ends on one next action, in plain words (no "baseline" or "agent"). The shape follows the MIT-licensed
  [i-have-adhd](vendor/skills/i-have-adhd/NOTICE.md) rules and [`docs/owner-words.md`](docs/owner-words.md)
  ([`src/agent/style.ts`](src/agent/style.ts)).
- **Onboarding from a URL.** A polite, SSRF-safe crawler reads the site, builds the brand kit, runs SEO checks, maps
  services, audiences and needs, and enrols the business in a 90-day program with goals and Day-0 baselines
  ([`src/onboard/`](src/onboard), [`src/ingest/sources/website/`](src/ingest/sources/website)).
- **Studio.** A phone photo goes in with EXIF stripped; Tara assesses it and the owner gets two options: A, a free local
  clean-up, and B, an AI edit from the real Higgsfield engine, quoted first in Studio credits (about 2) and refused above
  the per-edit and daily caps. Nisha's fidelity check compares each against the original, marks any structural change
  and picks "our pick"; a held-back AI edit gets one tighter retry. Under the options the owner asks for changes in plain
  words: light and colour are free, "make it festive", "a different background", "remove the pole" and "make this into an ad
  saying ..." use the AI editor, and a 5 second 9:16 clip is an explicit, priced extra. People in a photo are kept as they
  are unless the business turns on "Blur people's faces in my content"; a photo with a child gets the free clean-up only.
  Dev writes the caption and the owner approves ([`src/studio/`](src/studio)). Spend and the live check are in
  [`docs/higgsfield-spend.md`](docs/higgsfield-spend.md).
- **Other surfaces.** A Discord bot (a thread per conversation, live work log, approval buttons), a read-only MCP server
  for other agents, a CLI for everything, and a static marketing site with pricing in four currencies (`site/`).

## How FalkorDB is central

The agents cannot answer without walking the graph: every tool is a graph query or a graph algorithm, and the answer's
path is checked against the graph before it is drawn. Take FalkorDB away and no tool has anything to answer from.

**The queries and algorithms the product depends on**, each with its file and line, parameters, why a table would not
do, and a plan or timing note: [`docs/falkordb-queries.md`](docs/falkordb-queries.md) (a test keeps it in step with
the code). The quickest way to see the graph do work: the Brain page's **What breaks if something stops**, which shows
what fails one step away against what fails up to four steps away, with the path to each.

| FalkorDB capability | How Allevia uses it |
|---|---|
| **Multi-graph tenancy** | One graph per business (`allevia_<slug>`) plus a registry graph (`allevia_meta`). A request is bound to one tenant's graph; no tool takes a graph name ([`src/graph/tenants.ts`](src/graph/tenants.ts)). |
| **Bi-temporal facts and versions** | Every relationship carries valid time (`since`/`until`) and record time (`recordedAt`/`retiredAt`); nothing is deleted, a contradicted fact is closed. Changing entities write a `Version` before an update, so history is one hop away and every tool accepts `asOf` for time travel ([`src/graph/upsert.ts`](src/graph/upsert.ts)). |
| **Provenance on every fact** | Nodes and edges carry `src` (the source document) and `asOf`; extracted facts carry `conf` and `SOURCED_FROM`. Numbers are always `Observation` nodes with a window and a date, never overwritten properties. |
| **Read-only Cypher, guarded** | The `cypher` escape hatch runs `GRAPH.RO_QUERY` with a 5 s server timeout, a write-keyword and procedure allow-list check, bounded `range()`/`reduce()`, and capped output ([`src/agent/tools/cypher.ts`](src/agent/tools/cypher.ts)). |
| **Graph algorithms as agent tools** | `algo.SPpaths` for `find_paths` and the answer path (`show_path`), `algo.pageRank` for `important`, `algo.labelPropagation` for `topics`; the librarian stores PageRank and community ids and uses `algo.WCC` to report orphaned knowledge. `impact_of` walks `DEPENDS_ON`/`AFFECTS`/`BLOCKS` and scores the result by betweenness ([`src/graph/algorithms.ts`](src/graph/algorithms.ts)). |
| **Projections** | `algo.*` cannot filter on edge properties, so ranking and community algorithms run on a slim, cached projection graph of the currently valid edges (or of the edges valid at `asOf`), rebuilt when a write lands ([`src/graph/projection.ts`](src/graph/projection.ts)). |
| **Vector + full-text indexes** | 384-dim cosine vector indexes on entities and document chunks (local multilingual e5 embeddings, English and Hindi) and full-text indexes on names, summaries and chunk text, fused by reciprocal rank in `search` ([`src/graph/indexes.ts`](src/graph/indexes.ts), [`src/agent/tools/search.ts`](src/agent/tools/search.ts)). |
| **Memory in the graph** | `Session`, `Turn` (with `TOUCHED` and `CITED` edges and the full event log), `Finding`, `Memory`, learned `Rule`s with `LEARNED_FROM`, `GUIDED_BY` from a finding to the owner instruction it followed. Agents hand off through Findings stored in the graph. |
| **MCP** | `npm run cli -- mcp --tenant <slug>` serves 11 read-only graph tools for one tenant over stdio or Streamable HTTP, so another agent can use the company brain ([`docs/jarvis-integration.md`](docs/jarvis-integration.md)). |
| **FalkorDB Browser** | The compose file publishes it on 127.0.0.1:3090 for exploring the tenant graphs directly. |

### The graph data model

Every node has the base label `Entity` and a unique `id` (`<type>:<slug>`, range index plus UNIQUE and MANDATORY
constraints); the types search can return also carry `Searchable`, which holds the full-text and vector indexes. Every
relationship carries `since`/`until` (when it was true) and `recordedAt`/`retiredAt` (when we learned it), plus `src`
and `asOf` (where it came from). The main types and relationships (all 38 node types and 54 relationship types, with the
triples each allows, are in [`src/graph/schema.ts`](src/graph/schema.ts)):

```mermaid
flowchart LR
  subgraph Company
    B[Business]; P[Person]; A[Agent]; T[Team]
  end
  subgraph Work
    S[System]; C[Channel]; K[Task]; D[Decision]; G[Goal]
  end
  subgraph Knowledge
    Doc[Document]; Ch[Chunk]; O[Observation]; V[Version]
  end
  subgraph Memory
    Tu[Turn]; F[Finding]; M[Memory]; R[Rule]; Ap[Approval]; Rec[Recommendation]
  end
  P -- MEMBER_OF --> T
  P -- OWNS --> K
  T -- OWNS --> S
  S -- DEPENDS_ON --> S
  C -- DEPENDS_ON --> S
  K -- DEPENDS_ON --> S
  S -- BLOCKS --> K
  D -- AFFECTS --> C
  P -- DECIDED --> D
  D -- BASED_ON --> O
  D -- SUPERSEDES --> D
  O -- MEASURES --> C
  O -- SOURCED_FROM --> Doc
  Doc -- HAS_CHUNK --> Ch
  Doc -- MENTIONS --> S
  B -- PURSUES --> G
  A -- KNOWS_ABOUT --> C
  Tu -- CITED --> D
  F -- PART_OF --> Tu
  A -- PRODUCED --> F
  F -- BASED_ON --> F
  M -- ABOUT --> C
  Rec -- PROPOSES --> Ap
  R -- LEARNED_FROM --> Ap
  K -- HAD_VERSION --> V
```

Three patterns carry most of the weight:

- **Facts with two clocks.** Nothing is deleted. A fact that ends gets `until`; a contradicted claim is stored closed
  with a reason; a fact that comes back is a new edge beside the closed one. Every tool takes `asOf`.
- **Versions one hop away.** When a tracked property changes (a task's status, a reading's value), the old state is
  written as a `Version` in the same statement, behind `HAD_VERSION`.
- **Functional slots.** Some relationships have one holder at a time ("a task has one current owner", "an asset has one
  parent"): a new holder closes the old edge instead of adding a second.

On 15 October the Aamdani graph held about 3,700 nodes and 11,300 edges, and AVS Atelier's about 460 nodes and 2,000
edges.

We built on FalkorDB 6.0.2 and found two query shapes that crash it (a tied full sort over rows with nullable maps,
and NaN in a sort key). They are measured and reproduced in
[`docs/notes/falkordb-nan-crash.md`](docs/notes/falkordb-nan-crash.md), refused client-side before they are sent,
and held out of `src/` by a static test.

## Tracks

Entered in all three: **Agents That Act on Connected Data**, **Agent Memory and Coordination**, **Company Brain**. What
fits each, and where it is thinner:

| Track | What fits | Honest limits |
|---|---|---|
| **Agents That Act on Connected Data** | 21 graph tools (impact at depth 1 to 4, shortest paths, PageRank, communities, decisions, ownership, metrics, SEO, read-only Cypher); findings become approval cards with graph evidence; approved actions are recorded as `Action` nodes; an MCP server lets other agents use the same tools. | GitHub issues and Discord posts are dry runs unless switched on; ad changes are simulated; content is drafted, never published by us. |
| **Agent Memory and Coordination** | Twelve agents hand work to each other through `Finding` nodes in one shared graph (`BASED_ON` is the handoff); each turn's citations, the owner's notes and learned rules are written back and recalled by traversal on the next question; an owner's edit becomes a `Rule` linked to the approval it came from. | Memory is per business (by design); there is no memory across businesses. |
| **Company Brain** | Decisions with their evidence and deciders, who owns and who knows what, facts with valid time and sources, versions one hop away, "what breaks if this stops" with the path. | Proven on two real businesses and a synthetic demo company; the connectors that would feed it daily are read-only and few. |

## Architecture

```mermaid
flowchart LR
  subgraph Surfaces
    WEB["Web app<br/>office, ask, brain, insights,<br/>approvals, onboard, studio, team"]
    DIS["Discord bot<br/>thread per conversation"]
    MCPC["Other agents<br/>(MCP clients)"]
    CLI["CLI"]
  end
  subgraph Server["Node + TypeScript"]
    API["Hono API<br/>SSE streams, public mode"]
    ORCH["Agent company<br/>Meera plans, desks work,<br/>reviewers check, Meera answers"]
    TOOLS["21 graph tools<br/>queries, algo.*, RO Cypher"]
    CHK["Answer checks<br/>citations, numbers,<br/>simulated, freshness, mode"]
    INS["Detectors, brief,<br/>approvals, executors"]
    ING["Ingestion<br/>privacy filter, extraction,<br/>embeddings, librarian"]
    MCPS["MCP server<br/>read-only, one tenant"]
  end
  SDK["Claude Agent SDK<br/>(subscription login)"]
  subgraph FDB["FalkorDB 6.0.2"]
    META[("allevia_meta")]
    T1[("allevia_aamdani")]
    T2[("allevia_avs_atelier")]
    PROJ[("projections<br/>current edges")]
  end
  SRC["Sources: vault, registry, GitHub,<br/>ops connectors (read-only),<br/>website crawl, playbooks, simulated ads"]

  WEB --> API
  DIS --> API
  CLI --> ORCH
  MCPC --> MCPS
  API --> ORCH
  ORCH --> SDK
  ORCH --> TOOLS
  ORCH --> CHK
  API --> INS
  TOOLS --> FDB
  MCPS --> TOOLS
  INS --> FDB
  SRC --> ING --> FDB
```

A request: recall what the graph already knows about the question; Meera returns a plan (one to three desks); each
desk runs as its own Agent SDK query with only its tools and writes a Finding; the reviewers named in the roster
check it; Meera writes the answer, calls `show_path`, and may propose an action. The Turn, Findings, reviews and the
full event log are written to the graph, which is what makes replay possible. Design:
[engineering spec](docs/superpowers/specs/2026-10-15-allevia-design.md) §4–§9 and §16.

## Screenshots

| | |
|---|---|
| ![An answer with its path lit in the graph](docs/screenshots/live-ask-final.png) | ![Allevia 90: day 0, goals against their baselines](docs/screenshots/allevia90-office-desktop.png) |
| **Ask.** The answer cites nodes, the work log shows who did what, and the path behind the answer is lit (synthetic demo company). | **Your 90 days.** Goals against the Day-0 baseline, the first-pass curve and learned rules (Aamdani, read-only). |
| ![An edited approval becomes a learned rule](docs/screenshots/approvals-learned-chip-desktop.png) | ![Tell your team: a plain-language instruction previewed as a diff](docs/screenshots/team-directive-preview-desktop.png) |
| **Approvals.** An edit becomes a learned rule that later drafts apply; executors are dry runs by default. | **Tell your team.** A plain-language instruction previewed as a change before it applies. |
| ![Onboarding a business from its URL](docs/screenshots/onboard-done-desktop.png) | ![The marketing site](docs/screenshots/site-home-desktop.png) |
| **Onboard.** The brain built from a website (web app in mock mode). | **Site.** Home and pricing in four currencies, generated from `shared/plans.ts`. |

More, in light and dark and on mobile: [`docs/screenshots/`](docs/screenshots).

## Run it

### Public demo with Docker (no model needed)

Needs Docker with Compose v2.24 or later.

```sh
docker compose up -d --build                # FalkorDB 6.0.2 + Allevia on http://127.0.0.1:8787
```

The app starts in **public mode** (`ALLEVIA_PUBLIC_MODE=1`): the office, brain explorer, insights, approvals history
and scorecard read live from the graph; every write is refused; Ask replays recorded showcase turns instead of
calling a model. A fresh FalkorDB is empty, so load something first:

```sh
# the synthetic demo company: a small graph with real structure and made-up data (no model calls)
docker compose exec app tsx scripts/seed-demo.ts demo_seed --register
docker compose exec app tsx src/cli.ts enroll demo_seed --country UK --industry "jobs platform"
docker compose exec app tsx src/cli.ts insights demo_seed   # deterministic detectors, approval cards
docker compose exec app tsx src/cli.ts brief demo_seed      # today's note (the morning brief)
```

Then open http://127.0.0.1:8787: the office, the 90-day card, the brain explorer, insights and approval cards for
"Demo Seed". The FalkorDB Browser is on http://127.0.0.1:3090. The demo company has no recorded showcase turns, so
Ask has nothing to replay in public mode; the hosted demo carries the recorded Aamdani and AVS Atelier turns.

### Live mode (needs your own Claude login)

The agents run on the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) with a claude.ai
subscription login, never an API key: `ANTHROPIC_API_KEY` is stripped from the SDK's environment, and a run stops if
the SDK reports any API-key source ([`src/agent/sdk-env.ts`](src/agent/sdk-env.ts)). A public deployment therefore
cannot offer live chat to strangers. An evaluator with their own Claude account can run it live:

- **Recommended, on your machine:** install [Claude Code](https://docs.claude.com/en/docs/claude-code), run
  `claude` and `/login` with your claude.ai account, then follow the development setup below and run
  `npm run cli -- serve` (live mode is the default outside Docker). This is the path the eval runs used.
- **In Docker:** create a long-lived token with `claude setup-token`, put `CLAUDE_CODE_OAUTH_TOKEN=<token>` and
  `ALLEVIA_PUBLIC_MODE=0` in `.env`, and `docker compose up -d`. The SDK passes that token through; this path was
  not exercised in our runs, so if the subscription guard refuses it, use the local route.
- Onboarding from a URL needs Chromium for the crawler: `WITH_CHROMIUM=1 docker compose build`.

### Development setup

Node 22 or later (24 recommended), Docker for FalkorDB.

```sh
npm install && (cd web && npm install)
docker compose up -d falkordb                  # FalkorDB on 127.0.0.1:6390, the CLI's default
mkdir -p ~/.config/allevia && cp .env.example ~/.config/allevia/allevia.env && chmod 600 ~/.config/allevia/allevia.env
(cd web && npm run build)                      # the API serves web/dist; or `cd web && npm run dev` on :5173
npm run cli -- db:check
npx tsx scripts/seed-demo.ts demo_seed --register   # the synthetic demo company, as in the Docker quick start
```

The env file is optional: every name has a default, and secrets (a Discord bot token, for example) live only there,
outside the repo. Local embeddings are optional too ($0, no network after the first download): `npx tsx
scripts/spikes/embeddings.ts` fetches `Xenova/multilingual-e5-small` (about 130 MB) into `models/`. Without it, search
is full-text only.

### Keeping it running

`scripts/ops/run-server.sh` and `scripts/ops/run-bot.sh` start the server or the Discord bot and start it again whenever
it exits, logging to `~/allevia-logs/server.log` and `bot.log` (extra arguments go to `serve` or `discord`). A FalkorDB
restart does not stop either: queries wait for the database to come back (up to `ALLEVIA_DB_WAKE_WAIT_MS`, 20 s), and
meanwhile owners are told "Your team's memory is waking up, try again in a minute."

### FalkorDB settings and schema

`docker-compose.yml` starts FalkorDB with the limits the code is written for, as module load arguments (`FALKORDB_ARGS`:
`THREAD_COUNT 4`, `MAX_QUEUED_QUERIES 500`, `TIMEOUT_DEFAULT 15000`, `TIMEOUT_MAX 120000`, `QUERY_MEM_CAPACITY 536870912`,
`CACHE_SIZE 256`, `RESULTSET_SIZE 10000`; what each is for is in [`src/graph/server-config.ts`](src/graph/server-config.ts)).
Load arguments survive a restart and `GRAPH.CONFIG SET` does not, so a running server picks them up with
`docker compose up -d falkordb`, and `npm run cli -- db:check` reports one that differs.

Every tenant graph is brought to the same schema when it is created and again at the start of every ingest
([`src/graph/indexes.ts`](src/graph/indexes.ts), [`migrate.ts`](src/graph/migrate.ts)); `npm run cli -- db:migrate [tenant]`
runs it on demand. The schema is: a range index on `Entity.id` with UNIQUE and MANDATORY constraints (duplicate ids already in a graph
are merged first); range indexes on `Observation.metric`, `metricKey` (the lowercase metric, so no read wraps it in
`toLower()`), `subject` and `asOf`; the `Searchable` label on the types search returns, with the full-text and vector
indexes on it, so a reading's name never competes with an entity's. Queries look nodes up as `(n:Entity:Type {id:$id})`
(the index is on `Entity.id`), and bind the edge under every count (`WHERE ID(e) >= 0`) because FalkorDB 6.0.2 collapses parallel
edges nothing refers to; the suite holds both rules (see Tests).

### CLI

`npm run cli -- <command>` (`npm run cli` lists them all). The main ones:

| Command | What it does |
|---|---|
| `ingest <tenant> [--sources brain,ops,playbooks,simads,github]` | Ingest a configured tenant's sources (privacy filter, extraction on the subscription, embeddings, librarian, privacy scan) |
| `npm run onboard -- --name "…" --slug … --url https://…` | Onboard a business from its website (crawl, brand kit, SEO checks, understanding, program) |
| `enroll <tenant>` | Enrol a business already in the graph in Allevia 90: country defaults, goals, Day-0 baselines, capabilities |
| `ask <tenant> "<question>"` | Ask the agent company and watch every agent's steps in the terminal |
| `insights <tenant>` | Run the 20 detectors; write recommendations and approval cards |
| `brief <tenant>` | Write today's note (goals, what changed, what we noticed, on call, waiting for your OK, next step) |
| `approvals <tenant> [approve\|reject <id>]` | List or decide approval cards (`--edit <file>` teaches a learned rule) |
| `program <tenant> [--read-only]` | The Allevia 90 scorecard |
| `tell <tenant> "<instruction>"` | "Tell your team": preview a plain-language change, `--apply` to make it |
| `serve [--public]` | The API and the web app on one port |
| `discord [--tenant aamdani]` | The Discord bot (needs a bot token in the env file); with `DISCORD_HUB_GUILD_ID` set it serves every customer on the hub |
| `discord-hub status \| list \| provision <tenant> \| reinvite <tenant>` | The customer hub on Discord: read-only check and list, set a business up, a new join link ([setup](docs/discord-hub-setup.md)) |
| `mcp --tenant <slug> [--http]` | The read-only MCP server for one tenant |
| `auth:issue <tenant> [--days N]` / `auth:list` / `auth:revoke <id>` / `auth:demo <tenant>` | Owner links for `ALLEVIA_AUTH=1`: issue one (shown once), list them, revoke, mark a business as a public demo |
| `eval <tenant> [--fake]` | Run the tenant's eval questions, score every turn, write `docs/evals/<date>-<tenant>.md` |
| `showcase <tenant> [<turnId>]` | Mark a stored turn for public replay, or list the showcase turns |
| `db:check` / `db:migrate [tenant…]` | Ping FalkorDB and compare its settings with `docker-compose.yml`; bring tenant graphs up to the current schema |
| `privacy-scan <tenant>` | Scan every string in a tenant's graph for secrets and personal data (must report 0) |
| `checkup [<url>] --tenant <slug> [--weekly on\|off]` | The free website check-up: top five fixes by likely enquiries; with `--tenant` the site and kind come from onboarding and the run is stored. The web button, `/checkup` and the weekly schedule run it in the background |

## Tests and evals

- **1,493 tests pass** (2 more skipped) in 117 files (vitest), run against a real FalkorDB in throwaway graphs: unit tests,
  integration tests for every tool and algorithm, the API, SSE, the Discord and MCP surfaces, a static scan that
  holds every Cypher string in `src/` to the crash rules, the Entity-label and parallel-edge rules, an `EXPLAIN` of every
  query the suite sends (it fails the run if one looks a node up by id and still scans a label), and a regression that runs every tool, detector and read
  over a graph built of ties, zeros and gaps. Two live-model tests are skipped unless `ALLEVIA_LIVE_LLM=1`.
  `npm test` (or `ALLEVIA_FALKORDB_URL=redis://127.0.0.1:<port> npx vitest run` against a throwaway server).
- **Evals** ([`evals/`](evals), reports in [`docs/evals/`](docs/evals)): 43 questions with expected citations, regexes,
  tools, agents and trap questions, scored automatically. The first live runs on 15 October: Aamdani 8 of 12 passed
  every check and expectation (96% of expectations hit, 100% of turns finished), AVS Atelier 2 of 5 (89% of
  expectations hit). Failures are kept in the reports with their causes.

## Privacy and safety

- **Privacy filter before anything is stored or sent to a model:** a path allow-list for the vault, sensitive sections
  dropped, and redaction of addresses, account ids, emails, phone numbers, credentials and company identifiers
  ([`src/ingest/privacy.ts`](src/ingest/privacy.ts), [`src/ingest/redact.ts`](src/ingest/redact.ts)). Finance stays
  out entirely.
- **`privacy-scan`** checks every string in a tenant graph for the same patterns; ingestion fails loudly if it finds
  one.
- **Repo hygiene test** ([`tests/hygiene.test.ts`](tests/hygiene.test.ts)): every tracked file goes through the same
  detectors, and, where the real vault is present, every identifier found in it must be absent from the repo.
- **Read-only connectors:** the ops connector calls only tools on a read-only allow-list, refused before a byte is
  sent; the MCP server registers read tools only; `cypher` is `GRAPH.RO_QUERY` behind its own guard.
- **Dry-run actions:** approved GitHub issues and Discord posts are recorded, not executed, unless
  `ALLEVIA_ACTIONS_LIVE=1`; ad changes are simulated; content is drafted, never published.
- **Public mode:** every write route returns 403, and only turns marked as showcase are visible or replayable.
- **Tenant isolation:** every business is its own graph (`allevia_<slug>`) and its own folders; the server binds a request
  to one business, no tool or message can pick another, and a new business starts from code, never from another's data.
  With `ALLEVIA_AUTH=1` every business needs its private owner link (random, hashed, revocable; `auth:issue`), and only
  marked demo businesses open without one, read-only. Proof in `tests/security/`; findings and the ranked open items in
  [`docs/tenant-isolation.md`](docs/tenant-isolation.md).
- **Subscription only:** no API key is used or accepted for model calls. Secrets live in
  `~/.config/allevia/allevia.env`, outside the repo; `.env.example` documents every name with no values.
- **Studio:** photos are re-encoded without EXIF metadata on intake; edit prompts forbid text, numbers, logos and
  added or removed structures (except what the owner asked for), and Nisha's fidelity check fails closed. The AI editor
  runs on the founder's `higgsfield` CLI login (argument arrays, no shell, the photo in a private temp dir that is deleted),
  is quoted before every generation, and is capped per edit (`ALLEVIA_STUDIO_RUN_CREDIT_CAP`, 5), per clip
  (`ALLEVIA_STUDIO_CLIP_CREDIT_CAP`, 8) and per day (`ALLEVIA_STUDIO_DAILY_CREDIT_CAP`, 25) in a ledger kept in the data dir.
  `ALLEVIA_STUDIO_ENGINE=recorded` turns the live editor off.

## Repository layout

| Path | What |
|---|---|
| `src/graph/` | FalkorDB client with the crash guards, schema, bi-temporal upsert, algorithms, projections, indexes, tenants |
| `src/agent/` | Orchestrator, runtime (Agent SDK), 21 tools, answer checks, memory |
| `src/ingest/` | Sources, privacy and redaction, extraction, embeddings, librarian |
| `src/server/`, `web/` | Hono API and the React web app (Vite) |
| `src/insights/`, `src/actions/`, `src/program/`, `src/capabilities/`, `src/settings/`, `src/studio/` | Detectors and brief; approvals, executors and learning; Allevia 90; capability ladder; team settings; Studio |
| `src/discord/`, `src/mcp/` | Discord bot, MCP server |
| `shared/` | Contracts, roster and plans shared by server, web and site |
| `site/` | The public website (home, how it works, product tour, demo, pricing, security, about, contact, FAQ, privacy, terms, data deletion, cookies); static, built from shared/plans.ts. See docs/website-deploy.md |
| `evals/`, `tests/` | Eval sets and runner; the test suite |
| `vendor/playbooks/` | Third-party playbook data, with licences and notices |

## Credits and licences

- **Vendored playbook data** (MIT): hook formulas and a profile rubric (Jakeschincariol/instagram-agent-skill), SEO
  audit issues (every-app/open-seo), the Google update timeline (AgriciDaniel/claude-seo), industry templates and ad
  policy registries (nowork-studio/notfair-plugin), AI-writing patterns (conorbronsdon/avoid-ai-writing). Data only, at
  pinned commits, each with its LICENSE: [`vendor/playbooks/NOTICE.md`](vendor/playbooks/NOTICE.md).
- **brag-slim** (MIT, latent-spaces/brag), vendored unmodified in `.claude/skills/brag-slim/` to render the launch
  video.
- **Visuals:** the marketing site's illustrations, hero loop and the Studio demo's generated variant were made with
  Higgsfield; every generation is logged in [`docs/higgsfield-spend.md`](docs/higgsfield-spend.md). The office
  sprites are drawn in code by us.
- Libraries: FalkorDB and its Node client, the Claude Agent SDK, Hono, React, Vite, transformers.js, sharp,
  Playwright, discord.js and the MCP SDK, each under its own licence.

## AI tools used

- **Claude Code** (with subagents working in parallel git worktrees) wrote most of the code, tests and docs, under the
  founder's direction and review.
- **Claude, through a claude.ai subscription login** (the Claude Agent SDK), runs the twelve agents at runtime. No API
  key is used or accepted.
- **Higgsfield** made the website's illustrations, hero loop and social card, and the Studio demo's generated photo
  variant; every generation is logged in [`docs/higgsfield-spend.md`](docs/higgsfield-spend.md).
- **Local embeddings** (multilingual e5, run on the machine) for vector search.

What the founder decided and checked: the product (a done-for-you team for owner-run businesses, not a tool), who it is
for and the pricing; that FalkorDB is the company brain and one graph per business; the data rules (read-only
connectors, a privacy filter before anything is stored, actions as dry runs until approved, subscription only); which
businesses to use (his own, Aamdani, and AVS Atelier; the public demo uses synthetic data only);
the plain-words, owner-first style; and that the demo must be run live. He reviewed the agents' answers and the screens,
and can explain the graph model and the queries above.

## Built during the event

All of Allevia's code was written during the hackathon, which opened on 15 October 2026 at 00:01 IST. The
development history starts with its first commit at 01:08 IST that day; it is kept in a private repository because
early commits held private identifiers that were later removed, and this public repository is a single squashed
commit of the result. We can show the full history to the organisers on request.

Reused, not written here: npm libraries, the vendored third-party data and the brag-slim skill (credited above), and
the founder's existing systems, which Allevia reads as a service (a read-only connector over SSH) without copying
their code. The design spec, the plan and the decisions are in [`docs/superpowers/`](docs/superpowers). How AI tools
were used is above.
