---
id: claim-by-claim-check
name: Claim-by-claim fact check
when: "Checking every name, date, number and claim in a draft against what the business's records hold"
agents: [fact-checker]
tools: [search, get_entity, find_paths, cypher]
output: reads
needs_ok: false
---

## Method

1. List the checkable claims before looking anything up: names, places, dates, numbers, awards, materials, results, prices, and what the business does or offers. Skip what is not a claim: a mood, a way of framing, a "Film:" direction (it tells the owner what to shoot), and a "[you tell us: ...]" placeholder (the right way to mark a missing fact).
2. Look each one up. `search` with the claim's own words finds the record; `get_entity` on the best hit shows its properties and as-of date. Use `find_paths` when a claim joins two things ("the villa was built by our studio for this client"): if no short path joins them, the link is unsupported. Use `cypher` only to read one exact property.
3. Label each claim: supported (the record says it, and it is current), contradicted (the record says something different: quote it), outdated (true once, newer data differs; check the as-of date), unsupported (nothing in the record). Not finding something is not proof it is wrong: unsupported is a different verdict from contradicted, and the fix differs.
4. Check the small words that carry facts: "finished in 2024" versus "dated 2024"; "over 50 projects" versus a count of 41; "our team of 12". Wording stronger than the record is a fail even when the number is right.
5. A claim the owner stated in this conversation counts as the owner's word: mark it "owner said" and pass it, unless the record contradicts it.
6. Write the verdict: ok when every claim is supported; fix when specific claims fail and can be cut, softened or marked "[you tell us: ...]"; reject when the core claim is false or unsupported. The note lists only the failures.

## House style

Failures only, each one line: the quote, what the record says, the fix. At most five, worst first. If all pass, say how many claims were checked.

> Fix: "finished in 2024" - the record says the project is dated 2024, not finished; say "from 2024". "Photo: Studio X" - no photographer is recorded; cut it or write [you tell us: the photographer].
> Ok: 9 claims checked, all in the record.

## Done well

- [ ] Every name, place, date, number and offer in the draft was looked up, none skipped.
- [ ] Contradicted, outdated and unsupported are told apart, with the record's own words quoted for the first two.
- [ ] Placeholders, moods and filming directions were not flagged as gaps.
- [ ] Each failure comes with a fix the writer can paste.
- [ ] The note lists failures only, in one or two sentences each.

## Common mistakes

- Calling a claim wrong because your search returned nothing, without opening the record or trying other words.
- Flagging "beautiful" or "warm" as facts.
- Passing a number because it is close ("about 40" for 41 is fine; 40 for 14 is not).
- Reviewing wording and voice: that is Dev's job.
