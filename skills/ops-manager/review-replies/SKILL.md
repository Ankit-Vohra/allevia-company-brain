---
id: review-replies
name: Replies to customer reviews
when: "New Google, Facebook or app store reviews, or a complaint: a short reply to each in the owner's voice, and what the reviews keep saying"
agents: [ops-manager]
tools: [search, cypher, recall, propose_action]
output: creates
makes: a short public reply for each review and the two or three things customers keep mentioning, waiting for the owner's OK
needs_ok: true
---

## Method

0. Purpose first: a public reply is read by every future customer, not just the reviewer. The goal is that a stranger reading it thinks "they care and they fix things".
1. Collect the reviews of the last 90 days (a shorter window often holds nothing for a small business). `search` for reviews, ratings and complaints; `cypher` lists those with no reply yet, oldest first, when they are recorded. If the review sites are not connected, ask the owner to paste the reviews or a screenshot, and say which sites you could not see.
2. Check `recall` for the reviewer: an earlier complaint, a refund, a thread with the owner. Never reveal private details in public (what they bought, what they paid, a booking date) unless the reviewer wrote it themselves.
3. Find the patterns before replying: group the reviews into two or three themes ("waiting time", "the fit", "friendly staff"), each with a count and two short quotes in the customer's exact words. Patterns are what the owner can fix; single reviews are what Taskmaster replies to.
4. Write a reply to every review, not only the bad ones, under 60 words each, in the owner's voice:
   - Praise: thank them for the specific thing they mentioned. Short and human.
   - Complaint: name what went wrong, say what has changed or will, and take it offline with a real contact ("Call me on the studio number, ask for Noor"). No defending, no policy, no "sorry you feel that way".
   - Mixed: answer both halves honestly.
   - Unfair or false: stay calm, correct the fact once, then stop. Never argue in public.
5. Never offer a discount, refund, gift or credit in a reply unless the owner has agreed to it, and never offer anything in exchange for a review or for changing one (against Google's rules).
6. Hand everything over with `propose_action` (kind content_draft, body = the themes and every reply beside its review), so nothing is posted until the owner reads it. Public replies are permanent.

## House style

The rating picture in one line with its date, then the themes with quotes, then each review with its reply, oldest unanswered first.

> 4.6 stars from 82 Google reviews (15 Oct); 9 new in 90 days, 3 without a reply.
> What customers keep saying: the fit (5 reviews: "fits like it was made on me"); waiting at pick-up (2: "waited 40 minutes").
> 2 stars, Ahmed, 3 Oct: "Great suit, but I waited 40 minutes at pick-up."
> Reply: "Ahmed, thank you, and you're right about the wait. We now text when your suit is pressed and ready, so you can come straight in. If you'd like a quick fix on anything, call the studio and ask for Noor."

## Done well

- [ ] Every review in the window has a reply, praise included.
- [ ] Complaints get the specific problem, the change, and a real way to talk offline.
- [ ] Replies are under 60 words and in the owner's voice.
- [ ] No private detail, offer or refund the reviewer and owner did not already state.
- [ ] Themes carry counts and the customers' exact words.
- [ ] Nothing is posted before the owner's OK.

## Common mistakes

- Copy-paste replies ("Thank you for your feedback!") on every review.
- Explaining policy or arguing with an angry reviewer in public.
- Mentioning a booking, a price or a health detail the reviewer did not share.
- Offering a free service in exchange for changing a review.
- Paraphrasing the customer instead of quoting them.
