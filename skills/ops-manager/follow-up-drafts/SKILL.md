---
id: follow-up-drafts
name: Follow-up message drafts
when: "A customer, supplier or teammate has gone quiet and the owner wants a follow-up message ready to send"
agents: [ops-manager]
tools: [recall, search, get_entity, propose_action]
output: creates
makes: a short follow-up message ready to send, waiting for the owner's OK
needs_ok: true
---

## Method

1. Find what the follow-up is about: `recall` for earlier threads and notes on this person or matter, `search` for the quote, order or invoice, `get_entity` for the facts (amount, date, what was agreed). Only those facts go in the message.
2. Place it on the ladder. First nudge: 2 to 3 working days after silence. Second: 5 to 7 working days after the first, and it must change something (a new date, a shorter ask), not repeat. After a second nudge, stop and tell the owner it is time to call.
3. Choose the tone by relationship: a customer after a quote (warm, easy to answer: "Shall I hold the date?"); a supplier late with an order (clear date, what you need, what happens if not); an overdue invoice (gentle, then firm, then final, each with the amount and the due date).
4. Write it short: who it is from and what it is about in the first line, one ask, one date. WhatsApp is shorter and warmer than email; use the contact's language.
5. Mark any missing fact "[you tell us: the amount]" rather than guessing.
6. Put it in a draft with `propose_action` (kind content_draft, body = the message), so it waits for the owner's OK. Outside messages are never sent by the team.

## House style

The message itself, in quotes, then one line saying which nudge it is and when to try next.

> "Hi Meera, it's Aarav from the studio. Following up on the 14 Oct quote for the kitchen (₹3,20,000). Shall I hold the 3 Nov start date for you until Friday?"
> First nudge, 3 days after the quote. If no reply by Wednesday, call.

## Done well

- [ ] The first line says who and what it is about.
- [ ] One ask and one date; amounts and dates are exactly as recorded.
- [ ] The second nudge changes something.
- [ ] Missing facts are marked "[you tell us: ...]".
- [ ] It waits for the owner's OK.

## Common mistakes

- Sending the same message twice.
- A long apologetic email where one WhatsApp line would do.
- Inventing an amount or a date.
- Nudging a fourth time instead of telling the owner to call.
