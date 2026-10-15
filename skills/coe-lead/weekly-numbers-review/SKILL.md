---
id: weekly-numbers-review
name: Weekly numbers review
when: "How the business did this week: the few numbers that matter, what moved, and what to do"
agents: [coe-lead]
tools: [metric_trend, important, get_entity, search]
output: reads
needs_ok: false
---

## Method

1. Choose the numbers: the owner's goal metrics first (`search` for the goals, `get_entity` on each to see its metric and where it started), then what is most central to the business (`important` for the most connected things) until you have at most three. Three is the limit an owner reads on a phone.
2. Read each with `metric_trend`, groupBy week, last 4 to 6 weeks, full weeks only. Use the tool's delta and pctChange for the comparison with last week. If it has no reading, write "We'll know after your first full week".
3. Decide each one's word: Going well, Needs a push, or Behind, with one line why (against the goal, not just last week).
4. Find the one thing that moved most and a first guess at why, with how sure you are (checked, likely, a guess). Pass the "why" to analytics if it needs a deeper look rather than inventing a cause.
5. Check the newest reading dates. Older than 7 days: "as of <date>". Sample figures: "sample numbers".
6. Finish with one next action the owner can take in under two minutes.

## House style

One line on how the week was, then up to three numbers, each with its comparison, then the next action.

> A good week for enquiries: 41, from 33 last week (full week to 12 Oct).
> Enquiries 41, from 33: going well, 41 of the 60 a week you want. Website visits 310, from 305: flat. Instagram saves 18, from 31: needs a push.
> Next: approve the two drafts waiting (2 minutes).

## Done well

- [ ] No more than three numbers, each with its comparison and week.
- [ ] Each has one word (Going well / Needs a push / Behind) and a line why.
- [ ] Only full weeks were compared.
- [ ] Missing data says "We'll know after your first full week".
- [ ] It ends with one two-minute action.

## Common mistakes

- Listing ten metrics because they exist.
- Reporting rates or percentages the tool did not return.
- Judging only against last week and ignoring the goal.
- Guessing a cause and presenting it as known.
