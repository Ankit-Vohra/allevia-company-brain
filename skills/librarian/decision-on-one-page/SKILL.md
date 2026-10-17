---
id: decision-on-one-page
name: A decision on one page
when: "Setting out a past or recent decision in a standard shape: the question, the options, what was chosen and why, and what it costs"
agents: [librarian]
tools: [trace_decision, history, who_knows, search]
output: reads
needs_ok: false
---

## Method

1. Find the decision. `trace_decision` with its id, or with a query in the owner's words ("stop the Friday discount"). If nothing comes back, `search` with other words (the thing, the month, the person). If it was never recorded, say so and offer to write it down from what the owner tells you now; never invent a reason.
2. Lay it out in five short parts, the shape decision records use everywhere (MADR):
   1. The question: what had to be decided, in one or two sentences, and what it covers ("the salon's weekday offers", not "marketing").
   2. Options looked at: two to four, including "change nothing". If the record holds only the chosen one, write "other options: not recorded".
   3. Chosen: the option and the reason, tied to the evidence `trace_decision` returned (each number with its date and source).
   4. What it costs and what it gains: one or two lines each ("Good: fewer bookings at a loss. Bad: quieter Fridays for a few weeks").
   5. Who decided, when, and who knows most about it now (`who_knows` on the topic), so the owner knows who to ask.
3. Check it still stands with `history` on the decision: status changes, and whether a later decision replaced it. Say so at the top if it did.
4. Name the gaps plainly, at most three: the reason never written, the options never listed, no date to look again. Suggest one: "Set a date to look again: 1 Dec".
5. Keep it to what the records hold. A remark someone made is weaker than a measured number: say which kind each piece of evidence is.

## House style

One page with five short labelled parts, the most important line first. No long paragraphs.

> Still stands. Decided 29 Sep by you; Miss Influencer knows most about it.
> Question: should we keep posting a story every day?
> Options: keep daily stories; post three a week; stop and put the time into reels.
> Chosen: stop and put the time into reels, because stories reached 153 people against 1,282 for the best reel (Instagram, to 28 Sep, measured).
> Gains: about 3 hours a week back. Costs: fewer daily reminders to regular followers.
> Not recorded: why "three a week" was ruled out; no date to look again (suggest 1 Dec).

## Done well

- [ ] All five parts are there, or a missing part says "not recorded".
- [ ] The reason is tied to evidence with its date, source and kind (measured or remark).
- [ ] It says whether the decision still stands or what replaced it.
- [ ] It names who to ask now.
- [ ] Gaps are named, three at most, with one next step.

## Common mistakes

- Filling the options with ones nobody considered.
- Writing the reason the team would give today instead of the one recorded then.
- Missing that a later decision replaced this one.
- A long story where five short lines would do.
