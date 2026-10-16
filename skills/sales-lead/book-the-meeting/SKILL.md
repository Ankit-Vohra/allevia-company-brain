---
id: book-the-meeting
name: Book the call and send the invite
when: "A lead has picked one of the times (or the owner has chosen one) and the call should go on the calendar with an invite to the guest"
agents: [sales-lead]
tools: [crm_read, calendar_free_slots, calendar_book, gmail_send]
output: creates
makes: a meeting on the owner's calendar with an invite to the guest, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first: once a person says yes to a time, the call should be on both calendars within minutes, so nobody has to remember it. Booking and inviting are one step for the owner: one OK adds the meeting and sends Google's invite to the guest.
1. Read what the person said. `crm_read` (view lead) shows their last message and the times that were offered. Take the time they picked; if it is not clear which one they meant, ask in a short reply with `gmail_send` instead of guessing.
2. Check the time is still free with `calendar_free_slots`, starting on that day. If it is gone, offer the nearest free times in the reply and book nothing.
3. Propose the meeting with `calendar_book`: a title with the person and the company ("Call with Arjun Mehta, Mehta Logistics"), the start time with its offset, the length, the guest's email, a note with what the call is for and where it happens (a video link if the owner uses one; never invent a link), and why in plain words. The card shows the owner the day, the time and the guest.
4. Where useful, write a two-line confirmation with `gmail_send` ("Booked for Thursday 11:00 IST; the invite is on its way"), but only when the owner is not already satisfied with Google's own invite. One more email is not always a better one.
5. After the OK the meeting is on the calendar, the invite is sent, and the records are updated by themselves: the meeting is saved, and the lead and deal move to "meeting". Do not move them by hand before that.
6. If the card is turned down or the calendar is not connected, say so plainly, do not retry on your own, and keep the proposed times in the lead's notes.

## House style

One line on the call, one line on the guest, the card, then what happens after the OK.

> Call with Arjun Mehta (Mehta Logistics), Thursday 16 Oct, 11:00 to 11:30 IST, on Google Meet. Invite goes to arjun@mehtalogistics.example.
> Waiting for your OK. Then it is on your calendar, Arjun gets the invite, and his deal moves to "meeting".

## Done well

- [ ] The time is the one the person picked, and it was free when checked.
- [ ] The card names the guest's email, the day, the time with its zone and the length.
- [ ] No invented link, address or agenda.
- [ ] The owner's OK comes before anything is added or sent.
- [ ] If the pick was unclear or the time was gone, a short question went out instead of a booking.

## Common mistakes

- Booking the first time offered when the person picked the second.
- Guessing the guest's email address; use the one in their message.
- Double-booking over something that came up since the times were offered.
- Moving the lead to "meeting" before the OK; a card that is turned down has booked nothing.
