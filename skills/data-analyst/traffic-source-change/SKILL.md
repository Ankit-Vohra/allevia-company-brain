---
id: traffic-source-change
name: Why visits or sign-ups changed
when: "Visits or sign-ups went up or down and the owner wants to know which source explains it"
agents: [data-analyst]
tools: [metric_trend, seo_report, content_performance, search]
output: reads
needs_ok: false
---

## Method

1. Confirm the change is real first: `metric_trend` on the total (visits or sign-ups), groupBy week, last 6 weeks, using the delta and pctChange the tool returns. A move inside the normal weekly range is noise: say so and stop.
2. Split by source. Call `metric_trend` without a subject to list what exists, then for each source subject you find (search, direct, social, referral, ads) read the same weeks. The source whose change is largest and moves the same direction explains the most; give the numbers per source, not a computed share.
3. Check the usual suspects for that source. Search: `seo_report` for a page that lost clicks or position, or a low-CTR flag. Social: `content_performance` for a post that spiked or the posting that stopped. Ads: whether a campaign started or ended (`search` for the campaign). Anything with a date: a holiday, a launch, a price change, an outage (`search`).
4. Check measurement: a source that suddenly reads zero is usually a broken tag or a lost connection, not zero people. Say that when a series stops at a clean date.
5. State confidence: one source clearly explains it; several small sources; or cannot tell. Name what you could not check because a connection is missing ("Connect Search Console to see this").
6. Newest reading date, and sample numbers named if they are.

## House style

Answer first: the change, the main source, how sure. Then the source numbers and one next action.

> Sign-ups fell from 58 to 41 in the week to 12 Oct. Most of it is search: visits from search went from 190 to 120; other sources moved by a few. Likely cause: the services page lost its ranking (position 6 to 14, Search Console). Next: check the page title was not changed (5 minutes).

## Done well

- [ ] The change was confirmed outside normal swing before explaining it.
- [ ] Per-source numbers are shown for the same weeks, not computed shares.
- [ ] A dated event (campaign, post, launch, outage) was checked.
- [ ] A tracking break was considered before blaming people.
- [ ] Confidence and missing connections are stated.

## Common mistakes

- Explaining a normal wobble.
- Naming one cause when two sources moved together.
- Missing that a source dropped to zero because tracking broke.
- Using the unfinished current week.
