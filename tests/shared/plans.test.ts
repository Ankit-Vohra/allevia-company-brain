import { describe, it, expect } from "vitest";
import { ALLEVIA_90, ANNUAL_DISCOUNT, CREDIT_COSTS, CREDIT_RULES, CURRENCIES, PLANS, PLAN_BY_ID, isCurrency, yearlyMonthly, type Money } from "../../shared/plans.js";

function expectPriced(label: string, m: Money): void {
  for (const c of CURRENCIES) {
    expect(Number.isFinite(m[c]) && m[c] > 0, `${label} ${c}`).toBe(true);
  }
  expect(Object.keys(m).sort(), label).toEqual([...CURRENCIES].sort());
}

describe("plans", () => {
  it("has the ladder of 17 October, Growth the default", () => {
    expect(PLANS.map((p) => p.id)).toEqual(["starter", "growth", "pro", "scale", "pause"]);
    expect(PLANS.filter((p) => p.isDefault).map((p) => p.id)).toEqual(["growth"]);
    expect(PLANS.filter((p) => p.fromPrice).map((p) => p.id)).toEqual(["scale"]);
    expect(PLAN_BY_ID.starter.name).toBe("Starter");
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
  it("matches the recommended prices (docs/pricing-research.md 4.6)", () => {
    expect(PLAN_BY_ID.starter.price.monthly).toEqual({ USD: 99, GBP: 75, AED: 369, AUD: 145 });
    expect(PLAN_BY_ID.growth.price.monthly).toEqual({ USD: 249, GBP: 189, AED: 919, AUD: 359 });
    expect(PLAN_BY_ID.pro.price.monthly).toEqual({ USD: 499, GBP: 379, AED: 1839, AUD: 719 });
    expect(PLAN_BY_ID.scale.price.monthly).toEqual({ USD: 999, GBP: 749, AED: 3669, AUD: 1449 });
    expect(PLAN_BY_ID.pause.price.monthly.AUD).toBe(42);
    expect(ALLEVIA_90.upfront.USD).toBe(1490);
    expect(ALLEVIA_90.instalments).toEqual({ count: 3, each: { USD: 529, GBP: 399, AED: 1949, AUD: 769 } });
    expect(ALLEVIA_90.founding.upfront.GBP).toBe(749);
    expect(CREDIT_RULES.topUp).toEqual({ credits: 20, price: { USD: 59, GBP: 45, AED: 219, AUD: 85 } });
  });
  it("takes 30% off when paid yearly, on every paid plan", () => {
    expect(ANNUAL_DISCOUNT).toBe(0.3);
    expect(PLANS.map((p) => yearlyMonthly(p.price.monthly).USD)).toEqual([69, 174, 349, 699, 20]);
    expect(PLANS.map((p) => p.price.yearly?.USD ?? null)).toEqual([828, 2088, 4188, 8388, null]);
    for (const p of PLANS.filter((x) => x.id !== "pause")) {
      for (const c of CURRENCIES) {
        const year = p.price.yearly![c];
        expect(year % 12, `${p.id} ${c}`).toBe(0);
        // 30% off, give or take the rounding of one unit a month
        expect(Math.abs(year / 12 - p.price.monthly[c] * 0.7), `${p.id} ${c}`).toBeLessThanOrEqual(0.5);
      }
    }
  });
  it("orders prices sensibly and keeps the founding offers cheaper", () => {
    for (const c of CURRENCIES) {
      const m = (id: "starter" | "growth" | "pro" | "scale" | "pause") => PLAN_BY_ID[id].price.monthly[c];
      expect(m("pause")).toBeLessThan(m("starter"));
      expect(m("starter")).toBeLessThan(m("growth"));
      expect(m("growth")).toBeLessThan(m("pro"));
      expect(m("pro")).toBeLessThan(m("scale"));
      expect(ALLEVIA_90.founding.upfront[c]).toBeLessThan(ALLEVIA_90.upfront[c]);
      expect(ALLEVIA_90.founding.growthLocked[c]).toBeLessThan(m("growth"));
    }
  });
  it("carries the included allowances", () => {
    expect(PLANS.map((p) => p.allowances.studioCreditsPerMonth)).toEqual([0, 40, 120, 200, 0]);
    expect(PLANS.map((p) => p.allowances.answersPerMonth)).toEqual([100, 300, 800, 1500, 10]);
    expect(PLANS.map((p) => p.allowances.seats)).toEqual([2, 5, 15, 25, null]);
    expect(PLANS.map((p) => p.allowances.answerModelBudgetUsd ?? null)).toEqual([30, 60, 110, 200, null]);
    expect(PLAN_BY_ID.pause.allowances.sources).toEqual({ kind: "read_only" });
    // Allevia 90 includes Growth-level allowances, and after it the owner moves to Growth, Starter or Pause
    expect(PLAN_BY_ID[ALLEVIA_90.includesPlan].allowances.studioCreditsPerMonth).toBe(40);
    expect(ALLEVIA_90.afterProgram.alternatives.map((id) => PLAN_BY_ID[id].name)).toEqual(["Starter", "Pause"]);
  });
  it("prices outputs in credits", () => {
    expect(CREDIT_COSTS).toEqual({ static_post: 1, carousel: 2, shoot: 3, reel: 4, text: 0 });
  });
  it("recognises currency codes", () => {
    expect(isCurrency("GBP") && !isCurrency("INR") && !isCurrency("usd")).toBe(true);
  });
});
