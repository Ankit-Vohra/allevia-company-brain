---
id: reel-quality-check
name: Reel quality check and repair plan
when: "A reel or video cut is ready: check it against its script and say the cheapest fix for each fault"
agents: [fact-checker]
tools: [search, get_entity]
output: reads
needs_ok: false
---

## Method

1. Get the script and what was actually said. You need the approved script (lines, times, who speaks) and a word-for-word transcript of the cut with times; `search` and `get_entity` find them in the records. Without a transcript, say "not checked: no transcript of the cut" rather than judging from the script.
2. Check every line, beat by beat: is each scripted line there and whole; is there extra speech the script does not have (a repeated phrase is the most common fault); is each line said by the right voice (a man's line in a woman's voice is a fault); is a word said wrongly (the product's name, a place).
3. Check the time a viewer meets first: the first word lands by about 0.3 seconds; no silence longer than about 0.6 seconds between lines; a cut or a new screen before 5 seconds. Dead air at the start is the main reason viewers leave in the first 3 seconds.
4. Check the picture against the brief: no brand names, logos, stickers, religious pictures or drawn lettering in the set; no invented app screen or misspelled word drawn by the model; one prop where the script said one; the same person looks the same across cuts; words on screen spelled exactly, kept clear of faces and of the bottom and right edges.
5. Check facts like any copy: every claim, price and name said or shown must be in the records (your claim-by-claim skill applies to the lines).
6. For each fault, name the cheapest fix, in this order: trim a stray word or silence at a beat's edge (free); mute a small extra sound under a screen (free); cover a repeated line with the real screen it talks about, then trim under it (free); edit or extend one beat; add a short new beat with only the missing line; re-render one beat. Never re-render a whole reel for something a trim or a mute fixes.
7. Do not spend on details a viewer will not notice (a small mark on clothing); fix what a viewer notices and anything that breaks the brand's rules; mention the rest in one line.
Before the verdict, check the piece against its one-line brief ("Made to sell: ..."): it promotes what the brief says, to the audience it names, with the same call to action, and that product or offer exists in the records. A piece with no brief, or one that drifted from it (a nice picture that sells nothing), is a "fix": say what the brief is and what the piece shows instead.
8. Verdict: ok when every line is present and clean and the picture breaks no rule; fix with the list of faults and fixes; reject only when the cut is the wrong story or a guardrail is broken throughout.

## House style

One line per fault: where (beat and seconds), what is wrong, the cheapest fix and what it costs. Then what was not checked.

> Beat 3, 0.0-1.9s: the other person says the first line before he should. Trim it (free).
> Beat 5, 8.1-9.0s: an extra question under the job screen. Mute it (free).
> Beat 1: first word at 1.4s. Trim the start (free).
> Not checked: the Hindi pronunciation of the street name (no transcript of beat 6).

## Done well

- [ ] Every scripted line was matched against the transcript of the cut, not the script alone.
- [ ] Dead air at the start and long silences were measured.
- [ ] The set was checked for brands, drawn text and religious pictures.
- [ ] Each fault has the cheapest fix that works, with its cost.
- [ ] What could not be checked is said plainly.

## Common mistakes

- Trusting one automatic verdict; transcribe the slice yourself when it matters.
- Proposing a full re-render when a trim or a mute fixes it.
- Blocking a reel over a detail no viewer will see.
- Checking a different file from the one the owner watched: compare the lengths first.
