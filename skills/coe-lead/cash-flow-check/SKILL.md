---
id: cash-flow-check
name: Cash for the next 90 days
when: "Will we have enough cash: rent, wages or a big bill coming up, who owes us, and the next 30, 60 and 90 days"
agents: [coe-lead]
tools: [search, get_entity, metric_trend, cypher]
output: reads
needs_ok: false
---

## Method

1. Start from the money in the bank, with its date. `search` for the bank balance, cash on hand or the latest account statement and open it with `get_entity`. "Will I make payroll" is a question about the balance, not about profit. Never assume a balance: if none is recorded, ask "What is in the business account today?" and, until then, head the answer "no bank balance on file, so this shows money in and out only".
2. Collect money coming in. `search` for unpaid invoices, deposits, bookings already paid for and regular takings; `metric_trend` on sales or takings per week (groupBy week, last 12 weeks) gives the normal week and its swing. For each customer who owes money, look at how late they usually pay (from past invoices, with `cypher` if they are recorded as items with due and paid dates). Fewer than three past payments: treat the date as uncertain and say so.
3. Collect money going out, by date: rent, wages, loan payments, suppliers, subscriptions, tax. `search` for each by name; a regular cost the records do not hold is written as "[you tell us: monthly rent]", never guessed.
4. Lay out three windows: the next 30 days, 31 to 60, and 61 to 90. In each: money expected in (moved later by each customer's usual delay), money going out, and the difference. Give a low and a high case from the normal weekly swing, not one exact number. Do the arithmetic only on figures the tools returned, and show each figure with its source and date.
5. Name the risks, biggest money first, at most five: a big bill landing before a slow payer pays ("Mehta & Co usually pays 18 days late, so their 2,400 arrives around 3 Dec, after rent on 1 Dec"); a week where the low case goes below zero; a cost with no record; data too thin to judge.
6. End with the one move that helps most this week: chase one invoice (Taskmaster can draft it with the chase-unpaid-invoices skill), move a supplier payment, ask for a deposit on a big order, or hold a spend.
7. Keep every amount in the currency the records give, with its code (AED 4,200, GBP 1,150). Never convert currencies.

## House style

The answer first in one line (enough, tight, or short, and when), then a small table of the three windows, then the risks, then one move. Every figure has its date.

> Enough for the next 30 days; tight around 1 Dec when rent and wages land together.
>
> | Window | In | Out | Left (low to high) |
> |---|---|---|---|
> | to 14 Nov | AED 38,000 | AED 31,500 | AED 4,000 to 9,000 |
> | 15 Nov to 14 Dec | AED 35,000 | AED 36,200 | AED -3,500 to 1,800 |
>
> Bank: AED 12,400 on 14 Oct (statement). Biggest risk: Mehta & Co's invoice for AED 2,400 is usually 18 days late.
> Next: send Mehta & Co a friendly reminder this week (2 minutes to OK the draft).

## Done well

- [ ] It starts from a dated bank balance, or says plainly there is none.
- [ ] Money in is moved by each customer's usual delay, not taken at the due date.
- [ ] Low and high cases are shown, not one exact number.
- [ ] Every missing cost is marked "[you tell us: …]" rather than guessed.
- [ ] Risks are named with an amount and a date, five at most, biggest first.
- [ ] It ends with one move for this week.

## Common mistakes

- Treating profit as cash: a sale on 30-day terms is not money in the bank.
- Taking invoices at their due date when this customer always pays late.
- Adding currencies together or converting them.
- Reading "no record of rent" as "no rent".
- A wall of numbers with no answer to "will we be OK?".
