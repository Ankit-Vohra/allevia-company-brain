---
id: poster-text-integrity
name: Poster text and logo check
when: "Checking the words, prices, contact details and logo on a poster, ad or generated image before the owner sees it"
agents: [fact-checker]
tools: [search, get_entity]
output: reads
needs_ok: false
---

## Method

1. Get the exact strings. Ask for (or read from the brief) every piece of text that is meant to appear: business name, headline, price, offer and its dates, phone, address, web address. If you were given only a description or a prompt and not the final image or its text, say plainly what that means: you can check the strings that were planned, not what was drawn.
2. Pull the truth from the record: `search` the business and the product, then `get_entity` for the name spelling, price, address, phone and web address. Compare character by character: "Aarav Interiors" is not "Arav Interiors"; 4,999 is not 4,990; the area code must match.
3. Check what generated images typically get wrong: garbled or doubled letters, a dropped or invented word, numerals that changed (a 6 for a 5), a price with the wrong currency sign, a logo that is redrawn, recoloured, stretched or has an extra letter, a product whose shape or colour is not the real one, a missing "T&C apply" the offer needs.
4. Check dates and offers against the record: the offer's end date, the day of the week, the festival date. A date that does not exist (a 31st of a 30-day month) or a past date fails.
5. List separately the strings that must appear and the strings that must not (a competitor's name, an old price, a discontinued product).
Before the verdict, check the piece against its one-line brief ("Made to sell: ..."): it promotes what the brief says, to the audience it names, with the same call to action, and that product or offer exists in the records. A piece with no brief, or one that drifted from it (a nice picture that sells nothing), is a "fix": say what the brief is and what the piece shows instead.
6. Verdict: ok when every planned string matches the record; fix with the exact string as drawn or planned, what the record says, and the correction; reject when the logo or the main claim is wrong, or the image text cannot be read at all.

## House style

A short table-like list, mismatches only, then what could not be checked.

> Fix: price shows "₹4,990", the record says ₹4,999. The phone ends 4210, the record ends 4201. Logo: the "A" is redrawn; use the original file.
> Not checked: the final image was not available; only the planned text.

## Done well

- [ ] Every string meant to appear was compared with the record, letter by letter and digit by digit.
- [ ] Prices, dates, phone and web address were checked as numbers, not by eye.
- [ ] The logo was checked against the original: shape, colour, spelling.
- [ ] The note says clearly what was checked and what could not be (brief only, or final image).

## Common mistakes

- Approving the "text looks right" from the prompt when the image was never seen.
- Missing a one-digit price or phone difference.
- Accepting a redrawn logo because it is close.
- Judging the design instead of the words: layout is not your check.
