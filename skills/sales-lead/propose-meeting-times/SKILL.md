---
id: propose-meeting-times
name: Propose times for a call
when: "A lead or customer wants to talk and the owner needs to offer times that are really free on their calendar"
agents: [sales-lead]
tools: [crm_read, calendar_free_slots, gmail_send]
output: creates
makes: an email offering three free times, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first: the quickest way to lose a warm lead is a long back-and-forth about when to talk. Offer three times that are really free, once, so the person only has to pick.
1. Find out who the call is with and why. `crm_read` (view lead) gives what they asked, the deal if there is one, and every earlier message. If a meeting with them is already booked or proposed, say so instead of offering more.
2. Ask `calendar_free_slots` for the length the owner usually uses (30 minutes unless the person asked for more) over the next five working days. Time zones matter: read the slots in the owner's zone, then write them in the person's zone if you know it, and always name the zone in the email ("11:00 IST").
3. Choose three: on different days if there are different days, one earlier and one later in the day, nothing in the first two hours from now (people need notice), nothing on a weekend unless the owner works weekends. If fewer than three are free, offer what there is and say you can look further out.
4. Write the email in the owner's voice, under 70 words: one line on what the call is for, the three times in a plain list, and "reply with the one that suits you and I will send the invite". Keep the subject on the same thread so it reads as a reply.
5. Propose it with `gmail_send`. It becomes a card with the whole email and the recipient; nothing is sent until the owner says OK.
6. If the calendar is not connected, do not make up times: say so, give the owner the connect link and offer a version of the email that asks when suits them.

## House style

The email first, in quotes, then one line saying which three times and which part of the calendar they come from.

> "Hi Arjun, thanks for your time on Tuesday's note. To go through the shifts: Thursday 11:00, Friday 15:00 or Monday 10:00 (all IST), 30 minutes on a call. Reply with the one that suits you and I will send the invite. - Rhea"
> Three times from your calendar, free as of now; the invite goes out only after you say OK to the booking.

## Done well

- [ ] Three times, all free on the calendar when checked, written with their zone.
- [ ] The call's purpose is in the first line.
- [ ] Nothing is offered inside the next two hours or on a day the owner does not work.
- [ ] If a meeting with this person was already proposed or booked, the draft says so instead of repeating itself.
- [ ] The email waits for the owner's OK.

## Common mistakes

- Offering a time that was free yesterday: look again right before drafting.
- Times without a time zone, for someone in another country.
- Four or five options; three is a choice, five is homework.
- Booking the meeting before the person has picked a time.
