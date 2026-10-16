---
id: what-changed-before-it-broke
name: What changed before it broke
when: "Tie a problem to the change that came just before it: a release, a setting, a token, an owner"
agents: [oncall-engineer]
tools: [history, neighbors, metric_trend, get_entity, find_paths]
output: reads
needs_ok: false
---

## Method

1. Fix the time of the first bad reading: `metric_trend` groupBy day for the failing metric, find the first day it left its normal range. That date is the line you search before.
1b. Where the flow is mapped (a step that depends on a screen, crashes recorded on that screen, releases recorded as bringing a crash), follow the links instead of guessing: `get_entity` or `neighbors` on the screen lists the crashes on it; on each crash, the release recorded as introducing it (the link says how, and how sure the source is). `find_paths` from the failing step to the release gives the whole chain in one call. Report people affected and events a day for the crash (`metric_trend` sentry_issue_users and sentry_issue_events), and compare the crash's first day with the day the number fell.
2. List the changes on the affected system: `history` on it returns property changes (status, version, settings) with before and after, and relationships that ended (an owner reassigned, a dependency replaced). Do the same for what it depends on (`neighbors` to find them, `history` on each).
3. Line them up by time. The closest earlier change is a suspect, not the proof. Note changes the same day, and ones days earlier that only bite when something else happens (a token that expires).
4. Check what else moved: `get_entity` on the suspect for its owner and as-of date.
5. State the confidence in three words: strong (one change, matches to the hour, and rolling it back is the obvious test), likely (the closest change fits but others exist), only a coincidence in time (nothing links them but the date).
6. Name the one test that would confirm it: turn the change off or roll it back on a copy, and the number that should return.
7. If `history` shows nothing, say "no change recorded before it", which also points to something outside (a provider, a date, traffic).

## House style

The suspect, how sure, the test.

> Likely cause: the payment service was updated to version 4.2 on 14 Oct, 14:00; errors began at 14:10. Two other changes that day are minor. Test: roll back to 4.1 and check errors fall below 5 an hour.

## Done well

- [ ] The first bad time comes from the data, not a guess.
- [ ] The changes are listed with dates, before and after.
- [ ] Confidence is one of strong, likely or coincidence in time.
- [ ] One test is named that would confirm or kill the suspicion.
- [ ] "Nothing recorded before it" is said when true.

## Common mistakes

- Treating the nearest change as certain.
- Ignoring things the problem depends on.
- Naming a cause with no date behind it.
- Proposing five tests at once.
