# Competitor features: what rivals offer, and the good ones Allevia is missing

Checked **17 October 2026**. The founder asked: "check the competitors, what they provide, what good features we are
missing". This is research and writing only: nothing was built or run, and `shared/plans.ts` and
`docs/pricing-research.md` were not touched (prices live in `docs/pricing-research.md`; `docs/research/kylon.md` is the
earlier deep read of Kylon).

**The buyer, for every judgement below:** a working founder whose business already works, going from 1 to 100, in the US,
UK, UAE or Australia. Not a marketer or an engineer. Reads Allevia on a phone between jobs.

**How to read the tags.** In tables: **Y** = stated on the vendor's own page, read 17 Oct. **Y(s)** = only from a third
party (blog, review, press release, search summary). **Y(k)** = widely known, not re-checked today. **P** = partly.
**N** = not offered (for Allevia this is known from the repo). **-** = not stated on the pages I read: this does **not**
prove the rival lacks it. **?** = sources disagree. Effort: **S** = under a day for one builder, **M** = 2 to 5 days,
**L** = more than a week or needs an outside approval. "Tier a / b / c" is defined in section 6.

## 1. What Allevia has today (so the gaps are honest)

Sources: `README.md` ("What is live"), `docs/founder-os.md`, `docs/live-scenarios.md`, `docs/research/kylon.md`,
`docs/connections-design.md`, the routes in `web/src/App.tsx`, and a code search of `src/` and `web/src/` on 17 Oct.

**Has, and works live:**
- One company brain per business (a FalkorDB graph; every fact keeps its source and date; two clocks; nothing deleted).
  Answers cite nodes and draw the path; the server checks each citation (hero use case 5 of 5, twice).
- 13 AI staff in 9 departments (Meera plans, desks work, reviewers check). Chat with the team or one person, on the web
  and on Discord.
- Every outward action waits for the owner's OK: the real content on the card, the same three buttons on the web and on
  Discord; an edit teaches a rule (`Learning.tsx` lets the owner retire a rule).
- Today's note with a proactive daily stand-up (20 detectors, festival dates, at most three picks, drafts waiting).
- Website check-up (Lighthouse, SEO, conversion, "does AI know you?" for one model).
- Studio: posters in the brand's fonts (Hindi too), photo clean-up, photo to premium ad, 5-second clips, reels; every
  generation quoted first and capped; lineage and cost stored in the graph.
- Sales (Neel): reads new enquiries, drafts the reply with three real calendar times, books after OK, reminds, follows up.
- Posting to the owner's Instagram, Facebook Page and LinkedIn after OK, scheduled, cancellable.
- A growth plan with three goals, public data on rivals (Apify), spreadsheet upload, the living office, an eval-checked
  "not in the records" answer.

**Built but not yet proven with a real account:** the Composio connections (Google's five products and 16 other toolkits:
Meta, Shopify, Stripe, HubSpot and others), posting (a dry run until `ALLEVIA_ACTIONS_LIVE=1`; no real post made), Sales on a real inbox,
Apify (off without a token).

**Does not have** (confirmed by search of the code): a mobile app or an installable web app (the page is responsive; no
manifest, no service worker, no push); any channel besides web and Discord (no email, SMS, WhatsApp, Slack); voice input
(no speech or audio code); meeting notes or transcripts; anything customer-facing (no website chat, no phone agent); a
content calendar view (there is a posts list); owner-made recurring jobs; accounts, login or roles (one private owner link
per business; login and billing are parked as #21); a SOC 2, a subprocessor list or a DPA; a choice of data region (the
server is in Mumbai); Arabic layout (only Hindi and Latin fonts are handled).

## 2. The rivals in one line each

