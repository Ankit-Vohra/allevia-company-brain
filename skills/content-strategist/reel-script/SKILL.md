---
id: reel-script
name: Reel script craft
when: A short video script (15 to 45 seconds) with timed beats, words, on-screen text and what to film
agents: [content-strategist]
tools: [playbook, content_performance, search, get_entity, propose_action]
output: creates
makes: a timed reel script with on-screen text, filming directions, a caption and an audio note
needs_ok: true
---

## Method

0. Purpose first. Before making anything, fill the one-line brief (open the creative-brief skill): the goal (sell, announce, show a feature, get enquiries or bookings, build trust), the one product, service, feature or offer it promotes (by its name in the records), for whom, the one message, the call to action and where it runs. Infer each from the records and the owner's words; ask at most three quick questions with suggested answers only for what matters and is unknown; if the owner says "just make it", pick the strongest product or offer for their goal and say why. Open the piece with the brief in one line.
1. Fix the one idea before any timing. A reel carries one idea a stranger can repeat in a sentence ("sourdough takes 30 hours", "this villa has no corridor"). If the request holds two ideas, write the stronger one and offer the other as the next reel in one line. If the request is vague ("a reel for the new menu"), pick the idea from the facts in step 4 and say which you picked.
2. Learn the brand's rules. Call `playbook` with topic "hooks" and channel "instagram" for the hook formulas (each comes back with a template and an example), then `playbook` with topic "voice" and the same channel for how this brand talks. Rules the owner taught the team come back in the same list: they beat your habits.
3. Learn what worked here. Call `content_performance` with channel "instagram", days 90, limit 10. Look at items whose format is a reel or video: take the hook family of the top two (the `hook` field and the `byHook` ranking, best median multiple first) and read the weakest one to see what to avoid. Copy the family, never the words. Read average watch and skip rate if they are recorded: a high skip rate on a slow opening means this audience wants the payoff shown earlier. If fewer than five reels are recorded, say "only a few reels to learn from" and lean on the formulas from step 2.
4. Collect the facts. Call `search` for the product, project, dish or offer, then `get_entity` on the best one or two hits. Only what comes back may be said, shown as text or claimed. Every missing detail becomes "[you tell us: the detail in a few words]" in that spot. Never invent it, and never drop the scene because one detail is missing.
5. Pick the length by the idea, not by habit (rule of thumb):
   - 15 seconds: one visual surprise or one fact. Hook 0-2s, two beats, payoff, a one-line close.
   - 30 seconds: a short process or a before and after. Hook 0-3s, four beats about 4 to 6 seconds each, payoff, close.
   - 45 seconds: a story or a how-to with a proof moment. Hook 0-3s, six beats about 4 to 6 seconds each, payoff with proof, close.
   Shorter is better when the idea is one fact; do not pad to 45.
6. Write the hook for 0 to 3 seconds. Many people watch with the sound off and decide in about the first 3 seconds, so the hook must work as picture plus 6 words of text with no audio at all. Open on the most interesting frame (the result, the cut, the pour), never on a logo, a greeting or "so today we...". Bars from a real reel pipeline whose first reels lost two thirds of viewers inside 3 seconds (wide opening, silence, a setup line first): line 1 is the conflict and makes sense to a stranger (who the person is, what they need, the pain, in one spoken sentence from the first frame); beat 1 lasts 3 to 5 seconds so a second shot comes before 5 seconds; the product or result is on screen by about 12 seconds; the last line answers the first so the end flows back into the opening. Name the ONE thing this reel changes compared with the last one, so its numbers teach something.
7. Write the beats: one new thing about every 3 to 5 seconds (a new angle, a new action or a new line of text), so the picture never sits still for more than 5 seconds. Give each beat three things: SAY (the spoken line; rule of thumb 2 to 2.5 words per second, so about 60 words for 30 seconds; spoken Hindi runs faster, about 3 words per second; size each beat to its words, never a flat 10 seconds). Write proper sentences, not telegrams: every line makes sense to someone who heard only the lines before it (no verb without its object, no count without its noun), and when a line talks about the product, the product is on screen while it is said, TEXT (on-screen words, at most 6 per card, echoing the spoken line rather than paraphrasing it, kept away from the bottom fifth and the right edge where the app puts its buttons) and FILM (a direction, never a fact about the business).
8. End with a payoff and a close. The payoff delivers what the hook promised, in the last beat that can still be watched (the finished loaf, the final room). The close is one short line with one action (save this, book a visit, message us). Where the record gives the booking route, name it; otherwise "[you tell us: how people book or order]".
9. Write the caption as in the Instagram post skill (hook line, two short sentences, three to five hashtags, no ask that repeats the close), and an audio note: "original sound with your voice" or "music with no lyrics, kept low under speech", never a named track you cannot confirm is licensed for business use.
10. Hand it over with `propose_action` (kind content_draft, body = the whole script, the caption and the audio note, evidence = the ids you used). It becomes a draft waiting for the owner's OK.

