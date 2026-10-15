# Onboarding trials: can any company be onboarded from its website?

2026-10-15. Seven public sites nobody had hand-tuned, put through the real onboarding flow (`onboard()`, the same code
`POST /api/onboard` runs) on the Claude Code subscription: no API key, no spend, $0. Each went into a throwaway tenant
(`trial_<name>`, graph `allevia_trial_<name>`) on a private FalkorDB container, and every graph was deleted at the end.
The founder's question was "can we onboard anyone from a URL and build their graph, and sell that to everyone?"

## Verdict

**Onboarding from a URL generalises. The day-one product does not yet sell.**

- **Proven.** Six of seven sites onboarded without a hand-written adapter, in 1 to 13 minutes (one to four minutes for a
  normal site), with 8 to 14 model calls each. Five kinds of business (clinic, cafe, SaaS, garden centre with a shop,
  restaurant), three languages (English, German, Spanish), four site builders (WordPress, Squarespace, Shopify,
  custom). I read every site myself: the business profile was right on all six, and the brand voice was right on all six
  (the Viennese cafe's "address guests formally with Sie" and the Madrid restaurant's "write in Spanish" were both
  picked up). The privacy scan found nothing in any graph (0 hits across six graphs).
- **Broken, now fixed.** The founder's two onboardings hid seven generic defects that only a stranger's site shows (the
  table below and "What was fixed"). Two were serious: every site got the same three goals whatever it was (a dentist
  and a SaaS company both got "Enquiries per month, Instagram reach, Search clicks"), and a site that blocked us
  finished as "ready" with a plan for a business the team knew nothing about.
- **Not fixable by onboarding.** On day one all three goals read "We'll know after your first full week", the first
  Today's note says "Nothing new to flag today", and 0 of the 3 goals can be measured. Without customer connectors the
  graph is a good picture of the website and nothing else. The promise ("goals measured from real data") starts only when
  a number arrives, and for a new customer none can.

So: **any company with a public, readable website can be onboarded today, easily and for free. A company can not yet be
sold a working growth plan from that alone.** Selling to everyone needs the first connector (the spreadsheet upload,
below) before it needs anything else.

## The trials

Run with `npm run trial -- --name … --slug trial_… --url … --country …` (`scripts/trial.ts`). It sends what the web
form sends (name, URL, country and its money, time zone and spelling; no industry), counts every model call, then reads
back the graph, the goals, the capabilities and the first Today's note. Times are wall clock with up to four sites
running at once, so a lone run is a little faster; "calls" is model calls (1 brand, 1 profile, up to 12 pages read).

