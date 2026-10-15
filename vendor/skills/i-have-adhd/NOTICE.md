# i-have-adhd: third-party notice

Allevia shapes the Chief of Staff's answers and today's note with the rules of the `i-have-adhd` skill: lead with the
next action, number multi-step work, keep lists to five ranked items, end with one concrete next action, no preamble,
recap or closers, specific time estimates, visible wins, and a matter-of-fact tone for errors.

| | |
|---|---|
| Repository | https://github.com/ayghri/i-have-adhd |
| Pinned commit | `1ecea1993b7fce257ffbd686c070948b5e07eda6` |
| License | MIT, Copyright (c) 2026 Ayoub Ghriss |
| Files taken | `SKILL.md` (`skills/i-have-adhd/SKILL.md`) and `LICENSE`, both verbatim, fetched at that commit with `gh api` |

Copyright stays with the original author; `LICENSE` here is the verbatim licence text from that commit.

How it is used: `SKILL.md` is kept as the reference. It is a Claude Code skill for a coding session and is **not** loaded
by Allevia. Its rules are restated, for the owner of a small business instead of a developer, in
`src/agent/style.ts` (`ANSWER_SHAPE`, `DESK_SHAPE`), which the Chief's answer prompts, the house rules and the morning
brief use. Where `SKILL.md` and `docs/owner-words.md` disagree about wording, `docs/owner-words.md` wins: the owner never
reads "baseline", "agent", "finding" and the like.
