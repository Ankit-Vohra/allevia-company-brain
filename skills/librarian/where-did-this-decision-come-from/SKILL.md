---
id: where-did-this-decision-come-from
name: Where did this decision come from
when: "Why did we pause, stop, choose or change something: the story, the evidence, who decided, and whether it still holds"
agents: [librarian]
tools: [trace_decision, history, search]
output: reads
needs_ok: false
---

## Method

1. Call `trace_decision` with the decision's id, or a query ("pause daily stories") if you only have words. It returns the decision, its evidence (numbers and documents, each with sources), who decided, what it affects, what it replaced and what replaced it.
2. If nothing comes back, `search` with other words (the thing, the date, the person) and try again. If there is still no decision recorded, say "this was not written down" and stop; never invent a reason.
3. Tell it as a story in order: what was seen (the evidence, with its date and source), what was decided, by whom, when, and what it changed.
3b. If the question is about something happening now (a drop, a crash), also look for what we already decided about it: `search` for it, `trace_decision` on any decision found, and say what that decision set in motion and where it stands (the task and its owner come back with it). That is the "last time" the owner is asking about.
4. Check it still holds: `history` on the decision for status changes, and whether a later decision replaced it. Say clearly if it was replaced, and by what.
5. Give how old the evidence was at the time and how sure the record is: a measured number, a note in a document, or a verbal remark.
6. State what is missing: the reason never written down, the person not recorded, the alternatives not considered.

## House style

Answer first in one sentence, then the story in four short lines.

> We paused daily stories on 29 Sept because they reached few people: 153 views against 1,282 for the best reel (Instagram, to 28 Sept). You decided; Miss Influencer carried it out. It still holds. Not recorded: whether a restart date was set.

## Done well

- [ ] The first sentence is the reason, in plain words.
- [ ] Evidence is named with its date and source.
- [ ] It says who decided and whether it was replaced or still holds.
- [ ] Missing pieces are named; nothing is invented.
- [ ] No more than four lines of story.

## Common mistakes

- Making up a reason because the record only holds the decision.
- Skipping whether a later decision replaced it.
- Quoting a number without its date.
- Telling the whole history when the owner asked why.
