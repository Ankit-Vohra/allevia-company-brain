# Vendored playbook data: third-party notices

Allevia's procedural memory (hook formulas, profile rubric, SEO checks, ad benchmarks and policy assumptions, the
Google algorithm-update timeline, AI-writing voice patterns) is built from the open-source data files below. Each
repository was read at the pinned commit, its LICENSE was fetched at that commit and kept next to the data, and only
data was taken: no executable code, prompts or documentation. These files are third-party data used under their own
licenses; copyright stays with the original authors. Each `<owner>__<repo>/LICENSE` is the verbatim licence text from
that commit.

| Repository | Pinned commit | License | Files taken (source path at that commit) | How converted |
|---|---|---|---|---|
| https://github.com/Jakeschincariol/instagram-agent-skill | `d03c56bb598be770c60b201f94237e5d1a4268a6` | MIT (Jake Schincariol) | `hooks.json` (`skills/ig-reel/hooks.json`), `rubric.json` (`skills/ig-profile/rubric.json`) | Verbatim copies |
| https://github.com/every-app/open-seo | `d7ea7852480601af9bc8870942af8311a410e567` | MIT (Ben Senescu) | `audit-issues.json` (`src/shared/audit-issues.ts`) | The `AUDIT_ISSUE_TYPES` object literal and `ISSUE_SEVERITY_ORDER` converted to JSON by parsing the TypeScript to an AST and reading the literals (nothing executed). The object keys became a `type` field; wording is unchanged. Type declarations and the `getIssueDescriptor` helper are not taken. |
| https://github.com/AgriciDaniel/claude-seo | `4b99de2f7de7e7d5247042e5fb5b4ea9368ef734` | MIT (agricidaniel) | `google-updates.json` (`data/google-updates.json`) | Verbatim copy. Only this JSON file is taken: the repository's prompt and skill files are not used (some of them are reported to be CC BY 4.0, a different licence from the MIT data file). Allevia reads `updates[]` only; `unverified[]` is kept in the file but never loaded, as the file's own policy requires. |
| https://github.com/nowork-studio/notfair-plugin | `9afd332f421d58498ddac4fc3b41bbcd66ebe513` | MIT (Toprank Contributors) | `industry-templates.json` (`google-ads/shared/industry-templates.json`), `google-ads-policy-registry.json` (`google-ads/shared/policy-registry.json`), `meta-ads-policy-registry.json` (`meta-ads/shared/policy-registry.json`) | Verbatim copies. The two policy registries share a file name upstream, so they are renamed with a channel prefix. |
| https://github.com/conorbronsdon/avoid-ai-writing | `2dc826f7b9aea762f5557e56ba88a3e515bd2fed` | MIT (Conor Bronsdon) | `patterns.json` (`detector/patterns.js`) | The data tables inside the detector (word tiers and their replacements, phrase patterns, the 36 regex categories with their severities, `ISSUE_WEIGHTS`, `TYPE_LABELS`) converted to JSON by parsing the JavaScript to an AST and reading the literals (nothing executed). Regex literals are stored as `{source, flags}`; the 6 regexes the source builds with `new RegExp(<string> + <string>)` are stored as the resulting concatenated source. The detector's logic, the function-valued `UNNECESSARY_HYPHENATION` suggestions, and the Markdown/HTML masking code are not taken. The one phrase guarded by a function (`features`) keeps only the guard's name in `guard`. |

Layout: `vendor/playbooks/<owner>__<repo>/{LICENSE, data files}`. The ingest source `src/ingest/sources/playbooks.ts`
maps these files into the graph as Playbook, Rule, Event and Document nodes; every Rule links back to the vendored
file it came from (`SOURCED_FROM`).

To update a pack: re-pin the commit, re-fetch the LICENSE at the new commit and confirm it is still MIT or Apache-2.0
(skip the pack if it is not), re-convert, and update this table.
