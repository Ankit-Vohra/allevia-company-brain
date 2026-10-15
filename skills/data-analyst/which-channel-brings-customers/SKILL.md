---
id: which-channel-brings-customers
name: Which channel really brings customers
when: "Which of Instagram, Google, ads, WhatsApp or word of mouth brings paying customers, when the numbers from each place disagree"
agents: [data-analyst]
tools: [metric_trend, content_performance, cypher, search]
output: reads
needs_ok: false
---

## Method

1. Fix the one true count first. Customers, bookings or sales come from the place where money is real: the booking system, the till, the bank or the orders list. `search` for it and read the count with `metric_trend` (groupBy week or month). Every other source only explains where those customers came from; none of them changes how many there were.
2. Collect each channel's own claim for the same period: ads (sign-ups or sales the ad platform reports), Instagram (`content_performance`: link taps, profile visits, DMs), Google (search clicks, calls from the profile), WhatsApp enquiries, referrals. Use `cypher` to count customers by recorded source when customers carry a "how they found us" field. Never add the channels' claims together: Meta and Google often both claim the same sale.
3. Look for the hidden sources. "Direct" and searches for the business's own name usually mean someone found the business elsewhere first (a friend, a reel, a WhatsApp forward) and then typed the name. Word of mouth leaves no link at all.
4. Use the customer's own answer as the tie-breaker. If the business asks "How did you hear about us?" at booking or checkout, count those answers (`cypher` or `search`). If it does not ask, say so and suggest adding the question with a short pick list (Instagram, Google, a friend, walked past, WhatsApp, other) plus "tell us more".
5. Give an honest split with how sure you are: strong (the true count, the customer's answer and the channel's own claim agree in direction), medium (two of three), weak (one source only). Agreement in direction over several weeks ("Google up, Instagram flat") is trustworthy even when no two numbers match.
6. Turn it into one money move: where the next week's time or budget goes, and what not to cut ("Do not cut the Instagram posting: 9 of the 23 customers who answered said a friend showed them a reel").

## House style

The answer first (which channel, how sure), then each channel's numbers side by side for the same period with their source and date, then one move.

> Most new customers in September came from Google and friends, not ads. Fairly sure.
> - True count: 61 new customers in Sep (bookings system).
> - Asked at booking (34 answered): Google 14, a friend 11, Instagram 6, ads 3.
> - Meta ads report 19 sales; Google profile shows 48 calls.
> Ads claim far more than customers say; part of that is the same people counted twice.
> Next: keep the Google profile fresh and ask happy clients to tell a friend; hold ad spend at today's level for 4 weeks.

## Done well

- [ ] One true count of customers is named, from where the money is recorded.
- [ ] The channels' claims are shown side by side and never added together.
- [ ] The customer's own answer was used, or its absence was named with the fix.
- [ ] How sure we are is stated, with the reason.
- [ ] It ends with one move about time or budget.

## Common mistakes

- Believing the ad platform's sales number as the truth.
- Adding Meta's and Google's numbers into a total that exceeds the real customers.
- Reading "direct" as "nobody sent them".
- Cutting the channel that starts the interest (reels, word of mouth) because it never gets the last click.
- Giving a percentage split to one decimal place from 30 answers.
