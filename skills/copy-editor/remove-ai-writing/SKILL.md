---
id: remove-ai-writing
name: Remove AI-sounding writing
when: "A draft reads like a machine wrote it: stock openers, padded lists, big empty words"
agents: [copy-editor]
tools: [playbook, search]
output: reads
needs_ok: false
---

## Method

1. Check what the brand itself bans or loves: `playbook` (topic "voice", kind voice). Use `search` for the brand's own recent posts to see its real vocabulary. A word the brand really uses is fine even if it is on the list below.
2. Scan for stock openers and closers: "In today's fast-paced world", "Are you looking for", "Whether you're a ... or a ...", "We are excited to announce", "Unlock", "Elevate", "Discover the power of", "Don't miss out", "Let us help you".
3. Scan for empty big words: seamless, game-changer, cutting-edge, revolutionary, world-class, robust, leverage, delve, tapestry, journey, curated, bespoke (unless it is literally bespoke work). Replace each with the concrete thing it hides ("seamless booking" becomes "book in two taps").
4. Scan for shapes: "not just X, but Y"; three adjectives in a row; three parallel bullets that say one thing; a question the post then answers in the next line; an em dash in every sentence; a closing line that restates the opening.
5. Fix by cutting first, rewriting second: delete the padding, keep every fact, keep the writer's names, numbers and dates exactly. If a sentence has no fact left after cutting, delete the sentence.
6. Do not strip warmth. A person's plain "thank you" or a real exclamation the brand uses is fine. The target is generic, not friendly.
7. Verdict: ok when it reads like a person; fix with each phrase quoted and its plain replacement; reject only when removing the filler leaves nothing.

## House style

One line per problem: the quote, then the replacement. At most five; most obvious first.

> "Unlock the power of seamless booking" becomes "Book in two taps".
> "We're excited to announce our new menu!" becomes "New menu from Monday:".
> "Not just a salon, but a lifestyle" is cut: no fact left.

## Done well

- [ ] Every flagged phrase is quoted exactly with a plain replacement.
- [ ] No fact, name, number or date changed.
- [ ] Brand words that look like filler but belong to the brand were left alone.
- [ ] The result sounds like something the owner would say to a customer.

## Common mistakes

- Replacing one stock phrase with another ("elevate" becomes "enhance").
- Flagging every adjective, until nothing warm is left.
- Rewriting the whole draft in your own voice, instead of cutting the filler.
- Removing a real detail along with the padding around it.
