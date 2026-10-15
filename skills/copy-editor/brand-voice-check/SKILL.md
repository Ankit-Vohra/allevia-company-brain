---
id: brand-voice-check
name: Brand voice check
when: "Checking a draft (post, caption, script, message) against this business's own voice rules"
agents: [copy-editor]
tools: [playbook, get_entity, search]
output: reads
needs_ok: false
---

## Method

1. Get the rules in one round: `playbook` with kind "voice" (and the channel when the draft is for one). Rules the owner taught the team from their edits arrive in the same list: they outrank everything else. Read the owner's standing instructions in your prompt too ("no emojis on LinkedIn").
2. If the rules are thin (fewer than three), learn the voice from the business's own words: `search` for its about page or best posts, then `get_entity` on one or two. Judge the draft against how the brand really writes, not your taste, and say that is what you did.
3. Read the draft once for sound, once for rules. For sound: would the owner say this out loud? Is it as formal as the brand is? For rules: banned words, required words (a tag, a sign-off), emoji and exclamation policy, sentence length, person ("we" versus "I"), spelling variant, prices written the brand's way.
4. A caption that is only a label (a name, a place, a year) is not on brand: it needs a hook line and a sentence a person would say. Send it back.
5. Facts are Nisha's job, not yours: never reject for a fact you cannot check; only say the claim sounds bigger than the brand's usual.
6. Give the verdict: ok when it follows the rules and sounds like the brand; fix when a specific line or word changes it; reject only when most of it is off-voice. The note is one or two sentences: quote the line, name the rule, give the replacement.

## House style

The note is short and exact. Say which rule, quote the words, say the fix.

> Fix: line 1 "We are thrilled to unveil" breaks the rule "plain, no hype words"; say "New this week:". The exclamation mark in line 3 goes too.

When nothing needs changing: "On brand: plain, short, ends with a question like the best recent posts."

## Done well

- [ ] Every note names the rule it comes from (a voice rule, a learned rule, or the brand's own recent wording).
- [ ] Every quoted line comes with a replacement the writer can paste.
- [ ] The owner's own rules and edits were applied before any general taste.
- [ ] No fact was judged here.
- [ ] A label-only caption was sent back.

## Common mistakes

- Imposing a polished agency voice on a brand that writes plainly.
- A note like "make it more engaging": it says nothing the writer can do.
- Rejecting a whole draft for one hype word that a single fix removes.
- Rewriting the text yourself instead of quoting the line and the rule.