| | Weininger Family Dentistry | Prufrock Coffee | Plausible Analytics | Lay of the Land | Sobrino de Botín | Café Central | Casa Lucio |
|---|---|---|---|---|---|---|---|
| Kind | Dental practice, Ohio (WordPress) | Cafe and training, London (Squarespace) | Analytics SaaS, EU (custom) | Garden centre, cafe and Shopify shop, Yorkshire | Restaurant, Madrid (WordPress, Spanish, 6 MB pages) | Coffee house, Vienna (WordPress, German) | Restaurant, Madrid |
| Time | 59 s | 127 s | 177 s | 268 s | 467 s | 780 s | 10 s (ended) |
| Model calls | 8 | 14 | 14 | 14 | 14 | 14 | 0 |
| Pages crawled | 6 (all of it) | 40 (cap) | 40 (cap, sitemap lists 165) | 40 (cap) | 40 (cap) | 40 (cap) | 1 |
| What failed or went wrong | `sample-page` (a WordPress leftover) read as a page | 22 of 40 pages were blog posts; `blog?offset=` copies used 2 more; 1 page 404 | Crawled `/login` (reached through a link to `/sites`); SEO says 27 titles too long | 37 of 40 pages were product listings, so the cafe, nursery and visit pages were never read | Crawl alone took 391 s (6 MB pages); 3 of 40 pages were the same home page in English, French, German | Crawl took most of the 13 minutes; `home`, `home-2`, `test-social` stale pages | Every request answered HTTP 429: blocked |
| Profile right? | Yes: family dentist, Tiffin, open since 1917, Dr Weininger the fourth dentist | Yes: Leather Lane since 2011, made from scratch | Yes: privacy-friendly, EU, team of 10, claims reported as claims | Yes: family garden centre, Settle, founded 2011, cafe | Yes (in English): oldest restaurant (1725), hours, reservations by page | Yes: Viennese coffee house, closed for renovation until winter 2026, sister venue DECENTRAL | Nothing to judge |
| Brand voice right? | Yes: warm, family, teal | Yes: stark black and white, Bebas Neue, direct | Yes: indigo CTA, plain, numbers | Yes: cream and lime, playful, named trees | Yes: sober, literary, "write in Spanish" | Yes: burgundy, formal "Sie" | n/a |
| Goals before the fixes | Enquiries, Instagram reach, Search clicks | same | same | same | Calls and directions, Instagram reach, Search clicks | same | Enquiries, Instagram reach, Search clicks |
| Goals after the fixes | New booking enquiries, Search clicks, Calls and directions from Google | Calls and directions, Instagram reach, Search clicks | Weekly signups, Search clicks, Website visits | Enquiries, Instagram reach, Search clicks (the model called it a local business) | (as before) | (as before) | no plan written; "We could not read www.casalucio.es: the site asked us to slow down. Try again in a few minutes." |
| Graph, own nodes | 42 (of 341 in total) | 88 (of 532) | 130 (of 824) | 77 (of 591) | 38 (of 535) | 50 (of 549) | 0 |
| Graph quality | Clean: 10 services, 3 audiences, 4 people (three dentists past and present, and the hygienist); no duplicates | 21 Business nodes, 20 of them suppliers (roasters, a butcher, Royal Mail); Food / Food & drinks duplicate; 20 blog posts as Content | 45 Features of which about 15 are near-duplicates ("Funnels", "Funnel analysis", "Funnels and user journeys"); 8 Business nodes, 7 third parties; 2 Decisions from a blog (fixed) | 63 Products were plant cultivars (fixed to 20); Twitter and X channels twice; 4 staff first names as People | Only 4 Products (menu PDFs: "Speisekarte des Hauses" is a German menu title); 1 Person is a username | 4 Events for one renovation (German and English); 2 online-shop Channels; 3 staff names | n/a |

"Own nodes" are the business-specific ones: everything except pages, documents, chunks and the 236 nodes every tenant gets
from the playbooks (175 benchmark and SEO rules, 60 Google update events, 6 playbooks) and the plan scaffolding. The
"N nodes in the graph" the run reports counts all of them, so it overstates what was learned by about 5 to 10 times.

### What the owner sees on day one (after the fixes)

Same shape for every site:

- **Three goals**, each "We'll know after your first full week" with a number from the template: for the dentist
  "New booking enquiries per month, goal 10 by 13 Jan", "Search clicks, 50", "Calls and directions from Google, 50".
  The targets are the template's floors, not the business's: no baseline exists.
- **What your team can see.** Search Console: public pages (the crawl). Studio: public pages (images on the site).
  Ads: industry guess (benchmarks). Website analytics, Business Profile, Reviews: not connected. Instagram: public pages
  only if the site links to a real profile (Prufrock, Lay of the Land, Botín), otherwise not connected. Before the fix,
  Instagram read "public pages" for the dentist and the SaaS company, who have none.
- **The first Today's note:** the three goals, then "1 new number came in" (the SEO score, which means nothing to an
  owner), "Nothing new to flag today", "Nothing" waiting for their OK, "Nothing needs you today."

### What is missing for the agents to be useful, in numbers

