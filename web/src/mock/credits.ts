// Credits and the plan for the offline demo (?mock=1, or no server): a Growth business part way through its month. Nothing is
// bought or changed: the answers say what the live app would record.
import { TEST_MODE_NOTE, type BillingCycle, type BillingResultDto, type CreditsDto, type SubscriptionDto } from "@shared/credits";
import { CREDIT_PRICES, type CreditService, type PlanId } from "@shared/plans";

const now = () => new Date();
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const nextMonthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();

export function mockCredits(): CreditsDto {
  const d = now();
  const uses: Array<[CreditService, number, string]> = [
    ["question_deep", 9, "You"], ["question_quick", 41, "You"], ["picture", 4, "You"], ["draft_text", 12, "Priya"], ["website_checkup", 1, "You"],
  ];
  const rows = uses.map(([s, times, by]) => ({ s, times, by, credits: CREDIT_PRICES[s].credits * times }));
  const used = rows.reduce((a, r) => a + r.credits, 0);
  const byPerson = new Map<string, number>();
  for (const r of rows) byPerson.set(r.by, (byPerson.get(r.by) ?? 0) + r.credits);
  return {
    balance: { month: monthOf(d), plan: "growth", status: "active", allowance: 800, rollover: 120, packs: 0, trial: 0, owed: 0, used, left: 800 + 120 - used, resetsAt: nextMonthStart(d) },
    byService: rows.map((r) => ({ key: r.s, label: CREDIT_PRICES[r.s].label, credits: r.credits, times: r.times })).sort((a, b) => b.credits - a.credits),
    byPerson: [...byPerson].map(([who, credits]) => ({ key: who, label: who, credits, times: rows.filter((r) => r.by === who).reduce((a, r) => a + r.times, 0) })).sort((a, b) => b.credits - a.credits),
    entries: [],
    prices: (Object.keys(CREDIT_PRICES) as CreditService[]).map((s) => ({ service: s, ...CREDIT_PRICES[s] })),
  };
}

export function mockSubscription(): SubscriptionDto {
  return { plan: "growth", cycle: "monthly", status: "active", provider: "test", billing: "test-request", pending: [], implicit: true };
}

export function mockBilling(kind: "change" | "pack" | "pause" | "cancel", plan?: PlanId, cycle?: BillingCycle): BillingResultDto {
  return {
    done: false, message: `This is the offline demo, so nothing was changed. ${TEST_MODE_NOTE}`,
    request: { id: "bill_demo", kind, at: now().toISOString(), status: "pending", ...(plan ? { plan } : {}), ...(cycle ? { cycle } : {}) },
    subscription: mockSubscription(),
  };
}
