import { describe, it, expect } from "vitest";
import { ALLEVIA_90, CREDIT_COSTS, CREDIT_RULES, CURRENCIES, PLANS, PLAN_BY_ID, isCurrency, type Money } from "../../shared/plans.js";

function expectPriced(label: string, m: Money): void {
  for (const c of CURRENCIES) {
    expect(Number.isFinite(m[c]) && m[c] > 0, `${label} ${c}`).toBe(true);
  }
  expect(Object.keys(m).sort(), label).toEqual([...CURRENCIES].sort());
}

describe("plans", () => {
  it("has the four plans, Growth the default", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["essentials", "growth", "pro", "pause"]);
    expect(PLANS.filter((p) => p.isDefault).map((p) => p.id)).toEqual(["growth"]);
    expect(PLAN_BY_ID.growth.name).toBe("Growth");
  });
  it("prices every plan in all four currencies, positive", () => {
    for (const p of PLANS) {
      expectPriced(`${p.id} monthly`, p.price.monthly);
      if (p.price.yearly) expectPriced(`${p.id} yearly`, p.price.yearly);
    }
    expectPriced("allevia90 upfront", ALLEVIA_90.upfront);
    expectPriced("allevia90 instalment", ALLEVIA_90.instalments.each);
    expectPriced("founding upfront", ALLEVIA_90.founding.upfront);
    expectPriced("founding growth", ALLEVIA_90.founding.growthLocked);
    expectPriced("top-up", CREDIT_RULES.topUp.price);
  });
  it("matches the spec's table (4.3) on the headline numbers", () => {
    expect(PLAN_BY_ID.growth.price.monthly).toEqual({ USD: 449, GBP: 339, AED: 1649, AUD: 649 });
    expect(PLAN_BY_ID.growth.price.yearly).toEqual({ USD: 4490, GBP: 3390, AED: 16490, AUD: 6490 });
    expect(PLAN_BY_ID.essentials.price.monthly.USD).toBe(199);
    expect(PLAN_BY_ID.pro.price.monthly.AED).toBe(3669);
    expect(PLAN_BY_ID.pause.price.monthly.AUD).toBe(42);
    expect(ALLEVIA_90.upfront.USD).toBe(1490);
    expect(ALLEVIA_90.instalments).toEqual({ count: 3, each: { USD: 529, GBP: 399, AED: 1949, AUD: 769 } });
    expect(ALLEVIA_90.founding.upfront.GBP).toBe(749);
    expect(ALLEVIA_90.founding.growthLocked.AED).toBe(1469);
    expect(CREDIT_RULES.topUp).toEqual({ credits: 20, price: { USD: 59, GBP: 45, AED: 219, AUD: 85 } });
  });
  it("orders prices sensibly and keeps the founding offers cheaper", () => {
    for (const c of CURRENCIES) {
      const m = (id: "essentials" | "growth" | "pro" | "pause") => PLAN_BY_ID[id].price.monthly[c];
      expect(m("pause")).toBeLessThan(m("essentials"));
      expect(m("essentials")).toBeLessThan(m("growth"));
      expect(m("growth")).toBeLessThan(m("pro"));
      expect(ALLEVIA_90.founding.upfront[c]).toBeLessThan(ALLEVIA_90.upfront[c]);
      expect(ALLEVIA_90.founding.growthLocked[c]).toBeLessThan(m("growth"));
      // two months free on the year
      expect(PLAN_BY_ID.growth.price.yearly?.[c]).toBe(m("growth") * 10);
    }
  });
  it("carries the included allowances", () => {
    expect(PLANS.map((p) => p.allowances.studioCreditsPerMonth)).toEqual([20, 50, 120, 0]);
    expect(PLANS.map((p) => p.allowances.answersPerMonth)).toEqual([100, 300, 800, 10]);
    expect(PLANS.map((p) => p.allowances.seats)).toEqual([2, 6, 20, null]);
    expect(PLAN_BY_ID.pause.allowances.sources).toEqual({ kind: "read_only" });
    // Allevia 90 includes Growth-level allowances
    expect(PLAN_BY_ID[ALLEVIA_90.includesPlan].allowances.studioCreditsPerMonth).toBe(50);
  });
  it("prices outputs in credits", () => {
    expect(CREDIT_COSTS).toEqual({ static_post: 1, carousel: 2, shoot: 3, reel: 4, text: 0 });
  });
  it("recognises currency codes", () => {
    expect(isCurrency("GBP") && !isCurrency("INR") && !isCurrency("usd")).toBe(true);
  });
});
