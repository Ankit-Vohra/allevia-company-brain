# localseoskills: third-party notice

Allevia's local search check and review replies borrow the methods of three skills from Garrett Smith's
`localseoskills`: Google Business Profile optimisation, review management, and the local search audit.

| | |
|---|---|
| Repository | https://github.com/garrettjsmith/localseoskills |
| Pinned commit | `405ce209775f8cb8f9dbaa511656594bb682cf9f` (2026-08-15) |
| License | MIT, Copyright (c) 2026 Garrett Smith / GMB Gorilla |
| Files taken | `LICENSE`, `skills/gbp-optimization/SKILL.md`, `skills/review-management/SKILL.md`, `skills/local-seo-audit/SKILL.md`; all verbatim at that commit, under the same paths here |

Copyright stays with the original author; `LICENSE` here is the verbatim licence text from that commit.

How it is used: these files are kept as the reference and are **not** loaded by Allevia. Many of their steps call paid
tools (Local Falcon, BrightLocal, LocalSEOData, Semrush) that Allevia does not use. Their methods are restated in plain
words, with Allevia's own tools, in:

| Our skill | Who uses it | Built from |
|---|---|---|
| `skills/data-analyst/local-search-check/SKILL.md` | Kabir, analytics | `gbp-optimization`, `local-seo-audit` |
| `skills/ops-manager/review-replies/SKILL.md` | Vikram, ops | `review-management` (with `knowledge-work-plugins` `review-reputation`) |

Rules kept from the originals: recent reviews matter more than the total; never offer a reward for a review (against
Google's rules); never stuff keywords into the business name; reply to every review, briefly, and take problems offline.
