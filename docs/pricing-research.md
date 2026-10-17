# Allevia pricing research and plan recommendation

Issue #45. Prices checked on **17 October 2026**. Research and one document: no product code was changed
(`shared/plans.ts` still holds the old plans; section 5 lists what would change).

Confidence tags used in every table: **[V]** read on the vendor's own page today; **[S]** from a third party (blog,
review, search summary) and not confirmed by the vendor; **[U]** unverified or the sources disagree; **[M]** measured
by us in this repo; **[E]** our estimate.

## 1. The answer in one screen

**Does the founder's $100 Starter work? Yes, at $99, if three things are true.** At typical use it earns about 64% gross
margin (80% light, 49% heavy). It earns nothing at heavy use unless a hidden model budget caps it (uncapped it is break-even).
It does not work at $49 to $79 (34% to 56% margin) with the full 13-person team and a daily note. It needs no image or
video generation, no human time after setup, and at least about 10 businesses to spread the fixed costs.

**Recommended plans** (USD, ex-tax; local prices from the 1 to 3 October FX in the product spec, re-check at launch):

| | **Starter** | **Growth** | **Pro** | **Scale** |
|---|---|---|---|---|
| Per month | **$99** / £75 / AED 369 / A$145 | **$249** / £189 / AED 919 / A$359 | **$499** / £379 / AED 1,839 / A$719 | **from $999** / £749 / AED 3,669 / A$1,449 |
| Per year (2 months free) | $990 / £750 / AED 3,690 / A$1,450 | $2,490 / £1,890 / AED 9,190 / A$3,590 | $4,990 / £3,790 / AED 18,390 / A$7,190 | with a call |
| The team, the brain, every connection | yes | yes | yes | yes |
| Questions a month (fair use) | 100 | 300 | 800 | 1,500 |
| Studio credits a month (photo to premium ad, AI backgrounds, short clips) | **none** | 40 | 120 | 200 |
| Posting after OK, Sales booking, website check-up, daily note | yes | yes | yes | yes |
| Seats / locations | 2 / 1 | 5 / 1 | 15 / 3 | 25 / 5 |
| Setup | self-serve, optional 20-minute connect call | 45-minute setup call | setup call + 1 hour a month with a strategist | setup + 2 hours a month |
| Gross margin: light / typical / heavy (capped) | 80% / **64%** / 49% | 84% / **71%** / 50% | 83% / **67%** / 45% | 84% / **69%** / 49% |
| Less than | 1.3 to 2.8 hours of a mid-level US freelancer | 3 to 7 hours | 7 to 14 hours | |

Also: a **free Brain Snapshot** (no card, about $2 to $4 to us) before anyone pays; a **14-day money-back guarantee**
instead of a free trial on connected accounts; **Pause $29** kept as the cancel-save, not shown on the pricing page;
**Allevia 90** ($1,490, $990 founding) kept as the optional done-with-you start. Retire **Essentials ($199)**: Starter
replaces it as the entry and Growth takes its place at the top of the creative tier.

The three things that matter most: (1) the hidden model budget is what makes $99 safe, (2) we have never been billed for
model use (we run on a subscription), so the cost numbers are list prices times measured tokens, and the first paying
customers must run on the API with per-business metering, and (3) Starter without pictures has to win on numbers,
decisions and follow-ups, because the cheap competitors lead with content.

## 2. Competitors and comparables

### 2.1 AI employees and AI team products

