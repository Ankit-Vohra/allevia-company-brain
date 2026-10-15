---
id: incident-triage
name: Triage an error or outage
when: "A new error, crash spike or outage: is it real, how big, who owns it, and what to do in the first 15 minutes"
agents: [oncall-engineer]
tools: [metric_trend, impact_of, neighbors, get_entity, search]
output: reads
needs_ok: false
---

## Method

1. Confirm it is real. `metric_trend` on the error, crash or uptime metric, groupBy day, last 7 to 14 days. One blip that returns to normal is not an incident; a step up that stays, or a clear spike outside the earlier range, is. Use the tool's first, last, max and delta; no own arithmetic.
2. Size it: how many customers and which flow (sign-up, payment, booking, login). `search` for the flow and `impact_of` on the system that is failing to see what depends on it; `neighbors` for what it is connected to.
3. Set the severity with three plain levels: stops customers now, degrades, cosmetic. Anything that blocks payment or sign-up is the first level.
4. Find who owns it: `get_entity` on the system gives the owner. Name the person to tell.
5. Give the first 15 minutes, the way an on-call engineer would: stop the bleeding before finding the cause (roll back the last change, switch the feature off, put up a notice), then the real fix later. Say which of these the record allows.
6. Say when to wake the owner: stops customers now, or money is being lost; otherwise it can wait for the morning note.
7. Missing data: "not recorded", and what to connect (error tracking, an uptime check). Mention the newest reading date.

## House style

Severity and what to do first, then the facts.

> Stops customers: payments have failed since 14:10 today (errors went from 2 an hour to 61). The payment page depends on the card service; Arjun owns it. First 15 minutes: roll back this morning's update. Tell the owner now.

## Done well

- [ ] It says whether the problem is real, with the numbers from the tool.
- [ ] Severity is one of the three plain levels, tied to a customer flow.
- [ ] An owner is named.
- [ ] The first-15-minute action comes before the cause.
- [ ] It says whether to wake the owner.

## Common mistakes

- Treating one blip as an outage.
- Hunting for the cause while customers are still blocked.
- Saying "high severity" with no customer effect.
- No owner, so nobody acts.