## House style

Whole script, timed, ready for someone to film on a phone. One line per beat, in this order: time, SAY, TEXT, FILM. Keep the whole note short: a reel with caption fits in about 1,500 characters. Below it, in one line each: the hook family used and why, and every "[you tell us: ...]" spot. Finish with one honest line: the timings are a plan, not data; the first cut decides the real pacing, and views come back only after posting.

Example (30 seconds, a bakery, invented for illustration):

> Idea: sourdough takes 30 hours, and the crust shows it.
> 0-3s | SAY: "Thirty hours for one loaf. Here is why." | TEXT: "30 hours. One loaf." | FILM: close-up of the crust being cut open
> 3-8s | SAY: "Day one, the starter wakes up." | TEXT: "Day 1: the starter" | FILM: spoon lifting bubbling starter
> 8-14s | SAY: "Then the dough rests, slowly." | TEXT: "The slow rest" | FILM: dough in a bowl, window light, if you have it
> 14-21s | SAY: "Into a hot oven, and the crust cracks." | TEXT: "Hear the crust" | FILM: loaf out of the oven, hold on the sound
> 21-27s | SAY: "That crackle is the 30 hours." | TEXT: "Worth the wait" | FILM: the first slice, steam rising
> 27-30s | SAY: "Open from [you tell us: opening time]. Save this for Saturday." | TEXT: "Save for Saturday" | FILM: the shop door sign
> Caption: Thirty hours from starter to oven. The crust is why people write to us. #cornerbakery #sourdough
> Audio: original sound for the crackle, soft music without lyrics under the voice.

## Done well

- [ ] It has a purpose: the one-line brief (goal, what it promotes, for whom, message, action, where) opens it, and every part serves it; a good-looking piece with no purpose fails.
- [ ] The first 3 seconds make sense with the sound off: a strong frame plus at most 6 words of text.
- [ ] One idea, one payoff that keeps the hook's promise, one action in the close.
- [ ] Beats change about every 3 to 5 seconds, and the spoken words fit the length (about 60 for 30 seconds).
- [ ] Every fact is one the record holds; every gap says "[you tell us: ...]"; every FILM line is a direction, not a claim.
- [ ] The hook belongs to a family that did well here, or the note says it is a fresh try.
- [ ] The note says plainly that timings are a plan, not data.

## Common mistakes

- Opening with a logo, a greeting or "Hi everyone": the viewer is gone before the idea starts.
- Two ideas in one reel, so the payoff arrives late or never.
- Text that repeats the speech word for word. Text should add the key word or the number the viewer needs without sound.
- On-screen text in the bottom fifth or at the right edge, where the buttons and caption cover it.
- Writing "Film: our team smiling in the kitchen" as if the shot exists. Film lines are directions the owner can follow or skip.
- Padding to 45 seconds when the idea fits in 15, or promising a result in the hook that the reel never shows.
- Inventing a number, a year or an award to make the hook stronger.
