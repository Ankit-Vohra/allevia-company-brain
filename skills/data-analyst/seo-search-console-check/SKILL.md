---
id: seo-search-console-check
name: Search visibility check
when: "How the website shows up on Google: which pages to fix first for more visits"
agents: [data-analyst]
tools: [seo_report, metric_trend, content_performance, search]
output: reads
needs_ok: false
---

## Method

1. Read `seo_report` once. It returns pages worst first with failing checks (severity, evidence, how to fix), clicks, impressions, click-through rate, average position, low-click flags and the searches they rank for, plus a site summary. If it says Search Console is not connected, you only have a public-site check: say that, and "Connect Search Console to see clicks and rankings".
2. Sort pages into three buckets using the figures as returned. Easy wins: many impressions, average position about 8 to 20, so a better title and description can lift clicks. Leaks: many impressions and very few clicks (a weak or off-topic title). Dead weight: no impressions, thin or duplicated pages.
3. Check each top page answers the search it ranks for (the queries are in the report; `search` for the page's own text). A page ranking for "kitchen renovation cost" that never mentions a price will not convert.
4. Put the failing checks in business order: pages that bring or could bring customers first; severity second; a technical error on an unimportant page last.
5. Use `metric_trend` on clicks or impressions (groupBy week) to see whether visibility is rising or falling, and `content_performance` only to compare with social when the owner asks where to spend time.
6. Name the first two fixes with the page, the change and a time estimate. Anything older than 7 days says "as of <date>".

## House style

Verdict, then the top two pages to fix, in plain words, each with the change and time.

> Search brings you 310 visits a week (as of 12 Oct) and two pages hold back the rest. 1. /services shows 4,200 times a month but few clicks: rewrite its title (20 minutes). 2. /contact has no description: add one (10 minutes). Later: three thin pages.

## Done well

- [ ] Pages are bucketed (easy win, leak, dead weight) using the report's own figures.
- [ ] Fixes are ordered by what brings customers, not by error count.
- [ ] Each fix names the page, the change and the time it takes.
- [ ] Not-connected data is said plainly with what to connect.
- [ ] Dates and sample numbers are labelled.

## Common mistakes

- Listing every failing check, with no order.
- Fixing a technical error on a page nobody visits.
- Recommending keywords the page cannot honestly answer.
- Stating rankings without the date.
