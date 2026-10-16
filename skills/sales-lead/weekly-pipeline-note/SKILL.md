---
id: weekly-pipeline-note
name: Weekly sales note
when: "The owner wants to know how selling went this week: who is new, what moved, what is stuck, and what to do first"
agents: [sales-lead]
tools: [crm_read, history, propose_action]
output: creates
makes: a one-page sales note for the week, waiting for the owner's OK to post
needs_ok: true
---

## Method

0. Purpose first: the owner should be able to read this in two minutes on a phone and know what to do about selling today. The note is for deciding, not for reporting; every line ends in an action or says "nothing to do".
1. Get the shape with `crm_read` (view pipeline): how many people are in each stage, how many deals are open and what they are worth, what has been won. Copy the figures exactly, with the currency; never add or convert them yourself.
2. Find what changed with `crm_read` (view moved, 7 days): who is new, who moved on to a call, who was won or lost. This is the heart of the note, and it comes from the records' own history, not from memory. If you need the story behind one move, `history` on that lead or deal shows each change with its date.
3. Find what is stuck: `crm_read` (view waiting) for enquiries nobody has answered (say how long the oldest has waited), and `crm_read` (view stalled) for deals with nothing happening for two weeks or more. Then `crm_read` (view meetings) for calls in the next two days.
4. Write the note in this order: one line on the week with a comparison if the records have one ("3 new people, 1 won, 2 deals quiet"); what moved; what is stuck and the first thing to do about each; calls coming up. At most five items in any list, ranked by money or by how long they have waited.
5. Hand it over with `propose_action` (kind content_draft, body = the whole note, target the place it is posted) so it waits for the owner's OK and can be posted to the team channel. If the records are empty or thin, say that plainly ("only 2 leads recorded, so this is a thin week") and do not pad.

## House style

The headline first, then what moved, what is stuck, what is coming, each short.

> This week: 3 new people, 1 deal won (Green Leaf Cafes, 96,000 rupees), 2 deals quiet.
> Moved: Mehta Logistics went from "contacted" to "meeting" (call tomorrow 11:00). Green Leaf Cafes went from "meeting" to "won".
> Stuck: Rohit Desai asked about 12 servers 27 hours ago and has no reply; Sahyadri Hotels has been quiet for 18 days (180,000 rupees).
> Do first: answer Rohit (draft ready), then nudge Sahyadri.

## Done well

- [ ] Every figure is copied from the records with its currency.
- [ ] What moved comes from the stage history, with the dates.
- [ ] Every stuck item has a first action next to it.
- [ ] No list is longer than five items; the biggest or oldest comes first.
- [ ] A thin week is called thin, not dressed up.
- [ ] The note waits for the owner's OK before it is posted.

## Common mistakes

- Reporting every lead instead of what changed.
- Mixing currencies or adding up values the records did not total.
- Naming a "best performer" from two data points.
- Leaving out the waiting enquiries because the week was otherwise good.
