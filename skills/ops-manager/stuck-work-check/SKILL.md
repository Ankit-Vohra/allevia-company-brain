---
id: stuck-work-check
name: Find stuck work
when: "What has stalled: no owner, no movement for too long, or blocked by something else that is stuck"
agents: [ops-manager]
tools: [search, cypher, who_owns]
output: reads
needs_ok: false
---

## Method

1. List open work with `cypher`: open and in-progress tasks with their id, name, status, last change and what they depend on. Order by id at the end of the query and keep it to what the question needs.
2. Mark stuck work by rule of thumb: a quick fix open more than a week, a decision open more than two weeks, anything with a due date that has passed, and anything with no change recorded in 3 weeks.
3. Check owners: `who_owns` for each stuck item. No owner, or an owner who changed and did not hand over, is the commonest cause.
4. Follow blocking chains: if a task is blocked by another, check that one too. The root of a chain is what to unblock, not each item along it.
5. Separate truly stuck from quietly in progress: look at recent related notes (`search`). A big job with weekly updates is not stuck.
6. For each stuck item say who has to act and the smallest thing that unblocks it. At most five, root causes first.

## House style

Short list: what is stuck, why, who acts, the smallest unblock.

> Stuck (3): the new menu page, blocked by the photos, which nobody owns since 2 Oct. Owner needed: you (assign in 1 minute). The supplier invoice: no change for 4 weeks, owner Taskmaster, needs a call.
> Not stuck: the website refresh, updated weekly.

## Done well

- [ ] Stuck means a stated rule (age, due date passed, no owner), not a feeling.
- [ ] Blocking chains are followed to their root.
- [ ] Each item names who acts and the smallest unblock.
- [ ] Quiet-but-progressing work is not flagged.
- [ ] At most five items.

## Common mistakes

- Reporting every old task as stuck.
- Missing that three tasks wait on one unowned task.
- Naming no owner for the unblock.
- Long lists with no ranking.
