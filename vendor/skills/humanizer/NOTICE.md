# humanizer: third-party notice

Allevia makes everything the owner reads sound written by a person with the rules of the `humanizer` skill: 26 patterns in
six groups (staging instead of stating, rhythm by rule, inflation and borrowed authority, formatting by rule, chat and draft
leftovers, writing for the wrong reader), taken from Wikipedia's "Signs of AI writing".

| | |
|---|---|
| Repository | https://github.com/blader/humanizer |
| Pinned commit | `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8` |
| License | MIT, Copyright (c) 2025 Siqi Chen |
| Files taken | `SKILL.md` and `LICENSE`, both verbatim, fetched at that commit with `gh api` |

Copyright stays with the original author; `LICENSE` here is the verbatim licence text from that commit.

How it is used: `SKILL.md` is kept as the reference. It is a Claude Code skill and is **not** loaded by Allevia. Its rules
are restated for a small business's owner in three places:

- `src/agent/humanize.ts`: `VOICE_RULES` (the six groups in plain words, added to the prompts that write for the owner),
  the no-model last pass (`cleanDeterministic`: chatbot wrappers, staged openers, stock closers, dashes, curly quotes),
  the flat detector (`aiTells`), the guard that nothing a reader relies on moved (`sameFacts`: numbers, names, sources,
  "waiting for your OK"), and Dev's one rewrite on the cheapest model when strong tells remain.
- `skills/copy-editor/make-it-sound-human/SKILL.md`: Dev's skill, the same groups with examples for the owner's markets
  (US, UK, UAE and Australian English; Hindi and Hinglish) and the brand's own voice rules above every pattern.
- `src/agent/style.ts` keeps the answer's shape (the i-have-adhd rules: the answer first, short lists, one next step).
  Where shape and voice disagree, shape wins and the voice adapts.