| Product | What it sells | Price (USD) | Included and limits | Images and video | Tag |
|---|---|---|---|---|---|
| [Sintra](https://sintra.ai/pricing) | 12 role "helpers" (social, SEO, copywriter, support, sales) | "Sintra X": $48.50 a month on 1 month (struck-through $97), $23.60 on 3 months, $15.60 on 12 months ($187.20 a year); one helper alone $39 a month | 250 credits a month, 15+ integrations (the page also says 1000+ tools), 14-day money-back; fair-use policy not shown | An "Image generation" row exists, no quota given; video not mentioned | [V] |
| [Kylon](https://www.kylon.io/pricing) | A shared workspace for people and agents | Core $50 / $100 / $200 / $400 / $600 / $800 a month for 500 / 1,000 / 2,000 / 4,000 / 6,000 / 8,000 credits (+10% bonus credits); Pro and Ultra "talk to sales" | Up to 10 agents, 3,000+ integrations, no per-seat price; 7-day trial with 300 credits; at zero credits agents and workflows pause; a credit's worth in tasks is not stated | Not a focus | [V] |
| [Marblism](https://www.marblism.com/pricing) | 7 AI employees (assistant, social, leads, SEO, receptionist, website, legal) | One plan: $44 a month, or $24 a month yearly | 50 work hours a month (only "advanced AI actions" use hours), unlimited businesses and members; the page gives two refund windows (7-day and 77-day) | "Creates on-brand photos and videos", no quota | [V] |
| [Lindy](https://www.lindy.ai/pricing) | General AI agents with approvals for outside actions | Free ($50 credits for 7 days); Team from $29.99 a month for 3,000 credits, up to $99.99 for 15,000, up to $9,999.50 for 1,750,000; top-up $10 per 1,000 credits | Per active user, credits pooled; 1,500+ integrations; credits do not roll over; typical asks 2 to 250 credits, research 250 to 1,000, big builds 1,000 to 2,500 | Not a focus | [V] |
| [Relevance AI](https://relevanceai.com/pricing) | Build-your-own agent workforce | The public page now shows only Enterprise, "Talk to sales". Reported: Pro $19 (yearly) or $29, Team $234 or $349, extra actions $80 per 1,000 ([Macha](https://www.getmacha.com/blog/relevance-ai-pricing-explained), Sept 2026) | Reported 2,500 and 7,000 actions plus vendor credits | Not a focus | [V] page, [U] prices |
| [Gumloop](https://www.gumloop.com/pricing) | Workflow and agent builder | The page text could not be read. Reported: free about 2,000 credits; Solo about $37; Team about $244 ([Lindy's comparison](https://www.lindy.ai/blog/gumloop-pricing)) | Reports disagree about the plan names | Not a focus | [U] |
| [Motion](https://www.usemotion.com/pricing) | Planner with AI employees | The page lists Pro AI $19 and Business AI $29 per seat, both marked "This plan is not available". Reports of an "AI Employees" tier disagree ($49; $99 for 3 seats; $148 or $446 per user) ([Usecarly](https://www.usecarly.com/blog/motion-pricing/), [Capterra](https://www.capterra.ca/software/214264/motion)) | 7,500 or 15,000 credits per seat | No | [U] |
| Artisan (Ava, outbound sales rep) | Sales-led AI BDR | No public list. Reported: about $250 a month (yearly) to about $600 to $660, enterprise $10,000+ a month ([11x's comparison](https://www.11x.ai/guides/artisan-pricing), a rival) | Credits tied to outreach volume | No | [U] |
| 11x (Alice, outbound sales rep) | Sales-led digital workers | Reported from $3,750 a month billed yearly ($36,000 to $45,000), median about $55,050 a year ([Landbase](https://www.landbase.com/blog/11x-ai-pricing), [MarketBetter](https://marketbetter.ai/blog/11x-ai-pricing-2026/)) | Annual contracts | No | [S] |
| [Ema](https://www.ema.ai/pricing) | Enterprise agent platform | Not published, demo only | n/a | n/a | [V] |

### 2.2 General-purpose AI at work

| Product | Price (USD) | Included and limits | Tag |
|---|---|---|---|
| [ChatGPT Business](https://openai.com/business/chatgpt-pricing/) | $25 per user a month, $20 yearly, 2-seat minimum (after a $5 cut in April 2026) ([eesel, 12 July 2026](https://www.eesel.ai/blog/chatgpt-work-pricing)) | Agent mode, connectors (Microsoft 365, Drive, Slack, GitHub, Linear, Figma); no figures for limits. The official page returned 403 | [S] |
| Microsoft 365 Copilot Business | $18 per user a month on a yearly plan (a promotion; $21 list), $25.20 month to month; needs a Business plan; up to 300 users ([Office Watch](https://office-watch.com/2025/microsoft-365-copilot-business-ai-add-on/), [Primend](https://www.primend.com/news/m365-copilot-business-licenses-for-small-and-mid-sized-businesses/)). The official page timed out | Sources disagree on when the promotion ended | [U] |
| [HubSpot Marketing Hub](https://www.hubspot.com/pricing/marketing) | Starter $20 a seat monthly or $7 yearly; Professional $890 a month ($800 yearly) with 3 seats and a $3,000 onboarding fee; Enterprise $3,600 | HubSpot Credits cost $0.01 each, 500 / 3,000 / 5,000 included a month, no rollover. Starter's monthly and yearly labels are our reading of the page | [V] |
| [HubSpot Breeze agents](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete) | Customer Agent $0.50 per resolved conversation (50 credits); Prospecting Agent $1 per lead recommended (100 credits), since 14 April 2026 | The only competitor here that prices by outcome | [V] |

### 2.3 AI marketing and creative tools

| Product | Price (USD) | What it includes | Tag |
|---|---|---|---|
| [Jasper](https://www.jasper.ai/pricing) | Pro $69 a seat monthly, $59 yearly; Business custom | 1 seat, 2 brand voices, 5 knowledge assets, image generation on paid plans; credits only on Business | [V] |
| [Copy.ai](https://www.copy.ai/prices) | Chat $29 ($24 yearly), 5 seats; Growth $1,000 a month billed $12,000 a year, 75 seats, 20K workflow credits; Expansion $2,000; Scale $3,000 | Sales and marketing workflows | [V] |
| [Predis.ai](https://predis.ai/pricing/) | Core $19 ($230 a year), Rise $40 ($474), Enterprise+ $212 ($2,540); the page shows struck-through earlier prices ($32, $79, $249) | 1,300 / 3,200 / 10,000 credits, about 325 / 800 / 2,500 images or 33 / 80 / 250 videos; auto-posting from Rise; 3-day trial with a card | [V] |
| [Ocoya](https://www.ocoya.com/pricing) | Starter $29, Team $79, Agency $199 a month; yearly "2 months free" | 300 / 1,500 / 5,000 credits, 5 / 20 / 100 social profiles, 1 / 5 / 20 users; 7-day trial with a card | [V] |
| [Pencil](https://www.trypencil.com/pricing) | Core $14 ($11 yearly), Growth $55 ($44 yearly), Pro custom | 50 / 250 / unlimited generations; ad launch and tracking | [V] |
| AdCreative.ai | Reported Starter $39 ($20 yearly), Professional $249, Ultimate $300 to $999 ([search summary of Hackceleration, Dupple, others](https://www.hackceleration.com/labs/adcreativeai-pricing)); the official page returned 404 | A credit is spent on a download, not a preview; video only on the $249 tier | [U] |

### 2.4 The human alternative

| Option | US | UK | UAE | Australia | Tag |
|---|---|---|---|---|---|
| Freelance social or marketing retainer, basic | $750 to $1,500 a month | £500 to £1,500 for a small business | AED 2,500 to 6,000 | A$1,000 to 2,500 | [S] |
| Standard retainer (more channels, video, reporting) | $1,500 to $3,000 | £800 to £2,500 social; £1,500 to £3,000 for a £500k to £2m turnover | AED 5,000 to 15,000 | A$2,500 to 5,000 | [S] |
| Premium or full service | $3,000 to $7,000+ | £3,500 to £16,750 | AED 7,000 to 50,000 | A$5,000 to 8,000+ | [S] |
| Hourly, mid-level freelancer | $35 to $75 | n/a | n/a | A$38 to 65 | [S] |
| Virtual assistant | $22.84 an hour ([Indeed](https://www.indeed.com/career/virtual-assistant/salaries), 10 Oct 2026), so about $1,990 for 20 hours a week; US agencies such as Belay $1,500 to $3,000 a month part-time | $19 to $38 an hour (as listed) | n/a | $18 to $35 an hour (as listed) | [V] Indeed, [S] rest |

Sources: US, [SolidGigs via MySocial](https://mysocial.io/blog/social-media-management-pricing-guide/) (updated Sept 2026) and
[VA Masters](https://vamasters.com/how-much-does-a-virtual-assistant-cost/) (June 2026); UK, [Whito agency retainers](https://www.whito.co.uk/research/uk-agency-retainers/)
(data May to Sept 2026, ex-VAT, ex-ad spend); UAE, [Digital Gravity](https://www.digitalgravity.ae/blog/how-much-does-a-digital-marketing-agency-cost-in-dubai/)
(16 June 2026, whose "Starter" full-service tier is AED 2,000 to 7,000); Australia, [Expert360](https://expert360.com/freelance/social-media-managers)
(indicative, set by the experts themselves). All are agencies and marketplaces describing their own market, so read them as
a range, not a quote. A loaded US social media manager hire is about $6,681 a month (Indeed $64,139 times 1.25, from
the product spec, not re-checked today).

### 2.5 What this tells us

1. **Self-serve AI-team tools sit at $15 to $100 a month.** Sintra, Marblism, Lindy Team and Kylon Core define what a
   small owner expects to pay. Sintra's list price is $97; the $15.60 is a 12-month promotion. Allevia at $99 is the
   top of this band, level with Kylon's $100 tier and Lindy's $99.99 bundle.
2. **A sales-led "digital worker" costs $3,000 to $5,000 a month** (11x, Artisan, Copy.ai Growth at $1,000). That is a
   different buyer, but it shows a business pays four figures when the work is an outcome.
3. **Creative generation is a commodity under $60 a month** (Predis $19 to $40 for about 325 to 800 images; Pencil $14 to
   $55 for 50 to 250 generations; Ocoya $29 for 300 credits). Our creative tier is a premium over that, so it has to sell on brand-aware, checked output that is posted after an OK, not on
   volume of images.
4. **Credits that stop the work are the complaint pattern** (Kylon agents pause at zero; Lindy actions pause). Our rule
   stays: questions and approvals are never metered visibly, and creative credits are spent only on approval.
5. **Prices are moving.** HubSpot, ChatGPT, Copilot and Composio changed or promoted prices between April and October
   2026, and Predis and Sintra show struck-through earlier prices. Re-check this document at launch.
6. **The human comparison is the strongest story.** Starter is 2.5% to 15% of a basic freelance retainer in all four
   markets; section 4.5.

## 3. Cost to serve

### 3.1 Unit prices we pay

| Input | Price | Source | Tag |
|---|---|---|---|
| Claude Sonnet 5.5 | $2 input, $10 output, $2.50 cache write (5 minutes), $0.10 cache hit, per million tokens | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) | [V] |
| Claude Haiku 5.5 | $0.10 / $0.50, cache hit $0.01 (prompts up to 100K tokens; 5x above) | same | [V] |
| Claude Opus 5.5 | $4 / $20 | same | [V] |
| Claude extras | Batch API is half price; US-only inference is 1.1x | same | [V] |
| Composio | Free (Hobby): 100,000 tool calls a month, then it pauses. Pro: $29 a month with a $29 usage credit, $0.0003 a call beyond 100,000; connected accounts free on our own apps; on its managed apps the first 1,000 accounts free, then $0.10 each once | [Composio](https://composio.dev/pricing) | [V] |
| Composio, later changes | One report says Premium tools move to provider cost plus 5%; another says a repricing announced for 15 August only partly shipped | [UsagePricing](https://usagepricing.com/blueprint/activity/composio-2026-08-25-packaging), [Scalekit](https://www.scalekit.com/blog/composio-pricing-change) | [U] |
| Apify | Free $5 a month of usage; Starter $19; Scale $199 (compute $0.20 a unit on Free and Starter, $0.16 on Scale) | [Apify](https://apify.com/pricing) | [V] |
| Apify, our own cap | `ALLEVIA_APIFY_MONTHLY_USD=2` per business per month; actors cost about $0.01 to $0.40 per lookup | `docs/apify-setup.md` | [M] |
| Higgsfield API | Prepaid USD balance; Kling 3.0 from $0.112 a second; failed jobs are not charged; output usable commercially | [Higgsfield](https://higgsfield.ai/blog/higgsfield-api) | [V] |
| Higgsfield consumer plans | $0.03 to $0.075 a credit; the sources disagree on plan prices | [Creatify](https://creatify.ai/blog/higgsfield-pricing-(2026)-plans-and-what-you-ll-actually-pay), [Luma](https://lumalabs.ai/news/higgsfield-pricing) | [U] |
| Direct image APIs | Nano Banana 2 $0.08 (1K) and $0.12 (2K) a picture, GPT Image 2 $0.0078 (low), $0.066 (medium), $0.264 (high) at 1024x1024, measured 8 Sept 2026 | [Segmind](https://blog.segmind.com/ai-image-gen-pricing-compared-nano-banana-2-vs-seedream-5-0-vs-gpt-image-2-2026/) | [S] |
| FalkorDB Cloud | Startup from $73 a month for 1 GB; Pro from $350 for 8 GB with high availability | [FalkorDB](https://www.falkordb.com/pricing/) | [V] |
| AWS | `t4g.large` (8 GB) about $0.067 an hour, so about $49 a month, in an unlabelled region (Mumbai was not shown); the server has an $80 monthly budget alert | [Vantage](https://instances.vantage.sh/aws/ec2/t4g.large), `allevia-ec2-server` memory note | [S] |
| Paddle (merchant of record) | 5% + $0.50 a transaction, no extra fee listed; we add 1% for currency and 0.5% for refunds and chargebacks | [Paddle](https://www.paddle.com/pricing) | [V], the 1.5% is [E] |
| Discord | Free (one hub server, the bot is ours) | `docs/discord-hub-setup.md` | [M] |
| Human help | $10 an hour (associate) and $15 to $20 (strategist), fully loaded | product spec, Appendix B.1 | [E] |

### 3.2 What we measured ourselves

**Tokens per answer** (`docs/graph-audit.md`, benchmark of 17 October, on the subscription, real Agent SDK usage numbers):
a question to the whole team read 68,383 to 250,403 tokens (median about 110,000; 3 to 19 tool calls). One agent with the
graph tools read 35,450 to 57,521. Stuffing the whole vault into a prompt read 300,000 per question on the real business.
At the Anthropic prices above and a cache mix of 60% hits, 25% fresh and 15% writes (with 7% of the reading as output),
a million tokens read costs about **$1.64**, so:

| Kind of answer | Tokens read | Cost at list price |
|---|---|---|
| One agent (solo) | 35,000 to 58,000 | $0.06 to $0.09 |
| The team, cheap end | 68,000 | $0.11 |
| The team, median | 110,000 | $0.18 |
| The team, expensive end | 250,000 | $0.41 |
| The team, median, no cache hits at all and 5K output | 110,000 | $0.27 |

This agrees with the spec's $0.18 blended answer. **The model bill has never been paid:** these are list prices times
measured tokens under an assumed cache mix, so [M] for tokens and [E] for dollars. `Turn.tokensIn`, `tokensOut` and
`modelCalls` are saved on every turn now, so a business's real cost per answer will be one Cypher query once it runs on
an API key.

**Creative cost per output** (`docs/higgsfield-spend.md`, credits as quoted before each job). A credit is worth about
**$0.075** on the API path: Kling 3.0 at $0.112 a second for 5 seconds is $0.56, which is exactly our 7.5 credits; and a
GPT Image 2 high 1K picture measured at $0.264 is our 3.5 credits. The consumer-plan rate of $0.03 to $0.05 is not our
production path (the spec rules it out because of the licence on uploaded client photos).

| Output (our ledger) | Credits | At $0.075 |
|---|---|---|
| Poster artwork, 2 options (`nano_banana_2_1` 1K x 2) | 3 | $0.22 |
| Photo clean-up edit (`nano_banana_2_1` 2K) | 2 | $0.15 |
| Premium ad picture (`gpt_image_2` 2K via product-photoshoot) | 6.5 (3.5 at 1K) | $0.49 ($0.26) |
| 5-second clip (`seedance_2_0_mini` 720p) | 5 | $0.38 |
| 5-second clip (`kling3_0` standard) | 7.5 | $0.56 |
| Premium ad picture plus its clip (the live check, issue #38) | 11.5 | $0.86 |
| 15-second reel, three mini clips and music | about 16 | $1.20 |
| 15-second reel, three Kling clips and music | about 23.5 | $1.76 |

Held-back results cost the same as passed ones: in the live check 2 of 5 generations were held back by Nisha and one was
retried. We charge the owner a credit only on approval, so we carry a **waste factor of about 1.5**. With that and
$0.15 to $0.30 of Claude vision and checking per piece, one Studio credit costs us about **$0.35 (light), $0.50
(typical) and $0.75 (heavy, reel-heavy)** [E]. The spec budgeted $0.65. Going direct to Google or OpenAI for pictures
(Nano Banana 2 at $0.08 and $0.12) would be roughly a quarter cheaper than the same pictures through Higgsfield's
credits, at the price of more code to maintain.

**Graph size** (`docs/falkordb-cloud.md`, `docs/graph-audit.md`). Today: the real business Aamdani has 3,799 nodes and
11,897 edges, about 21 MB of server memory (11 MB by `GRAPH.MEMORY USAGE`); AVS Atelier 471 nodes, 2,021 edges, about
2 MB; the demo 281 nodes. The spec assumed 150 MB a business. That is too high for month one (7x to 25x) but it is not
a bad number for month twelve: one day of use added 283 nodes and 4,911 edges to Aamdani (+41% edges, mostly `TOUCHED`
and `CITED`, the memory of its own work), though that day included the audit's own test runs. Plan for **6 to 20 MB at
onboarding and 100 to 150 MB at month twelve** [E]. Self-hosted on one 8 GB server that holds about 30 to 50 mature
businesses, so $1 to $3 each; FalkorDB Cloud at $73 a GB would be about $5 to $11 each. Old `TOUCHED` edges are the
obvious thing to archive if memory grows faster.

**Composio calls.** The daily note runs once a business-morning; the Sales reads are on demand. We have no real
Composio traffic yet (no account is connected, `docs/graph-audit.md` G6), so calls a month are [E]: about 800 light,
2,500 typical, 8,000 heavy on Starter. Even at the overage rate of $0.0003 that is $0.24 to $2.40. The free plan's 100,000 calls cover about 40 typical
businesses; Pro ($29, then $0.0003 a call) is what stops it pausing at the cap.

### 3.3 Usage profiles and the model bill per plan

| A month of... | Light | Typical | Heavy |
|---|---|---|---|
| Starter: questions | 10 | 40 | 150 |
| Starter: daily notes with drafts | 22 (weekdays) | 30 | 30 |
| Starter: new enquiries read by Sales | 5 | 15 | 60 |
| Starter: drafts made for approval | 8 | 20 | 60 |
| Starter: model bill, at list price | $8.12 | $21.10 | $78.20 |
| Growth: questions / model bill | 25 / $11.71 | 80 / $31.90 | 250 / $116.30 |
| Pro: questions / model bill | 60 / $27.40 | 200 / $63.90 | 600 / $249.80 |
| Scale: model bill | $45 | $113 | $360+ |

Unit costs behind these (answer $0.10 to $0.40 from 3.2; daily note $0.15 to $0.50; a Sales enquiry $0.06 to $0.12; a
draft $0.04 to $0.08; weekly review $0.30 to $0.80; monthly report and check-up $0.80 to $2; nightly extraction and
learning $1 to $2.50) follow the spec's Appendix B.2. **The daily note, Sales and draft unit costs are estimates:** no
token log exists for them yet. A heavy Starter owner would cost $78 in model use alone, which is why the cap exists.

**The hidden model budget** (never shown to the owner, as in the spec): Starter $30, Growth $60, Pro $110, Scale $200 a
month. At the cap the team switches to Haiku-first and one desk per answer, answers stay available, and ops is alerted
at 150%. Other levers that need no new product: Haiku 5.5 for single-desk answers (about a twentieth of the cost),
Batch (half price) for the nightly extraction, weekly review and monthly report, a stand-up that skips weekends and
drops to twice a week when the owner has not opened it for 7 days, and a cache layout with the shared prefix first.
Together these are worth about 30% of the Starter model bill [E].

### 3.4 Result: cost and margin per business per month (at 50 or more businesses)

Typical month, every line in USD:

| | Starter $99 | Growth $249 | Pro $499 | Scale $999 |
|---|---|---|---|---|
| Model | 21.10 | 31.90 | 63.90 | 113.00 |
| Studio (credits used x all-in cost) | 0 | 14.00 (28 x $0.50) | 42.00 (84 x $0.50) | 70.00 (140 x $0.50) |
| Composio (calls) | 0.75 | 1.35 | 2.70 | 4.50 |
| Apify | 0.80 | 1.20 | 1.60 | 2.00 |
| Infrastructure (FalkorDB, AWS, Composio base) | 4.00 | 4.00 | 4.00 | 4.00 |
| Human (10 / 20 / 60 / 150 minutes) | 1.67 | 3.33 | 15.00 | 50.00 |
| Misc (email, monitoring) | 0.50 | 0.50 | 0.50 | 0.50 |
| Payments (6.5% + $0.50) | 6.94 | 16.69 | 32.94 | 65.43 |
| **Cost to serve** | **35.76** | **72.97** | **162.64** | **309.43** |
| **Gross margin** | **63.9%** | **70.7%** | **67.4%** | **69.0%** |
| Contribution per month | $63 | $176 | $336 | $690 |

| Gross margin | Light | Typical | Heavy, model capped | Heavy, no cap |
|---|---|---|---|---|
| Starter $99 | 79.8% ($19.99) | 63.9% | 48.7% ($50.84) | 0.0% ($99.04) |
| Growth $249 | 84.4% ($38.78) | 70.7% | 49.5% ($125.72) | 26.9% |
| Pro $499 | 82.7% ($86.44) | 67.4% | 44.5% ($276.94) | 16.5% |
| Scale $999 | 84.1% ($158.70) | 69.0% | 48.6% ($513.90) | not run |

Paid yearly (10 months for 12), margin at typical use is Starter 58.5%, Growth 66.4%, Pro 62.3%: the discount costs
about five points, and one card payment a year saves some of the fee.

**What moves Starter's margin** (typical month):

| Change | Margin |
|---|---|
| Price $49 / $79 / $99 / $129 | 33.7% / 56.4% / 63.9% / 70.8% |
| Price that gives 60% / 70% | $88 / $125 |
| Fewer than 100 businesses: 5 / 10 / 25 / 50 / 100 businesses (infrastructure $25 / $14 / $7 / $4 / $3 each) | 42.7% / 53.8% / 60.9% / 63.9% / 64.9% |
| The model levers in 3.3 (-32% model) | 70.7% |
| Real cost per answer is double our estimate (the cap bites at typical use) | about 55% |

**Fixed monthly costs** (before any salary): Composio Pro $29, one `t4g.large` about $50 plus disk, snapshots and an
Elastic IP (the budget alert is $80), Apify $0 to $19, domain, email and monitoring $50 to $100, and if we read Gmail
inboxes a CASA security assessment of about $540 to $6,000 a year (`docs/connections-design.md` section 4). Call it
$250 to $450 a month, or up to about $950 with the dearest assessment. **About 6 Starter customers cover the middle
figure, and 15 cover the worst.**

**Lifetime value** at an assumed 4% monthly churn [E, the spec used 3.5%]: Starter about $1,600 of contribution, Growth
about $4,400, Pro about $8,400. At 3:1 that supports roughly $500 to spend to win a Starter customer, so a free Snapshot
that costs $3 is very cheap.

## 4. Recommendation

### 4.1 Plans and what each includes

Every plan has the whole team (all 13 people, all departments) and the company brain. We gate **volume, creative, seats,
locations and human time**, as the spec already decided; we do not gate connections, because a connection costs us
well under a cent a day.

**Starter, $99 a month** (£75, AED 369, A$145; $990 a year). For the owner who wants the numbers, the decisions and
the follow-ups taken off their plate.
- Every connection the owner uses (Google: Gmail, Calendar, Search Console, GA4, Business Profile, Google Ads; Meta:
  Instagram, Facebook Page, Meta Ads; Shopify, Stripe, HubSpot and the rest of Composio's list), read-only until the
  owner approves an action.
- The team's advice and answers: 100 questions a month (fair use, with the hidden $30 model budget).
- Today's note with the proactive stand-up and its drafts; approvals on the web and in Discord, with no limit.
- Sales: reads new enquiries, drafts the reply with three real times, books the call and sends the invite after the OK,
  reminds and follows up.
- The website check-up once a month (and on request), the growth plan with its three goals, the growth story of the brain.
- Posting to the owner's own Instagram, Facebook Page and LinkedIn after the OK, using the owner's own photos and words
  with layouts set by code from the brand kit (no generated pictures).
- 2 seats, 1 location. Setup: a 15-minute guided connect in the app and an optional 20-minute call.
- **Not included:** AI image and video generation (photo to premium ad, AI poster backgrounds, clips) and human strategist time.
- Optional: Studio credit packs, 20 for $59 (£45, AED 219, A$85). This turns "can't" into "pay for what you use", and a
  pack earns about 67% to 81% after payments (our cost $0.35 to $0.75 a credit).

**Growth, $249 a month** (£189, AED 919, A$359; $2,490 a year). Starter plus pictures.
- **40 Studio credits a month**: a post 1, a carousel 2, a shoot from one phone photo 3, a reel 4. That is about 20 posts, 3
  carousels, 2 shoots and 2 reels. Spent only on approval; unused credits roll over for one month; a task can borrow
  up to 20% of next month's.
- 300 questions a month (hidden $60 model budget), 5 seats, 1 location, a 45-minute setup call, a monthly report,
  WhatsApp delivery when it ships.

**Pro, $499 a month** (£379, AED 1,839, A$719; $4,990 a year). For volume and a person on our side.
- 120 credits a month, 800 questions (hidden $110), 15 seats, 3 locations.
- A strategist: 1 hour a month plus a monthly call, a 4-business-hour response, a setup call.
- Ads changes carried out after the OK once that ships (Phase 3), and the EU/UK data-residency addendum.

**Scale, from $999 a month** (£749, AED 3,669, A$1,449; with a call). Multi-location, regulated work, or "run it with me".
- 200 credits, 1,500 questions (hidden $200), 25 seats, 5 locations, 2 strategist hours a month, a named person.
- This is the old Pro ($999) unchanged in substance. It is quoted after a call, not bought on the page.

**Also kept**
- **Pause, $29** (£22, AED 109, A$42): the brain kept, a weekly brief and review alerts, 10 questions. Offered once
  when someone cancels.
- **Allevia 90, $1,490** (3 x $529; $990 for the first 20): the done-with-you start, 90 days at Growth-level allowances
  with strategist reviews and the three guarantees. Margin is still about 63% to 65% (setup human time $250, plus
  payments) with the cheaper Growth. Whether to lead with it now that a self-serve Starter exists is the founder's call.
- **Retire Essentials ($199).** Starter is the entry; a graduate on a budget takes Starter.

### 4.2 Free Brain Snapshot and the trial

- **Brain Snapshot, free, no card.** The owner gives a website and an email. We build a temporary brain from the public
  site and public data (Google listing, public Instagram, up to 3 rivals' ads), run the website check-up, and send a
  short page: what we found, 3 findings with their sources, and what the team would do this week. No connection, no
  posting, no generation (one sample poster can be laid out by code for about $0.10).
- **Cost to us: about $2 to $4** (model $1 to $3, Apify up to $1 with a per-snapshot cap, the graph kept for 14 days then dropped).
  At 15% to 25% converting that is $10 to $25 per paying customer, against a $500 ceiling.
- **Guardrails** so it cannot be farmed: one per domain, a verified email, a hard $3 cap each, and a daily cap of about
  20 across the product.
- **No free trial of connected accounts.** Instead a **14-day money-back guarantee** on monthly Starter and Growth (the
  spec's policy). A trial would spend $36 to $73 of real cost on someone who may never connect a tool, and connected
  accounts are the sensitive part. Annual plans get a pro-rata refund within 30 days. Competitors: Sintra 14 days
  money-back, Marblism 7, Kylon a 7-day trial with 300 credits, Lindy $50 of credits for 7 days.
- **Annual: 2 months free on every paid plan.** Cash up front and lower churn, for about five points of margin.
- **Optional founding offer** (first 20): Starter $79 and Growth $199, locked for 12 months. Margin at typical use is
  56% and 65%. Treat it as acquisition cost, as the spec treated its $990 program.

### 4.3 Does the $100 Starter work? The honest answer

**Yes, at $99.** Typical margin 64%, light 80%. Contribution of $63 a month pays the fixed costs at 6 to 15 customers.

**It works only because of these conditions, and each can fail:**
1. **The hidden model budget.** Without it a heavy owner costs $99, so margin is zero. With a $30 cap the worst month is
   49%. Cap, downshift, and alert; never let it be unlimited.
2. **No human after setup.** Ten minutes of support a month is already $1.67. A customer who needs a person moves to
   Growth, which has a setup call, or Pro. Track human minutes per customer from the first one.
3. **No generation.** One premium ad plus clip costs us about $0.86 raw and $1.30 to $1.60 with waste and checking, so ten a
   month would cost $13 to $16, up to a sixth of the Starter price. Creative is Growth's job.
4. **Scale.** At 5 businesses the margin is 43%, at 10 it is 54%. It is still positive, but the first customers carry
   the fixed costs.
5. **Cheaper prices do not work.** At $79 the margin is 56%, at $49 it is 34%. A $49 plan competing with Sintra's
   promotions would lose money on every busy owner.

**The commercial risk is not margin but comparison.** Sintra at $15.60 to $48.50 and Marblism at $24 to $44 lead with
content and pictures, and they are where a cost-conscious owner will look first. Starter at $99 with no pictures asks
two to six times more, so it has to be sold on what those pages do not describe: the owner's own numbers from
Google, Meta, Shopify and Stripe, a brain with sources for every claim, Sales that books the call, and approvals before
anything goes out. The Brain Snapshot is the proof. We have not tested this with a buyer. A reasonable test is $99 against
$129 in the first 20 sales conversations (at $129 the margin would be 71%).

### 4.4 Where the two ladders differ from the spec

The product spec (15 October) had Essentials $199, Growth $449 (with a named Growth Partner), Pro $999 and a
program-only launch. This recommendation changes four things, because the founder's direction on 16 and 17 October is a
self-serve Founder OS:
1. A $99 self-serve entry with no creative and no human.
2. Growth drops from $449 to $249, because the named human moves up to Pro. The $449 step from a $99 plan would have
   been a 4.5x cliff.
3. Pro is new at $499, and the old Pro becomes Scale.
4. The program is optional rather than the only way in.

### 4.5 How it compares: "less than a part-time marketer"

| Allevia plan | vs the human alternative | Ratio |
|---|---|---|
| Starter $99 | A basic US freelance retainer ($750 to $1,500); a part-time US virtual assistant (about $1,990 for 20 hours a week at $22.84) | 7% to 13% of the retainer; 5% of the assistant |
| Starter £75 | A UK small-business retainer (£500 to £1,500); social at £800 to £2,500 | 5% to 15%; 3% to 9% |
| Starter AED 369 | UAE social management (AED 2,500 to 15,000) | 2.5% to 15% |
| Starter A$145 | An Australian basic retainer (A$1,000 to 2,500) | 6% to 15% |
| Growth $249 | $750 to $3,000 | 8% to 33% |
| Growth A$359 | A$1,000 to 5,000 | 7% to 36% |
| Pro $499 | A standard US retainer ($1,500 to $3,000) | 17% to 33% |
| Pro A$719 | A standard Australian retainer (A$2,500 to 5,000) | 14% to 29% |
| Starter, in hours | A mid-level US freelancer at $35 to $75 an hour | 1.3 to 2.8 hours |

Against a loaded full-time US social media manager ($6,681), Starter is 1/67, Growth 1/27 and Pro 1/13. The spec's
"from 1/20th" claim therefore holds from Growth down. **Say what the comparison is not**: a person shoots the
photographs, goes to the site and talks to customers; Allevia does the analysis, the drafting, the follow-ups and the
checking. The sources above are agencies describing their own market, so quote them as "typically", with the method
published on the pricing page, as the spec commits (FTC and ASA both ask for substantiation).

**Against the AI tools**: Starter is level with Kylon's $100 tier and Lindy's $99.99 bundle, 2 to 6 times Sintra and
Marblism, 4 to 5 times a ChatGPT Business or Copilot seat, and the only one of these that keeps a per-business graph with
the source and date of every fact (as far as their public pages say; we have not used their products). Growth at $249
sits between Ocoya's Agency plan ($199) and a Copy.ai team ($1,000) with the posting and the approvals included.

### 4.6 Currencies and tax

FX of 1 to 3 October 2026 from the product spec (`$1 = £0.755 = AED 3.6725 = A$1.44`); I could not re-check it today
(the rate site blocked the fetch), so re-check before launch. Local prices are rounded to price points, not converted
live, and repriced if FX moves more than 5%. All prices are ex-tax: UK VAT 20%, UAE VAT 5% and Australian GST 10% are added
at checkout by Paddle, the merchant of record, with US sales tax where it applies.

| Plan | USD | GBP | AED | AUD |
|---|---|---|---|---|
| Starter | 99 | 75 | 369 | 145 |
| Starter, yearly | 990 | 750 | 3,690 | 1,450 |
| Growth | 249 | 189 | 919 | 359 |
| Growth, yearly | 2,490 | 1,890 | 9,190 | 3,590 |
| Pro | 499 | 379 | 1,839 | 719 |
| Pro, yearly | 4,990 | 3,790 | 18,390 | 7,190 |
| Scale, from | 999 | 749 | 3,669 | 1,449 |
| Pause | 29 | 22 | 109 | 42 |
| Credit pack, 20 | 59 | 45 | 219 | 85 |

(Scale, Pause and the credit pack are the amounts already in `shared/plans.ts`; the three new plans follow the same
rounding: roughly the converted figure, ending in 9.)

### 4.7 Risks

1. **We have never paid a model bill.** The answer cost is list price times measured tokens. If it is twice as high, Starter
   typical falls to about 55%. Mitigation: meter every business on the API from the first paying customer and review
   the real cost per answer after 30 days.
2. **Running paying customers on the subscription.** The spec says Anthropic's terms forbid it (not re-checked here) and
   makes the API-key runtime with per-business metering the first item before a paying customer. This research assumes it.
3. **Human minutes creep** (the spec's biggest warning). Starter must stay near zero; budget 20 minutes at setup.
4. **A cheaper rival.** Sintra's promotional price sets a low anchor; test $99 against $129.
5. **Connector terms and reviews** decide when each tool can go live for customers (Google, Meta, Shopify, HubSpot reviews
   take weeks; `docs/connections-design.md` section 4), which is a launch timing risk more than a cost.
6. **Supplier price moves**: Composio's August repricing, and Higgsfield's credit and API prices, are not settled in
   the sources. Our own cap and the cost check before every job protect margin; the architecture keeps Composio behind one
   interface so the long tail could move to self-hosted Nango.

### 4.8 What I would do next (no code is changed here)

1. The founder approves the ladder, or changes a price (decisions below).
2. Before the first paying customer: the API-key runtime with per-business token and dollar metering, the hidden budget
   with its downshift, and the human-minute counter.
3. Change `shared/plans.ts` to match: add `starter`, reprice `growth` to 249, add `pro` at 499, make the old `pro`
   `scale`, remove `essentials` (a `PlanId` change, so the pricing page and the allowance meter move together); update
   the draft Starter card on the website; keep the credit rules.
4. Offer the Brain Snapshot first, since it is the proof and costs about $3.
5. After 10 customers, re-run section 3 with real numbers and revisit the prices.

**Decisions for the founder**
1. Ladder: $99 / $249 / $499 / from $999, and retire Essentials ($199)? Or hold Growth at $449 and skip the middle plan?
2. Should Starter owners be able to buy credit packs (20 for $59), or stay strictly without generation?
3. Keep Allevia 90 as the optional done-with-you start, or drop it for now?
4. A founding offer (first 20: Starter $79, Growth $199 for 12 months)?
5. The Snapshot guardrails (one per domain, $3 cap, about 20 a day)?
6. Test $99 against $129 for Starter in the first conversations?

## 5. What I could not verify

- The official ChatGPT Business and Microsoft Copilot pages (403 and a timeout): their prices are from third parties.
- Artisan, 11x, Gumloop, Relevance AI and Motion prices: no reliable public page; the sources disagree.
- AdCreative.ai: the official page returned a 404.
- Higgsfield's own plan and credit prices (the pricing page gave no figures); the $0.075 a credit is cross-checked
  against two model prices, not read from a price list.
- Composio's current overage after its August change; the vendor page read today shows $0.0003 a call.
- Freelancer, agency and assistant rates are agencies' and marketplaces' own figures.
- FX rates (copied from the spec), the `t4g.large` price in Mumbai, the human cost per hour, churn, and every usage
  profile in 3.3 (these are assumptions, to be replaced by the first customers' numbers).

## Sources (all fetched or searched on 17 October 2026 unless noted)

Competitors: [Sintra](https://sintra.ai/pricing), [Kylon](https://www.kylon.io/pricing), [Marblism](https://www.marblism.com/pricing),
[Lindy](https://www.lindy.ai/pricing), [Relevance AI](https://relevanceai.com/pricing), [Gumloop](https://www.gumloop.com/pricing),
[Motion](https://www.usemotion.com/pricing), [Ema](https://www.ema.ai/pricing), [Artisan](https://www.artisan.co/pricing),
[Jasper](https://www.jasper.ai/pricing), [Copy.ai](https://www.copy.ai/prices), [Predis.ai](https://predis.ai/pricing/),
[Ocoya](https://www.ocoya.com/pricing), [Pencil](https://www.trypencil.com/pricing), [HubSpot Marketing Hub](https://www.hubspot.com/pricing/marketing),
[HubSpot Breeze outcome pricing](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete).
Third-party: [eesel on ChatGPT Business](https://www.eesel.ai/blog/chatgpt-work-pricing), [Office Watch on Copilot Business](https://office-watch.com/2025/microsoft-365-copilot-business-ai-add-on/),
[Primend](https://www.primend.com/news/m365-copilot-business-licenses-for-small-and-mid-sized-businesses/), [Macha on Relevance AI](https://www.getmacha.com/blog/relevance-ai-pricing-explained),
[Lindy on Gumloop](https://www.lindy.ai/blog/gumloop-pricing), [Usecarly on Motion](https://www.usecarly.com/blog/motion-pricing/),
[Capterra on Motion](https://www.capterra.ca/software/214264/motion), [11x on Artisan](https://www.11x.ai/guides/artisan-pricing),
[Landbase on 11x](https://www.landbase.com/blog/11x-ai-pricing), [MarketBetter on 11x](https://marketbetter.ai/blog/11x-ai-pricing-2026/),
[Hackceleration on AdCreative.ai](https://www.hackceleration.com/labs/adcreativeai-pricing).
Human alternatives: [MySocial (SolidGigs rates)](https://mysocial.io/blog/social-media-management-pricing-guide/), [VA Masters](https://vamasters.com/how-much-does-a-virtual-assistant-cost/),
[Indeed, virtual assistant](https://www.indeed.com/career/virtual-assistant/salaries), [Whito](https://www.whito.co.uk/research/uk-agency-retainers/),
[Digital Gravity](https://www.digitalgravity.ae/blog/how-much-does-a-digital-marketing-agency-cost-in-dubai/), [Expert360](https://expert360.com/freelance/social-media-managers).
Costs: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [Composio](https://composio.dev/pricing),
[Apify](https://apify.com/pricing), [Higgsfield API](https://higgsfield.ai/blog/higgsfield-api), [Creatify on Higgsfield plans](https://creatify.ai/blog/higgsfield-pricing-(2026)-plans-and-what-you-ll-actually-pay),
[Segmind on image API prices](https://blog.segmind.com/ai-image-gen-pricing-compared-nano-banana-2-vs-seedream-5-0-vs-gpt-image-2-2026/),
[FalkorDB](https://www.falkordb.com/pricing/), [Vantage on t4g.large](https://instances.vantage.sh/aws/ec2/t4g.large),
[Paddle](https://www.paddle.com/pricing), [UsagePricing on Composio](https://usagepricing.com/blueprint/activity/composio-2026-08-25-packaging),
[Scalekit on Composio](https://www.scalekit.com/blog/composio-pricing-change).

In this repo: `docs/superpowers/specs/2026-10-15-allevia-product-design.md` (sections 3.3, 4 and Appendix B),
`shared/plans.ts`, `docs/founder-os.md`, `docs/connections-design.md` (section 3 cost and 4 approvals),
`docs/higgsfield-spend.md`, `docs/graph-audit.md` (the efficiency benchmark and graph growth), `docs/falkordb-cloud.md`,
`docs/apify-setup.md`, `docs/research/kylon.md`. The cost model is a short script; its results are the tables in section 3.4
(inputs in sections 3.1 to 3.3).
