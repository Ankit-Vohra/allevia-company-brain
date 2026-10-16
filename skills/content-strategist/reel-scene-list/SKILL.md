---
id: reel-scene-list
name: Reel scenes and shot list
when: "Turning an approved reel script into scenes and shots: who, where, what each shot shows, and the words put on screen"
agents: [content-strategist]
tools: [search, get_entity, propose_action]
output: creates
makes: a scene-by-scene shot list with the set, the people, the on-screen words and the real screens to insert
needs_ok: true
---

## Method

0. Purpose first. Before making anything, fill the one-line brief (open the creative-brief skill): the goal (sell, announce, show a feature, get enquiries or bookings, build trust), the one product, service, feature or offer it promotes (by its name in the records), for whom, the one message, the call to action and where it runs. Infer each from the records and the owner's words; ask at most three quick questions with suggested answers only for what matters and is unknown; if the owner says "just make it", pick the strongest product or offer for their goal and say why. Open the piece with the brief in one line.
1. Start from the approved script only. Every beat of the script becomes one shot; do not add lines or change them here. Use `search` and `get_entity` for the product, the place and any real screen or photo the business has, so what is shown is what exists.
2. Describe the set in positive words: what IS there ("bare pale-green walls, a plain wooden counter"), never a list of forbidden things. A video model asked for "no posters, no brands, no stickers" tends to draw them; a crowded shop or street fills itself with brand signs and pictures. Keep signs blank or out of frame.
3. Describe each person once, down to clothes and colours and small marks ("a small red bindi", or "no bindi"), and their voice (age, pitch, texture). Keep it the same in every shot so the person does not change between cuts.
4. Shot 1 is the hook: a close shot on the speaker, speaking from the first frame, 3 to 5 seconds, then a cut. No establishing shot, no walk-in. Video models often ignore "close-up": plan to crop in during the edit.
5. For each shot write: time, who is in frame, where they start, the one action, the camera (still or one slow move), and how it ends with everyone in frame (the next shot starts from that frame).
6. A prop in a hand: say ONE, which hand, and what the other hand does ("her one phone in her right hand; her left hand rests on her knee"). Models invent a second phone otherwise.
7. Product screens, the logo, prices and every word on screen are put on top afterwards from real files, never drawn by the model (the design-standard skill has the reel rules: hook words on frame one, each line revealed at reading pace, the real screen in a phone with the camera pushing in on the part being talked about, the business's own photos filling the frame, everything inside the 14% top, 35% bottom and 6% side safe zone). A phone in the shot keeps its back to the camera; the real screenshot covers the frame while the line about it is spoken, with the part being talked about highlighted.
8. Plan a short label when a cut lands on a new person the picture cannot explain ("Rekha, the candidate"), and a time-jump card when the story jumps ("24 hours later").
9. Size every shot to its words (the script's words per second plus about 0.7 seconds before the first word and 1 second after the last); a shot is paid for by the second.
10. Hand it over with `propose_action` (kind content_draft, body = the whole shot list) so it waits for the owner's OK before anything is filmed or rendered.

## House style

A table the owner can read in one glance: one row per shot, in time order, with what we see, who speaks, and what is put on screen. Below it: the cast in one line each, the set in two lines, and any screen or photo the business still has to send.

> 1 | 0-4s | Close on Meena at her stall, phone in her right hand | MEENA: "Ten days, three shops, not one reply." | On screen: "Ten days. No reply."
> 2 | 4-9s | The phone's real job screen fills the frame, the pay line highlighted | MEENA: "This one is 2 km away." | Screen: the job card
> Cast: Meena, 30s, green kurta, no bindi, warm low voice. Set: a plain wooden stall, blank signboard, morning light.

## Done well

- [ ] It has a purpose: the one-line brief (goal, what it promotes, for whom, message, action, where) opens it, and every part serves it; a good-looking piece with no purpose fails.
- [ ] One shot per script beat, each sized to its words, the first a close shot with a cut before 5 seconds.
- [ ] The set is described by what is there, with blank signs; people are described the same way in every shot.
- [ ] Every screen, logo, price and on-screen word is put on afterwards from a real file.
- [ ] Each shot ends with everyone in frame, ready for the next one.
- [ ] Nothing in the list states a fact the records do not hold.

## Common mistakes

- An establishing shot and a walk-in before anyone speaks: viewers leave in the first 3 seconds.
- Asking the model to draw the app, the logo or Hindi text: it invents letters and buttons.
- Listing forbidden objects in the set, which tends to bring them in.
- Every shot a flat 10 seconds, paid for and then trimmed.
- A second person who only holds a phone and never speaks.
