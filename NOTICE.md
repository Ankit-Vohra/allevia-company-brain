# Third-party code and methods in Allevia's own source

Data files taken from other projects are listed in `vendor/playbooks/NOTICE.md`. This page lists code and methods
lifted into `src/`, each under its own licence. The licence texts are kept verbatim next to the vendored data:
`vendor/playbooks/every-app__open-seo/LICENSE` and `vendor/playbooks/AgriciDaniel__claude-seo/LICENSE` (both MIT).

## open-seo (every-app/open-seo), MIT, Copyright (c) 2026 Ben Senescu

Read at commit `d7ea7852480601af9bc8870942af8311a410e567`.

| Allevia file | What was taken | Upstream file |
|---|---|---|
| `src/checkup/lighthouse.ts` | `lhSeverity` (severity from time/byte saving, then score) and `sortLhIssues` (biggest saving first, then lowest score), adapted; the list of Lighthouse diagnostic audits that are not issues; the rule that numeric, informative, manual and not-applicable audits and scores of 90+ are not issues | `src/server/lib/lighthouseStoredPayload.ts`, `src/server/lib/lighthousePayload.ts` |

## claude-seo (AgriciDaniel/claude-seo), MIT, Copyright (c) 2026 agricidaniel

Read at commit `4b99de2f7de7e7d5247042e5fb5b4ea9368ef734`. Only MIT-licensed files were used. The FLOW framework and
prompts under `skills/seo-flow/references/` are CC BY 4.0 and were not used, nor the phrase lists in
`scripts/content_quality.py` / `content_humanize.py` (partly derived from CC BY-SA material).

Methods and thresholds, re-implemented (no code copied):
- Core Web Vitals bands: LCP good at 2.5 s or less, poor over 4 s; CLS good at 0.1 or less, poor over 0.25 (`skills/seo/references/cwv-thresholds.md`).
- Tap targets at least 24 x 24 CSS px (WCAG 2.2), inline links exempt (`skills/seo-technical/SKILL.md`).
- AI crawlers split by purpose: search/citation crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot) and user-triggered fetchers are flagged when blocked; training-only crawlers are the owner's choice (`skills/seo-geo/SKILL.md`).
- LocalBusiness essentials (name, address, opening hours, phone) and visible NAP, opening hours and a click-to-call link on a local business's site (`skills/seo-local/SKILL.md`, `skills/seo/references/schema-types.md`).
- Quick wins first among equal impact, and every recommendation carrying what to change, why and how we would know it worked (`skills/seo/references/thinking-framework-validate-act.md`).
