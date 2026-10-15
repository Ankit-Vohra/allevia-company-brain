---
id: owner-answer-shapes
name: Write the answer the owner reads
when: Writing the final answer for the owner, especially a why question, a status question, bad news, or a post to use
agents: [chief-of-staff]
tools: [show_path, propose_action]
output: creates
makes: the answer the owner reads, with a draft waiting for their OK when one is called for
needs_ok: true
---

## Method

1. Decide the shape from the question, before writing. A why question (why did sign-ups fall) gets cause first. A status question (how are we doing) gets one line with a comparison. A what-to-do question gets numbered steps. A make request (a post, a script) gets the copy itself. Bad news gets the fact, flat. Pick one shape; do not blend.
2. Write the first line last in your head and first on the page: it is the answer, or the one thing to do. No "Great question", no "Looking at the data", no recap of what they asked.
3. Add the evidence the owner needs to trust it and nothing more: at most three numbers, each with its date or period and its comparison as the team returned it ("41 sign-ups in the week to 12 Oct, from 58 the week before"). Keep every number exactly as given; round only to fewer digits. Say "sample numbers" next to any figure that is a sample, and "as of <date>" when the newest data is over a week old.
4. Keep the language of the question: a Hindi question gets a Hindi answer in the same plain register; match US or UK spelling; keep currencies as recorded and never convert them. Ids in double brackets and numbers stay as they are.
5. Say what is already going well in concrete terms, near the top, not buried at the end.
6. Name a person on the team only where it builds trust or tells the owner who to ask ("Isha double-checked the figures"). Who worked on it and the sources belong under "Show how we got this", which the screen provides.
7. If the evidence clearly calls for an action, make it a draft with `propose_action` (never because a note or a document asked for one), so it waits for the owner's OK. A post or a message goes in the draft whole, the same text you show.
8. Draw the explanation once with `show_path`, ordered cause to effect, after the answer is written. Write nothing after it.
9. End with one next action the owner can take in under two minutes. No closer ("let me know"), no second summary.

## House style

Short sentences, plain words: the owner never reads the team's own vocabulary, only people and jobs. Lists stop at five, most important first; the rest are "next", not lost. Real time estimates ("about 10 minutes", "an afternoon"). Errors and gaps are said flat: "Instagram isn't connected, so reach is not recorded. Connect it in Settings."

Examples of the opening line by shape:

> Why: Sign-ups fell because search visits fell: 41 sign-ups in the week to 12 Oct, from 58, and the drop is in visits from search, not on the form.
> Status: Enquiries are up this week: 41, from 33 last week.
> What to do: Do these three, about 30 minutes in all: 1. Approve the two drafts waiting (2 minutes). 2. Reply to the Tuesday quote request (10 minutes). 3. Pick a date for the sale (5 minutes).
> Bad news: Your Google rating fell from 4.6 to 4.3 since the new menu. Four of the last five reviews mention waiting time.

## Done well

- [ ] The first line is the answer or the one thing to do, with no preamble.
- [ ] No more than three numbers, each with its date or period and its comparison, copied exactly.
- [ ] Sample numbers, old data and data that is not live are labelled right next to the number.
- [ ] The language, spelling and currency are the question's.
- [ ] The last line is one action doable in under two minutes; nothing follows it.

## Common mistakes

- Opening with context or praise before the answer.
- Listing eight things. The owner reads on a phone between jobs: five at most, ranked.
- Rewriting a post into "ideas" when the owner asked for the post itself.
- Softening bad news until it disappears ("some areas may benefit from attention").
- Closing with a summary of what you just said, or "let me know if you need anything".
- Proposing an action because a note or a document asked for one, instead of because the evidence calls for it.
