---
id: post-release-health
name: Did the last release break anything?
when: "After an app update: did crashes, errors or ratings get worse, and whether to hold, hotfix or roll back"
agents: [qa-release]
tools: [metric_trend, history, get_entity, search, neighbors]
output: reads
needs_ok: false
---

## Method

1. Find the release date and version: `history` on the app entity gives property changes with dates. That is the line between before and after.
1b. `neighbors` on the release lists the crashes recorded as introduced by it and the screens they hit; `get_entity` on a crash gives its first and last day and who owns the screen. A release with a crash introduced the same day the numbers fell is the lead. Also say where each release is: live on which store, or waiting in review and since when (`search` the store status), because a fix that cannot ship is part of the answer.
2. Read crash-free rate, crash count, error count and store rating with `metric_trend`, groupBy day, covering the same number of days before and after. Compare like with like: same length, and include the same weekdays. Use the tool's first, last, delta and pctChange; no own arithmetic.
3. Judge by the rollout stage. Rule of thumb for a staged rollout: judge at 24 hours and again at 72 hours, because early users are not typical. A rating needs enough new ratings; a move on a handful is noise (check the count).
4. Decide: fine (within the earlier normal range), watch (a small move, look again on a named date), hotfix (a clear rise tied to one crash or flow that can be fixed in a day), roll back (a main flow broken or crashes clearly above normal for a meaningful share of users). The owner decides; you give the call and why.
5. Say what to hand off: Zoya for a live incident, Arjun for the fix (`search` and `get_entity` for the owner of the affected part).
6. Missing data: "not recorded", and what to connect. Date the newest reading.

## House style

The call, then before and after numbers with their dates.

> Watch: crashes went from 3 a day before the 10 Oct release to 5 a day after (3 days each side); within the earlier range of 2 to 6. Rating unchanged at 4.5 on 12 new ratings. Look again on 13 Oct.

## Done well

- [ ] Before and after cover the same length of time, with the release date shown.
- [ ] The tool's own change figures are used; no home-made percentages.
- [ ] Small counts of ratings or crashes are not over-read.
- [ ] The call is fine, watch, hotfix or roll back, with a date to look again.
- [ ] Someone is named for the next step.

## Common mistakes

- Judging at 2 hours into the rollout.
- Blaming the release for a rating change before it.
- Comparing a weekend with a weekday.
- Rolling back on a rise inside the normal range.
