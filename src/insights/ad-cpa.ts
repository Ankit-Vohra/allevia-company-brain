// One definition of an ad campaign's cost per sign-up, for everything that quotes it: the pause card (detectors.ts, ads.high_cpa)
// and the agents' ad_report tool (agent/tools/ads.ts). They once read different windows (the card the last 14 days of the data, the
// tool 30 days back from today), so the owner saw two figures for one campaign. The window, what counts as a CPA, the median it is
// compared with and the flag threshold live here; tests/insights/ad-cpa-agree.test.ts holds the two readers to the same numbers.
import { addDays, median } from "./text.js";

/** How many days of ads a figure covers unless someone asks for another window. */
export const AD_WINDOW_DAYS = 30;

/** A campaign whose CPA is this many times the median campaign's is flagged. */
export const HIGH_CPA_MULTIPLE = 1.5;

/** The window ends on the data's last day, never on today: ad numbers that stop three days ago still get all their days. */
export function adWindow(last: string, days: number = AD_WINDOW_DAYS): { from: string; to: string } {
  return { from: addDays(last, -(days - 1)), to: last };
}

/** Spend divided by conversions (sign-ups, leads, purchases); none when either is missing or zero. */
export function cpaOf(spend: number | null | undefined, conversions: number | null | undefined): number | null {
  return typeof spend === "number" && typeof conversions === "number" && spend > 0 && conversions > 0 ? spend / conversions : null;
}

/** The middle campaign's CPA: every campaign with a CPA in the window counts, whatever its status. */
export function medianCpa(cpas: ReadonlyArray<number | null>): number | null {
  return median(cpas.filter((c): c is number => c !== null));
}

/** The names a source may give each quantity; the first one a campaign has data for is the one used (never two names summed). */
export const AD_SPEND_METRICS = ["spend", "ad_spend", "cost", "amount_spent"] as const;
export const AD_CONVERSION_METRICS = ["signups", "conversions", "results", "leads"] as const;
