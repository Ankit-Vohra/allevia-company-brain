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

Marketing site total: 24 of its 150-credit cap. No generated image shows text or a brand mark; one stray pseudo-brand
on a drawn camera (the before/after image) was painted out locally, at no credit cost.

Studio thin slice total: 2 of its 30-credit cap. Nisha's fidelity check held this edit back ("changed": details such as
an air-conditioner unit, striped linen and a tiled pool band that she did not see in the dark original), so the demo
recommends the local variant A. No retry was generated: re-checking a retry would need another live Claude call.
