# Demo business: Blue Tokai Coffee Roasters (`bluetokai`)

A real, well-known Indian coffee roaster, set up from its public website and public data through the same pipeline a customer
goes through, with the private side (orders, money, analytics, ads, errors, inbox) added as **sample numbers** and always marked so.
In the app the business switcher reads "specialty coffee roaster (public data plus sample numbers)"; every sample node carries
`simulated: true`, which the screens show as "sample numbers"; Your tools shows Gmail, Calendar and Shopify as connected, each
with the line "Sample data for this demo".

## What is real and what is sample

| Real (public, read by onboarding on the server) | Sample (made by `seed-sample`, marked `simulated`) |
|---|---|
| The website's pages, products and prices, brand colours, fonts and tone, the website check | Eight weeks of orders by channel (online store, subscriptions, quick-commerce apps, wholesale), by city and by product |
| The Google Maps listing: address, hours, rating, review count, recent reviews (reviewers' first names at most) | Revenue, refunds, abandoned checkouts, the checkout's four steps, how people paid (UPI, card, other) |
| Public Instagram numbers: followers, posts, likes, comments, views | Instagram reach and visits from Instagram (private to the account) |
| Ads in Meta's Ad Library and Google's Ads Transparency Center, for the business and the rivals named | Ad spend and results of three sample campaigns |
| Rivals' public Instagram numbers and ads | Website visits (analytics) |
| | The checkout release, its error log, the payment gateway |
| | A sample inbox (a wholesale enquiry, a gifting enquiry, a UPI complaint), a sample calendar, sample Shopify data |
| | Wholesale accounts (made-up cafés and offices), staff as roles ("Web lead (sample role)") |

Rules the seed keeps: no statement is put in a real person's mouth (people the website names exist in the graph and say nothing);
staff are roles, never names; customers in the sample inbox are made-up names at `.example` addresses; the wholesale accounts are
made-up businesses; a product the crawl found keeps its real name and price, and only its sales are sample. When the crawl finds
no products, a small fixed list of products marked "(sample product)" is used instead. The "new roast" the sample campaign sells is
a sample product. The growth plan's goals count real numbers only, so on this demo they say "We'll know after your first full
week": sample numbers never move a goal.

## The story in the sample numbers ("Why did online orders drop this week?")

Every step is an edge in the graph:

1. **A checkout release on Monday** (`event:sample-release-checkout-4-12`) changes the payment step (`AFFECTS` the payment page).
2. **UPI payments start timing out**: the release `AFFECTS {how: introduced}` a new error in the error log
   (`event:sample-error-upi-timeout`), which `AFFECTS {how: breaks}` UPI payments at checkout. UPI failures go from about 12% of
   attempts to about 41%.
3. **Checkout completion falls**: "order placed" `DEPENDS_ON` UPI payments; the last step loses about 28% of payment attempts,
   against about 13% before.
4. **Online-store orders fall about 18%** against the same days a week earlier. Card orders, website visits, subscriptions and
   quick-commerce hold, so it is the payment step, not demand.
5. **The money wasted**: the Meta campaign for the new roast `DEPENDS_ON` the payment page and kept spending about ₹26,000 a day
   while its purchases fell about a third.

Also linked: a customer's complaint in the sample inbox `MENTIONS` the error; the online store `DEPENDS_ON` the real website
channel; every number is `SOURCED_FROM` a sample export that the sample Shopify connection `PRODUCED`, which the business `OWNS`.

**The red herring:** Instagram reach (sample) dropped about a quarter nine days *before* the release, and online orders did not
move that week. The brain should rule it out.

Dates are relative to when `seed-sample` runs: the release is the latest Monday with at least three full days after it. Run it
Wednesday to Sunday for a "this week" story (on 17 or 18 October 2026: release Monday 12 October); `--now` pins it.

## The five live scenarios to try (mirrors [live-scenarios.md](live-scenarios.md))

| # | Scenario | What to look for |
|---|---|---|
| 0 | The hero: **"Why did online orders drop this week, and what should we do?"** | The chain above with dates; "proven" for the release and the error, "likely" for the link to the drop; card orders and visits held; the ad spend wasted; sample numbers said to be sample; the fix card waiting |
| 1 | **Onboard from the URL** (already done by the commands below; for a second run, Add a business in the web app) | Pages, real products and prices, brand kit, website check, the Google listing and its reviews, Instagram and ads read through public data |
| 2 | **An unscripted question on Discord**, e.g. "Did the Instagram reach drop cause it?" or "What breaks if UPI payments keep failing?" | "No" with the dates (the dip came nine days earlier); depth 1 against depth 4 from the UPI payments node (order placed, the online store, the campaign) |
| 3 | **"Poster for Insta with my logo"** | The logo and fonts from the real website; it asks what the poster is for before making one |
| 4 | **The team notices something and drafts it** (Approvals / Today's note) | Waiting: the fix for the UPI error (sample), Deal Closer's reply to the café's 40 kg a month enquiry with three free times from the sample calendar, a reply to a real Google review, a post; the campaign's pause card (sample) |

Also worth asking: "Reply to the wholesale enquiry" (Deal Closer reads the sample inbox, offers three free times from the sample
calendar, waits for OK), "How many orders did Shopify show this week?" (sample Shopify), "Who complained about payments?".
Approving the email or a meeting is a dry run unless `ALLEVIA_ACTIONS_LIVE=1`, and even then it reaches nobody.

## Building it on a fresh server

On the server (its own FalkorDB on 127.0.0.1:6390, Claude logged in, Chromium installed), from the repository:

```bash
git pull && npm ci

# 1. onboard from the website, exactly as the web app does; APIFY_TOKEN for this run only (public data: listing, Instagram, ads)
APIFY_TOKEN=<token> npm run cli -- onboard https://bluetokaicoffee.com \
  --slug bluetokai --name "Blue Tokai Coffee Roasters" --country India \
  --industry "specialty coffee roaster" --vertical "online shop" \
  --instagram bluetokaicoffee \
  --rival "Third Wave Coffee|thirdwavecoffeeindia|thirdwavecoffee.in" \
  --rival "Sleepy Owl Coffee|sleepyowlcoffee|sleepyowl.co" \
  --max-usd 1

# 2. the sample layer, then enrol, insights, the stand-up and Today's note (no paid pictures; words written on the subscription)
npm run cli -- seed-sample bluetokai --profile coffee

# 3. so the server picks up the new code (the sample connections), and, with owner links on, opens the business read-only to everyone
sudo systemctl restart allevia-server allevia-bot
npm run cli -- auth:demo bluetokai        # only when ALLEVIA_AUTH=1

# 4. check it
npm run cli -- program bluetokai
npm run cli -- ask bluetokai "Why did online orders drop this week, and what should we do?"
```

Check the Instagram handles and websites of the business and the rivals before step 1: a wrong handle costs under a cent and
reads nothing. Re-running step 1 is safe (the same slug, everything merges); re-running step 2 re-dates the sample week to the
new day. To keep the server's own morning stand-up from paying for pictures, set `ALLEVIA_STANDUP_PAID_PER_DAY=0`.

**Public-data cost of step 1**, quoted before anything runs and capped by `--max-usd` (and by the $2 a month per business budget):

| Read | Actor | Cap | At most |
|---|---|---|---|
| Google Maps listing, 10 newest reviews | `compass/crawler-google-places` | 1 place, 10 reviews | $0.054 |
| The website, only if our reader is turned away | `apify/website-content-crawler` | 12 pages | $0.080 |
| Public Instagram (own + 2 rivals) | `apify/instagram-profile-scraper` (+ `apify/instagram-post-scraper` when a profile shows no posts) | 1 profile (+12 posts) each | $0.024 each, $0.072 |
| Meta Ad Library (own + 2 rivals) | `apify/facebook-ads-scraper` | 20 ads each | $0.110 each, $0.330 |
| Google Ads Transparency (own + 2 rivals) | `s-r/google-ads-transparency` | 20 ads each | $0.110 each, $0.330 |
| **Total** | | | **at most $0.87**; typically about $0.70 (no fallback crawl, posts in the profile) |

## Tests (offline)

`tests/demo/bluetokai-flow.test.ts` runs the whole flow on the test FalkorDB (6391): the operator's onboarding on a hand-made
fixture site (`tests/fixtures/bluetokai/site`, read by the real crawler without a browser), the model's answers canned, public
data answered from Apify-shaped fixtures (`tests/fixtures/bluetokai/apify`), then `seed-sample`. It checks the hero chain as
edges, the numbers behind it, the red herring, that everything sample is marked and the real layer is not, that nobody real says
anything, the four cards waiting, the sample connections, and that approving the email is a dry run. Neither the live website nor
Apify is ever called by a test; the fixtures are hand-made in the actors' published shapes, not recordings.
