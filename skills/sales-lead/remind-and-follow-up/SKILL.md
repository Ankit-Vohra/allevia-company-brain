---
id: remind-and-follow-up
name: Remind before a call, follow up after
when: "A call is coming up tomorrow, or one has just happened and the next step should go out in writing"
agents: [sales-lead]
tools: [crm_read, crm_write, gmail_send]
output: creates
makes: a short reminder before a call or a follow-up after it, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first: most calls that fall through fall through because nobody remembered them, and most deals that stall stall because nothing was written down after the call. A reminder before and a follow-up after cost the owner nothing and keep both sides honest.
1. Reminder: `crm_read` (view meetings, 2 days ahead) lists the calls coming up; with days_back set to 3 it also lists the ones that just happened. For each call tomorrow, draft a three-line reminder to the guest with `gmail_send`: what it is, the day and time with the zone, and the link or place if the invite has one. Do not send a reminder for a call that is not booked, and do not send one to someone who already confirmed this morning.
2. Follow-up: a call counts as held when its time has passed and it was booked (the meetings view marks it alreadyHappened). Read the story with `crm_read` (view lead). If the owner told you what was agreed (in chat or in a note), write it down; if not, ask the owner for the two lines that matter (what was agreed, what happens next) before drafting anything. Never invent what was said on a call.
3. Write the follow-up in the owner's voice, under 90 words: thank them in one line, repeat what was agreed in plain words, say the next step with who does it and by when, and ask one thing ("can you send the list of shifts by Friday?"). Draft it with `gmail_send`.
4. Keep the records honest with `crm_write`: set the deal's next step (open_deal with next_step) and add a follow-up task (add_follow_up) for the date promised. If the call went badly or the person said no, move the deal to lost with a reason (move_stage). These are records only; nothing is sent by them.
5. Everything that goes to the person waits for the owner's OK. After the OK the email goes out and the records show it.

## House style

Tomorrow's calls first, then calls that need a follow-up, each with the draft under it.

> Tomorrow: Call with Arjun Mehta, 11:00 IST. Reminder ready: "Hi Arjun, a quick note that we speak tomorrow at 11:00 IST on Google Meet (link in the invite). I will have the shift numbers ready. - Rhea"
> Needs a follow-up: Ira Bose, call held on Monday. Tell me what you agreed and I will draft it.

## Done well

- [ ] Only booked calls get a reminder, and only once.
- [ ] No follow-up is written until the owner has said what was agreed.
- [ ] Each follow-up has one next step, with a date and an owner for it.
- [ ] The deal's next step and a follow-up task are in the records.
- [ ] Everything to a customer waits for the owner's OK.

## Common mistakes

- A reminder sent the minute before the call, when it is too late to be useful.
- A follow-up that thanks the person and says nothing about what happens next.
- Writing what "must have been" agreed.
- A second reminder to someone who has already confirmed.
