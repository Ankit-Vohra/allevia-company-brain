# Tool scout: skills, repos and services for every department

Checked on 2026-10-15 and rebased on dev on 2026-10-16. Stars, licence (SPDX) and last push come from the GitHub API on
2026-10-15; SaaS prices come from the vendors' pages or third-party reports and must be re-checked before anyone pays.

Already on dev, so not re-adopted here: `i-have-adhd` and `humanizer` (vendored); Aamdani's own skills (read-only); the
Apify public-data tools with budgets; the website check-up (local Lighthouse, first-screen checks, open-seo and
claude-seo methods, optional DataForSEO) with the `website_checkup`, `ai_visibility` and `keyword_ideas` tools and the
skills `get-found-locally`, `does-ai-know-us`, `public-numbers-benchmark`, `competitor-ads-and-moves`,
`website-checkup-fixes`; the HTML/CSS design engine with its `design-standard` skill; Higgsfield.

Verdicts: **adopt now** (taken in this change, or free and ready the day the founder gives a login), **adopt later**
(good, but needs a connector, an account, an app review, or a customer who needs it), **skip** (and why).

## Top 10 adopt now

| # | What | Licence | Stars, last push | What it gives Allevia | Status |
|---|---|---|---|---|---|
| 1 | [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) `small-business` plugin | Apache-2.0 | 29,764, 2026-10-15 | 44 skills written for a small business owner: cash flow, invoice chasing, answering leads fast, reviews, win-back, Monday brief | **Taken.** 7 files vendored; 6 new skills for Isha, Vikram, Zoya |
| 2 | [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT | 54,869, 2026-10-15 | 50 marketing skills; the best text on email, WhatsApp, referrals, CRO, attribution, copy editing | **Taken.** 10 files vendored; 5 new skills for Vikram, Kabir, Dev, Tara |
| 3 | [garrettjsmith/localseoskills](https://github.com/garrettjsmith/localseoskills) | MIT | 126, 2026-08-15 | ~40 local SEO skills: Google Business Profile, reviews, citations, service areas | **Taken.** 3 files vendored; Rohan's get-found-locally upgraded, Vikram's review replies |
| 4 | [adr/madr](https://github.com/adr/madr) | MIT or CC0-1.0 | 2,559, 2026-08-28 | The standard short shape for a decision record | **Taken.** Template vendored; Sara's "A decision on one page" |
| 5 | [googleanalytics/google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) | Apache-2.0 | 3,469, 2026-10-02 | Official, read-only GA4 reports for Kabir (real funnels instead of fixtures) | Free; needs the founder's Google Cloud project (below) |
| 6 | Sentry hosted MCP ([getsentry/sentry-mcp](https://github.com/getsentry/sentry-mcp)) | FSL-1.1-Apache-2.0 (not OSI; use the hosted server, don't fork) | 928, 2026-10-15 | Zoya reads real issues, events and releases | Free Developer plan; needs a Sentry token (below) |
| 7 | [louislam/uptime-kuma](https://github.com/louislam/uptime-kuma) | MIT | 92,495, 2026-10-15 | Uptime checks with webhooks into Zoya's on-call flow | Free; one Docker container, no account |
| 8 | Buffer API and MCP ([announcement](https://buffer.com/resources/buffer-api-is-here/)) | proprietary, ToS | n/a (API launched 2026-05-27) | The fastest legitimate way to schedule the posts Tara writes | Free: 3 channels; needs a Buffer login (below) |
| 9 | Brevo ([brevo.com](https://www.brevo.com)) with [resend/resend-mcp](https://github.com/resend/resend-mcp) (MIT, 576, 2026-10-14) for one-off sends | proprietary, ToS | n/a | Sends the follow-up and win-back emails Rohan and Vikram draft | Brevo free: 300 emails a day; Resend free: 3,000 a month, 100 a day |
| 10 | Meta Ads official connector (mcp.facebook.com/ads, open beta) and [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp) (Apache-2.0, 1,044, 2026-10-09) | proprietary ToS / Apache-2.0 | n/a / see left | Rohan reads real spend and results instead of sample ad numbers; read-only scopes first | Free; Google needs a developer token (below) |

## What was adopted in this change

| Our skill (new) | Who | Built from (vendored, pinned) |
|---|---|---|
| `skills/ops-manager/bring-customers-back` | Vikram | marketingskills `emails`, `sms` (+ WhatsApp and compliance references), `referrals`, `churn-prevention`; knowledge-work-plugins `reactivate` |
| `skills/data-analyst/page-that-should-sell` | Kabir | marketingskills `cro` |
| `skills/data-analyst/which-channel-brings-customers` | Kabir | marketingskills `attribution` |
| `skills/growth-marketer/get-found-locally` (upgraded, already on dev) | Rohan | localseoskills `gbp-optimization`, `local-seo-audit`: compare with the top 3 on Maps, main category, reviews in the last 90 days, no keywords in the name, no rewards for reviews |
| `skills/copy-editor/seven-sweeps-edit` | Dev | marketingskills `copy-editing`, plus the "no AI tells" lists in `social` and `emails` |
| `skills/coe-lead/cash-flow-check` | Isha | knowledge-work-plugins `cash-flow-snapshot` |
| `skills/ops-manager/chase-unpaid-invoices` | Vikram | knowledge-work-plugins `invoice-chase` (+ `tone-matching.md`) |
| `skills/ops-manager/answer-new-enquiries` | Vikram | knowledge-work-plugins `speed-to-lead` |
| `skills/ops-manager/review-replies` | Vikram | knowledge-work-plugins `review-reputation`; localseoskills `review-management` |
| `skills/oncall-engineer/after-the-outage-note` | Zoya | knowledge-work-plugins `engineering/incident-response`; method of PagerDuty's postmortem docs (read, not copied) |
| `skills/librarian/decision-on-one-page` | Sara | MADR minimal template |
| `skills/content-strategist/weekly-content-plan` | Tara | marketingskills `social` (themes, hooks, repurposing, the calendar) |

Each source sits in `vendor/skills/<name>/` with its verbatim `LICENSE` and a `NOTICE.md` (pinned commit, files taken,
where each method is restated). The vendored files are references only; Allevia never loads them. Our skills keep our
format (purpose first, Allevia's own tools, plain owner words, nothing goes out without the owner's OK) and pass the
skills lint. Rohan is at the limit of 10 skills after dev added four, so the win-back and referral series sits with
Vikram, who owns follow-ups; a separate local search skill for Kabir was dropped because dev's `get-found-locally` covers
it, and its extra rules went into that skill instead.

Tara's weekly content plan (from marketingskills `social`) fills the "content calendar" job her profile names but no skill
covered.

## coreyhaines31/marketingskills, skill by skill

MIT, Copyright (c) 2025 Corey Haines, commit `45f51253` (2026-10-15). 50 skills, each with `evals/` and most with
`references/`. Written for SaaS and e-commerce marketers, so most need restating for a salon or an atelier.

| Skill | Best fit | Verdict |
|---|---|---|
| emails, sms (WhatsApp reference), referrals, churn-prevention | Vikram (Rohan is full) | **Adopted** into bring-customers-back |
| cro | Kabir | **Adopted** into page-that-should-sell |
| attribution | Kabir | **Adopted** into which-channel-brings-customers |
| copy-editing | Dev | **Adopted** into seven-sweeps-edit |
| social | Tara (Dev for the tells) | **Adopted** into weekly-content-plan |
| ad-creative, ads | Rohan | Later: our ad-creative-and-copy and ad-budget-check cover it; borrow the "angle matrix" when real ad data arrives |
| offers, pricing, marketing-psychology | Rohan | Later: fold into offer-test-plan when it is next revised |
| ab-testing | Rohan | Later: offer-test-plan already holds the small-sample method |
| content-strategy, copywriting | Tara | Later: overlaps her post, reel and campaign skills |
| image, video | Tara | Skip: dev's design engine and Higgsfield cover it |
| analytics, signup, onboarding | Kabir | Later: needs GA4 connected; funnel-drop-off-diagnosis covers the basics |
| seo-audit, ai-seo, schema, site-architecture, programmatic-seo | Arjun / Kabir | Already covered on dev: website check-up, `does-ai-know-us`, `website-checkup-fixes` |
| competitor-profiling, competitors | Rohan | Already covered on dev: competitor-benchmark, competitor-ads-and-moves (Apify) |
| customer-research, product-marketing | Meera / Rohan | Later: useful for setting up a new business's profile |
| marketing-plan, marketing-ideas, marketing-loops, launch, lead-magnets, events | Meera / Rohan | Later: plan-across-desks and campaign-brief cover the small-business version |
| cold-email, prospecting, revops, sales-enablement | Vikram | Skip for now: B2B outbound; small businesses here sell to walk-in and online customers |
| co-marketing, community-marketing, influencer-marketing, public-relations | Rohan | Later: good for the 1-to-100 stage; not weekly work |
| aso | Imran | Later: when a customer's app needs store listing work |
| paywalls, popups, free-tools, directory-submissions | n/a | Skip: SaaS-specific |
| marketing-council | Meera | Skip: role-plays named real marketers |

## Marketing and growth (Rohan)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| [marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT | 54,869, 2026-10-15 | See above | Free | Low | **Adopt now** (taken) |
| [aaron-he-zhu/aaron-marketing-skills](https://github.com/aaron-he-zhu/aaron-marketing-skills) | Apache-2.0 | 2,956, 2026-10-15 | ~80 skills: ad angle matrix, ad fatigue, budget pacing, reels scripter | Free | Heavy cross-links, Chinese-platform framing | Adopt later: ad fatigue and angle matrix once real ad data flows |
| [ericosiu/ai-marketing-skills](https://github.com/ericosiu/ai-marketing-skills) | MIT | 3,636, 2026-09-22 | Scoring rubrics a writer can grade drafts against; Instagram and Shorts experts | Free | Low | Adopt later: rubrics for Nisha and Dev |
| [CosmoBlk/email-marketing-bible](https://github.com/CosmoBlk/email-marketing-bible) | MIT | 342, 2026-10-13 | Deliverability, flows, compliance, benchmarks | Free | Low | Adopt later: when Brevo is connected and sending starts |
| Meta Ads official connector | Meta ToS | open beta | 29 tools: campaigns, insights; read, read-write and financial scopes | Free | Grant read-only first | **Adopt now** (founder login) |
| [googleads/google-ads-mcp](https://github.com/googleads/google-ads-mcp) | Apache-2.0 | 1,044, 2026-10-09 | Official Google Ads reporting | Free | Needs a developer token | **Adopt now** (founder application) |
| [pipeboard-co/meta-ads-mcp](https://github.com/pipeboard-co/meta-ads-mcp) | BUSL-1.1 | 1,305, 2026-09-23 | Popular community Meta Ads server | Free | BUSL bars offering it hosted to others, which is what Allevia does | Skip |
| [gomarble-ai/facebook-ads-mcp-server](https://github.com/gomarble-ai/facebook-ads-mcp-server) | MIT | 364, 2026-08-05 | Permissive read-only ads server | Free | Small maintainer base | Adopt later: fallback if Meta's beta changes |
| [knadh/listmonk](https://github.com/knadh/listmonk) | AGPL-3.0 | 23,792, 2026-10-15 | Self-hosted newsletters | Free + SMTP | AGPL: run unmodified, separately | Adopt later |
| [dittofeed/dittofeed](https://github.com/dittofeed/dittofeed) | MIT | 3,009, 2026-10-12 | Email, SMS and WhatsApp journeys | Free | Low | Adopt later: when win-back runs on a schedule |
| [mautic/mautic](https://github.com/mautic/mautic) | GPL-3.0 | 10,774, 2026-10-15 | Full marketing automation | Free | Heavy to run | Skip: too big for a small business |
| WhatsApp Business Platform (Cloud API) | Meta ToS | n/a | Template and service messages | Per message by country; marketing costs most; from 2026-10-01 service replies past 1,000 a month per number are charged; no marketing templates to US numbers | Opt-in required | Adopt later: needs business verification |
| [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp) | MIT | 6,625, 2025-07-13 | Personal WhatsApp via the web client | Free | Breaks WhatsApp's terms (bans); stale | Skip |
| Mailchimp | ToS | n/a | Email | Free: 250 contacts, 500 emails a month | Low | Skip: free tier too small |

## Content Studio (Tara, Dev, Nisha)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| marketingskills `copy-editing`, `social` | MIT | as above | Seven-sweeps edit; hooks, pillars, the "no AI tells" list | Free | Low | **Adopt now** (taken: Dev's edit, Tara's weekly plan) |
| [anthropics/skills](https://github.com/anthropics/skills) `brand-guidelines`, `canvas-design`, `theme-factory` | Apache-2.0 per folder (docx, pdf, pptx, xlsx are not open source) | 181,341, 2026-10-09 | Brand tokens and poster design method | Free | Take only the Apache folders | Skip: dev's design engine and `design-standard` skill now cover posters |
| [gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app) | AGPL-3.0 | 37,227, 2026-10-15 | Self-hosted scheduler for ~20 networks, with an API | Free self-hosted; hosted ~$29 to $99 a month | AGPL: run as a separate service, unmodified | Adopt later: the posting back-end if Buffer's free tier is too small |
| [inovector/mixpost](https://github.com/inovector/mixpost) | MIT (Lite) | 3,817, 2026-03-16 | Laravel scheduler | Free Lite | Slower development | Adopt later: the MIT alternative to Postiz |
| Instagram Graph API | Meta ToS | n/a | Publish reels and posts, read insights and comments (Business or Creator accounts) | Free | Meta app review; scraping tools break the terms | Adopt later |
| Canva AI Connector | Canva ToS | n/a | Create and export designs from the owner's brand kit | Free/Pro; brand templates need Enterprise | OAuth into the owner's Canva | Adopt later |
| [vercel/satori](https://github.com/vercel/satori) | MPL-2.0 | 14,085, 2026-10-15 | HTML to SVG/PNG for code-made posters | Free | MPL only if we change its files | Skip: dev's design engine renders HTML/CSS with Playwright already |

## Analytics (Kabir) and CRO

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| [google-analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) | Apache-2.0 | 3,469, 2026-10-02 | Read-only GA4 reports and realtime | Free | OAuth to the client's GA4 | **Adopt now** |
| marketingskills `cro`, `attribution` | MIT | as above | Page check and channel credit methods | Free | Low | **Adopt now** (taken) |
| knowledge-work-plugins `data` | Apache-2.0 | 29,764, 2026-10-15 | analyze, explore-data, validate-data | Free | Low | Adopt later: Isha's is-this-figure-real covers most of it |
| [GoogleChrome/lighthouse](https://github.com/GoogleChrome/lighthouse) and PageSpeed Insights API | Apache-2.0 / Google ToS | 30,890, 2026-10-15 | Speed and accessibility of a page on a phone | Free (API key) | Low | Already on dev (local Lighthouse in the check-up) |
| [umami-software/umami](https://github.com/umami-software/umami) | MIT | 39,395, 2026-10-15 | Light, privacy-friendly analytics for a client with none | Free self-hosted | Low | Adopt later |
| [PostHog/posthog](https://github.com/PostHog/posthog) | MIT outside `ee/` | 40,292, 2026-10-15 | Funnels, cohorts, replays; hosted MCP | Free tier, then usage | `ee/` is not MIT | Adopt later: for the fintech app's funnels |
| [microsoft/clarity](https://github.com/microsoft/clarity) | MIT (SDK) | 2,751, 2026-10-15 | Free heatmaps and recordings | Free | Needs a consent banner in UK and EU | Adopt later |
| [saurabhsharma2u/search-console-mcp](https://github.com/saurabhsharma2u/search-console-mcp) | MIT | 302, 2026-09-02 | Search Console queries | Free | Community code | Adopt later, if the check-up wants live Search Console data |
| [ahonn/mcp-server-gsc](https://github.com/ahonn/mcp-server-gsc) | none | 278, 2026-09-04 | Search Console | Free | No licence | Skip |
| [plausible/analytics](https://github.com/plausible/analytics) | AGPL-3.0 | 29,420, 2026-10-15 | Simple analytics | Paid cloud | AGPL | Skip: Umami does it under MIT |

## Local search and reviews (Kabir, Vikram)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| [localseoskills](https://github.com/garrettjsmith/localseoskills) | MIT | 126, 2026-08-15 | Profile, reviews, citations, service-area methods | Free | Some skills route to paid tools | **Adopt now** (taken into get-found-locally and review-replies) |
| [AgriciDaniel/claude-seo](https://github.com/AgriciDaniel/claude-seo) `seo-local`, `seo-maps` | MIT | 18,985, 2026-10-04 | Local SEO checks | Free | Low | Already on dev (website check-up) |
| Google Business Profile API | Google ToS | n/a | Read and reply to reviews, post updates, read calls and directions | Free, but quota starts at 0 until Google approves | Slow approval; apply as the profile's owner or manager | Adopt later: **apply now**, it takes weeks |
| [cablate/mcp-google-map](https://github.com/cablate/mcp-google-map) | MIT | 471, 2026-09-26 | Places search, nearby competitors | Google Maps pay-as-you-go | API key | Adopt later |
| GBP community MCPs (Insightful-Pipe and others) | MIT | 0 to 4 | Thin wrappers | Free | Unproven | Skip: build our own on the official API |

## Numbers and money (Isha)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| knowledge-work-plugins `cash-flow-snapshot`, `invoice-chase` | Apache-2.0 | 29,764, 2026-10-15 | Cash for 30/60/90 days; reminders by payer history | Free | Low | **Adopt now** (taken) |
| [stripe/ai](https://github.com/stripe/ai) (agent toolkit, MCP) | MIT | 1,950, 2026-10-15 | Payments, invoices, payouts | Free | Write tools can move money: use a read-only restricted key only | Adopt later (read-only) |
| [XeroAPI/xero-mcp-server](https://github.com/XeroAPI/xero-mcp-server) | MIT | 376, 2026-06-05 | Invoices, contacts, profit and loss, bank lines (UK, AU, UAE) | Free; Xero plan | OAuth; last push June | Adopt later |
| [intuit/quickbooks-online-mcp-server](https://github.com/intuit/quickbooks-online-mcp-server) | Apache-2.0 | 425, 2026-09-15 | Invoices, bills, profit and loss (US, AU, UK) | Free; QuickBooks plan | OAuth app review | Adopt later |
| knowledge-work-plugins `finance` | Apache-2.0 | 29,764 | Reconciliation, variance, month-end | Free | Written for finance teams | Adopt later: variance commentary for Isha |
| [anthropics/financial-services](https://github.com/anthropics/financial-services) | Apache-2.0 | 39,963, 2026-09-21 | Banking and fund skills | Free | Not small-business work | Skip |
| Invoice Ninja / Akaunting | ELv2 / BSL | 10,279 / 10,184 | Invoicing, accounts | Free self-hosted | Not open source; limits on offering as a service | Skip |
| Actual Budget, Firefly III | MIT / AGPL | 29,503 / 24,898 | Budgets, ledgers | Free | Personal-finance focus | Skip |

## Sales follow-up and customer support (Vikram)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| knowledge-work-plugins `speed-to-lead`, `review-reputation`, `reactivate` with marketingskills `emails`, `sms`, `referrals` | Apache-2.0 / MIT | 29,764 / 54,869, 2026-10-15 | Fast replies to new enquiries, review replies, win-back and refer-a-friend series | Free | Low | **Adopt now** (taken) |
| knowledge-work-plugins `sales`, `customer-support` | Apache-2.0 | 29,764 | draft-response, ticket-triage, handle-objection, crm-hygiene-check | Free | B2B-heavy | Adopt later: ticket-triage when an inbox is connected |
| [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot) | MIT outside `enterprise/` | 37,823, 2026-10-15 | One inbox for WhatsApp, Instagram, email, web chat, with an API | Free self-hosted; paid cloud | WhatsApp needs Meta business verification | Adopt later: the best support inbox for salons and the atelier |
| HubSpot remote MCP | HubSpot ToS | n/a | Contacts, deals, notes | HubSpot free CRM | Writes to customer data; scope it | Adopt later: for owners already on HubSpot |
| [twentyhq/twenty](https://github.com/twentyhq/twenty) | AGPL-3.0 + commercial files | 58,387, 2026-10-15 | Modern open-source CRM | Free self-hosted | AGPL | Adopt later: for owners with no CRM |
| Zammad, EspoCRM, SuiteCRM | AGPL-3.0 | 6,013 / 3,489 / 5,795 | Helpdesk, CRMs | Free | Heavy, AGPL | Skip |

## Tech: on call, releases (Arjun, Zoya, Imran)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| Sentry hosted MCP | FSL-1.1-Apache-2.0 | 928, 2026-10-15 | Issues, events, releases, root-cause hints | Free Developer plan; Team from about $26 a month | FSL: call the hosted server, don't fork | **Adopt now** (founder token) |
| [getsentry/skills](https://github.com/getsentry/skills) | Apache-2.0 | 1,057, 2026-10-15 | triage-frontend-issues, find-bugs | Free | Low | Adopt later: with the Sentry connector |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | MIT | 92,495, 2026-10-15 | Uptime checks with webhooks | Free | Low | **Adopt now** |
| [upptime/upptime](https://github.com/upptime/upptime) | MIT | 17,184, 2026-10-15 | Uptime and status page on GitHub Actions | Free on public repos | Status page public by default | Adopt later |
| knowledge-work-plugins `engineering/incident-response` | Apache-2.0 | 29,764 | Severity, updates, blameless write-up | Free | Low | **Adopt now** (taken) |
| knowledge-work-plugins `engineering/deploy-checklist` | Apache-2.0 | 29,764 | Release checklist | Free | Low | Adopt later: Imran's release-check already covers it |
| [PagerDuty/incident-response-docs](https://github.com/PagerDuty/incident-response-docs), [postmortem-docs](https://github.com/PagerDuty/postmortem-docs) | Apache-2.0 | 1,053 / 72 | Roles, severity, blameless postmortems | Free | Low | Method used in Zoya's note; vendor if the note grows |
| [obra/superpowers](https://github.com/obra/superpowers) `systematic-debugging` | MIT | 299,670, 2026-10-10 | Root cause before fixes | Free | Written for coding sessions | Adopt later: for Arjun's fix tickets |
| [fastlane/fastlane](https://github.com/fastlane/fastlane) | MIT | 42,246, 2026-10-15 | Build and store upload automation | Free | Low | Adopt later: when a customer ships an app |
| [zelentsov-dev/asc-mcp](https://github.com/zelentsov-dev/asc-mcp) | MIT | 77, 2026-09-24 | App Store Connect: builds, reviews, TestFlight | Free; ASC API key | One maintainer; key can write | Adopt later: read-only key |
| Google Play MCPs (AgiMaulana, OrellBuehler) | MIT | 7 / 1 | Crash and ANR rates, reviews | Free | Tiny projects | Skip: build our own Play reviews and crash-rate tool from the API calls |
| Google SRE books | CC BY-NC-ND 4.0 (not re-checked) | n/a | SLOs, postmortem culture | Free | No commercial adaptation | Skip vendoring; link only |

## Library and Chief of Staff (Sara, Meera)

| Name | Licence | Stars, last push | What it gives | Cost | Risk | Verdict |
|---|---|---|---|---|---|---|
| [MADR](https://github.com/adr/madr) | MIT or CC0 | 2,559, 2026-08-28 | Decision record shape | Free | Low | **Adopt now** (taken) |
| [FalkorDB/FalkorDB-MCPServer](https://github.com/FalkorDB/FalkorDB-MCPServer) | MIT | 41, 2026-10-15 | Graph queries over MCP | Free | Must keep our tenant and read-only rules | Adopt later: only behind our own tenant guard |
| [getzep/graphiti](https://github.com/getzep/graphiti) (FalkorDB driver) | Apache-2.0 | 31,787, 2026-10-15 | Time-aware memory of who said what, when | Free; extraction calls an LLM API | Breaks the no-API-spend rule unless run through the subscription | Adopt later |
| [FalkorDB/GraphRAG-SDK](https://github.com/FalkorDB/GraphRAG-SDK) | Apache-2.0 | 1,017, 2026-10-14 | Graph from documents, Q&A over it | Free; needs an LLM provider | Same API-spend question | Adopt later |
| [mem0ai/mem0](https://github.com/mem0ai/mem0), [topoteretes/cognee](https://github.com/topoteretes/cognee) | Apache-2.0 | 67,233 / 32,351 | Memory layers | Free / paid cloud | Overlap with our graph | Skip |
| knowledge-work-plugins `monday-brief`, `business-pulse`, `productivity/task-management` | Apache-2.0 | 29,764 | Weekly brief, follow-ups | Free | Low | Adopt later: compare against Meera's what-do-i-do-this-week |
| [taylorwilsdon/google_workspace_mcp](https://github.com/taylorwilsdon/google_workspace_mcp) | MIT | 3,342, 2026-10-09 | Gmail, Calendar, Drive for Meera and Vikram (real time slots for enquiry replies) | Free | Google sensitive-scope review if we publish our own app | Adopt later |
| [makenotion/notion-mcp-server](https://github.com/makenotion/notion-mcp-server), Trello, Asana, Todoist MCPs | MIT | 4,666 / 446 / 149 / 558 | Owners' own task tools | Free | OAuth or token | Adopt later, per customer |
| [joelparkerhenderson/architecture-decision-record](https://github.com/joelparkerhenderson/architecture-decision-record) | CC BY-NC-SA | 17,212 | Decision record examples | Free | Non-commercial | Skip |

## Lists for finding more

| Name | Licence | Stars, last push | Verdict |
|---|---|---|---|
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | MIT | 96,388, 2026-10-15 | Use to find connectors; entries are unvetted |
| [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) | MIT | 35,771, 2026-10-15 | Use to find skills; each has its own licence |
| [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills) | none | 77,171, 2026-09-18 | Ideas only: no licence, so copy nothing |
| [travisvn/awesome-claude-skills](https://github.com/travisvn/awesome-claude-skills) | none | 15,420, 2026-04-28 | Ideas only |
| [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official) | Apache-2.0 | 38,661, 2026-10-15 | Developer plugins; `external_plugins/discord` may help the Discord set-up |

## What the founder would need to do (nothing was signed up for)

| Service | What you do | Cost | Time |
|---|---|---|---|
| Google Analytics MCP | Create a Google Cloud project, enable the Analytics Data and Admin APIs, make an OAuth client, and give it read access to Aamdani's GA4 property | Free | About 30 minutes |
| Google Business Profile API | Apply for API access (Google form) as owner or manager of the profiles; quota is 0 until approved | Free | 10 minutes to apply; approval can take weeks, so apply first |
| Google Ads MCP | Apply for a Google Ads developer token from a manager account; basic access is enough to read | Free | 15 minutes; approval takes days |
| Meta Ads connector | Connect with a Meta Business login and grant the read-only scope only | Free | 10 minutes |
| Sentry | Create a user auth token with read scopes (or an org token) for the projects Zoya should watch | Free Developer plan (1 user); Team plan from about $26 a month | 10 minutes |
| Buffer | Make a Buffer account, connect Instagram and Facebook pages, create an API key | Free: 3 channels; Essentials about $5 to $6 per channel a month | 15 minutes |
| Brevo | Make an account, verify the sending domain (DNS records), create an API key | Free: 300 emails a day | 30 minutes including DNS |
| Resend (optional) | Make an account, verify the domain, create an API key | Free: 3,000 emails a month, 100 a day; Pro $20 a month | 20 minutes |
| WhatsApp Business Platform | Meta business verification, a phone number not on the WhatsApp app, approve message templates | Per message by country (marketing highest); first 1,000 service replies a month per number free | Verification takes days |
| Uptime Kuma | Nothing to sign up for; one container on the same host (keep it off port 8787) | Free | 15 minutes |
| Stripe (later) | Create a restricted key with read-only permissions | Free | 5 minutes |
| Xero or QuickBooks (later) | Create an app in the developer portal and connect the business | Free; the ledger plan the business already pays | 30 minutes |

Tokens go in the local config file (`~/.config/allevia/allevia.env`), never in the repository.
