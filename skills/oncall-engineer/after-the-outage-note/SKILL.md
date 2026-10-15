---
id: after-the-outage-note
name: After an outage, what happened and what we change
when: "The site or app was down or broken and is fixed: a short, blame-free note on what happened, who was hit, why, and what changes"
agents: [oncall-engineer]
tools: [metric_trend, history, impact_of, search, get_entity, propose_action]
output: creates
makes: a one-page note on an outage with a timeline, the cause, and dated follow-ups with owners, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first: the note exists so the same thing does not happen again, and so the owner can tell customers the truth. It names systems and steps, never a person to blame.
1. Fix the window. `metric_trend` on errors, crash rate, uptime or failed payments (groupBy day or the finest the tool gives) shows when it started and ended; `search` and `get_entity` on the alert or error give the first sighting. Write times with their time zone.
2. Rebuild the timeline from records, not memory: `history` on the affected system or page shows what changed just before (a release, a setting, a connector token, a price change). List in order: first sign, when we noticed, what we tried, when it was fixed, when it was confirmed fixed.
3. Size who was hit. `impact_of` on the broken system lists what depends on it (the booking page, payments, the app's login). Give counts the tools return (failed bookings, errors, users affected) with the period; anything not recorded is "not recorded", never estimated.
4. Find the cause with five whys, stopping at something the team can change: "Bookings failed. Why? The payment step timed out. Why? The payment provider key expired. Why? Keys expire every 90 days and nobody is told. Why? The expiry date is not tracked." The fix is at the last answer, not the first.
5. Say plainly how sure we are of the cause: confirmed (we changed it back and it recovered), likely, or unknown, and what would confirm it.
6. Write the follow-ups: at most five, each with an owner by name and a date, quickest protection first (an alert, a reminder, a check before release). Separate "done already" from "to do".
7. If customers were hit, add a two- or three-sentence message the owner could send them: what happened, that it is fixed, what to do if they were affected.
8. Hand it over with `propose_action` (kind content_draft, body = the note) so the owner reads it before anyone else does.

## House style

One page. The summary in two sentences first, then who was hit, the timeline, the cause, follow-ups, and the customer message if needed.

> Bookings failed for 2 hours 10 minutes on 12 Oct (14:05 to 16:15 GST) because the payment key expired. Fixed by renewing the key; confirmed when the next booking went through at 16:15.
> Hit: 23 failed booking attempts (booking records, 12 Oct).
> Cause (confirmed): payment keys expire every 90 days and the date was not tracked.
> Follow-ups:
> 1. Alert 14 days before any key expires (Arjun, 19 Oct).
> 2. Add "check payment keys" to the release check (Imran, 17 Oct).
> Customer message: "On Sunday afternoon our online booking was down for about two hours. It's fixed now. If you tried to book then, reply here and we'll hold your slot."

## Done well

- [ ] Start, end and length are from the records, with the time zone.
- [ ] Who was hit is counted from the records, or marked "not recorded".
- [ ] The cause goes past the first answer to something the team can change, and how sure we are is stated.
- [ ] Every follow-up has an owner and a date; five at most.
- [ ] No person is blamed; systems and steps are.
- [ ] It waits for the owner's OK before it goes anywhere.

## Common mistakes

- "Human error" as the cause; the question is why the system let it happen.
- A timeline written from memory, with guessed times.
- Follow-ups with no owner or date, which never happen.
- A long technical write-up the owner cannot use; the customer message gets forgotten.
