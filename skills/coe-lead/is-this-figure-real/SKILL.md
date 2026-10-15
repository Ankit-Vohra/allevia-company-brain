---
id: is-this-figure-real
name: Is this figure real?
when: "Checking a number before the owner sees it: right meaning, right period, fresh, not a sample or too small to read"
agents: [coe-lead]
tools: [get_entity, metric_trend, cypher]
output: reads
needs_ok: false
---

## Method

1. Open the metric with `get_entity` (id from the draft or found by search): read its definition, unit, subject, and its latest observations with dates and whether they are sample data.
2. Is it the right number? The draft's wording must match what the metric counts: sign-ups are not accounts, visits are not sessions, gross is not net, the website is not the app.
3. Right period and comparison? Run `metric_trend` for that metric, groupBy week, and check the draft's window against the dates. A partial week, a month called a week, or a comparison of unequal windows fails. Use `cypher` only to read one exact reading when the entity view does not show it.
4. Fresh? The newest reading older than 7 days must be written "as of <date>". Sample data must be called sample numbers.
5. Readable? A count under about 30 moving by a few is noise: the draft must not call it a trend. A rate needs its base.
6. Do two sources disagree? Say both with their dates; never average.
7. Verdict: ok; fix (quote the figure, what it should say); reject only if the main figure is wrong.

## House style

Failures only, one line each: the figure as written, what the record holds, the corrected wording.

> Fix: "sign-ups up 30% this week" - the week is partial (3 days); the last full week was 41, from 58. Say "down, from 58 to 41".
> Fix: the Instagram figure is from 28 Sept; add "as of 28 Sept".

## Done well

- [ ] The metric's definition matches the draft's wording.
- [ ] The period and comparison were checked against dates.
- [ ] Freshness, sample numbers and small-count warnings were applied.
- [ ] Each fix is a sentence the writer can paste.
- [ ] Disagreeing sources were both shown.

## Common mistakes

- Checking only that the digits exist, not what they count.
- Passing a partial week as a drop.
- Accepting "up 30%" with no figure behind it.
- Averaging two different sources.
