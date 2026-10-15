# Higgsfield spend

The founder approved 200 to 300 credits for Allevia's own content (demo assets and the website). Every generation is
logged here: date, model, credits, purpose, and the balance before and after. Customer generation (Phase 2) goes
through the Higgsfield API under its own agreement, not this account.

| Date | Task | Model | Credits | Purpose | Balance before | Balance after |
|---|---|---|---|---|---|---|
| 2026-10-15 | Marketing site (`site/`, cap 150) | `gpt_image_2_5`, high, 2k, 6 images | 16.5 (2.75 each) | Site illustrations: the hero (an owner with a pixel team on ledger paper), the team on the ledger, two before/after diptychs, a ledger still life for /pricing, a 90-day ledger roll. Kept: hero, team, before/after (architecture studio), ledger still life; jobs 856882d7, 674ea36c, 3292abb7, be3969c6. Not used: 5c88c9bf, cf945905. Cost checks first: `gpt_image_2_5` high 2k 2.75, xhigh 4.5; `recraft_v4_1` 2k 8; `nano_banana_pro` 2. | 650.55 | 634.05 |
| 2026-10-15 | Marketing site (`site/`) | `kling3_0`, std, 5 s, sound off, start frame = end frame | 7.5 | A silent 5-second hero loop from the hero illustration (job 659c4095), shipped as a 341 KB MP4. The still drawing is the first paint and the reduced-motion fallback, and the loop can be paused. `seedance_2_5` 5 s quoted 35, so not used. | 634.05 | 626.55 |
| 2026-10-15 | Studio thin slice (product design §9 item 4) | `nano_banana_2_1`, 2k, one image edit with the photo as reference | 2 | Variant B for the Studio demo: the "rough phone photo" of Retreat (a degraded copy of the studio's own website photo) relit and cleaned, with the prompt built from the AVS graph. Generated once; replayed by `RecordedEngine` from the data dir (not committed). Cost checks first: `nano_banana_2_1` 1k 1.5 credits, 2k 2 credits; `flux_3_image` 1.5k 2 credits. | 626.55 | 624.55 |
| 2026-10-15 | Content trials (`docs/content-trials.md`), Studio test cap 30 | `nano_banana_2_1`, 2k, 2 image edits | 4 (2 each) | Variant B for two trial photos from AVS Atelier's own website photos: P1 the bedroom (clean photo, job 54906f35) and P2 the director's desk (a degraded copy, job 74bb210d). Same graph-built prompt as the demo, photo as reference. Replayed by `RecordedEngine`. Cost check first (`get_cost`): 2 credits at 2k. | 624.55 | 620.55 |
| 2026-10-15 | Content trials (`docs/content-trials.md`), Studio test cap 30 | `kling3_0`, std, 5 s, sound off, start image = the approved variant B of P2, 9:16 asked | 7.5 | One 5-second reel clip, camera push-in only (job d3c475dd). Quoted first with `get_cost` (7.5). Not used for posting. The model kept the photo's 4:5 shape (856x1072) instead of 9:16, and a book with garbled lettering appeared at the frame edge by the end. Declined the "IN THE DARK" preset the tool suggested. | 620.55 | 613.05 |
| 2026-10-15 | Public website pass 2 (`site/`, cap 80 for this job) | `gpt_image_2_5`, high, 2k, 3 images | 8.25 (2.75 each) | Section art for the new pages: three filing cabinets with a key each for /security/ (job 3ecab8a6), a lamp-lit desk at dusk for /about/ (job 041f5c85), an envelope and an empty speech bubble for /contact/ (job fd35667a). No faces and no text in any of them; each prompt said so and the results were checked by eye. Cost check first with `get_cost`: 2.75 at high 2k (the default low 1k quoted 0.25, not used). The hero, the team, the before/after, the ledger still life and the hero loop from the first pass were reused: they still fit. The social card (`og.jpg`) and the icons cost nothing: the card is the hero drawing with the wordmark and promise set in the site's fonts by `site/scripts/og.mjs`, and the icons are the pixel mark in `favicon.svg` rendered by `site/scripts/icons.mjs`. | 613.05 | 604.80 |

Marketing site total: 24 of its 150-credit cap. No generated image shows text or a brand mark; one stray pseudo-brand
on a drawn camera (the before/after image) was painted out locally, at no credit cost.

Studio test total (thin slice 2 + content trials 4 + 7.5 = 13.5): 13.5 of its 30-credit cap, 16.5 left. Balance now 613.05.
No retry was generated for the trial photo whose edit Nisha held back (P1): a retry would cost 2 more credits and another live
Claude check, and the finding was already the point.

Studio thin slice total: 2 of its 30-credit cap. Nisha's fidelity check held this edit back ("changed": details such as
an air-conditioner unit, striped linen and a tiled pool band that she did not see in the dark original), so the demo
recommends the local variant A. No retry was generated: re-checking a retry would need another live Claude call.

Public website pass 2 total: 8.25 of its 80-credit cap, 71.75 left. Balance now 604.80. Nothing generated was published.
