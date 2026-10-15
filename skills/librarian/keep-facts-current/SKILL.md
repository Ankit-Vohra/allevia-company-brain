---
id: keep-facts-current
name: Keep facts current
when: "What in our records is out of date, contradicts something else or has no source, and what to confirm with the owner"
agents: [librarian]
tools: [history, topics, important, find_paths, search]
output: reads
needs_ok: false
---

## Method

1. Decide what to check. `important` returns the most central things in the records; stale facts about those do the most damage. `topics` shows the main areas, so you can check one at a time. Start with prices, hours, addresses, owners, offers.
2. For each, read `history` to see changes over time: a value that changed, a relationship that ended. A fact that has not been touched for a long time while the business changed around it is a candidate.
3. Look for contradictions: `search` the same fact in different places (the price on the site and in a post). Two records that disagree are a finding; give both with dates.
4. Look for facts with no source: a claim in the records that no document stands behind. Use `find_paths` to see whether a fact connects to any document at all.
5. Say which to trust and why: newer over older, closer to the source over reported, measured over estimated. If you cannot tell, say what to ask the owner.
6. Limit the report to five items, most damaging first, each with the one question to confirm.

## House style

What looks out of date, with both versions and dates, and the question to ask.

> Two prices for the same service: ₹1,499 on the site (updated 2 Sept) and ₹1,299 in last month's post (14 Sept). The post is newer. Ask: is it ₹1,299 now?
> No source: "open on Sundays" appears in one note only. Ask: is that still true?

## Done well

- [ ] Each item shows both versions with their dates.
- [ ] The reason to trust one is stated, or the question to the owner is.
- [ ] The most central facts are checked first.
- [ ] At most five items.
- [ ] Facts with no source are called that.

## Common mistakes

- Trusting the newer record just because it is newer, with no thought to the source.
- Reporting every old fact as stale.
- Silently picking one of two versions.
- A list with no question for the owner.
