// The Plan and credits page, the top bar's chip and the out-of-credits message (web/src/lib/credits.ts, shared/credits.ts): the
// words and numbers each one shows, in the owner's words (docs/owner-words.md), for a Growth business, a trial, a paused plan
// and one that ran out; the plan cards with the Monthly / Yearly switch (30% off); what a card costs to say OK to.
import { describe, expect, it } from "vitest";
import {
  approvalCharges, chargesTotal, leftWords, outOfCreditsSentence, studioCharges, usesWords, type BalanceDto, type CreditsDto,
} from "../../shared/credits.js";
import { ownerJargon } from "../../src/agent/style.js";
import {
  balanceWords, chipWords, isOutOfCreditsSentence, madeOfWords, packWords, pendingWords, planCards, planIntent, suggestedPlan, useLines, usedShare,
} from "../../web/src/lib/credits.js";

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const date = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const bal = (over: Partial<BalanceDto> = {}): BalanceDto => ({
  month: "2026-10", plan: "growth", status: "active", allowance: 800, rollover: 120, packs: 0, trial: 0, owed: 0, used: 708, left: 212,
  resetsAt: "2026-11-01T00:00:00.000Z", ...over,
});

describe("credits in a line", () => {
  it("the chip says what is left, and plainly when none is", () => {
    expect(chipWords(bal())).toBe("212 credits left");
    expect(chipWords(bal({ left: 1 }))).toBe("1 credit left");
    expect(chipWords(bal({ left: 2000 }))).toBe("2,000 credits left");
    expect(chipWords(bal({ left: 0 }))).toBe("No credits left");
    expect(chipWords(bal({ left: -4 }))).toBe("No credits left");
    expect(leftWords(-1)).toBe("No credits left");
  });

  it("the page's heading and line say the plan and when credits reset; a trial says when it ends", () => {
    expect(balanceWords(bal(), date)).toEqual({ title: "212 credits left", lede: "Your Growth plan. Credits reset on 1 Nov." });
    expect(balanceWords(bal({ status: "trial", plan: null, allowance: 0, trial: 100, left: 95, trialEndsAt: "2026-10-31T09:00:00.000Z" }), date))
      .toEqual({ title: "95 credits left", lede: "Your free trial. It ends on 31 Oct." });
    expect(balanceWords(bal({ status: "paused", plan: "pause", left: 0 }), date)).toEqual({ title: "No credits left", lede: "Your plan is paused. Credits reset on 1 Nov." });
    expect(balanceWords(bal({ left: -9 }), date).title).toBe("9 credits over");
    expect(madeOfWords(bal({ packs: 100, owed: 4 }))).toBe("800 from your plan · 120 carried over · 100 bought · 4 owed from last month");
  });

  it("the bar is used against everything the month had", () => {
    expect(usedShare(bal())).toBeCloseTo(708 / 920);
    expect(usedShare(bal({ allowance: 0, rollover: 0, used: 0 }))).toBe(0);
    expect(usedShare(bal({ allowance: 0, rollover: 0, used: 5 }))).toBe(1);
  });

  it("what used them: most first, in words, without the brackets of the price list", () => {
    const rows: CreditsDto["byService"] = [
      { key: "question_deep", label: "Deep question (the whole team looks into it)", credits: 45, times: 9 },
      { key: "website_checkup", label: "Website check-up", credits: 10, times: 1 },
    ];
    expect(useLines(rows)).toEqual([
      { key: "question_deep", label: "Deep question", detail: "9 times · 45 credits" },
      { key: "website_checkup", label: "Website check-up", detail: "once · 10 credits" },
    ]);
  });
});

describe("out of credits", () => {
  it("says the founder's sentence, naming the next plan up, and recognises it", () => {
    expect(outOfCreditsSentence({ plan: "starter" })).toBe("You've used this month's credits. Buy 100 more for $29 or move to Growth.");
    expect(outOfCreditsSentence({ plan: "growth" })).toBe("You've used this month's credits. Buy 100 more for $29 or move to Pro.");
    expect(outOfCreditsSentence({ plan: "scale" })).toBe("You've used this month's credits. Buy 100 more for $29.");
    expect(outOfCreditsSentence({ trial: true })).toBe("You've used your trial credits. Buy 100 more for $29 or move to Growth.");
    expect(outOfCreditsSentence({ plan: "growth", currency: "GBP" })).toBe("You've used this month's credits. Buy 100 more for £22 or move to Pro.");
    expect(isOutOfCreditsSentence(outOfCreditsSentence({ plan: "pro" }))).toBe(true);
    expect(isOutOfCreditsSentence(outOfCreditsSentence({ trial: true }))).toBe(true);
    expect(isOutOfCreditsSentence("Something went wrong on the server.")).toBe(false);
    expect(suggestedPlan(bal({ status: "trial", plan: null }))).toBe("growth");
    expect(suggestedPlan(bal({ plan: "pause", status: "paused" }))).toBe("growth");
    expect(suggestedPlan(bal({ plan: "growth" }))).toBe("pro");
    expect(packWords("USD", usd)).toBe("Buy 100 credits for $29");
  });

  it("the Discord buttons' links open the page on the pack or the plan", () => {
    expect(planIntent("?buy=pack100")).toEqual({ buy: "pack100" });
    expect(planIntent("?plan=growth")).toEqual({ plan: "growth" });
    expect(planIntent("?plan=gold&buy=pack9")).toEqual({});
  });
});

