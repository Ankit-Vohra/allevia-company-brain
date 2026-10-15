---
id: carousel-post
name: Swipe post (carousel) craft
when: "A post people swipe through, slide by slide: steps, a list, a before and after, or myth versus fact"
agents: [content-strategist]
tools: [playbook, content_performance, search, get_entity, neighbors, propose_action]
output: creates
makes: a slide-by-slide swipe post with the text for each slide, a caption and hashtags
needs_ok: true
---

## Method

1. Check that the job suits a carousel. It suits four jobs: a process (steps in order), a list (three to seven items that stand alone), a before and after, and myth versus fact. It does not suit a single announcement or a mood: hand those to a one-photo post (Instagram post skill) or a reel (reel script skill) and say so in one line.
2. Learn the brand's rules. Call `playbook` with topic "hooks" and channel "instagram" for the hook formulas, and `playbook` with topic "voice" and the same channel for how this brand talks. The owner's own rules in that list come first.
3. Learn what worked here. Call `content_performance` with channel "instagram", days 90, limit 10. Find the items whose format is a carousel: saves and shares are the signal that matters for swipe posts (people save steps and lists), more than views. Take the hook family of the best one. If no carousel is recorded, say "no swipe posts to learn from yet" and use the best hook family from the other formats.
4. Collect the facts. Call `search` for the process, product, project or topic, then `get_entity` on the best hits, and `neighbors` on the main one to find linked steps, materials, products, people or audiences. List the facts you hold before you plan any slide: each slide needs one fact or one clear action from the record.
5. Count the facts and set the slide count (rule of thumb):
   - Five or more distinct facts: 5 to 8 slides.
   - Three or four facts: make it 3 or 4 slides and say "the record holds only N facts, so this is a short swipe post".
   - Fewer than three: do not stretch it. Write a one-photo post or a 3-slide version (hook, the one fact, the action) and list what the owner could tell us to unlock a longer one.
6. Slide 1 is the hook and the only slide most people see in the feed. Put a promise or a question in at most 8 words, large, plus a small "swipe" cue. Use the hook family from step 3. Never a title card with the brand name.
7. Middle slides: one idea per slide. Heading at most 8 words, body at most 25 words (about 2 short lines), so it is readable on a phone in 3 seconds. Use the same order and layout on every slide so the swipe feels like one thing. Process posts: one step per slide, numbered "1 of 5" style. Lists: one item per slide, the strongest item second, not first. Before and after: before on one slide, after on the next, same framing. Myth versus fact: the myth on one slide, the fact on the next, never both together.
8. Add a payoff slide second to last: the result, the answer or the proof the hook promised. A swipe post without it feels like a trick. Only facts from the record may appear on it.
9. The last slide carries one action: save this, send it to someone, book, message us. One verb. Where the route (a link, a phone number, a place) comes from the record, use it exactly; otherwise "[you tell us: how people book or reach you]". Never end on a thank-you slide.
10. Write the caption: the hook line again in a new angle (it is seen before the slides are), two short sentences, three to five specific hashtags, no second call to action. Add one line of alt text for slide 1.
11. Hand it over with `propose_action` (kind content_draft, body = every slide's text, the caption, the hashtags, the alt text; evidence = the ids you used). It becomes a draft waiting for the owner's OK.

## House style

Slide-by-slide text the owner or a designer can paste into a template, one line per slide: "Slide n: heading | body | picture direction". Pictures are directions ("Photo: the finished tile floor, wide"), never facts. The whole note is short: for 6 slides about 1,200 to 1,800 characters including the caption. Below it, in one line each: the hook family used and why, the job (process, list, before and after, myth versus fact), and every "[you tell us: ...]" spot. When you cut the slide count, say why in one line.

Example (5 slides, a physiotherapy clinic, invented for illustration):

> Job: myth versus fact. Format: 5 slides, 4:5.
> Slide 1: Does rest cure a stiff neck? | swipe | Photo: someone rubbing their neck at a table
> Slide 2: The myth | "Lie still for a week." | Plain text on a light background
> Slide 3: What the clinic says | [you tell us: the clinic's advice on movement, one sentence] | Photo: a gentle neck stretch
> Slide 4: When to book | [you tell us: the sign that means come in] | Plain text
> Slide 5: Save this, and book if it is not easing | [you tell us: how people book] | Clinic logo, small
> Caption: Rest feels right for a stiff neck. Moving gently is often the better start. #yourclinic #necktension
> Alt text for slide 1: a person at a table holding the back of their neck.

## Done well

- [ ] Slide 1 works alone in the feed: a promise or question in 8 words or fewer.
- [ ] One idea per slide; headings 8 words or fewer, bodies 25 words or fewer.
- [ ] The second-to-last slide pays off the hook and the last slide asks for exactly one thing.
- [ ] The slide count matches the facts held, and any cut is explained in a line.
- [ ] Every fact is from the record; every gap says "[you tell us: ...]".
- [ ] The note says which job it is and which hook family it used.

## Common mistakes

- Stretching three facts across eight slides with filler ("Quality matters", "We care"). Make it 3 slides and say why.
- A cover slide with the brand name and a date as the hook.
- Two ideas on one slide, or a paragraph on a slide: nobody reads it on a phone.
- Putting the myth and the fact on the same slide, which removes the reason to swipe.
- Ending on "Thank you for watching" or with three calls to action.
- Changing the layout from slide to slide, so the swipe feels like a scrapbook.
- Treating a posted carousel's views as the measure: look at saves and shares first.
