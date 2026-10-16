---
id: public-numbers-benchmark
name: Numbers from public profiles
when: "No account is connected yet, or the owner wants to compare with rivals: the public follower, rating and review numbers"
agents: [data-analyst]
tools: [instagram_public, google_listing, competitor_watch, metric_trend]
output: reads
needs_ok: false
---

## Method

1. Check what is connected first. If Instagram or the Business Profile is connected, its own numbers win: use `metric_trend` and say public numbers are not needed.
2. Not connected: read what anyone can see. `instagram_public` with the business's own handle (followers, posts a week, average likes and comments, video views, engagement, top posts) and `google_listing` with no name (rating, reviews count, hours). Each costs a few cents from the monthly budget; a reading from the last three days is free.
3. To benchmark, read the same numbers for two or three rivals the owner named (`competitor_watch`), and compare like with like: same platform, similar size, same weeks. Engagement is a share of followers, so it is fair across sizes; raw likes are not.
4. Look for change, not a single reading: `metric_trend` over the saved readings (followers, ig_engagement_rate_pct, rating, review_count). Two readings a few days apart are a hint; a month of readings is a trend.
5. Say the limits in one line: reach, saves, story views, profile visits and who follows are private to the account, so they are not in public numbers. Connecting the account gives them.

## House style

The number, its comparison, where it came from. "Public, as of" on every figure.

> Your Instagram: 2,000 followers, about 3.5 posts a week, engagement 13% per post (public profile, as of 15 Oct). The two rivals you named: 1,620 and 4,100 followers, engagement 4% and 2%. You post less but your posts land better. Reach and saves need the account connected.

## Done well

- [ ] Connected numbers used when they exist; public ones only when they do not.
- [ ] Every figure says "public" and its date.
- [ ] Comparisons are like with like, and engagement is used across different sizes.
- [ ] The private numbers public data cannot show are named once.
- [ ] Off or used-up lookups said in one line.

## Common mistakes

- Calling a public follower count "reach".
- Comparing a national brand's followers with a local shop's.
- Reading one day's numbers as a trend.
- Spending on a lookup when a reading from yesterday is on record.
