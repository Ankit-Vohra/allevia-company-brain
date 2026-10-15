---
id: bring-customers-back
name: Bring customers back (email, WhatsApp, referrals)
when: "Getting past customers to come again or bring a friend: welcome, thank-you, win-back and refer-a-friend messages by email, WhatsApp or text"
agents: [growth-marketer]
tools: [search, metric_trend, playbook, research, propose_action]
output: creates
makes: a short series of follow-up messages (email, WhatsApp or text) with when each one goes out, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first. Before making anything, fill the one-line brief (open the creative-brief skill): the goal (a second visit, a rebooking, a review, a referral), the one service or offer it promotes (by its name in the records), for whom, the one message, the call to action and where it runs. Infer each from the records and the owner's words; ask at most three quick questions with suggested answers. Open the plan with the brief in one line.
1. Find who to talk to and how often they come. `search` for customers, bookings, orders and any list the business keeps (email list, WhatsApp contacts). `metric_trend` on repeat visits, rebookings or orders per week tells you today's level. Work out the normal gap between visits for this trade (a haircut: 5 to 8 weeks; a tailored outfit: once a season); a customer past twice that gap is lapsed. If the records hold no repeat data, say so and ask the owner one question: "Roughly how often does a happy customer come back?"
2. Pick the one series that pays first. In order of usual value for a small business: (a) thank-you after a visit with a review ask; (b) win-back for lapsed customers; (c) welcome for a first-time customer; (d) refer-a-friend. One series per plan; say which you left for later.
3. Pick the channel by where the customers are, not by habit. UK, UAE, India and much of Australia: WhatsApp is often read first. US: Meta does not deliver WhatsApp marketing messages to US numbers, so use text (SMS) or email there. Email carries the longer story; WhatsApp and text carry a short nudge. Check the business's own channel rules with `playbook` (topic "messages" or "voice").
4. Check permission before writing a word. Marketing messages need the customer's clear yes: in the UK and EU (consent, easy opt-out), in the US for texts (written consent, STOP honoured, no sends before 9am or after 8pm local), in Australia (consent, the sender named, an unsubscribe in every message), in the UAE (opt-in, a way to stop). On WhatsApp, a message outside 24 hours of the customer's last message must be a pre-approved template, and offers count as marketing. If you cannot see how the list was collected, the plan says "[you tell us: did these customers agree to hear from you?]" and nothing is sent until they did.
5. Write the series, one job per message, one action per message:
   - Thank-you (day 1 after the visit): thanks by name, one line about what they had, the review link.
   - Win-back (at twice the normal gap): a genuine check-in and what is new; two weeks later, a reason to come back (a free add-on beats a discount when margins are thin); two weeks after that, a last note with an easy "stop these".
   - Welcome (same day): what to expect, one tip, how to book again.
   - Refer-a-friend (after a happy moment: a five-star review, a repeat booking): a two-sided reward ("you both get a free blow-dry") said as the bigger-feeling number ("£10 off" reads bigger than "15% off" on a small bill), one tap to share a pre-written message.
   Name the brand in the first line (many people have not saved the number), keep a WhatsApp or text message to two or three short sentences, and a text under 160 characters.
6. Cost and limits. A text costs money per message; WhatsApp marketing messages are charged per message by country, and from October 2026 service replies past 1,000 a month are too. Use `research` to check Meta's current rate card for the customer's country before you quote a cost, and give it with its date.
7. Say how you will judge it: the number that decides (rebookings, repeat orders, reviews or referred customers per week, with today's level from `metric_trend`) and when to look (after 4 weeks). Opt-outs above 2 in 100 per send means the messages are too frequent or not wanted.
8. Hand over with `propose_action` (kind content_draft, body = the series and the timing) so nothing is sent until the owner says yes.

## House style

The brief first, then each message in sending order with its day, channel and the exact words, then cost, then the number to watch.

> Brief: bring back colour clients who have not booked in 10 weeks, by WhatsApp, to book a gloss top-up.
> 1. Week 10, WhatsApp: "Hi Priya, it's Mira from Studio Nine. It's been a while since your colour. Want me to hold a slot this Saturday? Reply YES and I'll send times."
> 2. Week 12, WhatsApp: "Studio Nine here: book your colour this month and the gloss is on us. Book: [link]. Reply STOP to stop these."
> 3. Week 14, email: a short note with two new looks and the booking link.
> Cost: about [you tell us: your WhatsApp rate] per message; 40 clients means 80 messages.
> Watch: colour rebookings per week (now 6, week to 12 Oct). Look again on 16 Nov.

## Done well

- [ ] It has a purpose: the one-line brief opens it, and every message serves that one goal.
- [ ] Permission was checked, or the plan asks the owner before anything is sent.
- [ ] The channel fits the customers' country (no WhatsApp marketing to US numbers).
- [ ] Each message has one job and one action, names the brand, and has a way to stop.
- [ ] The timing comes from this business's normal gap between visits, not a generic schedule.
- [ ] The deciding number has today's level and a date to look again.

## Common mistakes

- A discount in the first message, which teaches customers to wait for one.
- Sending to everyone on the phone's contact list without their yes.
- Four messages in a week; the customer blocks the number and the WhatsApp rating drops.
- Quoting a message cost from memory instead of today's rate card.
- Judging by opens or likes when the goal is rebookings.
