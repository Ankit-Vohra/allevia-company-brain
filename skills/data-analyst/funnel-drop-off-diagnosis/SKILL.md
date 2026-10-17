---
id: funnel-drop-off-diagnosis
name: Where people drop off
when: "Why fewer people finish a sign-up, booking or enquiry, and at which step they leave"
agents: [data-analyst]
tools: [search, cypher, metric_trend]
output: reads
needs_ok: false
---

## Method

0. Where the flow is mapped as steps (nodes named like "Seekers: Phone number entered", kind funnel_step), read them all at once: `metric_trend` with metric funnel_users and no subject gives every step's first and last value, change and, when a step's level stepped, the date it did (shift: at, before, after). The first step whose level steps is where the flow breaks; later steps fall with it. Name that step and the date.
0b. Also read the daily counts that feed the top of the flow, by day: new accounts, active app users, sessions (`search` for their metric names, then `metric_trend` groupBy day with no `from` limit shorter than three weeks). Each comes back with its shift when the level stepped, so you can say "daily active app users fell from about 130 to about 25 from 28 Sep" with the date from the tool, and whether the step counts moved the same day. A count that is only a 28-day total has no date to compare: say so instead of reading a trend into it.
1. Find the steps the record has. `search` for the funnel's metrics (visits, started, finished, or page views of the form) and use `cypher` to list the exact metric names and subjects with their latest dates. If only the first and last step exist, say so: you can see that people are lost, not where.
2. Get each step as a weekly series with `metric_trend` (groupBy week, last 6 weeks). Use the numbers and ratios the tool returns; never compute a rate yourself. Where you need a step-to-step comparison write "from 310 visits to 22 started".
3. Separate two different problems. Fewer people arrived (the top fell; the cause is traffic, go to the traffic-source question) versus the same people arrived and fewer finished (a step broke). Compare the first and last steps over the same weeks to tell which.
4. Find the biggest step-to-step loss and whether it moved. Check the usual causes in order: a broken or slow step (errors, a form field that now fails), mobile only (check device split if it exists), a changed form or price, a new traffic source filling the top with people who will not buy.
5. Say how sure you are: the step is clear and the cause is checked; the step is clear but the cause is a guess; or the data cannot locate it.
6. End with the one thing to check first and who owns it (`search` the owner of the form or system).

## House style

The answer first: where people leave and whether it changed. Then at most three numbers, then what to check first.

> People are leaving at the form: 310 visited the booking page and 22 started it in the week to 12 Oct; a month ago it was 305 and 41. The top is flat, so it is the form, not the traffic. Check first: does the phone number field accept spaces? Owner: Techie.

## Done well

- [ ] The loss is placed at one step, with that step's numbers and weeks.
- [ ] "Fewer arrived" and "fewer finished" were told apart.
- [ ] No rate or percentage that a tool did not return.
- [ ] The cause is labelled checked, or a guess.
- [ ] One thing to check first, with an owner.

## Common mistakes

- Blaming the page when the traffic mix changed.
- Comparing a partial week with a full one.
- Naming a cause (the new button colour) the record gives no sign of.
- Missing that only two steps are recorded and pretending to locate the loss.
