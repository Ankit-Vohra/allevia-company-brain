# Higgsfield spend

The founder approved 200 to 300 credits for Allevia's own content (demo assets and the website). Every generation is
logged here: date, model, credits, purpose, and the balance before and after. Customer generation (Phase 2) goes
through the Higgsfield API under its own agreement, not this account.

| Date | Task | Model | Credits | Purpose | Balance before | Balance after |
|---|---|---|---|---|---|---|
| 2026-10-15 | Studio thin slice (product design §9 item 4) | `nano_banana_2_1`, 2k, one image edit with the photo as reference | 2 | Variant B for the Studio demo: the "rough phone photo" of Retreat (a degraded copy of the studio's own website photo) relit and cleaned, with the prompt built from the AVS graph. Generated once; replayed by `RecordedEngine` from the data dir (not committed). Cost checks first: `nano_banana_2_1` 1k 1.5 credits, 2k 2 credits; `flux_3_image` 1.5k 2 credits. | 626.55 | 624.55 |

Studio thin slice total: 2 of its 30-credit cap. Nisha's fidelity check held this edit back ("changed": details such as
an air-conditioner unit, striped linen and a tiled pool band that she did not see in the dark original), so the demo
recommends the local variant A. No retry was generated: re-checking a retry would need another live Claude call.
