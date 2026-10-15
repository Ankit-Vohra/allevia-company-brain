---
id: number-grounding
name: Number grounding
when: "Tracing every figure in a draft or an analysis back to the record, with its period, source and date"
agents: [fact-checker, coe-lead]
tools: [search, get_entity, cypher]
output: reads
needs_ok: false
---

## Method

1. Extract every number from the text with what it counts, its unit, its period and its comparison: "41 sign-ups, week to 12 Oct, from 58 the week before". A number with no period is already a problem; mark it.
2. Find each in the record. `search` the metric by name, then `get_entity` on it to see its latest readings with dates. Use `cypher` only to read one exact observation (metric, subject, date) when the entity view is not enough.
3. Compare four things, not one: the value, the thing it counts (sign-ups are not accounts; visits are not sessions; revenue gross is not net), the period (a week is not 7 rolling days; check the dates), and the subject (the website is not the app).
4. Allowed: rounding to fewer digits ("about 40" for 41). Not allowed: changing digits, inventing a percentage the record does not hold, or adding numbers together that no tool returned. A difference you can only get by your own arithmetic is flagged "not in the record".
5. Check freshness: if the newest reading is more than 7 days old the text must say "as of <date>". If any reading is sample data it must be called "sample numbers" next to the number.
6. Two sources that disagree: report both with their dates; never average them or pick silently.
7. Verdict: ok when every number matches value, meaning, period and subject; fix with each mismatch as quote, what the record has, the correction; reject when the headline number is wrong.

## House style

Mismatches only, one line each: quote, record, correction. Then one line on freshness if it matters.

> Fix: "sign-ups up 30%" has no percentage in the record; say "from 41 to 53, week to 12 Oct". "1,200 visits" is for the month, not the week (week: 310).
> Fresh: newest reading is 4 Oct, so add "as of 4 Oct".

## Done well

- [ ] Every number was matched on value, meaning, period and subject.
- [ ] No percentage, sum or difference is accepted unless the record holds it.
- [ ] Freshness and sample-number wording was checked.
- [ ] Disagreeing sources are both shown, not blended.
- [ ] Each correction is a sentence the writer can paste.

## Common mistakes

- Matching only the digits and missing that the number is for a different period.
- Accepting a rounded figure that changed a digit (41 written as 48).
- Letting a plausible-sounding percentage through because it "looks right".
- Treating an older reading as current without the "as of" date.
