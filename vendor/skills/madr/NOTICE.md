# MADR: third-party notice

Sara's "A decision on one page" skill uses the shape of the minimal Markdown Architectural Decision Record (MADR):
the question, the options considered, the option chosen and why, and its consequences.

| | |
|---|---|
| Repository | https://github.com/adr/madr |
| Pinned commit | `ba75bb1b20d42af5746b246ad348c202419ae681` (2026-08-28) |
| License | MIT OR CC0-1.0 (dual; we take it under MIT), Copyright (c) 2017-2022 Oliver Kopp, Olaf Zimmermann |
| Files taken | `LICENSE`, `LICENSE.MIT`, `template/adr-template-minimal.md`; verbatim at that commit |

How it is used: the template is kept as the reference and is **not** loaded by Allevia. Its sections are restated in
plain words for a business owner in `skills/librarian/decision-on-one-page/SKILL.md`, filled from the decisions, evidence
and people the business's own records hold (`trace_decision`, `history`, `who_knows`).
