// How many people a business's plan lets in (shared/plans.ts `seats`), for invites. The plan is the business's subscription
// (src/billing/subscription.ts). On the trial, and with no subscription record (the businesses set up before credits, which
// run on Growth), it is the default plan's seats (Growth: 5), so an owner trying Allevia can bring their team in. Every open
// invite holds a seat (accounts.ts createInvite).
import { getSubscription } from "../billing/subscription.js";
import type { TenantOpts } from "../graph/tenants.js";
import { PLANS, PLAN_BY_ID, type PlanId } from "../../shared/plans.js";

const DEFAULT_PLAN = PLANS.find((p) => p.isDefault) ?? PLANS[0]!;
/** Seats on the trial, and with no subscription record. */
export const TRIAL_SEATS = DEFAULT_PLAN.allowances.seats ?? 1;

/** The business's plan, or "trial" on the trial and when it has no subscription record. */
export async function planOf(slug: string, opts?: TenantOpts): Promise<PlanId | "trial"> {
  const sub = await getSubscription(slug, opts);
  return !sub || sub.status === "trial" || !sub.plan ? "trial" : sub.plan;
}

/** People (owner included, open invites counted) the business may have. A plan that states none (Pause) has the owner only. */
export async function seatsFor(slug: string, opts?: TenantOpts): Promise<number> {
  const plan = await planOf(slug, opts);
  return plan === "trial" ? TRIAL_SEATS : PLAN_BY_ID[plan].allowances.seats ?? 1;
}
