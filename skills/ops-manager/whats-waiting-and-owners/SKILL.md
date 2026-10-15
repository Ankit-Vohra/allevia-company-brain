---
id: whats-waiting-and-owners
name: What is waiting and who owns it
when: "What is pending right now, who has it, how long it has waited, and what costs most to leave"
agents: [ops-manager]
tools: [recall, search, cypher, who_owns]
output: reads
needs_ok: false
---

## Method

1. Collect what is open. `recall` returns open recommendations and drafts waiting for the owner's OK; `search` and `cypher` find open tasks (status open or in progress) and anything the team asked the owner for. Keep each with its id and dates.
2. Sort into three groups: waiting on the owner (OKs, decisions, information), waiting on the team, waiting on someone outside (a supplier, a client).
3. For each, find the owner: `who_owns` with the task id. No owner is itself a finding: say "nobody owns this".
4. Say how long each has waited, from the record's dates, and what waiting costs (a sale date passes, a customer is waiting, nothing). Put the item that costs most by waiting first.
5. Keep at most five items. Group small ones ("three more small drafts") rather than listing them.
6. End with the one thing the owner can do in under two minutes.

## House style

Group by who has to act. Each line: what, who, how long, why it matters.

> Waiting on you (2): the Diwali post draft, 3 days (the sale starts in 4); a reply to the venue quote, 6 days.
> Waiting on the team (1): the new menu page, Arjun, 2 days.
> Nobody owns: the supplier invoice from 2 Oct.
> Next: approve the Diwali draft (1 minute).

## Done well

- [ ] Items are grouped by who has to act.
- [ ] Each has an owner (or "nobody owns this") and how long it has waited.
- [ ] The costliest wait is first; at most five lines.
- [ ] Nothing from the record is left out of the count.
- [ ] One two-minute action at the end.

## Common mistakes

- Listing every open task in date order.
- Saying "pending" with no owner and no age.
- Hiding that something has no owner.
- Mixing what the owner must do with what the team is doing.