With no connector data the graph holds 3 Observations in total (the site's SEO score and the two Day-0 counters of the plan) and no
measured goal.

- **Can answer:** what the business sells and for whom; how its site speaks and looks (colours, fonts, tone, do's and
  don'ts); what is wrong with the site (14 failing checks on the dentist's 6 pages, 127 on Prufrock's 40); who runs it
  and how long it has been open; what is on each page, with the page as the source.
- **Cannot answer, and why:**
  - How many people visit, from where, and what they do (GA4: not connected). 0 of 1 capability.
  - Which searches bring people, where the site ranks, which pages are not indexed (Search Console).
  - Calls, direction requests, reviews and ratings (Business Profile; 2 capabilities).
  - Reach, followers, best post (Instagram insights).
  - Orders, bookings, enquiries, revenue, signups: nothing in the graph can answer them, with or without Google. This is
    the main goal of every template, and it needs the owner's own numbers.
  - Ad spend and results (no ads connector; only industry benchmarks).
  - "Why did it go up or down last week": nothing to compare.
  - The business's phone number and email: the privacy filter redacts them on purpose (`[redacted:phone]`), so even
    "what is our number?" has no answer. Hours, address and prices are only text in a page chunk, not facts.
- **Detectors.** 20 detectors run over the graph. On a crawl-only graph 0 to 2 produce anything: the dentist 0, Prufrock
  2 ("Fix 1 high-severity SEO issue on /terms", "1 page not in Google's index"), and the two sites with Decisions read off
  blogs produced "2 decisions with no evidence on record" (fixed).
- **Goals.** 0 of 3 measurable on every site. A goal reads its number from Observations through its template's
  `sources`; nothing writes those for a new tenant.

## What was fixed

Every fix has a test written first (it failed on the old code). All are generic: none names a site.

| Commit | Defect found | Fix | Test |
|---|---|---|---|
| `c37dc21` | A link that redirects to a login page was read as a page (Plausible `/sites` to `/login?return_to=`). A link that redirects into a path robots.txt disallows was requested. `?offset=`, `?page=2` and `?sort=` copies of a blog used the page cap. | The crawler judges every redirect hop before following it (off-site, login or cart, robots.txt); list copies are skipped as "listing variant". | `tests/ingest/website/crawl-trials.test.ts` |
| `c37dc21` | "Instagram: public pages" for businesses with no Instagram: the playbooks put a bare Channel anchor in every graph and the ladder counted it as a profile. | A rung needs a Channel that is PART_OF the business. | `tests/capabilities/bare-channel.test.ts` |
| `89200dd` | Every site got the local-business template, so goals did not fit the business: the web form sends no industry. | The profile question now returns an industry label and a kind; four new templates (software or app, online shop, cafe or restaurant, clinic or salon); the owner's own words still win. `Business.industry` is filled, which the Studio prompts and the benchmark match use. | `tests/onboard/templates-kinds.test.ts`, `onboard-kind.test.ts` |
| `c231f7a` | 37 of 40 pages were product listings; "/pages/cafe" scored below "/collections/roses"; the 12 pages the model reads were mostly collections. | `keyPagePriority` sees through the `/pages/` wrapper and knows visit, cafe, treatments, new patients, opening hours; one section may take at most 30% of the crawl and 3 of the 12 pages read while other sections have pages. | `tests/ingest/website/key-pages.test.ts`, `crawl-trials.test.ts` |
| `60ec13b` | A site that blocked us (HTTP 429) ended as "ready", 279 nodes, three goals. The receipt said "175 website fixes" (it counted the playbook rules too) and "services" for a shop's products. | The run says why in plain words ("the site asked us to slow down") and stops before the plan; the receipt counts failing checks and says products and services. | `tests/onboard/onboard-unreadable.test.ts` |
| `f47716f` | Blog posts became Decision nodes and a jobs page a Task; the knowledge detector then said "2 decisions with no evidence". | A website yields no Decisions or Tasks, nor relations that touch them. | `tests/ingest/website/web-types.test.ts` |
| `9a8ab79` | A Madrid restaurant onboarded as United Kingdom (pounds, London time): the form had no closer country, and Canada, Ireland, New Zealand and Singapore were on the form with no backend defaults. | Spain, Germany, France, Italy, Netherlands, Austria added; the four missing ones given defaults. English spelling everywhere. | `tests/onboard/region-eu.test.ts` |
| `11b5a05` | One crawl took 13 minutes, and a page whose script never lets go would hang the browser's own calls forever (they have no timeout). | A hard limit on each browser job (the stuck context is dropped, the page recorded as failed) and a 5-minute budget for the whole crawl (`timedOut` on the result). | `crawl-trials.test.ts` |
| `87a3cf2` | The hygiene scan read a metric name as a credential. | Allowed by name, with the reason. | `tests/hygiene.test.ts` |

The privacy filter stayed on throughout, and `src/graph/safety.ts`, `src/graph/schema.ts` and the index code were not
touched. One test expectation changed on purpose: "bakery" used to be the example of a trade with no template; it now has
one (`plumber` takes its place). Three small web edits were needed for the receipt and the country list
(`web/src/pages/Onboard.tsx`, `web/src/lib/format.ts`); the web app was not built or run here.

## The top five gaps, ranked by impact on a real customer

1. **No customer data: nothing to measure.** 0 of 3 goals can be measured on day one, the first Today's note is empty,
   and 18 to 20 of 20 detectors cannot fire. The plan the owner is asked to OK is a template with floors, not a
   plan. Everything that makes Allevia more than a website audit starts with a number from the business. See the design
   note below; the spreadsheet upload is the cheapest way in.
2. **Nothing can be done for the owner: fixes only go to GitHub.** The crawl finds 14 to 144 failing checks per site, but
   the one action that carries them out, `github_issue`, runs against a single repo in the server's config
   (`ALLEVIA_ACTION_REPO`, default Allevia's own), and an owner on WordPress, Squarespace or Shopify has no repo. A
   customer's findings would land in Allevia's issue tracker. Day one therefore shows no recommendation by design: running
   the SEO detectors at the end of onboarding would put approval cards in front of owners that cannot be carried out.
3. **The facts an owner expects the team to know are not facts.** Phone and email are redacted by the privacy filter
   (by design: but the business's own public number is not personal data), hours, address and prices are text in
   chunks, and catalogues are samples (20 of Lay of the Land's products, however many it sells). "What are our hours?"
   works only by searching page text. Needs a business contact card the owner confirms, with the public details
   allowed through.
4. **Graph quality at 5 to 30% noise.** Near-duplicates are not merged (about 15 of Plausible's 45 Features; Twitter and
   X; four Events for one renovation), because the librarian only merges Systems, Channels and Products with equal names
   and does not run at onboarding; third-party businesses (suppliers, vendors) are typed `Business` like the owner's own
   (20 of 21 on Prufrock's graph), and staff first names become People. `findBusinessId` picks the business among 50 by
   degree, so a long supplier list is a risk. The run's "N nodes in the graph" counts 236 shared playbook nodes.
5. **Reach: sites we cannot read, or read slowly.** A site that blocks the crawler (1 of 7) cannot be onboarded at all:
   there is no fallback (paste your text, upload a brochure, point us to your Instagram). Heavy sites take 8 to 13
   minutes (now capped at 5 for the crawl); only the first 40 pages are read; the key-page rules are English words
   ("visit", "treatments"); the form lists 15 countries; agents do not know the site's language (the German cafe's
   posts would be drafted in English unless a brand rule says otherwise). Single-page apps that render with scripts are
   handled by the browser crawler, but the only ones tried were Squarespace and Shopify.

Not ranked, but seen: one onboarding process died with SIGBUS (exit 138) while four ran at once on a laptop; a re-run of
the same site succeeded and I could not reproduce it. A failed run leaves the tenant in the registry with a graph
that has a business and no content.

## Reproduce

```
docker run -d -p 127.0.0.1:6398:6379 falkordb/falkordb:6.0.2        # a private server: do not use the shared one
export ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6398
npm run trial -- --name "Weininger Family Dentistry" --slug trial_weininger --url https://www.weiningerfamilydentistry.com --country "United States"
npm run trial -- --delete trial_weininger                              # only trial_* graphs
npx tsx scripts/crawl-probe.ts https://example.com 40                  # where a slow crawl spends its time
```

## Design note: the customer data connectors we do not have

Today the only numbers a new business has are the crawl's (SEO checks, one site score). None of the three goals can be
measured, so the plan is the template's. The capability ladder (`src/capabilities/ladder.ts`) already has the rungs
for this: `api`, `delegated`, `upload`, `public`, `benchmark`. What is missing is the way in. Five candidates, with what a
customer does, what it costs us to build and what stops us.

| Connector | What the customer does (target: under 2 minutes) | What it unlocks | Build cost | What can stop us |
|---|---|---|---|---|
| **CSV or spreadsheet upload** | Taps "Add your numbers" on a goal, drops a file (or pastes from a sheet), checks a three-row preview ("Column B is orders per day, 1 to 31 Oct"), taps OK. About 60 to 90 seconds. | Any number the business already has: orders, bookings, enquiries, signups, a GA4 or Search Console export, a POS or Shopify export. Works for every business and country. | About 1.5 days: parser, column mapper, preview card, writes. No approval from anyone. | Nothing external. One column-mapping model call per file, cached. |
| **Search Console** | Copies one email address shown on screen, opens Search Console, Settings, Users and permissions, Add user, pastes it, picks Restricted. We check it and the card turns green. About 90 seconds for someone who owns the property. | Clicks, impressions, CTR, position, queries and pages: the "Search clicks" goal and the detectors `seo.low_ctr`, `seo.not_indexed`, `seo.sitemap`. | 1.5 to 2 days: service account, `searchanalytics.query`, daily sync, health check. | The owner often does not own the property (a web agency does): give them a "forward this to your web person" email. Google caps service accounts per project (100 by default), so one per tenant needs a plan. |
| **GA4** | Same shape: copy the email, Admin, Property access management, add it as Viewer. About 90 seconds. | Visits, sources, conversions: the "Website visits" goal and the funnel detector. | 1.5 to 2 days after Search Console (same service-account plumbing). | Same; and a GA4 property must exist (many small sites have nothing or only the old Universal Analytics). |
| **Instagram** | Connects the account to Allevia's Meta partner portfolio (three taps in Meta Business settings) or logs in with Instagram Login. About 2 minutes. | Reach, saves, follower growth: the "Instagram reach" goal, the content detectors. | 2 days of code, weeks of waiting. | Meta App Review for Advanced Access. AVS Atelier works today only through a hand-made long-lived token. Start the review in month 1. |
| **Google Business Profile** | Adds Allevia's ops account as Manager on the listing. About 2 minutes. | Calls, directions, website clicks, reviews: the "Calls and directions from Google" goal (cafes, clinics) and the reviews capability. | 2 days of code, weeks of waiting. | The Business Profile API quota is 0 until Google approves access. Apply now. |

**Cheapest first: the spreadsheet upload.** It is the only one with no external dependency, it works for businesses with no
Google accounts set up (the common case for a first-time customer), and it fills the numbers no connector can: orders,
bookings and enquiries live in the owner's shop system, diary or inbox, not in Google. The ladder already treats numbers
from an upload Document as the `upload` rung, and a goal reads them through the same `MetricSource` contract
(`orders`, `enquiries`, `new_accounts`, `gbp_actions`, `ga4_sessions`, `gsc_clicks`, `account_reach`), so the build is the
front half only. **Second: Search Console** (least friction after the upload, feeds three existing detectors, the one
every owner has heard of). **Third: GA4**, on the same plumbing. Instagram and Business Profile are gated by approvals:
file those requests this week and build behind them.

**The 2-minute flow for the upload, as the owner sees it** (words from `docs/owner-words.md`):

1. Home says: "Orders per month: we'll know after your first full week. **Add your numbers** to know today."
2. They drop a file or paste from a sheet. We read it (one model call, cached by file hash) and show: "We found a date in
   column A and *orders* in column C, from 1 Sep to 14 Oct. Is that right?" with three sample rows.
3. They tap OK. We write one Observation per day (or per window), `src` a Document `{kind:'upload'}`, so the capability
   reads "from files you uploaded" and every answer that uses it says so. "Where you started" locks from the file, with
   no wait for a full week.
4. Next month: "Add this month's numbers" in Today's note, or later a Google Sheet link we read on a schedule.

What to build in so the upload does not become a support burden: refuse files with personal columns (the privacy filter
runs on every cell and the header), cap at 20 MB and 50,000 rows, accept CSV, XLSX and pasted text, and never overwrite a
day that has a connector reading.
