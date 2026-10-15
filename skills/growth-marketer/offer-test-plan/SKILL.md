---
id: offer-test-plan
name: Offer test plan
when: "Trying an offer, price or message honestly: one question, one change, a clear way to judge it"
agents: [growth-marketer]
tools: [metric_trend, playbook, search, propose_action]
output: creates
makes: a one-page test plan for an offer or message, waiting for the owner's OK
needs_ok: true
---

## Method

1. Write the one question: "Does a free add-on bring more bookings than a 10% discount?" One change only; if two things change, nothing can be learned. Find the business's current offer and goal with `search`, and the number that will decide with `metric_trend` (enquiries, bookings or sign-ups per week) so you know today's level and its normal swing.
2. Check the owner's margin before choosing the offer: a discount that wipes out the profit is not a test, it is a loss. Ask for the margin if it is not in the record: "[you tell us: the lowest price you can offer]".
3. Choose the control and the variant. For a small audience, run them one after the other, equal length (A for one week, B for the next, same weekdays) or split by channel, not both at once. Look up the brand's own offer wording and rules with `playbook` (topic "offers", kind hook) so the variant sounds like them.
4. Fix the rules before starting: the deciding number, the minimum run (at least one full week; with under about 30 responses per option the result is a hint, not a proof, and the plan says so), and the stop rule (stop early only for harm: refunds, complaints, a cost per sale above the margin).
5. Write the decision in advance: "If B brings clearly more (not just 2 or 3 more enquiries), keep B and test a new idea; if it is close, keep A."
6. Give 2 or 3 concrete ideas for this business (a first-visit discount versus a free add-on; a small deposit that holds the slot; a bundle) and why each one fits its margin.
7. Hand over with `propose_action` (kind content_draft, body = the plan) so it waits for the owner's OK.

## House style

One page, plain words: question, what is tested, how long, the number that decides, what happens next in each case.

> Question: does "free blow-dry with a colour" bring more bookings than "10% off colour"?
> Test: week of 20 Oct "free blow-dry"; week of 27 Oct "10% off". Same posts, same days.
> Decides: colour bookings per week (now about 14, as of 12 Oct).
> Under 30 bookings in all means treat the result as a hint.
> Next: if the free blow-dry wins by more than a few bookings, keep it.

## Done well

- [ ] One question, one change, a control.
- [ ] The deciding number is one the business already records, with today's level.
- [ ] The run length and the "too small to call" warning are stated.
- [ ] The margin was checked or is marked "[you tell us: ...]".
- [ ] The decision rule was written before the test.

## Common mistakes

- Changing the offer and the picture and the price together.
- Calling a winner after two days or a handful of responses.
- Judging by likes or clicks when the goal is bookings.
- Offering a discount the owner cannot afford.
