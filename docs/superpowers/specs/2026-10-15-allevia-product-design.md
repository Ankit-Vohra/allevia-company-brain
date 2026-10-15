# Allevia: product design

Status: synthesis for founder review, 2026-10-15. It merges six design analyses (market gap, go-to-market, retention,
onboarding and isolation, content studio, pricing), critiques them (Appendix A and B), and makes the calls.
Engineering spec: `2026-10-15-allevia-design.md`. Roster: `shared/roster.ts`. Ontology: `src/graph/schema.ts`.

Conventions: **[A]** marks an assumption to verify with the first 10 customers. Prices are in USD, ex-VAT/GST (B2B).
Local prices use FX of 1 Oct–3 Oct 2026: $1 = £0.755 = AED 3.6725 (pegged) = A$1.44
([exchange-rates.org](https://www.exchange-rates.org/exchange-rate-history/aud-usd-2026-10-01)). They are rounded
to local price points, not converted live, and repriced quarterly if FX moves more than 5%. Model prices were checked
on the live [Claude pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-15.

## Decisions at a glance

| Question | Decision |
|---|---|
| Category | A done-for-you **AI growth team**. Not "an AI tool" and not "an agency". |
| Pitch | "Allevia is the growth team every founder needs: set up for you once, it knows your business, does the marketing work with sources, and gets better every week, from 1/20th the cost of a hire." |
| Front door | **Allevia 90**: a 90-day program at **$1,490** upfront or 3 × $529. The first 20 "founding" customers pay **$990**, the founder's figure, in exchange for case-study rights. |
| Plans after day 90 | **Essentials $199**, **Growth $449** (the default), **Pro $999**, and **Pause $29**. All 12 agents and 8 departments are on every plan. |
| Credits | One visible unit, the **Studio credit**. It is spent only when the owner approves a finished image or reel. Questions, briefs, drafts, revisions and text work never use credits. |
| Margins | Typical gross margin is 76–79% on software plans, and 69–71% at heavy use. Allevia 90 is 63% at list (target ≥ 50%) and 47% at the founding price, which is treated as acquisition cost. |
| Owner's time | One 15-minute setup plus an optional 30-minute connect call. After that, at most 90 s a day and 10 min on Mondays. |
| Connections | Agency-style delegated access, with no OAuth for the owner. Every capability has a fallback ladder, so no desk starts empty. |
| Publishing | v1 drafts and exports with a one-tap share. API publishing comes after Meta App Review and GBP API approval. |
| Hackathon | 8 product items, about 20 h. They run in parallel with the unfinished core (M3–M6) and have a hard cut line. See §9. |

---

## 0. The market gap, why now, and what "the black box" means

### 0.1 The gap is depth, not access

| Market | "Uses AI" (broad) | "AI does a job in the business" |
|---|---|---|
| US | 17–20% of firms use AI in any business function (Dec 2025–May 2026). Under 20% of firms with 1–4 staff. Use grew at firms with 20+ staff but was flat below 20 ([Census BTOS](https://census.gov/library/stories/2026/05/ai-use-businesses.html)). | 76% of engaged owners use AI, but only **14% have it fully integrated into core operations**. 73% want training and implementation help ([Goldman Sachs 10KSB, n=1,256, Jan–Feb 2026](https://www.goldmansachs.com/community-impact/10000-small-businesses-voices/insights/ai-presents-a-major-opportunity-for-small-businesses)). |
| UK | 29% of firms ([ONS via SIA, Jun 2026](https://www.staffingindustry.com/news/global-daily-news/uk-business-ai-adoption-rises-to-29-in-2026)) | Adopters use 1.6 AI technologies, up from 1.4 in 2023: "widening, not deepening" ([TechMarketView](https://www.techmarketview.com/news/archive/2026/07/21/ukhotviewsextra-uk-ai-adoption-has-tripled-since-2023-but-barely-deepened)). 71% of non-adopters see "no identified need" ([DSIT](https://gov.uk/government/publications/ai-adoption-research/ai-adoption-research/)). |
| Australia | 43% of SMEs ([NAIC](https://www.ai.gov.au/news-and-insights/blog/ai-adoption-insights-december-2025-february-2026)) | Trust is the top barrier. |
| UAE | 72% self-reported | **12% actually pay for AI tools**, from transaction data of 6,000 firms ([Pemo via tbreak](https://tbreak.com/72-of-uae-businesses-use-ai-the-next-challenge-is-making-it-useful/)). |
| Ireland (a proxy for small rich markets) | 92% use generic tools | Fewer than 1 in 5 have built AI into their business model ([Irish Times / SFA](https://www.irishtimes.com/business/2026/08/10/fewer-than-one-in-five-small-firms-have-built-ai-into-their-business-models-survey-finds/)). |

**Reading.** The high numbers mean "I've tried ChatGPT". The paid, embedded share is 12–20%. The 50–60-point spread
between the two is Allevia's market: owners who already believe AI is useful but have no AI doing a job for them.
They name the same blockers everywhere:
- no identified use case: 39–71%;
- skills: 60–70% ([Thryv](https://www.morningstar.com/news/business-wire/20260625243838/ai-adoption-continues-to-rise-but-70-say-they-need-more-training-to-use-it-effectively));
- time;
- trust in accuracy;
- maintenance, which is the hidden one: models retire, tokens expire and APIs change.

The founder's line, "AI is available and accessible but has not got the penetration", is backed by the data. Size the
market on the conservative numbers (Census, ONS, Pemo), never on the 76%.

### 0.2 Why now
1. **A full answer costs cents.** A multi-agent answer (Meera plans, two desks work, one reviewer checks, Meera
   writes) costs about **$0.21** at Sonnet 5.5 list prices ($2 in / $10 out per MTok, cache hits $0.10); a single-desk
   answer about $0.10 (Appendix B).
2. **A phone photo can now become an ad.** A masked image edit costs about $0.04–0.17; a 5-second Kling 3.0 clip about
   $0.56 through the Higgsfield API ([from $0.112/s](https://higgsfield.ai/blog/higgsfield-api)).
3. **Owners have hit a ceiling.** They know what AI can do and found the DIY route disappointing ("widening, not
   deepening").
4. **"AI employee" apps proved willingness to pay and created churned, educated buyers.** Sintra charges $97/month for
   250 credits, and "if a workspace runs out of credits, helpers will stop working"
   ([eesel](https://www.eesel.ai/blog/sintra-ai-pricing)).
5. **Integration got cheap for us, not for the owner.** MCP and agent SDKs made wiring cheap; the owner still needs
   someone to set it up and keep it running. What is left is labour, not technology.

### 0.3 "The black box, fully functional after one setup", in practice

| | The owner | Allevia (software) | The Allevia team (India) |
|---|---|---|---|
| **Setup (day 0)** | **15-minute wizard** (§2.1): website, Instagram handle, Google listing, country; confirms about 15 brand cards; picks 1–3 goals; drops in 10–30 phone photos. **Optional 30-minute connect call** in their own time zone. | Crawls the site and public profiles and builds the tenant graph. Drafts the brand kit and sets the Day-0 baseline. Configures the 12 agents for the industry and country, compiles each agent's context from the graph, and generates 15 "golden questions" as nightly evals. Runs the Health Check. Makes 3 drafts from the owner's own photos. | The Setup Desk spends about 45 min within 24 h: QA of the brand kit, compliance answers and drafts, plus finishing the delegated connections (GBP, GA4/GSC, Meta partner access). |
| **Daily** | Reads the morning brief (≤ 90 s) and taps up to 3 approvals. | Runs detectors, the brief, alerts, review-reply drafts and follow-ups. | Nothing visible. |
| **Weekly** | Approves the Monday pack (≤ 10 min). | Content autopilot: Tara, then Dev, then Nisha, plus a weekly growth review. | 100% QA in weeks 1–4, then a 20% sample. Escalations follow the time-zone shift plan in §2.5. |
| **Monthly / quarterly** | Reads the report (≤ 15 min) and approves the next quarter's goals. | Scorecard, learning feed, autonomy promotions. | A 30-min async review on Growth, or a live call on Pro. |
| **Maintenance** | Nothing. | Watches capability health, renews tokens, re-runs evals on every model change. | Reconnects broken accounts, re-tunes, productizes recurring problems. |

**Promises we can keep:**
- a Health Check with 5 ranked fixes within 10 minutes;
- 3 drafts from the owner's own photos in the setup session;
- the first Monday pack within 48 hours;
- every capability working, or its fallback explained, within 7 days.

"Fully functional" means **every desk has work on day 1** at the best access mode available (§2.3), and the UI never
shows an empty state.

---

## 1. Positioning and pitch

**Category:** a done-for-you AI growth team, offered as a growth partner and not a tech company. The original spec
positioned Allevia as an "AI growth analyst". This document keeps that analyst as the engine and sells the team.

**Pitch line:** *Allevia is the growth team every founder needs: set up for you once, it knows your business, does
the marketing work with sources, and gets better every week, from 1/20th the cost of a hire.*

**Landing page**
- Tagline: *One setup. A whole team. Better every week.*
- H1: *Your growth team, already briefed.*
- Line for sceptics: *"You've tried ChatGPT. Allevia is what happens when someone sets it up properly for your
  business and keeps it running."*

**Three proof points, each shown working in the demo:**
1. **Receipts on every answer.** Every claim cites a node and the path lights up; citations and numbers are checked
   against this turn's tool results, and a failure shows the yellow "unverified" badge.
2. **Your photo, our studio.** A dim, tilted phone photo becomes an on-brand post or reel in minutes. *Enhance, never
   invent*: Nisha's fidelity badge proves the building, dish or hair was not altered.
3. **It learns you, visibly.** Every edit becomes a learned rule linked to its approval, and the first-pass approval
   rate rises week by week on the scorecard.

**One platform instead of five tabs.** ChatGPT, Claude, Canva, Later and Higgsfield become one inbox. The owner asks in
plain words, the right desk answers, and nobody writes prompts. A founder's hour is worth more than prompt-writing.

**Claims we will not make:**
- "replaces your hire";
- "guaranteed growth";
- "SOC 2", until it is audited.

"From 1/20th the cost of a hire" is anchored on Essentials, and we publish the method (§4.6). For Growth we say "about
a tenth". We say up front: "built and supported from India, which is why it costs a fraction of a local agency."

**Beachhead (all of it to be tested within 30 days [A]):**
1. **Architecture, interior and landscape studios in the UK and UAE.**
   - AVS Atelier is the dogfood case.
   - One project is worth more than £20k, so one lead pays for a year.
   - The work is visual, and the photo-to-post wedge is obvious.
   - The compliance load is light: the "architect" title (ARB) and client consent.
2. **Home-improvement trades in Australia and the US.** These businesses run on Google Business Profile (GBP), reviews
   and job photos, and approvals happen on a phone.
3. **Clinics and Dubai real estate from month 4**, once their compliance packs exist (ASA/CAP health claims, Trakheesi
   permit numbers).
4. **Cafés and retail later.** Their margins are thin and their AI use is about 14%.

---

## 2. Onboarding, customisation and isolation

### 2.1 The 15-minute wizard (crawl first, interview second)
| Min | Screen | Owner | Graph writes |
|---|---|---|---|
| 0–1 | **Where do we find you?** | URL, Instagram handle, Google listing (Places autocomplete), country | `Business{country, currency, locale, timeZone, privacyRegime}`, inferred from the address, TLD and phone code, then confirmed |
| 1–4 | **Reading your business** (the pixel office goes live) | Watches | M5 crawl (≤ 60 pages), Places details, public IG grid; Haiku extraction of Product, Audience, Need, BrandRule, BrandAsset; SEO `FAILS`/`PASSES`; Day-0 `Observation{baseline:true}` |
| 4–6 | **Is this you?** | ✓/✗/edit on about 15 cards: logo, colours, tone, services and prices, audiences, do's and don'ts, design style | Each ✗ closes the edge and writes `Memory{kind:'fact'}` STATED by the owner. `Business.designStyle` |
| 6–11 | **Goals and photos** (Meera asks at most 5 questions and skips anything the crawl answered with conf ≥ 0.8) | 1 primary and up to 2 secondary goals from industry templates; the best customer; "never say"; 10–30 photos | `Goal` nodes (PURSUES/TRACKS), `Memory{kind:'preference'|'instruction'}`, `Asset{kind:'original'}` |
| 11–15 | **Your team and first week** | Confirms which desks are on; approves 1–3 drafts made from their photos | `Agent.enabled/mode`, `Program{kind:'allevia90'}` with a D0 `Checkpoint`, the first `Approval`s |

Every step after the URL can be skipped, nothing waits on an integration, the session resumes from an emailed link,
and drafts start generating in the background from step 2. Cost: about $1–3 of model spend and 45 min of Setup Desk
time per onboarding [A].

### 2.2 Connections without platform review: agency-style delegation
| Capability | v1 mechanism (no owner OAuth) | Note |
|---|---|---|
| GA4, Search Console | The owner adds a per-tenant Google **service account** as Viewer | Avoids the [100-user cap on unverified apps](https://support.google.com/cloud/answer/7454865) |
| GBP (posts, reviews, insights) | The owner adds a per-tenant ops identity `t-<slug>@ops.<domain>` (a Cloud Identity user behind an *Internal* OAuth client) as Manager | GBP API quota is 0 until Basic access is approved ([prereqs](https://developers.google.com/my-business/content/prereqs)). **Apply this week.** |
| Instagram, Facebook | Partner access to Allevia's Meta business portfolio | **[A]** API reads of partner-shared assets may still need Advanced Access via App Review. File in month 1. |
| Everything else | CSV or screenshot upload, read by vision extraction | Labelled with access mode `upload` |

Each tenant gets its own ops identity. That limits the blast radius if one is compromised. Security keys and
just-in-time staff access are required.

### 2.3 The capability fallback ladder ("fully functional" made honest)
Each `Capability{key, accessMode, status, lastOkAt, upgradeHint}` sits at the best mode available, best first: `api` →
`delegated` → `upload` → `public` (the crawl) → `benchmark` (playbook norms, labelled). Answers disclose any mode other
than `api` the way they disclose "simulated" (a new `modeDisclosed` turn check), and the UI shows the mode plus the one
action that would upgrade it.

**When a connected account breaks** (token expired, access revoked, password or 2FA changed): the nightly health check
sets `Capability.status = 'down'`; the capability drops one rung, so answers keep working and say so; Vikram puts
"reconnect" in the brief; an `Escalation` reaches the Growth Partner with a next-local-morning SLA. Nothing fails
silently.

### 2.4 Customisation: all of it is graph data
| Layer | What it sets | Where it lives |
|---|---|---|
| Country | Currency, spelling (en-US/en-GB/en-AU), tax display, week start, holiday and season calendar (Ramadan and Eid, Black Friday, Boxing Day, EOFY on 30 June), compliance rules | `Business` props; `Event{kind:'season'|'holiday', country}`; `Rule{kind:'compliance'}` |
| Industry template | Which desks are emphasised, goal templates, formats, seasonality, connection priority, autonomy ceiling | v1: YAML in `templates/`, copied in with `SOURCED_FROM` a `Document{kind:'template'}`. Phase 3: a read-only `allevia_templates` graph |
| Brand and design style | Voice, colours, fonts, "warm minimal, film grain, no stock people" | `BrandRule`, `BrandAsset`, `Business.designStyle` |
| Per agent | `enabled`, `mode: full|light|off`, `autonomy 0–3`, persona notes, limits | `Agent` props; `Memory{kind:'instruction'} -ABOUT-> Agent`; `Rule{kind:'policy'} -APPLIES_TO-> Agent` |
| Plain language | Example: "Tara, no emojis on LinkedIn; switch Arjun off till the new site launches" | Haiku turns this into patches, the owner confirms a diff card, and the patches are written STATED by the owner. Undo closes the edge. |

**Agent context.** `operatingContext(tenant, agentId, now)` compiles at most about 900 tokens per agent turn (profile,
policies, instructions, top 10 BrandRules, the agent's goals, events in the next 14 days). It sits *after* the global
cached prefix (tool definitions, generic persona), so that prefix stays shared across tenants. Findings write
`GUIDED_BY` to the instructions they applied, so "why no emojis?" lights up the owner's own words on the path, and
disabled agents drop out of Meera's plan schema.

Repo gaps to close: `PLAN_SCHEMA` in the agent worktree's `src/agent/prompts.ts` still builds its enum from the global
`AGENTS` list, and `TenantInput` in `src/graph/tenants.ts` has no country, locale, currency or time zone yet (the
prompts already accept a `timeZone`).

### 2.5 Isolation and support from India
**Isolation.**
- **Storage and binding:** one FalkorDB graph per tenant; the tenant is bound per request from a `Membership` in
  `allevia_meta` (anything else is a 403); no tool takes a graph name; `cypher` runs `GRAPH.RO_QUERY` on the bound
  handle.
- **Per-tenant namespaces:** the extraction cache (global today: `data/cache/extract/`), assets under
  `data/assets/<tenant>/` behind 15-minute signed URLs, one Higgsfield project per tenant with every media and job id
  checked against its `Asset`, and a vault path (the graph holds only `vaultRef`).
- **Staff access:** only through an `AccessGrant` (reason, ≤ 24 h), visible to the owner in an access log.
- **Region:** one EU (London) region at launch; a US cell at 50 US customers. Inference uses Anthropic's default
  global routing, and the DPA says so.
- **Lifecycle:** export (graph JSONL, media, KPI CSVs) any time; erase with a 7-day undo, then `GRAPH.DELETE`, caches,
  vault, media and the Higgsfield folder, with backups aged out in 35 days. Billing records stay in `allevia_meta` for
  tax law.
- **No cross-tenant learning.** Benchmarks are opt-in and published only for cohorts of 10 or more (Phase 3).

**Support across time zones (async by default).** Shift A (IST 08:00–17:00) covers Sydney's afternoon and Dubai's working
day until mid-afternoon. Shift B (IST 15:00–00:00) covers the rest of Dubai's day, London's working day and New York's
morning (09:00 ET is 19:30 IST in winter). AI answers are
instant; the human SLA is the next local morning. Sell to the UK, UAE and Australia first, and to the US once Shift B
is staffed. Each tenant has a named Growth Partner and a backup; Indian holidays are covered by a published roster.

---

## 3. Retention: the operating rhythm and Allevia 90

### 3.1 Why owners keep paying once the website is fixed
- **One-off fixes are the welcome gift**, done in the first 14 days: website, GBP profile, the top 5 SEO issues.
- **The subscription pays for jobs that never finish:**
  - weekly content from the owner's photos;
  - review replies;
  - watching the numbers and alerting;
  - follow-ups with the team;
  - a seasonal campaign calendar per country;
  - keeping connections and models working.
- **Value builds up:** learned rules, performance history and decisions with evidence. Leaving means losing a trained
  team, and export is always free.

### 3.2 The rhythm (push, not pull)
| When (owner's local time) | Agents | What arrives | Owner time |
|---|---|---|---|
| Daily 07:30 | Meera writes, Isha checks the numbers | **Morning brief**: a goal-pulse line, at most 2 changes (each with a "why" path), at most 3 one-tap approvals, today's to-dos | ≤ 90 s |
| Monday 08:00 | Tara → Dev → Nisha | **Monday pack**: 3 posts, 1 reel, 1 GBP post and drafted review replies, each with a "why this" | ≤ 10 min |
| Monday, same message | Kabir and Rohan, reviewed by Isha | **Weekly growth review**: what moved and why; last week's experiment; 1–2 new ones | 3 min |
| 1st working day of the month | Isha (numbers), Meera (letter) | **Monthly report**: goals against the Day-0 baseline, work done, hours saved (with an editable assumption table), what Allevia learned | ≤ 15 min |
| Each quarter | Meera, Isha | **Goal reset**: next quarter's targets, approved with one tap. This is the renewal moment. | 5 min |

**Always-on work:**
- **Review replies.** GBP replies go out through [`reviews.updateReply`](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/updateReply). Reviews of 2★ or lower never go automatically.
- **Detector alerts.** These come from deterministic Cypher with an 8-week baseline.
  - Triggers include a drop of 30% or more in GBP calls, the site down, a posting gap, an ad CPA at 1.5× the median, and
    an approval waiting more than 48 h.
  - Only an outage or a 1★ review pushes immediately. Everything else waits for the brief.
- **Team to-dos.** Vikram runs them on the Board. Staff need no login, and a photo reply closes a task and feeds the
  Studio.

**Learning made visible:**
- **The KPI.** The **first-pass approval rate** is the share of drafts approved without edits over 30 days. It is
  computed from `Approval.firstPass`. Target: about 30% in month 1, 60% by day 90, with 70% as a stretch [A].
- **Autonomy ladder per format.**
  - L0: draft only.
  - L1: scheduled after approval.
  - L2: auto-publish with a digest afterwards (needs API publishing).
  - L3: act within budget caps.
- **Promotion.** It needs at least 20 approvals in the format, at least 85% of them first-pass, and 0 compliance or
  fidelity failures. Isha proposes it and the owner accepts with one tap.
- **What never goes autonomous:** ad spend above a cap, replies to reviews of 3★ or lower, and price or legal claims.

**North star:** **weekly approving owners**, the share of accounts where the owner approved something in the last
7 days. Target ≥ 70%.

### 3.3 Allevia 90 (the improvement program)
The program costs $1,490 upfront or 3 × $529, and $990 for the first 20 founding customers (§4). It includes:
- the done-for-you setup;
- Growth-level allowances (50 Studio credits a month);
- weekly tuning;
- strategist reviews on day 0, 30 and 90.

| Day | What happens | Graph |
|---|---|---|
| D0 | The 15-min wizard, then the optional 30-min connect call. The graph is built; goals and baselines are locked. | `Program`, `Checkpoint{day:0}`, `Goal`, `Observation{baseline:true}` |
| D1–D2 | First morning brief; the Health Check fixes are shipped or filed | `Recommendation`, `Approval`, `Action` |
| D7 | First approved content week. Weeks 1–4 get 100% human QA, and every edit becomes a learned rule. | `Rule{kind:'learned'} -LEARNED_FROM-> Approval` |
| D30 | Report #1 and a 30-min review with a human Growth Partner | `Checkpoint{day:30}` with Observations measuring it |
| D45–D60 | The first autonomy promotion becomes possible. A seasonal campaign is planned for the next local season. QA drops to a 20% sample. | `Agent.autonomy`, `Campaign` |
| D75 | Graduation report drafted. An account-health check runs, with an intervention if the account is red. | `Document{kind:'report'}` |
| D76 | Renewal notice, at least 14 days ahead, as auto-renewal laws require (California ARL, UK DMCC) | — |
| D90 | **Graduation**: before and after on every goal, the 3 biggest wins with their evidence paths, the first-pass curve, rules learned, hours saved | `Checkpoint{day:90}` |

**Guarantees** (on what we control, never on revenue):
1. **14-day full refund**, no questions asked.
2. **Day-30 delivery guarantee.** If the brain is not live (3 or more capabilities working or explained), or fewer than
   4 Monday packs and 12 approve-ready pieces have been delivered, we refund the remaining two-thirds.
3. **Month 4 free** if fewer than 2 of the 3 *leading-indicator* goals are hit, provided the owner acted on at least
   50% of proposals. Examples of leading indicators: posting 3 times a week, GBP replies within 24 h, the top 5 SEO
   fixes shipped.

**Conversion at D90:**
- The default is Growth monthly at $449.
- Alternatives:
  - Growth annual at $4,490, which is 2 months free;
  - Essentials at $199;
  - Pause at $29, which keeps the brain, a weekly brief and review alerts.
- Founding customers get Growth locked at $399 for 12 months.
- Target: 65% continue [A], and 30% of those choose annual [A].
- Cancelling is one screen that offers Pause once.

---

## 4. Plans, credits and unit economics

### 4.1 Plans
| | **Essentials** | **Growth** (default) | **Pro** | **Pause** |
|---|---|---|---|---|
| Who | Program graduates on a budget | Single-location owners who want the whole team | Multi-location, regulated or done-with-you | Seasonal businesses or a break |
| Studio credits / month | 20 | 50 | 120 | 0 |
| Answers (fair use; hidden model budget) | 100 ($25) | 300 ($60) | 800 ($150) | 10 |
| Rhythm | Daily brief, Monday pack, monthly report | All of §3.2 | All, per location | Weekly brief, review alerts |
| Sources / locations / seats | 3 (site, IG, GBP) / 1 / 2 | All / 1 / 6 | All / 3 / 20 | Kept read-only |
| Human | Quarterly async check | Named Growth Partner, 30-min monthly async review | Strategist 2 h/month plus a monthly call; 4-business-hour SLA | — |
| Extras | — | WhatsApp delivery (Phase 2) | Ads execution after approval (Phase 3); EU/UK data-residency addendum | — |

**Packaging rules:**
- **All 12 agents and 8 departments are on every plan.** The brain is the product. We gate volume, sources, locations,
  seats and human time.
- **At launch, everyone enters through Allevia 90.** Essentials is open only to graduates until onboarding is fully
  automated and activation is at least 60% without human help (Phase 3). Agency and franchise "Partner" pricing comes
  later and is quoted per deal.

### 4.2 Studio credits (the founder's credits, without the anxiety)
| Output (finished, approved) | Credits |
|---|---|
| Static post, GBP post or story: 1 image, up to 3 variants, 2 free tweak rounds | 1 |
| Carousel, up to 6 frames | 2 |
| Project or product shoot: 4 angles from one phone photo | 3 |
| Reel up to 15 s, with script, cover and captions | 4 |
| Answers, briefs, review replies, captions, emails, reports, analysis | 0 |

**Rules:**
- **When credits are spent.** Only on approval: a rejected draft costs the owner nothing.
- **Unused credits** roll over for 1 month, up to one month's allowance.
- **Running short.** A task can borrow up to 20% of next month's credits, so nothing stops mid-task. Top-ups are
  **20 credits for $59**, and they are automatic only if the owner opts in.
- **Internal caps** (not shown to the owner):
  - $8 of provider cost per piece;
  - a model allowlist per format, so Seedance 2.0 at $0.93/s is never used;
  - Vikram flags any piece regenerated more than 5 times.
- **The approval card** shows "uses 1 of 50 credits this month".

### 4.3 Prices in four currencies (ex-VAT/GST)
| | USD | GBP | AED | AUD |
|---|---|---|---|---|
| Essentials / month | 199 | 149 | 729 | 289 |
| **Growth / month** | **449** | **339** | **1,649** | **649** |
| Growth / year (2 months free) | 4,490 | 3,390 | 16,490 | 6,490 |
| Pro / month | 999 | 749 | 3,669 | 1,449 |
| Pause / month | 29 | 22 | 109 | 42 |
| **Allevia 90, upfront** | **1,490** | **1,129** | **5,490** | **2,149** |
| Allevia 90, 3 instalments | 3 × 529 | 3 × 399 | 3 × 1,949 | 3 × 769 |
| Founding 20: Allevia 90 | 990 | 749 | 3,649 | 1,429 |
| Founding 20: Growth locked for 12 months | 399 | 299 | 1,469 | 579 |
| Top-up, 20 credits | 59 | 45 | 219 | 85 |

`shared/plans.ts` is the single source of truth for the pricing page, the allowance meter and billing.

### 4.4 Cost to serve (derivation in Appendix B)
**Unit assumptions:**
- **Answer:** $0.18 blended, from $0.10 for a single desk to $0.21 multi-agent, plus 20% for retries and revisions.
- **Background jobs:** $4–8 per month (brief, weekly review, report, ingestion, learning pass).
- **Studio:** $0.65 per credit used, including Claude vision and QA. A post is about $0.50 and a reel about $3.65.
- **Human time:** $10/h for an associate and $20/h for a strategist, fully loaded [A].
- **Payments:** Paddle at 5% + $0.50, plus about 1% FX and a 0.5% refund and chargeback reserve, so 6.5% + $0.50.

| Per tenant per month | Essentials $199 | Growth $449 | Pro $999 | Pause $29 | Allevia 90 $1,490 (whole 90 days) |
|---|---|---|---|---|---|
| Claude API, typical | 9.40 | 16.10 | 29.60 | 0.50 | 72.90 |
| Studio media + content LLM (70% of credits used; 100% in the program) | 9.10 | 22.75 | 54.60 | 0 | 99.50 |
| Human (India) | 5.00 | 28.00 | 70.00 | 0 | 250.00 |
| Infrastructure (at 100+ tenants) | 6.00 | 8.00 | 15.00 | 3.00 | 30.00 |
| Messaging and data APIs | 1.00 | 2.00 | 4.00 | 0.30 | 6.00 |
| Payments, FX, refund reserve | 13.44 | 29.69 | 65.44 | 2.39 | 97.35 |
| **COGS, typical** | **43.94** | **106.54** | **238.64** | **6.19** | **555.75** |
| **Gross margin, typical** | **77.9%** | **76.3%** | **76.1%** | **78.7%** | **62.7%** |
| Gross margin, heavy (3× answers, 100% of credits) | 70.5% | 69.3% | 69.4% | 78.7% | 54.3% (human +50%) |

**Founding prices:**
- The $990 program runs at 47.1%. That is a deliberate acquisition cost, capped at 20 customers.
- Growth at $399 runs at 74.1%.

**Contribution and lifetime value:**
- Allevia 90 at list contributes **$934**, which pays for acquisition inside the first 90 days.
- Growth contributes about $342 a month. At 3.5% monthly churn after the program [A], that is about $9.8k.
- With 65% conversion, a program buyer is worth about **$7.3k**, which supports a CAC ceiling of about $2.4k at 3:1.

**Margin verdicts** (target ≥ 70% on software plans, ≥ 50% on the program; detail in B.5). Every software plan clears
70% at typical use and sits at 69–71% at heavy use, which the hidden model budget and credit allowance cap. The program
clears 50% even with human time 50% over budget. **The margin lever is human minutes, not models:** one extra
associate hour per Growth tenant costs 2.2 points, while doubling Claude spend costs 3.6. Below 30 tenants, fixed
infrastructure of $15–30 per tenant puts Growth at about 71–74%.

**Fixes we commit to:** a human-minute budget per tenant (240 min in the onboarding month, 75 min steady state on
Growth; a tenant over 120 min for two months gets its cause productized or moves up a tier); the model-budget
downshift (Haiku for single-desk questions, at most 2 desks, ops alerted at 150%); the Studio model allowlist; Batch
for overnight jobs; and a cache layout with the shared prefix first.

### 4.5 Billing mechanics
- **Merchant of record: Paddle** ([5% + $0.50](https://dodopayments.com/blogs/paddle-fees-explained), which handles
  VAT, GST and US sales tax).
  - Stripe is invite-only for new Indian businesses ([Stripe](https://docs.stripe.com/india-exports)).
  - Exports from India need a GST export LUT, and every payout needs its foreign-inward-remittance paperwork (FIRA).
  - Revisit at about $15k MRR.
- **Refunds:**
  - Monthly plans cancel at the end of the period, with no partial refunds.
  - Annual plans get a pro-rata refund within 30 days.
  - Allevia 90 follows the guarantees in §3.3.
- **Chargebacks** are answered with the graph itself: every `Approval` the owner tapped, with timestamps, and every
  delivery is evidence.
- **Ledger.** The ledger lives in `allevia_meta` (`Wallet`, `LedgerEntry`, keyed by tenant and approval id).
  - Tenant graphs carry only cost `Observation`s on `Asset`s and `Content`, which gives lineage.
  - The LLM never writes the ledger.

### 4.6 "1/20th of human cost", substantiated
The comparison is against a loaded social-media-manager hire:
- **US:** [Indeed](https://www.indeed.com/salaries/Social-Media-Manager-Salaries) $64,139 × 1.25 = $6,681 a month.
- **UK:** [Payscale](https://www.payscale.com/research/UK/Job=Social_Media_Manager/Salary) £29,313 × 1.2 = £2,931 a
  month, and £5,250 in London.
- **UAE:** AED 14,400 a month [A].
- **Australia:** A$7,312 a month [A].

| | US | UK | London | UAE | AU |
|---|---|---|---|---|---|
| Essentials | 1/34 | 1/20 | 1/35 | 1/20 | 1/25 |
| Growth | 1/15 | 1/9 | 1/15 | 1/9 | 1/11 |

The claim "from 1/20th" holds in every market. The method is published on the pricing page, because the FTC and the ASA
require substantiation.

---

## 5. One platform for every request: routing to departments

Meera routes each request in two stages:
1. **A deterministic pre-router.**
   - An attachment goes to the Studio.
   - "remind / ask <person> to" goes to Vikram.
   - A metric plus "why" goes to Kabir.
2. **Meera's structured plan.** Only enabled agents are in it. One desk is the default and three the maximum.

| The owner says | Desk(s) | Graph and tools | Output |
|---|---|---|---|
| "Why did enquiries drop this month?" | Kabir, checked by Isha | `metric_trend`, `seo_report`, `find_paths`, Goal | Answer with a path, plus a Recommendation |
| (sends a photo) "finished this, want to post" | Tara → Studio → Dev → Nisha | `assess_photo`, render, fidelity | Approval card with variants A/B/C |
| "Reply to the new 2-star review" | Dev drafts, Nisha checks | Review Content, BrandRule | Approval card, never sent automatically |
| "Should we run ads for Ramadan?" | Rohan, with Isha | `ad_report`, `playbook`, `Event{season}` | A budget proposal |
| "The contact form is broken" | Arjun | `impact_of`, `seo_report` | A GitHub issue, or a fix brief Task for the web designer |
| "The app keeps crashing" / "is the site down?" | Zoya (on call) | `metric_trend`, `impact_of`, `history` | A triaged incident with what changed, and a GitHub issue |
| "Did the last release break anything?" | Imran, reviewing Arjun | `metric_trend`, `history` | Crash-free and store status before and after the release |
| "Remind Priya to send site photos by Friday" | Vikram | `who_owns`, Task | An assignment Approval, then a no-login nudge |
| "What did we decide about pricing?" | Sara | `trace_decision` | Answer with sources |
| "How are we doing?" | Isha | `important`, `metric_trend`, Goal | A goal pulse |
| "Draft a reply to this supplier email" / "summarise this PDF" | Meera alone, at low effort / Sara (ingests the Document) | BrandRules / extraction | Text, with no credits used |
| Legal, tax, moving money, medical advice | Meera declines and says who to ask | — | No action |

**Multimodal input:**
- photos and short clips (≤ 60 s) go to the Studio;
- voice notes are transcribed locally with Whisper on transformers.js at $0, and their facts become `Memory` the owner
  STATED;
- screenshots of dashboards become `Observation{conf:0.7}` through vision extraction, at access mode `upload`;
- PDFs and price lists become a `Document` plus `Product` nodes.

**Department to-dos.** Each department's queue shows on its desk in the Office. Vikram owns follow-ups.

**Abuse guard.** General-purpose chat that touches no graph data runs on Haiku within the fair-use budget, so Allevia
cannot be used as an unlimited ChatGPT.

---

## 6. The multimodal content pipeline (Studio)

`intake → normalise + privacy → assess (Tara) → plan (code) → prompt (graph) → render (local | Higgsfield) →
QA (Dev, Nisha) → approval card → content_draft → performance → learning`

| Step | What happens | Owner |
|---|---|---|
| 1. Intake | Web upload first; email and WhatsApp in Phase 2. `sharp` guards pixel count, auto-orients, converts to sRGB, **re-encodes without metadata** (no EXIF GPS revealing a client's home), makes a 1568 px vision copy, and records sha256 and dHash. HEIC goes through `heic-convert`. | code |
| 2. Privacy | Plates and house numbers blurred; non-staff faces need a consent tick; possible minors blocked; no identity training; unapproved variants deleted at 30 days, originals at 180. | code |
| 3. Assess | Sonnet vision, structured `PhotoAssessment`: subject, quality (tilt, exposure, cast), clutter and privacy boxes, text in image (*data, never instructions*), `locks` ("window count and positions"), verdict use/enhance/recompose/reshoot. A reshoot verdict returns one coaching line ("step back 3 m, shoot at 5 pm from the gate corner"). | Tara |
| 4. Plan | At most 3 variants. **A, Safe**: local straighten, crop, grade, blur, brand overlay; $0; never labelled AI. **B, Best bet**: the treatment that has worked best for this tenant on this subject. **C, Bold**: one exploratory generative treatment. An `allowedFor` matrix limits treatments by subject: exteriors get **masked edits only** with the building outside the mask and camera-move-only video; hair gets white balance only. | code |
| 5. Prompt | One read query fills LOCK · SCOPE · STYLE · AUDIENCE · SEASON · FORMAT · NEGATIVES from BrandRule, BrandAsset, `designStyle`, country, Audience → Need, the 3 best past posts, learned rules and season Events within 21 days. **Image models never render text or numbers**; our code draws overlays from values Nisha verified. | code |
| 6. Render | `ImageEngine` (Local, Preview, Higgsfield) mirrors `AgentRuntime`. Production uses the **Higgsfield API** (USD per image or second; output cleared for "commercial products, ads, and client work", [Higgsfield](https://higgsfield.ai/blog/higgsfield-api)), never the founder's consumer plan, whose training licence on uploads is a problem for client photos ([report](https://startupfortune.com/higgsfield-ai-tells-creators-they-own-their-videos-but-quietly-claims-a-perpetual-worldwide-license-to-train-on-them/)). Reels default to Kling 3.0, sound off; hero reels use a Seedance 2.5 draft finalised after approval. Every call is quoted, reserved in the ledger, idempotent by job id, never resubmitted after a timeout. | Tara |
| 7. QA (fails closed) | Dev: `voiceLint`, `classifyHook`, brand don'ts, palette ΔE. Nisha: claims against the graph; SSIM ≥ 0.92 outside the mask; ΔE00 ≤ 6 on food and hair; a vision diff returning `{added, removed, structuralChange}`. One retry with a tighter lock, then the variant is dropped. | Dev, Nisha |
| 8. Approval card | Original beside variants, a badge ("Building unchanged · removed 2 bins, scooter"), 4:5 / 9:16 / 4:3 crops, "uses 1 of 50 credits". Tweak: warmer, less edited, no AI. Reject: changed my building, looks fake, not our style. Approve runs `content_draft`: `Content -USES_ASSET-> Asset`. | owner |
| 9. Publish | v1: one-tap export and share (caption copied, native share sheet). GBP posts and review replies via the GBP API once Basic access is approved. Instagram after App Review (`instagram_content_publish`, at most [100 API posts per 24 h](https://developers.facebook.com/documentation/instagram-platform/content-publishing)). TikTok and LinkedIn need partner approval (Phase 3). | owner / API |
| 10. Learn | `CHOSE` / `DECLINED {reason}`, caption edits, and saves per reach at 48 h and 7 d update per-tenant treatment scores; a learned Rule is written at ≥ 1.5× lift over ≥ 5 posts. | Sara |

**Disclosure and brand safety.**
- Generative outputs carry IPTC `DigitalSourceType`. Before/after posts use only a real "before" photo.
- UK beauty posts carry a "hair unretouched" style line: under [CAP guidance](https://www.rpclegal.com/snapshots/advertising-and-marketing/summer-2025/cap-issues-guidance-on-use-of-ai-in-ads/) a disclosure does not cure an exaggerated result.
- The owner attests to rights in every upload. Blocked: adult, weapons, tobacco and vape, gambling, unauthorised
  financial promotions, prescription drugs, political ads.
- **Allevia never writes customer reviews or testimonials** (FTC fake-review rule and
  [Endorsement Guides](https://www.ftc.gov/legal-library/browse/rules/guides-concerning-use-endorsements-testimonials-advertising)).

---

## 7. Graph and ontology additions (`ONTOLOGY_VERSION` 1 → 2)

Every addition reuses an existing label or relationship wherever the meaning fits. Numbers stay `Observation` nodes, as
spec §5.4 requires.

### 7.1 New node labels
| Label | Key props | Phase | TRACKED / SEARCHABLE |
|---|---|---|---|
| `Goal` | metricKey, target, baseline, baselineConf, unit, period, dueAt, priority, status (on_track, at_risk, off_track, achieved) | Hackathon | status, target / yes |
| `Program` | kind:'allevia90', startAt, endAt, status, guaranteeState, priceUsd, currency | Hackathon | status, guaranteeState / no |
| `Checkpoint` | day (0, 30, 60, 90), at, summary. It holds no numbers: Observations MEASURE it. | Hackathon | — / no |
| `Asset` | kind (original, variant, final), mediaType, mime, w, h, sha256, dhash, storageKey, source, subjectKind, treatment, consent, aiEdited, iptcSourceType, hfJobId, status | Hackathon | status / no |
| `Capability` | key (ga4, search_console, gbp, instagram_insights, reviews, studio, ads), accessMode (api, delegated, upload, public, benchmark, none), status, lastOkAt, upgradeHint | Hackathon | accessMode, status / no |
| `Treatment`, `Prompt` | The Studio catalog, and prompts with BASED_ON lineage | Phase 2 | — |
| `Alert` | kind, severity, firedAt, status | Phase 2 | status |
| `Escalation` | reason, openedAt, slaAt, resolvedAt, humanMinutes | Phase 2 | status |
| `Location` | address, city, country, timeZone, gbpLocationId | Phase 2 (Pro) | — |
| `Delivery` | channel, sentAt, readAt, cost | Phase 2 | — |

### 7.2 Reused labels with new kinds or props
- **`Rule`:**
  - `kind` gains `learned` (already in the spec), `policy`, `compliance` and `fidelity`;
  - learned rules also carry `confidence`, `appliedCount` and `status`, with `status` TRACKED.
- **`Task{kind:'assignment', dueAt, proof, channel}`** holds to-dos for humans. Assignment uses the existing functional
  `Person -OWNS-> Task`.
- **`Document{kind:'brief'|'report'|'template'|'snapshot'}`** holds briefs and reports, which reach what they summarise
  through the existing `Document -MENTIONS-> *`.
- **`Content`** gains the formats `'review'` and `'review_reply'`.
- **`Memory{kind:'instruction'} -ABOUT-> Agent`** stores per-agent notes.
- **`Event{kind:'season'|'holiday', country}`** stores the country calendars.
- **`Observation{baseline:true}`** marks the Day-0 baseline, and new metric keys `allevia.first_pass_rate`,
  `allevia.learned_rules`, `allevia.deliverables_approved`, `allevia.owner_minutes`, `credits_charged` and `usd_cost`.
- **`Business` gains** country, currency, locale, timeZone, privacyRegime, designStyle, vertical and templateKey. All
  except privacyRegime and vertical are TRACKED.
- **`Agent` gains** enabled, mode and autonomy (TRACKED), plus titleOverride.
- **`Approval` gains** firstPass, decisionMs and editDistance.

### 7.3 New relationship types
| Rel | Pattern | Functional |
|---|---|---|
| `PURSUES` | Business → Goal | — |
| `TRACKS` | Goal → Metric | key `from`: one metric per goal |
| `ADVANCES` | Recommendation, Content, Task, Approval, Campaign → Goal | — |
| `ENROLLED_IN` | Business → Program | key `from`: one current program |
| `DERIVED_FROM` | Asset → Asset {step, treatment} | key `from` |
| `USES_ASSET` | Content → Asset | — |
| `DEPICTS` | Asset → Product, Page, Business, Event | — |
| `GUIDED_BY` | Turn, Finding, Content → Memory, Rule, BrandRule | — |
| Phase 2 | `MADE_WITH` (Asset → Treatment), `PROMPTED_BY` (Asset → Prompt), `CHOSE`/`DECLINED` (Approval → Asset), `REPLIES_TO` (Content → Content), `AT_LOCATION` (* → Location), `TRIGGERED_BY` (Alert → Observation, Content, Approval, Task) | — |

### 7.4 Extended patterns on existing relationships
- `PART_OF`: Goal → Program; Checkpoint → Program; Capability → Business (later also Location → Business).
- `DEPENDS_ON`: Capability → Channel or System.
- `USES`: Agent → Capability.
- `AUTHORED`: Person → Asset.
- `PRODUCED`: Agent → Asset or Task.
- `REVIEWED`: Agent → Asset.
- `RESULTED_IN`: Action → Task (already allowed; the assign-task flow is Recommendation → Approval → Action → Task).
- `SUPERSEDES`: add Goal, for the quarterly reset (same-type rule).
- `OWNABLE`: add Goal, so that `Agent OWNS Goal` gives each agent its KPIs.
- `MEASURES` (Observation → \*) already covers Goal, Asset and Checkpoint. `APPLIES_TO` (Rule → \*) already covers
  policies on agents.

### 7.5 Outside the tenant graph
- **`allevia_meta`:** Plan, Subscription, Wallet, LedgerEntry, Usage {llmUsd, mediaUsd, humanMinutes}, Membership,
  AccessGrant, AuditEvent (with no content).
- **`allevia_templates`** (Phase 3).
- **`allevia_benchmarks`** (Phase 3; only for cohorts of 10 or more).

**Contracts** (`shared/contracts.ts`):
- `OnboardEvent.stage` gains `profile`, `goals`, `baseline` and `capabilities`.
- `AgentEvent` gains:
  - `{type:'asset', assetId, kind, parentId?, thumb, simulated?}`;
  - `{type:'assessment', assetId, verdict, overlays}`;
  - `{type:'learned', ruleId, text, fromApprovalId}`;
  - in Phase 2, `{type:'allowance', credits, left}`.
- `ActionKind` gains `assign_task`, `gbp_post` and `review_reply` in Phase 2.

---

## 8. API and UI additions

The paths follow the plan's `/api/:t/...` convention.

| Endpoint | Purpose | Phase |
|---|---|---|
| `POST /api/onboard`, with body `{name, url, instagram?, country, vertical?, goals?, bestCustomer?, avoid?}` | Wizard; the SSE stream gains the stages profile, goals, baseline and capabilities | Hackathon |
| `GET /api/:t/program` | Program day, checkpoints, first-pass rate, learned-rule count, goals against baseline, capabilities by mode | Hackathon |
| `GET /api/:t/learning?since=` · `DELETE /api/:t/learning/:ruleId` | Learning feed; retiring a rule closes it and writes a Version | Hackathon |
| `POST /api/:t/studio/intake` (multipart) · `GET /api/:t/assets/:id` | Studio, streamed as AgentEvents; the asset proxy checks the tenant | Hackathon |
| `GET /api/:t/capabilities` | Ladder state | Hackathon |
| `GET /api/:t/agents` · `PATCH /api/:t/agents/:id` · `POST /api/:t/directives` (preview) · `POST /api/:t/directives/:id/apply` | Team settings, "Tell your team" | Hackathon |
| `GET /api/plans?currency=` | Pricing data from `shared/plans.ts` | Hackathon |
| `/api/:t/today`, `/goals`, `/board`, `/assignments/:id/{done,snooze}`, `/alerts`, `/reports/:period`, `/allowance`, `/topup`, `/export`, `/erase`, `/access-log`, `/api/billing/paddle-webhook`, `/api/hooks/{whatsapp,email}` | The full rhythm, billing, data rights and channels | Phase 2 |

**Screens:**
- **Home**
  - A "Your 90 days: Day N" card: the first-pass curve, learned rules, goals against Day 0, capability chips.
  - The brief, with goal-pulse lines.
- **Studio** (new): drop a photo and a note, see Tara's overlay, compare variants A/B/C with Nisha's badge, approve.
- **Approvals:** an "applied: your edit on Oct 16" learned-rule chip and the credits line.
- **Office**
  - Sara's shelf gains a book per learned rule; clicking one opens its `LEARNED_FROM` path.
  - Disabled desks are dimmed.
  - The Studio room reacts to `asset` events.
- **Team settings:** agent cards (on, light or off; notes; autonomy badge; learned rules) and the "Tell your team" box
  with a diff preview.
- **Onboard:** the 5-step wizard and a "What we did for you" receipt (nodes by type, agents configured, capabilities by
  mode, detectors armed).
- **/pricing:** a currency toggle and the Allevia 90 timeline.
- **Phase 2:** Today, Board, Goals, Reports, Plan & usage, and Data & privacy.

---

## 9. The hackathon build list (about 2.5 days left)

**Context.**
- The core is still in flight in worktrees:
  - the M3 agent orchestrator and tools;
  - the M4 web app, currently in mock mode;
  - the M5 website crawler, not yet started on `dev`;
  - M6 insights, approvals and learning.
- The core comes first.
- The product items below total about 20 h. They run as 2–3 parallel subagent worktrees, each starting only when its
  dependency is merged.
- **Cut line: anything not merged by Oct 17 12:00 IST is cut.** Oct 18 is for the demo video, the blog post and the
  submission.

| # | Item | Size | Depends on | Demo beat |
|---|---|---|---|---|
| 1 | **Schema v2**: Goal, Program, Checkpoint, Asset and Capability; the 8 new rels; extended patterns; TRACKED props; tests in `tests/graph/schema.test.ts` | S (1.5 h) | — | — |
| 2 | **Onboarding v2**: country, locale, currency and TZ on `TenantInput`/`ensureTenant`; Goal nodes from industry defaults; `Observation{baseline:true}`; `Program` + D0 `Checkpoint`; the new OnboardEvent stages; the AVS run (architecture studio) | M (3 h) | 1, M5 | AVS from its URL, with the graph growing live |
| 3 | **Visible learning loop**: edit diff → `Rule{kind:'learned'}` LEARNED_FROM Approval; `Approval.firstPass`; the next draft writes USES_RULE; the `learned` event; the chip | M (2.5 h) | M6 approvals and content_draft | Edit "villa" to "home", and the next draft applies it |
| 4 | **Studio thin slice**: intake with EXIF stripped; Tara's assessment (vision; fallback is the Read tool on a scratch copy); variant A local; variant B from a **pre-recorded** Higgsfield masked edit (a live run only with the founder's approval, at most $5); Nisha's vision diff; the card; `content_draft` with DERIVED_FROM and USES_ASSET | L (5 h) | 1, M3 runtime, M4 web | A dark, tilted AVS phone photo becomes a post, with a "building unchanged" badge |
| 5 | **Program scorecard**: `GET /api/:t/program` (Cypher) and the Home card. Aamdani's program starts on the event date, with goals against real historical Observations and **no fabricated approval history** | S–M (2 h) | 1, 2, 3 | "Day 1: 2 learned rules, first-pass 0 → 1/2" |
| 6 | **Capability ladder**: derived from Channel and System status; `modeDisclosed` added to the turn checks; UI chips | S (1.5 h) | 1, M3 checks | "Instagram: public mode, connect to upgrade" |
| 7 | **"Tell your team"**: Haiku patches with a preview and apply; `Memory{instruction}` ABOUT Agent; `Agent.enabled`; `PLAN_SCHEMA` built from the enabled agents; `GUIDED_BY` | M (3 h) | M3 orchestrator | "No emojis on LinkedIn; switch Arjun off", after which the plan skips Arjun and the path lights the instruction |
| 8 | **Pricing**: `shared/plans.ts`, a static `/pricing` page with the currency toggle, and the business section of the README and blog post | S (1 h) | M4 web | Business model on screen |
| 9 (if green) | Isolation test (`tests/tenancy/isolation.test.ts`), plus a per-tenant extraction cache and asset directory | S (1.5 h) | — | — |
| 10 (if green) | Morning brief shaped as a goal pulse | S (1 h) | M6 brief | — |

**Cut order if time runs short:**
1. Item 4's SSIM check and variant C.
2. Item 7's directive parser, keeping only the toggles.
3. Item 6's UI chips.
4. Item 9.

Never cut 1, 2, 3 or 5: they *are* the Track 2 story of a compounding memory with a measurable learning curve.

**Phase 2, before the first paying customer (Nov–Dec 2026).** An API-key `AgentRuntime` with `CostLine` metering and
the model-budget downshift; a Higgsfield API agreement with a no-training clause and `HiggsfieldEngine` with the
ledger; Paddle billing, plans, Wallet and renewal notices; delegated connections and the GBP Basic access application;
the Capability health monitor and Escalations; a Routine scheduler for the rhythm; WhatsApp and email delivery with
Delivery tracking; the Board with nudges; GBP reviews and replies; the DPA (GDPR Art. 28 terms, CCPA service-provider
terms, UAE PDPL and Australian Privacy Act clauses), the subprocessor list (Anthropic, Higgsfield, hosting, Paddle),
SCCs/IDTA and a transfer impact assessment; export and erase; the London region.

**Phase 3 (Q1 2027).** Meta App Review, then Instagram publishing and L2 autopilot; the templates graph with 5
verticals and the clinic and real-estate compliance packs; multi-location Pro; benchmarks; self-serve Essentials;
Partner/agency pricing; a US region; Xero and Google Workspace marketplaces.

---

## 10. Risks and open questions for the founder

**Top risks** (the critiques in the appendices cover the rest):
1. **The service trap.** Human minutes creep up, and margins fall to agency levels.
   - Mitigation: a minute budget per tenant, `Escalation.humanMinutes`, and a weekly review of escalation reasons that
     turns the top reason into a product fix.
2. **Platform gates.** These include GBP API approval, Meta App Review, the 100-user cap on unverified Google apps, and
   WhatsApp template approval.
   - Mitigation: the delegated-access and fallback ladder, and filing every application in month 1.
3. **Generative fidelity and advertising law** (ASA/CAP, FTC Section 5).
   - Mitigation: "enhance, never invent", masked edits on buildings, and Nisha's fail-closed gate.
4. **Cross-border data.** Staff access tenant data from India, which has no EU adequacy decision.
   - Mitigation: SCCs/IDTA, a transfer impact assessment, EU hosting, audit-logged access grants.
   - [A], to confirm with counsel: India's DPDP §17(1)(d) exempts foreign data processed under contract, except for its
     security duties.
5. **A cold-outbound trust discount** for an unknown team selling from India.
   - Mitigation: a personalised Brain Snapshot as proof of work, the 14-day refund, and partner introductions.
   - In the UK, use LinkedIn and Instagram DMs, because PECR covers cold email to sole traders
     ([ICO](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guide-to-pecr/)).
6. **Latency.** A live multi-agent run took 116 s in the agent worktree.
   - Mitigation: push over pull, single-desk plans by default, and streaming the work log so the wait is visible.

**Open questions:**
1. **Price points.** Approve Growth at $449 and Allevia 90 at $1,490, with $990 for the founding 20? Or stay closer to
   the $200 anchor (Essentials at $199 keeps that)?
2. **The first India hire.** A Growth Partner associate once there are about 8 paying tenants (Shift A)? And is the US
   async-only until Shift B is staffed?
3. **Beachhead and case study.** Architecture and interior studios in the UK and UAE? And may AVS be the public case
   study with real numbers?
4. **Entity and payments.** Paddle from the Indian entity (GST LUT, FIRA)? Or a US or UK entity for trust and for
   Stripe?
5. **Higgsfield.** Sign API terms with a no-training clause before the first customer, or use another provider? And
   approve up to $5 of live API renders for the demo, or replay fixtures only?
6. **Publishing.** Is "draft plus one-tap share" acceptable for the first customers, or should Meta App Review be filed
   now so auto-posting arrives in Phase 2?

---

## Appendix A: adversarial product critique

### A.1 The sceptical owner (a Dubai interior studio, 6 staff, three AI tools tried and dropped)
| Objection | What the analyses got wrong | Fix in this design |
|---|---|---|
| "Another subscription that needs me." | Setup was quoted at 15–60 min, and several analyses assumed the owner connects GA4, GBP and Meta. | The wizard asks for no connections; the Setup Desk delegates on a call in the owner's time zone. |
| "I paid upfront to a team in India I've never met." | Upfront money is right for the economics and wrong for trust unless risk is reversed. | 14-day refund, Day-30 delivery guarantee, a named Growth Partner, and a free Brain Snapshot *before* payment. |
| "Will it post something that embarrasses me?" | Only the studio analysis dealt with brand safety in depth. | Nothing leaves without a tap until autonomy is earned per format; fidelity checks; blocked categories; no automatic replies to reviews of 3★ or below. |
| "What happens when Instagram logs it out?" | Only the market-gap analysis designed for it (the fallback ladder). | §2.3: degrade visibly, never fail silently. |
| "Credits again?" | Five of six analyses rejected visible credits; the founder asked for them. | One unit, spent only on approval, never on questions, so Sintra's failure mode ("helpers stop working") cannot happen. |

### A.2 The investor
- **"Is this an agency with a chatbot?"** Program margin was quoted anywhere from 29% to 51%, and the retention
  analysis claimed 89% at $299 by leaving out human time and payments. Re-derived: 63% on the program and 76% on
  Growth. It stays software-like *only* if human minutes are budgeted and productized, so `Escalation.humanMinutes` is
  on the founder's dashboard from customer 1.
- **"What's the moat?"** Per-tenant graph memory, learned rules, evidence-checked answers, the done-for-you setup and
  compounding performance history. Real but slow, and defensible only if the first-pass curve visibly rises, which is
  why §9 item 3 is the most important build item.
- **"Why $449 when Sintra is $54–97?"** The comparison is a freelancer at $500–1,500 or an agency at $1,000–5,000
  ([whito](https://whito.co.uk/research/uk-social-media-management-costs/)), not a tool. The founding-cohort scorecards
  must prove it.

### A.3 Contradictions between the analyses, and how they were resolved
| Topic | The six analyses said | Decision and why |
|---|---|---|
| Program price | $1,100; $1,200; $1,200; $1,497 ($997 founding) | **$1,490, $990 founding.** The founder's ~$1k becomes the founding price. List needs at least 50% margin and $900+ to fund acquisition. |
| Main plan | $299; $349; $449; $549 | **$449.** It clears 70% margin with a named human. It is 1/15 of a US hire and a third to half of a freelancer. |
| Plan set | 2 to 4 tiers, different names | **Essentials, Growth, Pro, plus Pause.** Partner pricing is deferred, and fewer choices helps SMB buyers. |
| Visible unit | posts and reels; "pieces"; hidden "Sparks"; "no credits" | **Studio credits, spent on approval.** This honours the founder and avoids credit anxiety. Internal cost is USD `CostLine`s. |
| Entry | Self-serve Starter (pricing lens) vs. everyone through the program (three lenses) | **Program only at launch.** Upfront cash covers the churn-heavy first quarter and the human onboarding. Self-serve waits until onboarding is automated. |
| Guarantees | 7-day refund; D30 refund of the remainder; D30 full refund plus month 4 free | **14-day refund, D30 delivery guarantee, month 4 free on leading indicators** |
| Learning KPI | edit rate, first-draft acceptance, unedited acceptance, first-pass | **First-pass approval rate.** One name, from `Approval.firstPass`. |
| Autonomy thresholds | 80% over 20 items (L0–L2); 90% over 20 items (L0–L3) | **85% over 20, 0 failures, L0–L3,** with template ceilings |
| Goal edges | PURSUES, TRACKS, MEASURED_BY, ADVANCES, SERVES | **PURSUES, TRACKS, ADVANCES.** Synonyms were dropped. |
| Program model | Program, Plan{program_90}, Milestone, Checkpoint, Scorecard, Report | **Program and Checkpoint; reports are Documents.** The pricing lens's Scorecard stored numbers as props, which breaks spec §5.4. |
| Photos | `Asset` vs. `Document{kind:'photo'}` | **`Asset`.** Media need lineage (DERIVED_FROM); they are not text sources. |
| Ledger | Tenant graph vs. `allevia_meta` | **`allevia_meta`.** Erasure must keep tax records, and the LLM must never touch billing. Tenant graphs carry cost Observations. |
| Onboarding length | 15-min wizard; 20 min across 4 screens; a 45–60-min call | **15-min wizard plus an optional 30-min connect call** |
| Regions | One EU region vs. four region cells | **One EU (London) region now.** Add a US region at 50 US customers. |
| "1/20th" | "Don't claim"; "Starter only"; "Grow ≈ 1/19" | **"From 1/20th", anchored on Essentials, with the method published** |
| Higgsfield cost | Credits at $0.033–0.06 | **USD from the API.** Consumer credits are not a production path. |

### A.4 Weak or unbacked claims found
- **Time to first value.** "Time to first value under 24 h" and "70% unedited by D90" are targets, not evidence. Both are
  marked [A].
- **Benchmarks.** US-calibrated playbook norms (notfair) cannot be shown to UAE or Australian owners without a label
  and a country overlay.
- **Partner access.** "Meta partner access works under Standard Access" is unverified. It is treated as a risk with a
  fallback.
- **Agent SDK and images.** "The Agent SDK accepts image blocks on the subscription" is unverified. The Studio has the
  Read-tool fallback.
- **Media cost.** The pricing lens's $1.20 per post assumed 5 generations at consumer-credit prices. With a local
  variant A and one generative B, a post is about $0.50.

### A.5 What was missing
- **Abuse and brand safety:** blocked categories, fake reviews, rights to uploads, competitor claims, and prompt
  injection through images and documents. All are added in §6.11.
- **Refunds and chargebacks:** policy, plus the graph as dispute evidence (§4.5).
- **Auto-posting terms:** Instagram's 100 posts/24 h limit and App Review; TikTok and LinkedIn partner gates (§6.9).
- **CCPA:** service-provider contract terms in the DPA.
- **The UAE PDPL and the Australian Privacy Act:** Australia's small-business exemption may be removed by reform, so
  assume coverage.
- **Founder bandwidth:** one founder cannot sell, onboard and support beyond about 8 tenants. The first hire is an open
  question (§10).

### A.6 Hackathon scope risk
- **The slices don't fit.** The six lenses proposed 6–14 h slices each, about 65 h in total, against about 2.5 days in
  which M3–M6 are also unfinished.
- **What this design keeps.** About 20 h of glue that makes the judged story visible:
  - Company Brain: onboarding and customisation as graph context;
  - Agent Memory: the learning loop and scorecard;
  - Act on connected data: Studio lineage and approvals.
- **What it cuts:** billing, channels, schedulers, templates and benchmarks.

---

## Appendix B: the sceptical CFO

### B.1 Prices verified on 2026-10-15
- **Claude** ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)), per MTok:
  - **Sonnet 5.5:** $2 input, $10 output, $2.50 for a 5-minute cache write, and **$0.10 for a cache hit** (0.05×). The
    $0.20 figure in the cached skill table and in the pricing lens is stale.
  - **Haiku 5.5:** $0.10 input, $0.50 output and $0.01 for a cache hit, for prompts up to 100k tokens (5× above that).
  - **Opus 5.5:** $4 input and $20 output.
  - **Batch:** −50%.
  - **US-only inference:** 1.1×.
  - The newer tokenizer counts about 30% more tokens for the same text.
- **Higgsfield API** ([Higgsfield](https://higgsfield.ai/blog/higgsfield-api)):
  - bills USD from a prepaid balance, not credits;
  - Kling 3.0 from $0.112/s, Seedance 2.5 from $0.0738/s, and **Seedance 2.0 at $0.93/s**;
  - failed jobs are not charged, and output may be used commercially.
  - Per-image rates were not published in what we found.
  - Reference prices: Nano Banana Pro is
    [$0.134](https://tech-insider.org/how-to-use-nano-banana-pro-api-2026/) per 1K–2K image at Google's list price, and
    GPT Image 2 high at 1024×1536 is about
    [$0.165](https://docs.gmicloud.ai/model-quickstarts/image/gpt-image-2-generate.md).
  - Third-party reports put Seedance 2.5 at 720p with audio at about
    [$0.46/s](https://omidsaffari.com/blog/higgsfield-api-pricing).
- **Paddle:** 5% + $0.50, with about 1% FX on top according to a competitor's analysis (treat that with caution).
- **WhatsApp utility templates:** about $0.004 (US) to $0.017–0.029 (UK, UAE) per message, and free inside the 24-h
  service window ([setsmart](https://setsmart.io/blog/whatsapp-business-api-pricing); check against Meta's rate card).
- **India customer-success associate:** ₹5.5 lakh average base in Bangalore
  ([Payscale](https://www.payscale.com/research/IN/Job=Customer_Success_Associate/Salary/e3e14591/Bangalore)). At a
  1.3× load, 70% utilisation, a shift premium and lead overhead, that is about **$10/h effective** [A], at ₹88 to $1
  [A]. A mid-career strategist is about **$20/h** [A].

### B.2 Claude cost per active business
**Per model call.** A typical Sonnet call has 10k input tokens: 60% cache hits, 25% fresh and 15% cache writes. It
produces 700 output tokens, including thinking.

$0.0006 + $0.0050 + $0.0038 + $0.0070 = **$0.016**. Haiku is about 1/20 of that.

| Workload | Calls | Unit cost | Growth / month |
|---|---|---|---|
| Single-desk answer | about 6 Sonnet calls | $0.10 | — |
| Multi-agent answer (plan, 2 desks × 4, review, synthesis) | about 13 Sonnet calls plus Haiku reviews | $0.21 | — |
| Blended answer, +20% retries and revisions | — | $0.18 | 60 answers → $10.80 |
| Morning brief, daily | 3 Sonnet calls plus Haiku | $0.05 | $1.50 |
| Weekly growth review | multi-agent | $0.40 | $1.70 |
| Monthly report | — | $0.50 | $0.50 |
| Nightly extraction (Haiku, Batch) | — | — | $0.30 |
| Weekly learning pass (Sonnet) | — | $0.30 | $1.30 |
| **Total** | | | **$16 typical, $38 heavy** |

The lenses' estimates were $13, $30, $35 and $45. The lowest priced questions at $0.15 with no retries or review
rounds; the highest assumed 300 answers a month on a 500-answer allowance. Even with Claude spend doubled, Growth stays at 72.7%.

### B.3 Generation cost
| Piece | Cost basis | All-in |
|---|---|---|
| Post (1 credit) | A local at $0; B one generative edit at about $0.15; 15% retries; Claude vision, prompt and QA at about $0.10 | **≈ $0.50** |
| Carousel (2 credits) | 1 generative hero plus local frames | ≈ $0.90 |
| Reel ≤ 15 s (4 credits) | 15 s of Kling 3.0 at about $0.15/s × 1.5 attempts (≈ $3.40), cover and upscale (≈ $0.10), script and QA (≈ $0.15); keyframes reuse the approved still | **≈ $3.65** |
| Blended cost per credit used | 60% posts, 10% carousels, 30% reels (by credits) | ≈ $0.62, **budgeted at $0.65** |

A Growth tenant that spends all 50 credits on reels costs $45.60. Media is not the margin risk. Using the wrong video
model is (Seedance 2.0 costs 13× more), and the allowlist prevents it.

### B.4 Infrastructure
- FalkorDB is in-memory, at about 150 MB per tenant [A]. At 100 tenants that is about 15 GB of RAM: one 32 GB host plus
  a replica.
- Add app servers, workers, Playwright, object storage (R2 at about $0.015/GB, with no egress fees), backups and
  monitoring.
- That comes to about $600–800 a month at 100 tenants, or $6–8 per tenant. It is $15–30 per tenant below 30 tenants.
- FalkorDB Cloud at $73/GB-month would cost about $11 per tenant for the graph alone, so we self-host.

### B.5 Verdicts
| Offer | Typical GM | Heavy GM | Verdict |
|---|---|---|---|
| Essentials $199 | 77.9% | 70.5% | Positive |
| Growth $449 | 76.3% | 69.3% | Positive. The heavy case is capped by the model budget. |
| Pro $999 | 76.1% | 69.4% | Positive, provided strategist hours are capped at 2 a month |
| Pause $29 | 78.7% | 78.7% | Positive. The graph is snapshotted to disk and loaded on demand. |
| Allevia 90 $1,490 | 62.7% | 54.3% | Above the 50% target. Contribution $934. |
| Allevia 90 $990 (founding) | 47.1% | — | Below target by design: limited to 20 customers and booked as acquisition cost |
| Top-up, 20 credits for $59 | about 70% | — | Positive |

**What breaks the model, in order:**
1. Unbudgeted human time.
2. Selling Pro without capping strategist hours.
3. The wrong video model.
4. Running production on the founder's subscription. Anthropic's terms forbid it, so the API-key runtime with
   per-tenant metering is Phase 2's first item.

---

## Sources

Every source is linked inline where it is used. Unlinked figures are assumptions and are marked [A].
