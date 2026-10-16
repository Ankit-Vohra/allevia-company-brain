# Public data through Apify: setup, costs and what it gathers

Allevia's team can read public, business-level data the website crawl cannot give: the business's Google Maps listing
(address, hours, rating, reviews), its public Instagram numbers when the account is not connected, competitors' public
numbers and ads, and the public ad libraries. It runs Apify store actors in Apify's cloud through Apify's REST API
(`src/publicdata/apify.ts`), and only the actors on the allow-list (`src/publicdata/actors.ts`).

Off by default. With no `APIFY_TOKEN`, every public-data tool answers "Public data lookups aren't switched on" and
nothing else changes.

## What the founder does (about 5 minutes)

1. Create an account at [apify.com](https://apify.com). The free plan includes a monthly platform credit (a few dollars),
   enough for a few hundred lookups at the prices below; check the current amount on Apify's pricing page.
2. In the Apify console: Settings, API and Integrations, copy the **personal API token**.
3. Put it in the env file yourself (never in the repo, a chat or a ticket):
   ```
   # ~/.config/allevia/allevia.env
   APIFY_TOKEN=apify_api_xxxxxxxxxxxxxxxx
   # optional budgets, in US dollars (defaults shown)
   ALLEVIA_APIFY_MONTHLY_USD=2      # per business, per calendar month (UTC)
   ALLEVIA_APIFY_DAILY_USD=3        # all businesses together, per day (UTC)
   ```
4. Restart the server so it reads the file. To check the token once (spends under a cent, capped at $0.20):
   `APIFY_TOKEN=… npx vitest run tests/publicdata/live-smoke.test.ts`.

The token stays in the env file: it is sent only in the `Authorization` header to `api.apify.com`, never logged, never
put in a URL, an error message, the graph or a model prompt (the agents' environment is allow-listed and does not
include it).

## Budgets

Every run is estimated in dollars before it starts (the store price per 1,000 results, rounded up, plus a small start
allowance), reserved in a ledger (`<dataDir>/apify/spend-ledger.json`, locked so the server and the Discord bot share
one count), and refused in plain words when it would pass either budget:

- "This lookup would cost about $0.05, and this month's budget for public lookups ($2.00) has under 1 cent left. It
  starts again on 1 Nov."
- "Today's limit for public lookups ($3.00 across all businesses) is used up. Try again tomorrow."

A run that never started (a refused token, an empty account) is not counted; one that started and then failed or timed
out keeps its estimate; one that reports a higher cost is recorded at the higher figure. Each run also carries Apify's
own `maxItems` and `maxTotalChargeUsd` limits, and is stopped when it passes its time limit. A repeat of the same lookup
within 3 days is served from the business's graph and costs nothing.

## The tools, what each costs and what it gathers

Prices are Apify store prices per 1,000 results, approximate and rounded up; check the actor's page for today's.

| Tool (who has it) | Actor | Approx. price | One typical run | What it gathers and keeps |
|---|---|---|---|---|
| `google_listing` (Rohan, Kabir, Tara; onboarding) | `compass/crawler-google-places` | about $4 / 1,000 places | 1 place + 10 reviews: about $0.05 | Name, address, opening hours, category, website, rating, review count, whether it is closed; up to 20 recent reviews of the business itself (stars, date, the reviewer's first name at most, text through the privacy filter, whether the owner replied). For a competitor: rating and review count only, no reviews. The phone number is not kept. |
| `instagram_public` (Rohan, Kabir, Tara) | `apify/instagram-profile-scraper` (and `apify/instagram-post-scraper` when the profile has no recent posts) | $1.60 / 1,000 profiles; $1.00 / 1,000 posts | about $0.01 (up to $0.04 with posts) | A public business profile's followers, following, posts count, category, bio (filtered), and its latest posts' public likes, comments and video views; computed: posts a week, average likes and comments, engagement (likes + comments per post as a share of followers), top three posts. Private accounts give nothing. |
| `competitor_watch` (Rohan, Kabir, Tara) | the Instagram actors above, `apify/facebook-ads-scraper`, `s-r/google-ads-transparency` | ads: about $3.40 to $5 / 1,000 ads | up to 3 rivals: about $0.10 to $0.40 | Each rival as a Competitor (COMPETES_WITH the business) with its public Instagram numbers and the ads it runs, saved as dated readings so trends build over time. |
| `ad_library` (Rohan, Kabir, Tara) | `apify/facebook-ads-scraper` (by brand), `s-r/google-ads-transparency` (by website) | about $3.40 to $5 / 1,000 ads | 20 ads each: about $0.11 each | Ads in Meta's Ad Library and Google's Ads Transparency Center: the copy, title, button, link, format, placements, start and end dates, whether it runs now; reach only where the library shows it. |
| onboarding, when our crawler is turned away | `apify/website-content-crawler` | about $5 / 1,000 pages (compute) | 12 pages: about $0.08 | The text, title and description of the site's own public pages (other sites' pages are dropped). No SEO checks are run on them. |
| (allow-listed, no tool yet) | `apify/google-search-scraper` | about $5 / 1,000 result pages | 1 page: under 1 cent | Reserved for a later news-and-mentions tool. |

Two input shapes are written from the actors' published examples and are confirmed only by a live run:
`s-r/google-ads-transparency` (sent `startUrls` with the Transparency Center URL, `domains` and `maxItems`) and the
review fields of `compass/crawler-google-places`. The parsers accept camelCase and snake_case and skip what they cannot
read, so a changed field leaves a gap, never a wrong number.

## Where it lands

Only in the asking business's own graph (`ctx.graph`; no tool takes a tenant), with provenance on everything:

- a Document per lookup (kind `public`: source, the actor, the page it describes, `fetchedAt`, the cleaned result);
- the numbers as Observations, one per metric per day, `conf` 0.9 so a connected account's own measurement always wins,
  sourced from that Document;
- the business's listing as `channel:google-maps` (PART_OF the business), its Instagram handle on `channel:instagram`;
- each review of the business as its own Document (kind `review`).

The capability ladder (`src/capabilities/ladder.ts`) reads public-data numbers as the **public** rung, never as live:
reading the listing moves Business Profile and Reviews to "public"; reading the business's own Instagram moves
Instagram to "public" when it is not connected.

## The honest limits

- **Business-level public data only.** Public profiles and listings of businesses, and ads in public libraries. Never a
  private person's account, never private insights (reach, saves, story views, profile visits, who follows), which need
  the account connected.
- **Ad performance is hidden.** Meta's Ad Library shows spend and reach only for ads delivered in the EU or UK and for
  political and issue ads; Google's shows none. The tools never claim a rival's spend or results.
- **The platforms' terms prohibit automated collection** (scraping) of their sites. Apify runs the collection; Allevia
  reads only public, business-level facts, as little as a question needs, and keeps reviewers to a first name. This is a
  stopgap, not the long-term route for Instagram:
- **Meta's Business Discovery API is the replacement for Instagram scraping** once Allevia's Meta app passes App Review:
  it returns another business account's public followers, media count and recent posts' likes and comments through the
  official Graph API, with the connected account's token. When that is live, `instagram_public` should call it first and
  keep Apify only as a fallback.
- **Privacy.** Every text goes through the redaction filter (`src/ingest/redact.ts`): no e-mails, phone numbers or keys.
  The business's own phone number is not stored either, because the graph's privacy scan treats any phone number as
  personal until the owner confirms a contact card (onboarding gap 3).
- Apify is a processor: the queries (a business name and town, a handle, a brand, a website) go to Apify's cloud, which
  fetches the public pages and returns the results. The Privacy Policy lists it (`site/src/render/legal.ts`).

## Files

`src/publicdata/` (actors, client, ledger, service, normalize, write, enrich), `src/agent/tools/publicdata.ts`,
`shared/toolkits.ts` (toolkits `public-profiles` and `competitors`), the skills `competitor-ads-and-moves`,
`public-numbers-benchmark` and Tara's `instagram-post`, tests in `tests/publicdata/`.
