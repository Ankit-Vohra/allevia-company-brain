---
id: ad-budget-check
name: Ad budget check
when: "Whether the ads are worth their money, which campaign to keep, fix or pause"
agents: [growth-marketer]
tools: [ad_report, metric_trend, propose_action]
output: creates
makes: a proposal to pause or change an ad (when one is needed), waiting for the owner's OK
needs_ok: true
---

## Method

1. Read `ad_report` with its default window: 30 days to the last day with ad numbers, the same window and the same median the pause cards use, so your figures match the card's. Per campaign it returns spend with currency, impressions, clicks, signups, CPA, CTR and CPA versus the median campaign; a campaign at 1.5 times the median or more is flagged cpa_high. Copy the figures exactly. If the report says the ad data is sample data, say "sample numbers" next to every figure.
2. Decide if there is enough to judge. Rule of thumb: about 100 clicks or about 30 sign-ups before calling a winner or a loser, and at least 3 to 5 days since the last change (ad platforms need that to settle). One day of numbers says nothing. Too little data: the verdict is "keep running, look again on <date>", not a change.
3. Use `metric_trend` on spend and on the signup metric (groupBy week) to see whether the cost is rising or the results are falling; a CPA that is high only in the latest few days may be noise.
4. Apply the verdict per campaign: keep (CPA at or below the median, enough data), fix (high CPA but a good CTR: the ad is clicked, so the page or the offer is the leak), fix the ad (low CTR: new hook or picture, not a bigger budget), pause (cpa_high with enough data and no recent change).
5. Respect the owner's daily cap from their standing instructions; never suggest going above it. Never raise the spend of a campaign with too little data.
6. When a pause or a change is justified, make it a proposal with `propose_action` (kind pause_ad), the campaign, the evidence ids, the figures and the date window. The owner decides. When nothing needs changing, propose nothing and say so.

## House style

Verdict first, then at most three campaigns, each with its money figures and the reason, then one next action.

> Keep the Diwali offer ad running; pause "Spring brochure". Spring brochure spent ₹6,200 in the 30 days to 12 Oct for 4 sign-ups (sample numbers), about twice the usual cost per sign-up. The Diwali ad has 31 sign-ups, under the median cost. Next: approve the pause (about 1 minute).

## Done well

- [ ] Every figure is copied from the report with its currency and window, and sample numbers are named.
- [ ] A verdict is only given when there is enough data; otherwise it says when to look again.
- [ ] The reason separates "not clicked" (the ad) from "clicked but did not sign up" (the page or offer).
- [ ] The owner's spend cap is respected.
- [ ] A pause or change is a proposal waiting for OK, never an action.

## Common mistakes

- Pausing on one bad day.
- Moving money to the best-looking campaign that has only 10 clicks.
- Blaming the budget when the problem is the landing page.
- Converting currencies or showing a total the report did not return.