describe("the plans", () => {
  it("monthly: the price a month, the credits, the current plan marked and the rest offered", () => {
    const cards = planCards({ cycle: "monthly", currency: "USD", current: "growth", currentCycle: "monthly", status: "active" }, usd);
    expect(cards.map((c) => c.id)).toEqual(["starter", "growth", "pro", "scale"]); // Pause has its own button
    expect(cards[1]).toMatchObject({ name: "Growth", price: "$249", per: "a month", note: null, credits: "800 credits a month", current: true, action: null });
    expect(cards[2]).toMatchObject({ price: "$499", current: false, action: "Switch to Pro" });
    expect(cards[3]).toMatchObject({ price: "From $999", note: "We talk first, then quote." });
  });

  it("yearly: 30% off every month, the year's total, and paying yearly offered on the current plan", () => {
    const cards = planCards({ cycle: "yearly", currency: "USD", current: "growth", currentCycle: "monthly", status: "active" }, usd);
    expect(cards[1]).toMatchObject({ price: "$174", per: "a month, paid yearly", note: "$2,088 a year, 30% off", current: false, action: "Pay yearly" });
    expect(cards[0]).toMatchObject({ price: "$69", action: "Switch to Starter" });
  });

  it("on a trial nothing is current; a request waiting for us is marked", () => {
    const pending = [{ id: "bill_1", kind: "change" as const, plan: "growth" as const, cycle: "monthly" as const, at: "2026-10-17T09:00:00Z", status: "pending" as const }];
    const cards = planCards({ cycle: "monthly", currency: "USD", current: null, currentCycle: "monthly", status: "trial", pending }, usd);
    expect(cards.every((c) => !c.current)).toBe(true);
    expect(cards.find((c) => c.id === "growth")?.waiting).toBe(true);
    expect(pendingWords([...pending, { id: "bill_2", kind: "pack", packId: "pack100", at: "x", status: "pending" }])).toEqual(["Move to Growth", "100 more credits"]);
  });
});

describe("what saying OK costs", () => {
  const card = { variants: [{ id: "a" }, { id: "b", premium: true }], recommended: "a", extras: [{ kind: "clip", from: "b" }] };
  it("a picture 5, a premium ad 15 plus its clip 40, a clip card 40; a draft or a meeting 1; pausing an ad nothing", () => {
    expect(chargesTotal(studioCharges(card))).toBe(5);
    expect(studioCharges(card, "b")).toEqual([{ service: "photo_ad", part: "" }, { service: "video_short", part: "clip" }]);
    expect(chargesTotal(studioCharges(card, "b"))).toBe(55);
    expect(chargesTotal(studioCharges({ variants: [{ id: "c" }], creative: { kind: "clip" } }))).toBe(40);
    expect(chargesTotal(approvalCharges("email_send"))).toBe(1);
    expect(chargesTotal(approvalCharges("calendar_event"))).toBe(1);
    expect(approvalCharges("pause_ad")).toEqual([]);
    expect(usesWords(5)).toBe("Uses 5 credits when you say OK");
    expect(usesWords(1)).toBe("Uses 1 credit when you say OK");
    expect(usesWords(0)).toBeNull();
  });
});

it("every sentence is in the owner's words", () => {
  const lines = [
    chipWords(bal()), ...Object.values(balanceWords(bal(), date)), madeOfWords(bal({ packs: 100 })), outOfCreditsSentence({ plan: "growth" }),
    ...planCards({ cycle: "yearly", currency: "USD", current: "starter", currentCycle: "monthly", status: "active" }, usd).flatMap((c) => [c.price, c.per, c.note ?? "", c.credits, c.action ?? ""]),
    usesWords(15)!, packWords("USD", usd),
  ];
  for (const l of lines) expect(ownerJargon(l), l).toEqual([]);
});
