# From hackathon demo to a product founders pay for

This is the plan for after 18 October 2026, the founder's brainstorm of 17 October: "how to make this a complete product
after hackathon, what all will be required, regarding database and all, entire systems, what competitors' good things we
need on our platform". It builds on the following documents:
- `docs/pricing-research.md` (plans, costs, margins);
- `docs/competitor-features.md` and issue #47 (what rivals have);
- `docs/superpowers/specs/2026-10-17-credits-login-subscription-design.md` (credits, login, subscription);
- `docs/falkordb-cloud.md` and issue #46 (the database).

Tags: **[check]** means the price or fact must be confirmed before we commit to it.

## 1. The goal

- **Phase 1:** the first **10 paying founders** by mid-November, on Starter or Growth, without the founder babysitting
  the servers.
- **Phase 2:** **50** by the end of December.
- **Phase 3:** **100+** in 2027.

Each phase has one test: could a founder in London sign up at 2 a.m. our time, connect Gmail, get a useful answer, pay,
and have it all still working a month later?

## 2. Where we stand

| Area | What we have (strong) | What a paying customer needs that we don't have |
|---|---|---|
| Brain | One FalkorDB graph per business, a source and date on every fact, checked answers, 8x fewer tokens than stuffing documents | A database with backups, TLS and room to grow |
| Team | 13 AI staff, plans, reviews, stand-up, Studio, Sales | An AI runtime that is ours, metered per business (today it runs on the founder's own Claude login) |
| Doors | Web app, Discord, CLI, MCP | Public HTTPS, email, phone (installable app, push), later WhatsApp |
| Accounts | Owner links; login being built (18 Oct) | Email check, reset by email, Google sign-in, two-step |
| Money | Plans, credits, test-mode subscription (18 Oct) | A payment provider live, invoices, tax, refunds |
| Tools | Composio connections, sealed tokens, approvals before anything goes out | Our own verified Google and Meta apps for the core tools |
| Running it | One server (not public yet), nightly backups that run from a Mac | Background jobs that survive a restart, staging, automatic deploys, error alerts |
| Trust | Privacy, terms, export and erase, isolation tests | Company facts filled in, a lawyer's review, a subprocessor list, a DPA, SOC 2 later |

## 3. The systems, one by one

### 3.1 AI runtime: the first blocker

Today every business's questions run on the founder's own Claude subscription through the Agent SDK. That was right for a
hackathon at $0, but not for paying customers:
- subscription terms are for one person's use;
- one login's limits are shared by everyone;
- we can't see the cost per business.

**Needed:**
- **The Claude API** on an Anthropic organisation account, with one usage key per environment.
- **Per-business metering:** every model call writes tokens and dollars to that business's ledger, next to the credits,
  so we see margin per customer.
- **Caps:** the hidden model budget per plan already in `shared/plans.ts` (`answerModelBudgetUsd`).
- **Model routing:** a small model for routing and extraction, a mid model for most desks, the large one only for deep
  questions. Prompt caching on the brain context.

The pricing research measured about $0.18 per typical answer. **[check]** Re-measure on the API with caching before
pricing goes public.

**Founder decision:** this is the first real monthly spend. Start it when the first paying customer signs.

### 3.2 Database

**Today:**
- FalkorDB Cloud free tier: 100 MB, 64 MB used, no TLS, no backups the provider keeps.
- About 13 MB for an active business (aamdani), and it grows every day.
- 100 active businesses would need about **1.5 to 2 GB**.

**Needed:**
- **The brain stays on FalkorDB.** It is the product and the hackathon story. Two options:
  - (a) a **paid FalkorDB Cloud tier** with TLS, backups and version 6.x **[check price]**;
  - (b) **self-hosted FalkorDB 6.x** on its own server, with persistence (snapshot plus append log), a password, TLS,
    private networking only, and backups to S3.
  - **Recommendation:** (a) for the first 50 customers, so nobody is on call for a database. Revisit (b) when the bill
    passes a small server's cost.
- **Database users per business**, so isolation isn't only the application's job (open on #23).
- **Housekeeping on a schedule:** `db:usage` alerts at 80%, `graph:tidy`, telemetry streams with a cap, and a snapshot's
  temporary graph dropped after 14 days.
- **Money records in Postgres**, once payments go live: payment webhooks, invoices, refunds and tax lines need
  transactions, idempotency and exports an accountant can open. Managed Postgres (Amazon RDS, Neon or Supabase) at the
  smallest size **[check]**.
  - Users, sessions and the credit ledger can stay in the graph.
  - The ledger links each spend to what it paid for, which is part of the "how we know" story.
- **Files to S3**, not the server's disk: uploads, Studio pictures and videos, exports and backups. Lifecycle rules
  delete old drafts. The ledger already records cost per job.

**Measured on 17 October** (FalkorDB Cloud, `db:usage` and a read-only probe; `graph:story aamdani`):

| Business | Things | Links | Memory, all in |
|---|---|---|---|
| AVS Atelier (website + Instagram) | 544 | 2,222 | about 5 MB |
| A café from its website only (test) | 612 | 2,497 | about 6 MB |
| Shiftly demo | 758 | 3,103 | about 7 MB |
| Aamdani (website, documents, code, ops, 2 days of use) | 4,084 | 16,831 | about 40 MB |

- **All in** means about 10 KB per thing, once links, search vectors, indexes and the server's own overhead are shared out.
  The server held 64 MB for 6,352 things, and an empty server uses about 3 MB. The graphs' own data is only 19 MB of
  that; vectors, indexes and the server's working memory are the rest.
- **What grows:**
  - numbers from connected tools: 40% of Aamdani's things;
  - the team's work log of what it touched while answering: 26% of its links;
  - documents and their search vectors.
- **How fast:** Aamdani's first load was 3,799 things. A heavy day of use then added 283 things and 4,911 links, about
  3–5 MB.
  - An active business: about 20–30 MB a month.
  - A quiet one (daily stand-up and tool numbers): 3–8 MB a month.
- **After a year:**
  - Untouched, an active business would reach about 400 MB and a quiet one about 80 MB.
  - With housekeeping, about 100–150 MB and 30 MB: daily numbers rolled up into weeks after 90 days, old work-log links
    trimmed to a summary, vectors only on text worth searching, and closed facts and old versions archived to S3.

**How storage scales.** About 75 MB per business on average, with housekeeping:

| Businesses | Memory | Where | Cost a month | Per business |
|---|---|---|---|---|
| 10 | under 1 GB | FalkorDB Cloud Startup, 1 GB | $73 | about $7 |
| 100 | about 7.5 GB | FalkorDB Cloud Pro, 8 GB | $350 | about $3.50 |
| 1,000 | about 75 GB | Several servers (each business is its own graph, so businesses spread across servers without changes), self-hosted at about $5 per GB of memory, or FalkorDB Enterprise | about $400–600 self-hosted | under $1 |

FalkorDB keeps everything in memory, so a business on Pause ($29) can have its brain saved to S3 and loaded back when it
returns. Storage stays at 1–7% of even the $99 plan's price. Each plan gets a storage budget, with an alert at 80%.

### 3.3 Hosting and running it

**Today:** one EC2 t4g.large in Mumbai, not reachable from the internet, plus the founder's Mac doing backups.

**Needed:**
- **Public HTTPS:** `app.allevia-ai.in` (DNS at the registrar) behind Caddy or an AWS load balancer, with automatic
  certificates. The marketing site stays on GitHub Pages, or moves to `allevia-ai.in`.
- **Two processes:**
  - the web and API server;
  - a worker for check-ups, Studio jobs, the stand-up, insights and the Discord bot.

  Today these queues live in memory and are lost on a restart. They need a **durable job queue** (BullMQ on a small
  Valkey or Redis, or a jobs table in Postgres), with retries and "what ran when" visible.
- **Staging and production,** each with its own database and keys. Real businesses never touch staging.
- **Automatic deploys:** GitHub Actions runs type checks and tests on every push, then deploys to staging and, after a
  button, to production. A rollback is a click.
- **Errors and uptime:**
  - Sentry (free tier) for the server and the web app;
  - an uptime check that messages the founder;
  - structured logs kept for 30 days, as the privacy policy says.
- **Region:** Mumbai is fine for the UAE and acceptable for the UK. Add a London region when a UK customer asks where
  their data lives (the Pro plan's "EU/UK data-residency addendum").

### 3.4 Accounts

The login of 18 October covers email and password, sessions, invites and roles.

**Next:**
- **Email sending:** Amazon SES on `allevia-ai.in`, with SPF, DKIM and DMARC records at the registrar. It's needed for
  everything below and for Today's note by email.
- Email check on sign-up, and password reset by email (today it's an operator link).
- **"Continue with Google"**, using our own Google OAuth app with basic scopes, so no security assessment.
- **Two-step sign-in for owners**, a list of signed-in devices, and sign out everywhere.
- **Agency mode later:** one login, many client businesses (a channel to market, #47).

### 3.5 Money

The subscription page and credits of 18 October run in test mode.

**Next:**
- **Paddle** (merchant of record): it collects VAT and GST in the UK, UAE and Australia, plus US sales tax, and supports
  sellers in India **[check onboarding for an Indian company]**. It covers checkout, webhooks, invoices, failed-payment
  retries and refunds (the 14-day money-back).
- **Credit packs** through the same checkout.
- **Yearly plans** at 30% off, as decided.
- **A margin view for us:** revenue minus model, picture and data cost per business per month, from the ledgers.

### 3.6 Connections

Composio gives 16 toolkits with managed sign-in today.

**Next:**
- **Our own Google app** for Gmail, Calendar, Search Console, Analytics and Business Profile:
  - Google's verification;
  - reading Gmail is a restricted scope and needs a yearly security assessment (CASA), about $540 to $6,000
    **[check]**;
  - sending only, or Calendar only, avoids it.
- **Our own Meta app** for Instagram, Facebook Pages and Ads (Meta App Review).
- **WhatsApp Business** later (Tech Provider).
- **Connection health on the Your tools card:** a token about to expire, a failed sync, "reconnect" in one tap.

### 3.7 Trust

Needed before the first payment:
- **Company facts** (#10): legal name, kind of company, payment provider.
- **A lawyer's review** of the privacy policy and terms (the drafts say so).
- **A trust page:** where data lives, the subprocessors (Anthropic, FalkorDB, AWS, Composio, Apify, Higgsfield,
  Paddle), a DPA on request, and how deletion works (`tenant:erase` exists).
- **Privacy law:** India's DPDP rules, UK and EU GDPR for UK customers, and the UAE PDPL.

Needed later: **SOC 2 Type II**, through a compliance tool (Vanta or Drata, about $7k to $15k a year **[check]**), once a
bigger customer asks. Lindy, Motion, Notion, Dust, Fireflies and ChatGPT Business already have it.

### 3.8 Support and learning what works

**Support:**
- A person answers in Discord or by email within a working day (the terms promise this).
- An in-app "Talk to a person".
- A short help centre.

**Product analytics:** self-hosted PostHog, or plain counts from our own graph. Track the activation path:
1. signed up;
2. pasted website;
3. first answer;
4. first OK;
5. first tool connected;
6. paid.

Watch where people stop.

## 4. Features from rivals, in order

The detail is in `docs/competitor-features.md`.

### Phase 1: the first 30 days, alongside the systems above

1. **Email as a door.** Today's note and waiting approvals by email, with signed one-tap links. Lindy, Kylon and Motion
   reach people where they are.
2. **"What your team did this week" on Home.** Drafts approved, calls booked, fixes shipped and facts learned, each
   opening the nodes. It's the reason to keep paying.
3. **Installable app and push** for waiting cards.
4. **Microphone on the Ask box,** then voice notes. Motion, Sidekick and Fireflies have these.
5. **Meeting memory.** Paste notes or connect Granola or Fireflies; decisions and tasks go into the brain, the follow-up
   becomes a card, and there's a brief before the next call.

### Phase 2: 30 to 75 days

6. **Owner routines** ("every Monday send me the numbers"), saved as skills.
7. **Website chat for the business's customers,** answered from its brain, handing leads to Sales and asking the owner
   what it doesn't know. Marblism, Lindy, HubSpot and Owner.com have this.
8. **A content calendar and catalog-to-posts.** Predis, Ocoya and Pomelli have these.
9. **A reviews inbox** with drafted replies, **Arabic posters** for the UAE, **Slack as a door**, **pin an answer to
   Home**, and **forget or correct a fact**.

### Phase 3: 2027

10. WhatsApp.
11. A phone receptionist.
12. A UK or EU region and SOC 2.
13. Agency mode.
14. Fixing the website or shop after OK.
15. Native phone apps, only if the installable app isn't enough.

### Not copying

Computer control, a general agent builder, outbound cold sales at scale, and enterprise search. They suit a different
buyer from a founder whose business already works.

## 5. The calendar

| When | What ships | Done when |
|---|---|---|
| **18 Oct** (hackathon) | Credits, login, subscription in test mode, live for judges; video and submission | Judges sign up and use their trial credits |
| **19–31 Oct** | Claude API with per-business metering; public HTTPS on `app.allevia-ai.in`; worker plus durable queue; S3 files; paid FalkorDB tier; Sentry; staging and CI deploys | A restart loses nothing; a bad deploy rolls back; we see each business's cost |
| **1–15 Nov** | SES email (check, reset, Today's note by email); Paddle live; Google sign-in; company facts and lawyer review; trust page; "what your team did"; installable app | The first paying founder, end to end, with no hand-holding |
| **16 Nov–31 Dec** | Google and Meta app verification; meeting memory; routines; website chat; voice notes; push; content calendar; reviews inbox; Arabic | 50 businesses; the founder isn't on call every night |
| **2027 Q1** | WhatsApp, phone, London region, SOC 2, agency mode | Bigger customers and partners |

## 6. What it costs to run, before any customer

These are rough monthly figures, every one **[check]**:

| Item | Amount |
|---|---|
| Two small servers (app and worker) | $60–100 |
| Paid FalkorDB Cloud tier | to confirm |
| Small managed Postgres | $15–30 |
| S3 and backups | $5 |
| SES | about $1 |
| Sentry and uptime | $0 |
| Composio | $29 |
| Apify | $0–49 |
| Domain and email | $10 |
| A CASA assessment, if we read Gmail | $45–500 a month equivalent |
| Paddle fees | per sale (about 5% + 50¢) |

Pricing research put fixed costs at **$250 to $450 a month** before the database tier. About 6 Starter customers cover
that. Claude API and picture costs are per use, and the credits are priced to cover them.

## 7. Decisions for the founder

1. **When to switch to the Claude API** (the first real monthly spend). Recommendation: when the first customer pays.
2. **Paid FalkorDB Cloud or self-hosted.** Recommendation: paid Cloud for now.
3. **Open Paddle** (and the company facts it will ask for, #10).
4. **DNS records on allevia-ai.in:** `app.` for the product, plus SES's mail records.
5. **Read Gmail** (yearly assessment) **or send only** at first. Recommendation: send only, plus Calendar.
6. **The order of Phase 1 features.** Recommendation: email, then "what your team did", then installable app, then mic,
   then meeting memory.

## 8. Risks

- **Model cost per answer could be double our estimate.** Measure on the API in the first week; the hidden budget caps
  the damage.
- **Pomelli is free creative and Sidekick comes inside Shopify.** Sell the brain, the numbers and the approvals, not
  pictures.
- **One person runs everything.** Automatic deploys, alerts, durable jobs and backups exist so a night off is possible.
- **Google and Meta verifications take weeks.** Start the paperwork on 19 October, even before the code needs it.

## 9. Keeping the brain clean as it grows (17 October)

Measured live: general reference knowledge was copied into every business graph (about 200 playbook rules each, plus a
58-event Google update timeline in AVS Atelier). Number readings (about 1,500 to 1,700 in active businesses) and search
chunks grow without limit.

**Already in place:**
- bi-temporal facts, closed and never deleted (the approach Zep's Graphiti takes);
- a source on every fact;
- one graph per business;
- `graph:tidy`;
- `db:usage` alerts.

**Phase 1** (building on 17 Oct):
- a shared read-only reference graph;
- the map shows business knowledge only;
- a write gate (source, date and known type required);
- entity resolution on write;
- a `graph:hygiene` report.

**Phase 2:**
- roll up daily numbers to weekly after 90 days and monthly after a year, archiving the raw values to S3;
- drop the chunks of superseded documents;
- move closed facts and versions older than 180 days to the S3 archive;
- a review list of cold, low-degree, low-PageRank nodes, with no auto-delete;
- per-plan size budgets with an 80% alert.

**Phase 3:** community summary nodes (one per cluster, as Graphiti does) for large brains and a calmer map.

**Research:**
- the Zep paper (arXiv 2501.13956): episodes, entities and communities; invalidation instead of deletion; bi-temporal facts;
- 2026 work on selective forgetting: pruning by recency, access, centrality and age loses little accuracy.