| Rival | What it is | Notable things it has that Allevia does not | Source |
|---|---|---|---|
| [Sintra](https://sintra.ai/) | 12 role "helpers" with a shared "Brain AI" memory | Mobile apps; 12 helpers across support, SEO, copy, social; a "Brain" the owner can toggle per helper. Users complain that unlimited use became 250 credits and agents stop at zero ([eesel review, 6 Oct 2026](https://www.eesel.ai/blog/sintra-ai-review)) | Y |
| [Marblism](https://www.marblism.com/) | 7 AI employees (assistant, social, leads, SEO, receptionist, website builder, legal) | A receptionist that answers every call and a phone number for it; a website builder that keeps improving the site; a 700M-contact lead database; unlimited businesses and members | Y |
| [Lindy](https://www.lindy.ai/) | General AI agents with approvals | iMessage and Slack; a meeting notetaker; memory in plain files the owner can open and edit; scheduled jobs; a skills library; phone agent ([Gaia, Oct 2025](https://www.lindy.ai/blog/gaia-announcement)); computer use; 1,500+ integrations; SOC 2 Type II, GDPR, HIPAA | Y; phone Y(s) |
| [Kylon](https://www.kylon.io/) | A Slack-like workspace where people and agents share rooms | iOS, Android and Mac apps; Slack and Teams; agents join with memory and permissions; workflows on a schedule or webhook; agents build small hosted apps and dashboards; 3,000+ integrations; separate client workspaces for agencies; SOC 2 and ISO 27001 in progress ([trust page](https://kylon.trust.site/)) | Y |
| [Motion](https://www.usemotion.com/) | Planner, calendar, docs and meeting notes with AI | Auto-timeblocking; AI meeting notetaker with action items; Siri voice; email assistant for follow-ups; booking pages; dashboards; SOC 2 Type 2. The page does not show the "AI employees" other sources describe | Y; employees ? |
| [ChatGPT Business](https://openai.com/business/pricing/) | General assistant for a team | Company knowledge across connected apps, 60+ connectors, record mode for meetings, workspace agents, SOC 2 Type 2; data residency listed but not included on Business ([search summary of OpenAI's page, official page returned 403](https://openai.com/business/pricing/)) | Y(s) |
| Microsoft 365 Copilot (Business and above) | Assistant inside Word, Outlook and Teams | Researcher and Analyst agents; memory in Researcher due for general availability around November 2026 ([roadmap RM562996](https://mc.merill.net/message/RM562996), [Thurrott](https://www.thurrott.com/a-i/microsoft-copilot-a-i/321717/research-and-analyst-agents-are-now-available-in-microsoft-365-copilot)); no page on the Business SKU could be read | Y(s) |
| [HubSpot Breeze](https://www.hubspot.com/products/artificial-intelligence) | Agents inside the CRM | Customer Agent that resolves enquiries across channels, priced at $0.50 a resolution; Prospecting Agent ($1 a lead); Content Agent for blogs, social and landing pages; Data Agent; the owner approves CRM updates and follow-up drafts after each meeting; setup "in three steps"; an AEO add-on that tracks prompts in three answer engines ([pricing](https://www.hubspot.com/pricing/marketing)) | Y |
| Shopify Sidekick ([Shopify](https://www.shopify.com/magic), [Winter '26 edition](https://ecommerce-platforms.com/shopify/shopify-editions-winter-2026)) | The store's built-in assistant | Included in the Shopify plan; writes ShopifyQL reports; acts in the admin; Sidekick Pulse gives proactive suggestions that run in one click; voice chat; builds Flow automations and small apps | Y; Pulse and voice Y(s) |
| Google Pomelli ([overview, 9 Sept 2026](https://blog.buildfastwithai.com/what-is-pomelli-google-ai-marketing-tool)) | Free Google Labs tool that builds a brand profile from a website and makes campaigns | "Business DNA" from a URL or Business Profile; campaign briefs; product Photoshoot from six templates; 9:16 animation as MP4 or GIF; Brand Book PDF; builds and publishes a website; posts to a connected Instagram; free in the experimental phase; expanded to the UK and EU in April 2026 (UAE not confirmed) | Y(s) |
| [Predis.ai](https://predis.ai/) | Posts, carousels, videos and ads from a prompt or product link | Content calendar with autopost; brand kit; competitor analysis; UGC ads; 19+ languages; client workspaces and an approval flow; $19 to $212 a month | Y |
| [Ocoya](https://www.ocoya.com/) | Social content and scheduling | Calendar, auto-scheduling, 37 languages, bio pages, WooCommerce products turned into posts, workflows that post and reply | Y |
| [Relevance AI](https://relevanceai.com/) | Build-your-own AI workforce | Human-in-the-loop approvals, evaluation and governance, role-based access, SOC 2 and GDPR badges, a data-residency option, an embedded team that sets it up; WhatsApp, Slack, Gmail, LinkedIn and Twilio shown as integrations | Y |
| [Gumloop](https://www.gumloop.com/) | A "multiplayer" agent builder | Agents anyone can build, 100+ MCP connectors, templates, an MCP server that exposes a "Company Brain" | Y |
| [Artisan](https://www.artisan.co/) and [11x](https://www.11x.ai/) | Outbound sales agents (Ava; Alice and Julian) | Lead finding and enrichment, outreach, reply handling and meeting booking; 11x adds voice, chat, SMS and WhatsApp channels, multilingual outreach and a human dialer. A different job: new customers by outbound | Y |
| [GoDaddy Airo](https://marketchameleon.com/PressReleases/i/2205764/GDDY/godaddy-brings-agentic-ai-to-small-businesses) | An agentic layer on GoDaddy for small businesses | Agents for website, app, domain, logo and compliance; remembers preferences; 6 agents at launch (Nov 2025), 19 to 25 live by mid-2026 (counts disagree); $50M annualised bookings in Q2 2026 ([call notes](https://www.marketbeat.com/instant-alerts/godaddy-q2-earnings-call-highlights-2026-07-31/)) | Y(s) |
| [Owner.com](https://www.owner.com/) | Restaurant platform: site, ordering, marketing, loyalty | Website, ordering app, email and SMS campaigns, review prompts, listings kept current, phone orders answered automatically; over $100M annual revenue and a $240M raise ([SiliconANGLE, 28 Aug 2026](https://siliconangle.com/2026/08/28/owner-raises-240m-for-its-restaurant-management-platform/)) | Y; AI phone Y(s) |
| [Glean](https://www.glean.com/product/overview) | Enterprise knowledge graph, assistant and agents | A graph of people, content and processes; memory that learns; 100+ connectors; permission-aware; SOC 2 Type II, ISO 27001, HIPAA, GDPR, a single-tenant option ([Gend](https://www.gend.co/blog/glean-autonomous-agents)); contracts reported from $50K to $100K a year | Y; detail Y(s) |
| [Dust](https://dust.tt/) | Custom agents over company knowledge | 70+ connectors, 20+ models, spaces and permissions, audit logs, **ROI and usage analytics**, SOC 2 Type II, US or EU data residency | Y |
| [Notion](https://www.notion.com/product/ai) | Workspace with Custom Agents | Agents on a trigger or schedule ($10 per 1,000 credits from 4 May 2026), AI meeting notes with no bot, enterprise search, SOC 2 Type 2 and ISO 27001 | Y |
| [Granola](https://www.granola.ai/) and [Fireflies](https://fireflies.ai/) | Meeting memory | Granola: notes without a bot, chat across meetings, briefs from earlier meetings, phone apps, an MCP connector. Fireflies: bot recording, 100+ languages, CRM auto-fill, talk-time and sentiment, phone app, SOC 2 Type II, GDPR, HIPAA | Y |

## 3. Feature matrix

Allevia and the ten most relevant rivals for this buyer (small-business tools first, then the general assistants the
buyer already pays for). Legend in the intro. A "-" is "not stated on the pages read".

| Feature | **Allevia** | Sintra | Marblism | Lindy | Kylon | Motion | ChatGPT Business | HubSpot Breeze | Shopify Sidekick | Google Pomelli | Predis.ai |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Memory of the business | **Y** graph, sourced and dated | Y Brain AI | - | Y editable plain files | Y agents with memory | P docs, tasks, calendar | Y(s) company knowledge | P CRM data | - | P brand profile | P brand kit |
| Source and date on every fact, path to the answer | **Y** checked | - | - | - | - | - | - | - | - | - | - |
| Integrations | Google (5) + 16 toolkits (none live yet) | 15+ (page also says 1000+) | about 16 named | 1,500+ | 3,000+ | hundreds | 60+ (s) | native CRM, marketplace | Shopify only | Instagram, Google Ads share | social networks |
| Acts through the owner's own tools | **Y** after OK; dry run until live | P posts, replies, calendar | Y | Y | Y as drafts | P | P | Y inside HubSpot | Y inside the admin | P post, share | Y autopost |
| Approval before anything goes out | **Y** always | P "approval levels" | - | Y | Y | - | - | Y CRM updates, drafts | - | P user edits first | P approval flow |
| Proactive daily brief or ideas | **Y** stand-up | P daily summary | - | P scheduled briefs | - | Y auto-plans | - | - | Y(s) Pulse | P campaign ideas on request | - |
| Owner sets own recurring jobs | **N** | P scheduled tasks (s) | - | Y | Y | P | P | P workflows | - | N | P calendar |
| Mobile app or installable | **N** | Y | - | - (iMessage) | Y iOS, Android, Mac | Y | Y(k) | Y(k) | - | N | - |
| Slack or Teams | **N** (Discord) | - | - | Y Slack | Y both | Y | Y(s) Slack | - | n/a | n/a | - |
| WhatsApp, SMS or iMessage | **N** | - | - | Y iMessage | - | - | - | - | - | - | - |
| Email as a channel | **N** | - | - | - | - | Y email assistant | - | - | - | - | - |
| Voice with the assistant | **N** | - | - | - | P voice setup call | Y Siri | Y(k) | - | Y(s) | - | - |
| Phone agent for the owner's customers | **N** | - | Y receptionist | Y(s) Gaia | - | - | - | - | - | n/a | n/a |
| Customer-facing chat or support agent | **N** | P Cassie (text) | P | P | n/a | - | - | Y Customer Agent | - | n/a | n/a |
| Meeting notes | **N** | - | P assistant | Y | - | Y | Y(s) record mode | P follow-up drafts | n/a | n/a | n/a |
| Sales: reply to enquiries, book calls | **Y** | P scripts | Y | Y | P | P | - | Y Prospecting | n/a | n/a | n/a |
| CRM | P in the brain; HubSpot toolkit | - | - | Y integrations | Y builds one | P | - | Y native | P customers | - | - |
| Images and video | **Y** Studio | P images | P photos, videos | - | Y built-in | N | P(k) | P | P photo upgrade | Y free | Y |
| Posting and scheduling | **Y** after OK | Y | Y | - | P | N | - | Y(s) | n/a | Y Instagram | Y |
| Content calendar view | **N** (a list) | - | - | - | - | - | - | - | - | - | Y |
| Website | P check-up, fix cards | - | Y builds it | - | - | - | - | - | Y store | Y builds it | - |
| Ads | P read, change as card | - | - | - | - | - | - | - | n/a | P share to Google Ads | P creatives |
| Rivals and market watch | **Y** | - | - | - | - | - | - | - | - | - | Y |
| Reports and dashboards | P | P insights helper | - | P | P built in chat | Y | P docs, decks | Y | Y reports | - | P |
| Several people, roles | **N** one owner link | Y shared | Y unlimited | Y pooled | Y roles | Y 1 to 1,000 | Y | Y | Y staff | - | P workspaces |
| Templates, skills, marketplace | P 39 skills; no marketplace | P 100+ power-ups (s) | - | Y skills, role templates | P skills | - | P | P app marketplace | P saved skills (s) | Y 6 photo templates | - |
| SOC 2 | **N** | - | - | Y Type II | In progress | Y Type 2 | Y(s) Type 2 | - | - | - | - |
| Choice of data region | **N** | - | - | - | - | - | listed, not on Business (s) | - | - | - | - |
| Time to first value | about 8 min to a brain; numbers need a connection | "minutes" | - | "minutes" | sign up, then you build | - | - | "three steps" | built in | a URL | a prompt |

Adjacent rivals not in the matrix (Relevance AI, Artisan, 11x, Gumloop, GoDaddy Airo, Owner.com, Glean, Dust, Notion,
Granola, Fireflies, Ocoya, Copilot) are in section 2.

## 4. Good features we are missing

Ranked by what a founder would notice and pay for, then by how cheap it is, then by fit with the graph-first story.
"Fit" says whether the feature gets better because the brain is a graph (strong), is a delivery layer on top of it
(neutral), or is unrelated.

### 4.1 The top ten

**1. Reach the owner where they already are: email, WhatsApp, SMS.**
- Who: Lindy (iMessage, Slack), Kylon (Slack, Teams, phone apps), Motion (email assistant); 11x for its own prospects.
- Why our buyer cares: a café owner in Dubai or a plumber in Leeds will not open a Discord server. Today's note and the
  approvals are the product, so they have to arrive in the place the owner already looks. Discord was a good first
  surface; it is not where this buyer lives.
- Effort: email digest with signed approve, change and no-thanks links: **M** (a mail account and per-business
  unsubscribe; the approval endpoint already exists). WhatsApp: **L** (Meta Tech Provider, weeks of review,
  `docs/connections-design.md` section 4).
- Fit: neutral. The approval stays a graph record with `decidedBy` set. Tier: **b** (email), **c** (WhatsApp).

**2. Meeting memory: a call goes in, decisions, tasks and a follow-up draft come out; a brief before the next call.**
- Who: Granola, Fireflies, Lindy, Notion, Motion, ChatGPT Business (record mode), HubSpot (approve follow-up drafts after
  every meeting).
- Why: a founder going 1 to 100 lives on calls with clients, suppliers and staff, and the commitments from them are what
  falls through. Sales already books and reminds; it does not know what was said.
- Effort: pasted notes or a transcript in chat: **S to M**; file upload plus calendar-linked capture through Granola's
  or Fireflies' connectors: **M**.
- Fit: **strong.** Meeting, Decision, Task, Person nodes with the pasted text as the source, the Company Brain track's
  "decisions with their evidence and deciders", and "who said what, when" is a path question. Tier: **a** (paste), **b**
  (capture).

**3. Talk to it: a microphone on the Ask box, then voice notes.**
- Who: Motion (Siri), Shopify Sidekick (voice chat, Y(s)), Fireflies (dictation), Kylon (voice call for setup), ChatGPT
  voice (Y(k)).
- Why: the buyer is between jobs, hands busy, on a phone. Typing "why did bookings drop" on a phone is where they give up.
- Effort: browser speech-to-text button: **S**, free, no server change (Chrome and Safari). Discord and web voice notes
  transcribed on our own server: **M** (a local speech model on the EC2 box; the Mac must stay light).
- Fit: neutral (input only; the answer still comes from the graph). Tier: **a** (mic button), **b** (voice notes).

**4. It feels like an app: installable on the phone, then push.**
- Who: Sintra, Kylon, Motion, Granola, Fireflies (all have phone apps).
- Why: the buyer reads Allevia on a phone. An icon on the home screen and a nudge when a card is waiting turn "a website
  I should check" into a habit.
- Effort: installable web app (manifest, icons, standalone display): **S** (an hour or two; the site already has
  icons). Web push for waiting cards: **M**. A native app: **L**, not needed.
- Fit: neutral. Tier: **a** (install), **b** (push).

**5. A customer-facing agent: website chat that answers from the brain, later a phone receptionist.**
- Who: Marblism (receptionist with a phone number), Lindy (Gaia phone agent), HubSpot (Customer Agent at $0.50 a
  resolution), 11x (Julian voice agent), Owner.com (phone orders), Sintra (Cassie, text only).
- Why: the owner's loss is the enquiry that came at 9 pm and went cold. Sales answers email; nothing answers the website
  visitor or the phone.
- Effort: website chat widget on the brain with hand-off to Sales and "I don't know, here is a card for the owner":
  **M** (a public endpoint needs rate limits, abuse protection and the tenant boundary kept; the highest-risk item on this
  list). Phone: **L** (telephony, latency, call-recording law in four countries).
- Fit: **strong** for chat: every answer cites a node, and a missing fact becomes a card instead of a guess. Tier: **b**
  (chat), **c** (phone).

**6. Routines the owner can ask for, and skills the owner can teach.**
- Who: Lindy (scheduled jobs, skills library), Kylon (workflows on a schedule or webhook), Notion (Custom Agents on
  triggers), Gumloop.
- Why: "every Monday send me the numbers", "on the 5th remind me who has not paid" is the first thing an owner asks after
  the daily note. `docs/research/kylon.md` already lists "recurring jobs the owner can ask for" as a gap.
- Effort: **M** (a `Routine` node with a schedule, a runner on the existing 15-minute tick, a card or a note as the
  result, and a "stop" control).
- Fit: strong (Routine, its runs as Turns and Observations). Tier: **b**.

**7. Teammates with roles, and a real login.**
- Who: Kylon (roles for people and agents), Lindy, Dust and Glean (permissions), Sintra and Marblism (shared workspace).
- Why: a founder has a partner, an ops manager, a bookkeeper. They need someone else to approve a booking or see the
  numbers without seeing everything. Every rival has a login; Allevia has a private link. Login and billing are parked as #21.
- Effort: a second and third link with a role (approver, viewer): **M**; real accounts, invites and billing: **L**.
- Fit: medium (Membership nodes; `decidedBy` already records who). Tier: **b** (links), **c** (login).

**8. Product catalog to weekly ads and posts, with a calendar.**
- Who: Predis (a Shopify product link or catalog to ads; content calendar), Ocoya (a WooCommerce product becomes a post),
  Pomelli (pick a product, get a campaign), Pencil (feeds), Shopify Sidekick.
- Why: for a shop, "what should I post about this week" is "this product, this offer, before this festival". Allevia
  reads Shopify and makes pictures, but does not connect the two or show a month on one screen.
- Effort: **M** (Shopify products to `Product` nodes, a weekly pick, Studio, a read-only calendar grid from `publishAt` and
  `festivals.ts`). The calendar grid alone is **S to M**.
- Fit: **strong** (Product to Asset to Content to Approval is one lineage chain; `graph:lineage` already exists). Tier:
  **b**.

**9. Fix the website or shop for them after the OK.**
- Who: Marblism (Walter builds and improves the site; WordPress, Shopify, Webflow, Wix), GoDaddy Airo, Pomelli (builds and
  publishes a site), Shopify Sidekick (acts in the store admin).
- Why: the check-up finds the fixes; most owners cannot make them. This is the step from "advice" to "done".
- Effort: **L** (one CMS at a time through Composio; WordPress or Shopify first; each fix type needs a safe preview and
  undo).
- Fit: strong (Task to Action to Page, with the before and after kept). Tier: **c**, with a **b** spike on one fix type.

**10. A trust pack: SOC 2, where the data lives, who processes it.**
- Who: Lindy (SOC 2 Type II, GDPR, HIPAA), Motion, Notion, Fireflies, ChatGPT Business, Glean (SOC 2); Dust (US or EU
  residency); Kylon (SOC 2 and ISO in progress, a dated subprocessor list, a DPA).
- Why: a UK or Australian owner connecting Gmail and Google Ads will ask "where does my data go". Our server is in Mumbai.
  The honest answer today is better than the missing page: Composio is SOC 2 Type II, nothing is shared between businesses,
  nothing goes out without a tap.
- Effort: subprocessor list, "where your data lives", a DPA on request and a deletion promise: **S to M** (a page and a
  document). A UK or EU region: **L**. SOC 2 Type II: **L** (6 to 12 months, a compliance tool).
- Fit: neutral. Tier: **b** (the page), **c** (SOC 2, residency).

### 4.2 Smaller gaps worth a ticket

| Feature | Who has it | Effort | Tier | Note |
|---|---|---|---|---|
| A "what your team did this week" card (drafts approved, calls booked, fixes shipped, facts learned) | Dust (ROI and usage analytics); none of the small-business tools say they do | S | a | Strong fit: each number is a count over `Approval`, `Action` and `Content` nodes with dates, and it opens the nodes. It is also the retention argument for a $99 plan |
| Reviews inbox with drafted replies from public reviews | Owner.com (reviews engine, review prompts) | M | b | A "review reply" card kind exists; posting waits on Business Profile access (#19) |
| Arabic (right-to-left) posters and answers for the UAE | Predis (19+ languages), Ocoya (37) | M | b | Only Hindi and Latin are handled; the poster engine needs an Arabic font and RTL layout |
| Slack as a surface | Lindy, Kylon, Dust, Motion | M | b | Composio has Slack; unlisted apps work but history is rate limited |
| Pin an answer to Home as a live tile | Kylon (dashboards built in chat), Motion, Sidekick (reports) | M | b | Strong fit: a saved read query over the graph |
| "Forget or correct this fact" on the Brain page | Lindy (editable memory), Sintra (Brain toggle) | S to M | b | Strong fit: retiring an edge with a date is what the graph already does; today only learned rules can be retired |
| AI search visibility across more than one model | HubSpot AEO ($50 a month, 3 engines), Jasper (GEO hub) | M | c | Ours asks Claude only, with no web search; more engines need paid APIs |
| Agency and partner mode (many client businesses, one login) | Kylon (partner program, client workspaces), Predis (workspaces), Marblism (unlimited businesses) | M to L | c | A channel to market; needs roles first |
| A lead database and outbound | Marblism (Stan), Artisan, 11x | L | c | A different job from "business already works"; consider an Apollo toolkit through Composio rather than building |
| Template and skill marketplace; teach a skill by walkthrough | Lindy (skills, role templates), Gumloop, Kylon | M | c | Per-company skills exist; no owner-facing way to add one |
| Creative scoring before posting | Pencil (predictions, listed as coming soon); Higgsfield has a virality predictor | S to M | c | Unproven; low priority |

### 4.3 Not worth copying now

- **Computer use and browser control** (Lindy): a risk surface, not a founder need.
- **A general agent builder** (Relevance AI, Gumloop, Dust): Allevia's value is the staff already built; a builder
  turns it into a toolkit for engineers.
- **Enterprise search, SSO, SCIM** (Glean, Dust): wrong customer size.
- **Outbound sales at scale** (Artisan, 11x): an inbound-first buyer, and deliverability and consent risk.
- **Native phone apps**: an installable web app plus push covers the need for months.

## 5. Where Allevia is ahead

Relative to what the rivals' public pages say. I have not used their products, so "ahead" means "not described".

1. **Provenance.** Every fact keeps a source and a date on two clocks, a contradicted fact is closed rather than deleted,
   every answer's citations are checked against what the tools returned that turn, and the path is drawn from real edges.
   Glean has a knowledge graph and Lindy's memory is open and editable, but none of the pages read describe sources and
   valid time on each fact or a checked path under each answer.
2. **Honest uncertainty.** "Not in the records" is a tested answer, not a guess (the hero question passes on a business that
   cannot prove the cause; `docs/live-scenarios.md`).
3. **Approvals as a default, with real content.** The card shows the actual email, the time, the words; the same card and
   buttons on the web and Discord; an edit teaches a rule. Kylon is equal on drafts; Sintra's page mentions approval
   levels but not how they work; Marblism, Motion and ChatGPT Business say nothing on the pages read.
4. **A team that notices, not just answers.** A daily stand-up with detectors, festival dates and drafts waiting.
   Shopify's Pulse is the closest (stores only, a few suggestions); Sintra has a daily summary; Motion re-plans tasks.
5. **Creative with checks and cost in the graph.** Purpose-first briefs, the owner's words and logo set by code, a
   fidelity check that held back an edit that invented things, photo to premium ad with lineage and cost per job.
   Pomelli is free and strong on brand profile and photoshoot, but it does not (from what we read) look at the business's
   numbers, hold a card for approval or record cost.
6. **A growth plan on real numbers**, a website check-up with a "does AI know you?" measure, and rivals' ads and Instagram
   (Apify). Only Predis (competitor analysis) and HubSpot (AEO add-on) come near.
7. **A measured efficiency claim.** On a real business one agent on the graph read 8 times fewer tokens than stuffing the
   documents into a prompt (`README.md`, 17 Oct); none of the pages read show a comparable measurement.
8. **One graph per business, with isolation tests**, and a living office that makes the work visible. Kylon is a
   Slack-like workspace; the others are chat windows.

**Where rivals threaten the pitch** (so we do not over-claim): Pomelli gives creative for free in the US, Canada,
Australia, New Zealand, the UK and the EU (UAE not confirmed). Shopify Sidekick is included in a Shopify plan. ChatGPT
Business is $20 to $25 a seat with connectors, agents and SOC 2. HubSpot's agents sit where a CRM user already works.
Lindy has a phone agent, iMessage and SOC 2. Our answer is the brain, the approvals and the numbers, plus being the one
product that ties them for an owner who has no time.

## 6. Ranked shortlist

The submission checklist (#14, #15) and the live scenarios come first. Tier **a** items are sized in hours, optional, and
not on the submission's critical path; do none of them if the checklist is not done.

### Tier a: before the hackathon deadline (18 Oct, 23:59 IST), and worth showing in the demo

| # | Item | Effort | The demo moment | Fit | Risk |
|---|---|---|---|---|---|
| a1 | **Microphone button on the Ask box** (browser speech to text; the answer still follows the graph) | S, 2 to 4 hours | Say the hero question out loud on a phone and watch the path light up | neutral | Chrome and Safari only; set the recognition language from the business |
| a2 | **"Remember this meeting"**: paste notes or a transcript in chat; Sara extracts decisions, tasks, people and dates into the brain with the pasted text as the source, and Neel drafts the follow-up as a card | S to M, 4 to 8 hours | A client call becomes a decision with its evidence, an owner for each task and a card waiting for OK, in under a minute | **strong** (Company Brain track) | Writes must go through the existing privacy filter and `remember`; keep to text, no audio |
| a3 | **"What your team did this week" card on Home**: counts of approved drafts, booked calls, shipped fixes and facts learned, each opening the nodes | S, 3 to 5 hours (Home cards are data in `home-cards.tsx`) | A real line of proof for a buyer deciding whether the plan is worth it | **strong** | Counts must be real queries; on a quiet week it shows zeros, so word it plainly |
| a4 | **Installable web app** (manifest, icons, standalone display, theme colour) | S, 1 to 2 hours | An icon on the phone's home screen beside the screenshots | neutral | No push yet; say so |

### Tier b: the next 30 days, in order

1. **Email channel**: Today's note and approvals by email with signed links (M).
2. **Meeting capture on autopilot**: Granola or Fireflies through Composio or MCP, and a brief before each calendar
   event from the graph (M).
3. **Owner routines and saved skills** (M).
4. **Customer-facing website chat from the brain**, with Sales hand-off and an owner card for what it does not know (M).
5. **Teammate links with roles** (approver, viewer) before a real login (M).
6. **Voice notes** on Discord and the web, transcribed on our own server; **web push** for waiting cards (M each).
7. **Catalog to weekly ads and posts, with a content calendar grid** (M; the grid alone S to M).
8. **Trust page**: subprocessors, where data lives, a DPA on request, deletion (S to M).
9. **Reviews inbox with drafted replies**, **Arabic (RTL) posters**, **Slack as a surface**, **pin to Home**, **forget or
   correct a fact** (M each; the last is S to M).

### Tier c: later

- WhatsApp as a channel (L: Meta Tech Provider, review).
- A phone receptionist (L).
- SOC 2 Type II and a UK or EU region (L, 6 to 12 months).
- Real login, invites and billing (#21) (L).
- Agency and partner mode (M to L).
- Fixing the owner's website or shop after OK, one CMS at a time (L).
- A lead database through a connector, if founders ask for it (L).
- A skills and template marketplace, creative scoring, search visibility across several engines (M each).

## 7. What I could not verify

- **Official pages that returned an error or no content:** ChatGPT Business (403), Microsoft Copilot Business (timeout; I
  found no page on the SKU), GoDaddy Airo (403), Google Pomelli (an empty title page), Lindy's calls page (404). Their
  entries rest on third parties and are marked Y(s).
- **Marblism and Sintra** pages list roles and promises with no detail on approvals, channels or memory; "-" in the matrix
  means "not stated", not "absent". Sintra's "15+ integrations" and "1000+ tools" are both on its pages.
- **Motion's AI employees**: its own page does not describe them and the pricing page marked both paid plans "not
  available"; third parties disagree on the tier.
- **Owner.com's AI phone ordering** is a waitlist item on its own site and "answers phone orders" in a press piece; treat
  its scope as unverified. **GoDaddy's** live agent count (19 versus 25) conflicts.
- **Glean's** certifications and prices are from third parties. **ChatGPT Business data residency** is listed but marked
  as not included on one mirror of the pricing table.
- **Every "Y(k)"** (ChatGPT and HubSpot mobile apps, ChatGPT voice) is common knowledge I did not re-check today.
- **I have used none of these products.** Everything is from public pages and write-ups of 17 October 2026.

## Sources (all fetched or searched 17 October 2026)

Vendors, own pages: [Sintra](https://sintra.ai/), [Marblism](https://www.marblism.com/), [Marblism pricing](https://www.marblism.com/pricing),
[Lindy](https://www.lindy.ai/), [Lindy pricing](https://www.lindy.ai/pricing), [Kylon](https://www.kylon.io/),
[Kylon trust page](https://kylon.trust.site/), [Motion](https://www.usemotion.com/), [HubSpot Breeze](https://www.hubspot.com/products/artificial-intelligence),
[HubSpot pricing](https://www.hubspot.com/pricing/marketing), [HubSpot outcome pricing](https://www.hubspot.com/company-news/hubspots-customer-agent-and-prospecting-agent-now-you-pay-when-the-task-is-complete),
[Shopify Sidekick](https://www.shopify.com/magic), [Predis.ai](https://predis.ai/), [Ocoya](https://www.ocoya.com/),
[Relevance AI](https://relevanceai.com/), [Gumloop](https://www.gumloop.com/), [Artisan](https://www.artisan.co/),
[11x](https://www.11x.ai/), [Owner.com](https://www.owner.com/), [Glean](https://www.glean.com/product/overview),
[Dust](https://dust.tt/), [Notion](https://www.notion.com/product/ai), [Granola](https://www.granola.ai/), [Fireflies](https://fireflies.ai/),
[Jasper pricing](https://www.jasper.ai/pricing) (GEO hub credits), [Pencil pricing](https://www.trypencil.com/pricing).

Third parties: [eesel on Sintra, 6 Oct 2026](https://www.eesel.ai/blog/sintra-ai-review), [eesel on ChatGPT Business, 12 Jul 2026](https://www.eesel.ai/blog/chatgpt-work-pricing),
[search summary of OpenAI's Business pricing](https://openai.com/business/pricing/), [Lindy on Gaia](https://www.lindy.ai/blog/gaia-announcement),
[Pomelli overview, 9 Sept 2026](https://blog.buildfastwithai.com/what-is-pomelli-google-ai-marketing-tool), [Shopify Winter '26 edition](https://ecommerce-platforms.com/shopify/shopify-editions-winter-2026),
[GoDaddy Airo launch release](https://marketchameleon.com/PressReleases/i/2205764/GDDY/godaddy-brings-agentic-ai-to-small-businesses),
[GoDaddy Q2 2026 call](https://www.marketbeat.com/instant-alerts/godaddy-q2-earnings-call-highlights-2026-07-31/),
[SiliconANGLE on Owner.com](https://siliconangle.com/2026/08/28/owner-raises-240m-for-its-restaurant-management-platform/),
[Gend on Glean](https://www.gend.co/blog/glean-autonomous-agents), [Sacra on Glean](https://sacra.com/research/glean/),
[Microsoft roadmap RM562996](https://mc.merill.net/message/RM562996), [Thurrott on Researcher and Analyst](https://www.thurrott.com/a-i/microsoft-copilot-a-i/321717/research-and-analyst-agents-are-now-available-in-microsoft-365-copilot).

In this repo: `README.md`, `docs/founder-os.md`, `docs/live-scenarios.md`, `docs/connections-design.md`,
`docs/research/kylon.md`, `docs/pricing-research.md`, `docs/graph-audit.md`, `web/src/App.tsx`, `web/src/pages/`, and the
code searches described in section 1 (`src/`, `web/src/`).
