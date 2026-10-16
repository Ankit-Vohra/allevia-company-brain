---
id: nudge-stalled-deals
name: Nudge deals that have gone quiet
when: "A deal has had nothing happen for two weeks or more and a follow-up should go to the person before the chance is lost"
agents: [sales-lead]
tools: [crm_read, crm_write, gmail_send, connection_read]
output: creates
makes: a short nudge for each quiet deal, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first: a deal rarely says no; it just goes quiet because both sides got busy. A short, useful nudge at the right moment brings a good share of them back, and a clear "should we close this?" is better than letting it drift.
1. Find them with `crm_read` (view stalled): open deals with nothing happening for 14 days or more, most quiet first, with the value and what the next step was. If the business has HubSpot connected, `connection_read` can show its own idea of the deal's stage and last note; use it to check the records are not behind, and say which one you trusted.
2. For each deal read the story (`crm_read`, view lead): who the person is, what they asked, what was promised and by whom. If the promise was ours (a rate card, a quote, a call-back), the nudge is an apology and the thing itself. If the promise was theirs (a list, a decision), the nudge is a light question.
3. Place it on the ladder. First nudge: 2 to 3 weeks of silence. Second: 5 to 7 days after the first, and it must change something (a new date, a smaller ask, a fresh fact), never repeat. After a second nudge with no reply, stop and tell the owner it is time to call or to close the deal as lost.
4. Write each nudge in the owner's voice, under 70 words, easy to answer in one line: who it is from and what it is about in the first sentence, one real reason to reply now (a date, a seat, a price that holds until Friday only if the owner said so), and one ask. Never invent an offer or a discount.
5. Draft each with `gmail_send` (one card each). Use `crm_write` add_follow_up to put the next nudge date in the records, and move_stage to "lost" only when the person said no or the owner decided to close it, with the reason.
6. Nothing goes out until the owner says OK. Finish with one line: how many are quiet, how much money is in them, which one to do first.

## House style

The money and the count first, then each deal on two lines (who and how long, then the draft).

> 2 deals have gone quiet; together about 2,76,000 rupees. Start with Sahyadri Hotels (18 days).
> Sahyadri Hotels, Sana Qureshi: we promised a rate card on 27 Sep and never sent it. Draft: "Hi Sana, sorry for the delay on our rate card. It is attached. We have weekend teams free for the November weddings; shall I hold two for you until Friday? - Rhea"

## Done well

- [ ] Every deal quiet for 14 days or more is listed, with how long and what it is worth.
- [ ] Each nudge fits what was actually promised, and by whom.
- [ ] The second nudge changes something, and there is never a fourth.
- [ ] No offer or price the owner has not agreed to.
- [ ] Each draft waits for the owner's OK, and the next date is in the records.

## Common mistakes

- "Just checking in" with no reason to answer.
- Chasing someone who told us no.
- A nudge that ignores that the delay was ours.
- Closing a deal as lost because it is quiet, when the owner has not decided that.
