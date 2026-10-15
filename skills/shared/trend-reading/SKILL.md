---
id: trend-reading
name: Reading a trend honestly
when: "Saying whether a number is really up, down or flat, and how sure we are"
agents: [data-analyst, coe-lead, growth-marketer, oncall-engineer, qa-release]
tools: [metric_trend]
output: reads
needs_ok: false
---

## Method

1. Pull the series with `metric_trend` for one metric and one subject, groupBy week for anything that counts events (sign-ups, visits, orders), starting at least 6 weeks back so you can see normal swings. Use the first, last, min, max, delta and pctChange the tool returns; never calculate your own percentages. If you need a difference it did not return, write "from 58 to 41".
2. Compare like with like. Full weeks only: drop a partial latest week or say it is partial. Same weekdays (a Monday-heavy business looks bad on a short week). A rate (conversion) is not a count (visits): do not mix them.
3. Judge size against normal swing. Look at the min and max over the earlier weeks: a move inside that range is noise. Rule of thumb for small numbers: a change of a few on a base under 30 is not a trend. A trend needs at least 4 to 6 points moving the same way, or one move clearly outside the normal range with a known cause.
4. Look for a reason before saying "trend": a campaign that started or ended, a holiday, a launch, an outage, a tracking change. A one-off spike followed by a return is not growth.
5. Say the newest reading date. If it is older than 7 days, write "as of <date>". If readings are sample data, call them sample numbers.
6. Use one of four plain verdicts: up, down, flat, too early to tell, with how sure you are (clear, likely, a hint).

## House style

The verdict word first, then the two numbers with their weeks, then how sure.

> Sign-ups are down: 41 in the week to 12 Oct, from 58 the week before. Earlier weeks ranged from 52 to 63, so this is outside the usual swing. Reason not yet known.
> Visits are flat: 310, from 305. Too small a move to read.

## Done well

- [ ] The numbers and change figures are the ones the tool returned, with their weeks.
- [ ] A partial week was dropped or flagged.
- [ ] The move was compared with the normal swing before being called a trend.
- [ ] The verdict word is plain: up, down, flat, or too early to tell.
- [ ] The as-of date and sample numbers were handled.

## Common mistakes

- Calling a 3-sign-up change on a base of 20 a trend.
- Including the current unfinished week and reading it as a drop.
- Explaining a movement with a cause nothing in the record shows.
- Mixing a rate and a count in one sentence.
