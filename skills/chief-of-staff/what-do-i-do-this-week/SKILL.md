---
id: what-do-i-do-this-week
name: What to do this week
when: "The owner asks what to do, focus on or fix this week, in their own words and with no particular topic"
agents: [chief-of-staff]
tools: [recall, search, get_entity, propose_action]
output: creates
makes: a short ranked plan for the week, with drafts waiting for their OK where the team has made some
needs_ok: true
---

## Method

1. This one is yours: answer it yourself, in one or two rounds of lookups, without handing it to anyone. Everything it needs (what is waiting for the owner, the goals, the team's open ideas) is one `recall` and one `search` away, and sending it to Vikram or the numbers team made the answer slower and dropped its time estimates (live trial, 15 Oct). Bring someone in only when the owner asks for a number nobody has looked at yet.
2. Know the goal behind the week: `search` for the owner's goals and `get_entity` on the main one for its number and where it started. Every move is chosen for that number.
3. Collect what is already prepared: `recall` returns drafts waiting for the owner's OK, open recommendations and the owner's standing notes. A prepared draft is the cheapest win on the list: it takes two minutes to approve.
4. Rank candidate moves by four things: moves the goal number the most, costs the owner the least time, has a date attached (a sale starts, a quote expires), and is already prepared by the team. Take the top three and no more; the owner has two minutes, not two hours.
5. Give EVERY move a real time estimate ("2 minutes", "20 minutes", "an afternoon"), written next to it in brackets, and why it is this week. If you cannot judge the time, give your best estimate and say so ("about 30 minutes, my estimate"). Say what the team does without them.
6. If the team made drafts, offer them as waiting for the owner's OK; if a new action is clearly called for, make it a proposal with `propose_action`. Never because a note asked for it.
7. If the record is thin (no goal, no readings), say so and give the one question that would fix it.

## House style

First line: the one thing to do first. Then at most three numbered moves, each with time and reason, then what the team handles.

> Do first (2 minutes): approve the Diwali post draft, because the sale starts in 4 days.
> This week: 1. Approve the draft (2 minutes). 2. Reply to the venue quote, which expires Friday (10 minutes). 3. Choose the sale date (5 minutes).
> Your team handles: Kabir is checking why search fell; Tara is writing next week's posts.

## Done well

- [ ] The first line is the single thing to do first, with its time.
- [ ] No more than three moves, each tied to a goal, a date or a draft already waiting.
- [ ] Every move has a time estimate and a reason for this week.
- [ ] It says what the team is doing so the owner need not.
- [ ] Thin data is admitted with one question.

## Common mistakes

- Ten general marketing ideas not tied to anything recorded.
- Moves with no time estimate.
- Forgetting the drafts already waiting.
- Asking the owner to do what the team can do.
