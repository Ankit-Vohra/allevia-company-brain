---
id: why-did-a-number-drop
name: Why did a number drop, and what do we do
when: "The owner asks why sign-ups, sales or traffic fell, or what broke: find the cause, show the chain, draft the fix"
agents: [chief-of-staff]
tools: []
output: reads
needs_ok: false
---

## Method

1. Treat it as a diagnosis, not a lookup. The answer is a chain from the number to its cause, so several desks look at the same drop from different sides, side by side: the analyst for which step or source moved and on which day; the on-call engineer for what crashed or errored on the screens behind that step, and who owns them; the release manager for what shipped or sits in a store's review around that day; the librarian for what the team decided or learned about this before. The tech lead goes after the on-call engineer, to say what else the broken thing takes down.
2. Write each task around the same drop and the same dates, so the findings join: "the week to 15 Oct against the week before", "since the sign-up numbers fell", "around the day the fall started". Ask the analyst for the step where the fall starts, not only the total.
3. Never plan the marketer or an ad change before a cause is found. A tempting cause (a paused ad, a search update) has to be ruled in or out by its dates.
4. When the findings come back, line them up by date: the day the number fell, the day the crash or the release appears. A record that links them (a release recorded as introducing a crash, a crash recorded on that screen) makes it proven; matching dates alone make it likely; nothing at all is "not shown". Say which.
5. Walk the chain cause to effect for the owner, and call show_path with the same ids in the same order: the reading, the funnel step, the screen, the crash, the release, the owner.
6. Two cards wait for the owner's OK when a cause is shown or likely: the fix as a task with the numbers and dates in it, and a short message to the people affected. Follow the owner's standing preferences about when and how to tell users.
7. If a desk found nothing, say what is not recorded and what would settle it. Do not fill the gap.

## House style

The cause first with how sure, then the chain in one short paragraph, what else it hits, what we decided before, what is not recorded, and the two cards.

> Sign-ups fell about 80% on 7 Oct because the 2.8.0 release put a crashing phone-number box on the sign-up screen (proven: the release is recorded as bringing the crash, 380 crashes a day). Google sign-up is unchanged, so it is the phone flow, not demand. One step away this stops the next step; four steps away it reaches employers' first applicants. Last week we chose a hotfix over a rollback; the hotfix is waiting on the App Store. Not recorded: when Apple will review it. Two cards are ready for your OK: the fix task, and a two-line note to users.

## Done well

- [ ] Up to five desks, side by side, each with a different question about the same drop; no marketer before a cause.
- [ ] The cause is labelled proven, likely or not shown, with the dates that say so.
- [ ] The chain is in order, and show_path walks the same ids.
- [ ] A tempting wrong cause is named and ruled out by its dates.
- [ ] What is not in the records is said, and two cards are drafted only when a cause is shown or likely.

## Common mistakes

- Planning one desk and answering from totals, so the cause is never named.
- Calling a cause proven because the dates match.
- Sending the marketer to change ads before the cause is known.
- Drafting a long apology to users, or messaging them before a fix is on its way.
- Filling a missing release date or owner with a guess.
