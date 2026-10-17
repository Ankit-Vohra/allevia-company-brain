---
id: plan-across-desks
name: Plan a request across the team
when: A request that might need more than one person, or whose owner is not obvious, before anyone starts work
agents: [chief-of-staff]
tools: []
output: reads
needs_ok: false
---

## Method

1. Read the request for its job, not its topic. Sort it into one of five jobs: a lookup (a fact, a decision, who owns something, what we already know), a diagnosis (why did a number move, what broke), a make (a post, a script, a brief, a ticket, a message), a check (is this figure or claim right), or a plan (what should we do this week or this month). The job decides the desks; the topic only picks which desk does that job.
2. Default to one step. If a quick lookup answers it, plan only yourself (chief-of-staff); the owner waits for every extra desk. Add a second desk only when the request clearly needs a different department's work, and a third only when the second one's answer depends on it. Three desks is the ordinary ceiling. Five is for a broad review of the whole business (a weekly review, "how is everything going"), and then only desks whose numbers or records the review really uses.
3. Route by job. The owner's own plan ("what do I do this week", "what should I focus on") is yours alone: plan only chief-of-staff and use your what-do-i-do-this-week skill. Posts, reels, carousels, briefs and calendars go to content-strategist alone: Wordsmith and Fact Checker check its work automatically, so never plan them. Why a traffic, sign-up or search number moved goes to data-analyst; how the business is doing overall and whether a figure is right goes to coe-lead; ad spend, channels, offers and campaigns go to growth-marketer; a broken site or app, what breaks if, and technical search fixes go to tech-lead; an error, crash, outage or alert goes to oncall-engineer; a release, store review or rating goes to qa-release; what is waiting, who owns it and follow-ups go to ops-manager; why did we, who knows, what changed and where something came from go to librarian.
4. Use `after` only when the second desk truly needs the first one's answer (growth-marketer building a budget move on data-analyst's traffic breakdown). Steps with no `after` run side by side, which is faster, so do not chain desks that can work in parallel. Naming a desk in another desk's task does not create the dependency: set `after`.
4b. Purpose first for any creative request (a post, reel, ad, poster, campaign): the task tells Miss Influencer or Growth Hacker to start from the one-line brief (goal, what is promoted, for whom, message, action, where) using their creative-brief skill, and names any part the owner already gave ("sell the free site visit, for Instagram").
5. Write each task as one sentence a stranger could do: what to find, for which period or thing, and what shape to hand back. "Find why sign-ups fell in the week to 5 Oct, split by source, and name the biggest single cause" is a task. "Look at sign-ups" is not.
6. Respect the owner's switches. A desk the owner switched off is never planned. If the request needs it, plan only yourself and say that desk is off so the answer can tell the owner.
7. Write the one-sentence rationale in plain words: why these people and no others.

## House style

The plan is short and boring on purpose. One step is the best plan. Tasks name the period and the shape of the answer. The rationale is a sentence the owner could read aloud ("Data Detective splits the drop by source; Growth Hacker then looks at whether the ads changed").

Example plan for "why did sign-ups drop last week and should I change my ads":

> Data Detective, analytics: find why sign-ups fell in the last full week, split by source, and name the biggest single cause.
> Growth Hacker, marketing (after Data Detective): using Data Detective's split, say whether the ads explain it and propose one change if they do.
> Why: the drop has to be located before anyone changes spend.

## Done well

- [ ] The plan is one step when one step is enough, and never more than three desks for an ordinary request.
- [ ] Every task says what to find, for which period or thing, and what to hand back.
- [ ] A step has `after` only where it truly needs another step's answer; everything else runs in parallel.
- [ ] No reviewer is planned (Wordsmith, Fact Checker and Number Cruncher review automatically) and no switched-off desk appears.
- [ ] The rationale explains the choice in one plain sentence.

## Common mistakes

- Sending a vague request to five desks "to be safe". The owner waits for the slowest one and gets five overlapping answers.
- Planning Fact Checker or Wordsmith to double-check Miss Influencer's post: it happens anyway and would run twice.
- Writing tasks like "analyse traffic". Without a period and a shape, each desk guesses, and the answers cannot be joined.
- Chaining desks that do not depend on each other, which doubles the waiting time.
- Planning a make job (a post, a ticket) as a lookup, so nothing ready to approve comes back.
