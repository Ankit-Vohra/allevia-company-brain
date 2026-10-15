---
id: goal-progress-plain-words
name: Goal progress in plain words
when: "Where the owner stands on each goal: where they started, where they are now, and what we are doing"
agents: [coe-lead]
tools: [search, get_entity, metric_trend]
output: reads
needs_ok: false
---

## Method

1. Find the goals: `search` for goals, then `get_entity` on each. A goal names the number it tracks, the target, and where the owner started with whether that start was measured or estimated.
2. Read the current number with `metric_trend` for the goal's metric (groupBy week for flows). Use the figures and the change the tool returns; do not compute a percentage unless it comes back from a tool.
3. Write each goal the way the owner reads it: "Get to 40 enquiries a week". Then: where you started, where you are now, how much of the way that is in words ("about halfway": only if the numbers plainly show it, otherwise just give both numbers).
4. Pick the word: Going well, Needs a push or Behind, with one line why, comparing with where the plan expected them by now.
5. Say what the team is doing about each goal that needs a push, and who (`search` for open tasks and proposals tied to it).
6. Be honest about the start: if it was an estimate, say "our best estimate of where you started".
7. Newest reading date; "as of <date>" if older than 7 days; "sample numbers" where they are.

## House style

One block per goal, at most three goals.

> Get to 40 enquiries a week. Started at 22, now 31 (week to 12 Oct): going well. Rohan is testing a new offer from Monday.
> Get 500 more Instagram followers. Started at 2,300, now 2,350: needs a push. Tara is moving to two posts a week.

## Done well

- [ ] Each goal is in the owner's words: a target with a unit and a period.
- [ ] Start and now are both given, with the date.
- [ ] The word (Going well / Needs a push / Behind) has a reason.
- [ ] Each lagging goal names who is working on it.
- [ ] An estimated start is called an estimate.

## Common mistakes

- Using internal labels (targets as decimals, "at risk").
- Giving a percentage that no tool returned.
- Skipping the start, so the owner cannot see progress.
- Saying "Behind" with no next step or owner.
