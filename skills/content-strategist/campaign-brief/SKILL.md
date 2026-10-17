---
id: campaign-brief
name: Festival or offer campaign plan
when: "A plan for a festival, season, launch or offer (Diwali, Eid, Christmas, Black Friday, Mother's Day): timeline, offer, posts, what to measure"
agents: [content-strategist]
tools: [what_worked, playbook, content_performance, search, get_entity, neighbors, propose_action]
output: creates
makes: a campaign plan with an offer, a day-by-day timeline, a posting rhythm, the pictures and copy needed, and how to judge it
needs_ok: true
---

## Method

0. Purpose first. Before making anything, fill the one-line brief (open the creative-brief skill): the goal (sell, announce, show a feature, get enquiries or bookings, build trust), the one product, service, feature or offer it promotes (by its name in the records), for whom, the one message, the call to action and where it runs. Infer each from the records and the owner's words; ask at most three quick questions with suggested answers only for what matters and is unknown; if the owner says "just make it", pick the strongest product or offer for their goal and say why. Open the piece with the brief in one line.
1. Name the occasion and the one goal. A campaign has one goal: enquiries, orders, bookings, or visits. Pick it from the request; if the owner gave none, take the goal the record shows for the business (search for "goal") and say which you took. A campaign that tries for reach, sales and followers at once is judged on none.
2. Get the date from the record, not from memory. Call `search` for the occasion and the year (for example "Diwali 2026", "Eid sale") and look for the date the owner or a past plan recorded. Festival dates move: Diwali and Eid change every year, and Eid can fall a day apart between countries because it follows moon sighting; Mother's Day is on different dates in the US, the UK, India, Australia and the UAE. If the date is not recorded, write "[you tell us: the date this year in your city]" and keep every timeline point relative ("14 days before"), never a calendar date.
3. See what happened last time. Call `what_worked` (top and weakest posts by real numbers, edit rules, decisions, the main goal's call to action), then `search` for earlier campaigns and offers, then `get_entity` on the best hits for what was offered, to whom and for how long. Call `content_performance` with days 365 and limit 10 to see which posts around the same season did well and with which hook (the `byHook` ranking). If nothing is recorded, say "no earlier campaign recorded".
4. Learn the rules and the offer facts. Call `playbook` with topic "campaign" and then with topic "voice" for the owner's rules, tone and festival do's and don'ts. Call `get_entity` on the product or service in the offer and `neighbors` on it to find its linked audience, price, stock or capacity facts. Prices, discounts and quantities come only from the record or the owner: write "[you tell us: the price or the saving]" otherwise. Never invent a discount percentage.
5. Define the offer mechanics in four lines: what (the product, bundle or gift), for whom (new customers, regulars, one segment from the record), how long (a start and an end, in days from the occasion), and the one honest limit that creates urgency: a real end date, real stock, or a real number of slots. If the owner has no real limit, use the end date alone. Never a fake countdown, "only today" that renews tomorrow, or invented scarcity.
6. Lay the timeline from about 14 days before to 3 days after, using relative points (rule of thumb):
   - 14 to 10 days before: tease. Show the occasion and what is coming; collect interest ("message us to hear first").
   - 9 to 4 days before: launch the offer and show the best product proof (the hook family that worked).
   - 3 to 1 days before: last chance. Remind with the real limit; this is when most gifting orders arrive.
   - The day itself: a short greeting post, no selling on the greeting.
   - 1 to 3 days after: thank people and show what was sold or made; close the offer clearly, on time.
7. Set channels and rhythm from the record. Use the channels the business already posts on (from `content_performance` and `get_entity` on the channel entities); do not add a channel the owner does not run. Rule of thumb for a small business: 4 to 6 posts in the run-up plus the greeting and the thank-you, 3 stories or status updates in the last 3 days, and one reel or carousel of the product for the launch. Name each post's format and job in one line; hand the full copy to the reel script or swipe post skills.
8. List the assets needed, each with its owner: photos (product, packaging, the team at work), a price card, a short video, the offer text, the greeting text, and any logo or festival artwork the brand already holds (search the brand assets). Mark what the record already has and what the owner must supply.
9. Say what to measure and when to judge it. Measure the goal (orders, bookings or enquiries, which the owner reports or the numbers team can read) and the posts (views, saves, shares, from `content_performance`). Judge at the end of the offer plus 3 days, against the same number of days before the teaser. Say it plainly: the posts' numbers show interest; the goal's number shows whether it worked.
10. State what the owner must decide: the offer, the price or saving, the end date, the stock or slots, who answers messages, and any budget for paid promotion. Then hand the plan over with `propose_action` (kind content_draft, body = the whole plan; evidence = the ids you used) so it waits for the owner's OK.

## House style

One short plan the owner reads in two minutes, in this order: one line with the occasion and the goal; Offer (four lines); Timeline (five lines, relative days); Posts (a numbered list, at most 8, each with format and job); What we need (assets, who supplies); How we will judge it; Owner decides (at most 5 items, the first one the one to do now). Keep it under 3,000 characters and mark every missing fact "[you tell us: ...]". Prices are exactly as the record has them and in its currency.

Example (a small salon, invented for illustration):

> Goal: bookings for the week before the festival.
> Offer: a hair spa for [you tell us: price]. For regulars and new clients. 7 days, ends [you tell us: end day]. The one limit: [you tell us: slots per day].
> Timeline: 14 to 10 days before, tease; 9 to 4, launch; 3 to 1, last slots; the day, greeting only; 1 to 3 after, thank you.
> Posts: 1. Reel, the spa in 30 seconds (launch). 2. Swipe post, what is in the spa (launch). 3. Story, slots left (last chance). 4. Greeting photo. 5. Thank-you photo.
> We need: photos of the chair and products; the price card; the greeting text.
> Judge: bookings in the offer week against the week before the teaser, plus saves and shares on posts 1 and 2.
> Owner decides: 1. The price. 2. The slots. 3. The end day.

## Done well

- [ ] It has a purpose: the one-line brief (goal, what it promotes, for whom, message, action, where) opens it, and every part serves it; a good-looking piece with no purpose fails.
- [ ] One goal, one offer, one honest limit.
- [ ] Every timeline point is relative unless the record or the owner gave the date.
- [ ] Every price, discount, stock or slot number is from the record or marked "[you tell us: ...]".
- [ ] Posts are on channels the business already uses, each with a format and a job.
- [ ] What to measure and when to judge are stated, and what the owner must decide is ranked with the first item to do now.
- [ ] Earlier campaigns and hooks that worked are used, or the plan says none are recorded.

## Common mistakes

- Assuming a festival date or a regional custom instead of checking the record.
- Making up a discount or a countdown to create urgency.
- Posting the offer daily for two weeks: it burns the audience before the last-chance days.
- Selling inside the festival greeting post, which reads as tone-deaf.
- Judging the campaign on likes instead of the goal's number.
- A plan with no owner for each asset, so the photos never arrive.
- Adding a channel the business does not run, or a paid plan nobody approved.
