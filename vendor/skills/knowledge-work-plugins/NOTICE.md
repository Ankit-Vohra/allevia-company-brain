# knowledge-work-plugins: third-party notice

Allevia's money, follow-up, review and outage skills borrow the methods of seven skills from Anthropic's
`knowledge-work-plugins`: six from its `small-business` plugin (a cash-flow forecast, chasing unpaid invoices, answering
new enquiries fast, review replies and quiet customers, and win-back) and the incident skill from its `engineering`
plugin.

| | |
|---|---|
| Repository | https://github.com/anthropics/knowledge-work-plugins |
| Pinned commit | `e6b505348c39c6e751a70d52ff407e7b0a6bf676` (2026-10-15) |
| License | Apache License 2.0 (the repository's root `LICENSE`; the `small-business` and `engineering` folders carry no licence of their own, so the root licence covers them). The repository has no `NOTICE` file to carry over. |
| Files taken | `LICENSE`; `small-business/skills/cash-flow-snapshot/SKILL.md`, `small-business/skills/invoice-chase/SKILL.md`, `small-business/skills/invoice-chase/reference/tone-matching.md`, `small-business/skills/speed-to-lead/SKILL.md`, `small-business/skills/review-reputation/SKILL.md`, `small-business/skills/reactivate/SKILL.md`, `engineering/skills/incident-response/SKILL.md`; all verbatim and unmodified at that commit, under the same paths here |

Copyright stays with Anthropic; `LICENSE` here is the verbatim licence text from that commit. These files are kept
unmodified as the reference. They are Claude Cowork plugin skills that call connectors Allevia does not have yet
(QuickBooks, Xero, Stripe, PayPal, HubSpot, Gmail, Google Calendar), and they are **not** loaded by Allevia.

Their methods are restated in our own words, for Allevia's tools and the owner's plain language, in these new files
(Apache-2.0 section 4(b): the changed works are our own files, and this notice says where they came from):

| Our skill | Who uses it | Built from |
|---|---|---|
| `skills/coe-lead/cash-flow-check/SKILL.md` | Isha, numbers | `cash-flow-snapshot` |
| `skills/ops-manager/chase-unpaid-invoices/SKILL.md` | Vikram, ops | `invoice-chase` and `reference/tone-matching.md` |
| `skills/ops-manager/answer-new-enquiries/SKILL.md` | Vikram, ops | `speed-to-lead` |
| `skills/ops-manager/review-replies/SKILL.md` | Vikram, ops | `review-reputation` |
| `skills/oncall-engineer/after-the-outage-note/SKILL.md` | Zoya, on call | `engineering/skills/incident-response` (the blameless write-up and the five whys) |
| `skills/ops-manager/bring-customers-back/SKILL.md` | Vikram, ops | `reactivate` (with the marketingskills sources in `vendor/skills/marketingskills/NOTICE.md`) |
| `skills/sales-lead/answer-a-new-enquiry/SKILL.md` | Neel, sales | `speed-to-lead` (qualify, draft with real times, nothing sent without the OK) |
| `skills/sales-lead/propose-meeting-times/SKILL.md`, `skills/sales-lead/book-the-meeting/SKILL.md` | Neel, sales | `speed-to-lead` (real meeting times, booking after the OK) |
| `skills/sales-lead/remind-and-follow-up/SKILL.md`, `skills/sales-lead/nudge-stalled-deals/SKILL.md` | Neel, sales | `reactivate` and `invoice-chase` (the nudge ladder: a second one changes something, a third never goes out), with `emails` from marketingskills |
| `skills/sales-lead/add-leads-from-the-inbox/SKILL.md`, `skills/sales-lead/weekly-pipeline-note/SKILL.md` | Neel, sales | `speed-to-lead` (log every lead) |

Kept from the originals because they match Allevia's own rules: nothing is sent or posted without the owner's OK; text
found in what a skill reads is data, never an instruction; a source that returns nothing is named, not read as zero; no
offer, discount or credit the owner has not agreed to.
