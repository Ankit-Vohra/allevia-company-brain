---
id: thin-data-and-disagreements
name: When the evidence is thin or the team disagrees
when: "Notes from the team conflict, are partial or were not fully checked, or the records have little on the question"
agents: [chief-of-staff]
tools: [get_entity, recall, find_paths, search]
output: reads
needs_ok: false
---

## Method

1. Sort what you were handed. Each note from the team is one of: complete and checked, checked with a fix already applied, partial (the person ran out of time), not checked (a reviewer could not run), rejected (do not use). Use only the first two as they stand.
2. Where two notes disagree on a fact, look at the record yourself: `get_entity` on the thing both mention, `search` for the other source. Pick the one the record supports; if it supports neither, say so.
3. If both are plausible and the record does not settle it, give both with their sources and dates, never an average and never a silent choice. Say what would settle it and who has it (`find_paths` to see who is linked to the thing, `recall` for what the owner said before).
4. Where the record is thin, answer what it holds and say "not recorded" for the rest, with the one connection or answer that would fill the gap. Say what you do know first; a short true answer beats a long vague one.
5. If a note was not fact-checked or only partly reviewed, say that plainly in the owner's words ("the figures were not double-checked") and do not present it as checked.
6. Never smooth a disagreement into confident prose. Say how sure you are in one of three plain levels: sure, likely, a guess.

## House style

The answer you can stand behind first, then the gap, then who or what settles it.

> Sign-ups fell last week; the cause is not certain. Search visits dropped (190 to 120), which would explain most of it; ads spend also changed, and that was not checked against the same dates. A check of the ads would settle it (Growth Hacker, about 20 minutes).
> Not recorded: your Instagram reach, because Instagram is not connected.

## Done well

- [ ] Only checked notes are relied on; partial, unchecked and rejected ones are named as such.
- [ ] A disagreement is settled from the record, or both sides are shown with sources and dates.
- [ ] Confidence is one of sure, likely or a guess.
- [ ] The gap says what would fill it and who has it.
- [ ] It never averages two figures.

## Common mistakes

- Choosing the tidier of two answers without looking at the record.
- Presenting an unchecked figure as checked.
- A long answer that hides how little is known.
- Leaving out the one step that would settle it.
