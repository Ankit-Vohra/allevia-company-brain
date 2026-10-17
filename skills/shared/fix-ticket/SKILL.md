---
id: fix-ticket
name: Write a fix ticket
when: "A problem needs a developer: write a ticket they can start from without asking questions"
agents: [tech-lead, oncall-engineer, qa-release]
tools: [get_entity, search, propose_action]
output: creates
makes: a fix ticket with the problem, evidence, owner and how to know it is fixed, waiting for the owner's OK
needs_ok: true
---

## Method

1. Gather the facts: `search` and `get_entity` for the system or page, who owns it, what it connects to, its latest readings with dates. Note the ids; they go into the evidence list.
2. Write the title as the customer-visible problem, not the cause: "Booking form fails on phones since 9 Oct", not "JS error in form.js".
3. Write why it matters in one plain paragraph: who is hurt, how many, since when, what it costs, using numbers exactly as recorded with their dates.
4. Write what happens versus what should happen, then how to see it (steps a developer can repeat). If you cannot repeat it, say "not reproduced" and what you saw.
5. Add owner (from the record), severity in three plain levels (stops customers / hurts customers / untidy), a suggested first step, how to confirm it is fixed (what to look at, what number should return), and a short "do not" list (do not change the form layout, do not restart the server during opening hours).
6. Create it with `propose_action` kind github_issue, payload.body = the ticket text, evidence = the ids from step 1. It waits for the owner's OK; nothing is filed on its own.

## House style

A ticket the owner can understand in the first three lines and a developer can start from in the rest.

> Title: Booking form fails on phones since 9 Oct
> Why: 22 people started a booking in the week to 12 Oct, from 41; the form's submit button does nothing on Android. Customers are blocked.
> See it: open /book on an Android phone, fill all fields, tap Book.
> Expected: a confirmation page. Owner: Techie. Severity: stops customers.
> First step: check the last change to the form (9 Oct).
> Fixed when: bookings started return to about 40 a week.
> Do not: change the form's layout.

## Done well

- [ ] The title is the customer-visible problem.
- [ ] The first paragraph says who is hurt, how many, since when, with dated figures.
- [ ] Steps to see it, or an honest "not reproduced".
- [ ] Owner, severity, first step and a "fixed when" test.
- [ ] Evidence ids are attached.

## Common mistakes

- A title that names a guess at the cause.
- No way to confirm it is fixed.
- A ticket that needs three questions before anyone can start.
- Filing it without the owner's OK; it only becomes a proposal.
