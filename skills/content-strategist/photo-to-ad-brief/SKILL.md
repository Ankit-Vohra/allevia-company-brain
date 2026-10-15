---
id: photo-to-ad-brief
name: Photo-to-ad brief
when: "The owner sends a photo (product, finished project, dish, room) and wants an ad or poster made from it"
agents: [content-strategist]
tools: [playbook, content_performance, search, get_entity, propose_action]
output: creates
makes: a one-page ad brief a designer or the studio can build from, with headline, offer, sizes and what must not change in the photo
needs_ok: true
---

## Method

0. Purpose first. Before making anything, fill the one-line brief (open the creative-brief skill): the goal (sell, announce, show a feature, get enquiries or bookings, build trust), the one product, service, feature or offer it promotes (by its name in the records), for whom, the one message, the call to action and where it runs. Infer each from the records and the owner's words; ask at most three quick questions with suggested answers only for what matters and is unknown; if the owner says "just make it", pick the strongest product or offer for their goal and say why. Open the piece with the brief in one line.
1. Say what the photo is and what it can carry. Open the record of the thing in it (`search`, then `get_entity`): name, price, place, year, material. The photo proves one thing; pick that one claim ("handmade in small batches", "finished in six weeks") from facts the record holds, never from what the picture seems to show.
2. Pick the one offer or action: visit, book, order, call, ask for a quote. One ad, one action. If the owner gave a price or discount, copy it exactly; if the offer has dates or limits that the record lacks, write "[you tell us: the offer and its last date]".
3. Check how this business's ads and posts were judged before: `content_performance` for the best two items and their hook family; `playbook` (topic "voice" and "hooks", channel the ad will run on) for voice rules and rules learned from the owner's edits. Reuse the hook family, not the words.
4. Write the text that goes on the image: a headline of about 7 words or fewer, an optional line of at most 12 words, and the action. Fewer words win on a phone. Spell the business name, price and phone or web address exactly as the record has them.
5. Set the formats: 1:1 (feed), 4:5 (feed, more screen), 9:16 (stories and reels; keep text out of roughly the top 14% and bottom 20%, where the app puts its own buttons). Say which crop of the photo each size uses and whether the subject survives the crop.
6. List what must never change in the photo: the logo, any printed text, faces, and the shape, proportions and colours of the product or the building. Allowed: crop, brightness, tidying clutter. Anything that would change what the customer gets is not allowed.
7. List what you still need from the owner (a sharper photo, the offer end date, permission for any person visible) and how the ad will be judged: the one number that decides, and when to look at it.
8. Hand over with `propose_action` (kind content_draft, body = the whole brief). It waits for the owner's OK.

## House style

One page, in this order: the claim, the offer and action, the text on the image, the sizes, what stays untouched, what we still need, how we will judge it. Plain words, no design jargon the owner would not say.

> Photo: the walnut dining table by the window.
> Claim: made by hand in the workshop, 5 weeks per table (from the record).
> Action: "Book a viewing". Offer: [you tell us: the offer and its last date].
> On the image: "Made by hand. Seen in person." + "Book a viewing this week".
> Sizes: 1:1 and 4:5 full photo; 9:16 crops to the table, text kept clear of the top and bottom.
> Do not change: the table's shape and colour, the workshop logo in the corner.
> We need: the offer date. Judge it by viewing bookings after 7 days.

## Done well

- [ ] It has a purpose: the one-line brief (goal, what it promotes, for whom, message, action, where) opens it, and every part serves it; a good-looking piece with no purpose fails.
- [ ] One claim, one offer, one action, all traceable to the record or marked "[you tell us: ...]".
- [ ] The text on the image is short, spelled exactly, and clear of the areas an app covers.
- [ ] The brief names what must not change in the photo.
- [ ] Every size says what part of the photo it uses.
- [ ] It says how the ad will be judged and when.

## Common mistakes

- Claiming what the picture seems to show (a material, an award) that the record does not hold.
- Long headlines, or two offers in one ad.
- Letting text fall in the top or bottom of a vertical ad where buttons cover it.
- Asking for a "better" product: moved edges, brighter colours, a changed logo. The customer then gets something different from the ad.
