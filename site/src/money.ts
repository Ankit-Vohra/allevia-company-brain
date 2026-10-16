// Money formatting for the four billing currencies. Used at build time (the HTML ships with USD filled in) and in the
// browser (the currency toggle rewrites every price). Amounts are whole units, as in shared/plans.ts.
import type { Currency, Money } from "../../shared/plans.ts";

export const CURRENCY_LABEL: Record<Currency, string> = {
  USD: "US dollars",
  GBP: "pounds sterling",
  AED: "UAE dirhams",
  AUD: "Australian dollars",
};

const group = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export function formatMoney(amount: number, currency: Currency): string {
  switch (currency) {
    case "USD": return `$${group(amount)}`;
    case "GBP": return `£${group(amount)}`;
    case "AUD": return `A$${group(amount)}`;
    case "AED": return `AED ${group(amount)}`;
  }
}

/** A price that the currency toggle can rewrite: every currency's amount rides along as a data attribute. */
export function moneySpan(m: Money, cls = "money"): string {
  return `<span class="${cls}" data-usd="${m.USD}" data-gbp="${m.GBP}" data-aed="${m.AED}" data-aud="${m.AUD}">${formatMoney(m.USD, "USD")}</span>`;
}
