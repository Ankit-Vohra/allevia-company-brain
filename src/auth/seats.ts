// How many people a business's plan lets in (shared/plans.ts `seats`), for invites. The plan is read from the subscription
// record in the registry, (:Tenant)-[:HAS_SUBSCRIPTION]->(:Subscription {plan, status}) (the subscription work, design
// section 3). Until a business has one it is on the trial, which gets the seats of the default plan (Growth: 5), so an owner
// trying Allevia can bring their team in. Every open invite holds a seat (accounts.ts createInvite).
import { openGraphByName } from "../graph/client.js";
import { metaName, type TenantOpts } from "../graph/tenants.js";
import { PLANS, PLAN_BY_ID, type PlanId } from "../../shared/plans.js";

const DEFAULT_PLAN = PLANS.find((p) => p.isDefault) ?? PLANS[0]!;
/** Seats while a business is on the trial (no subscription record yet, or its status is "trial"). */
export const TRIAL_SEATS = DEFAULT_PLAN.allowances.seats ?? 1;

const isPlanId = (s: unknown): s is PlanId => typeof s === "string" && Object.hasOwn(PLAN_BY_ID, s);

/** The business's plan, or "trial" when it has no subscription record yet. */
export async function planOf(slug: string, opts?: TenantOpts): Promise<PlanId | "trial"> {
  const meta = await openGraphByName(metaName(opts));
  let rows: Array<{ plan: unknown; status: unknown }>;
  try {
    rows = await meta.roQuery(
      "MATCH (t:Tenant {slug:$slug})-[:HAS_SUBSCRIPTION]->(s:Subscription) RETURN s.plan AS plan, s.status AS status ORDER BY s.startedAt DESC, id(s) DESC LIMIT 1",
      { slug });
  } catch (e) {
    if (/empty key/i.test(String((e as Error)?.message))) return "trial";
    throw e;
  }
  const r = rows[0];
  if (!r || r.status === "trial" || !isPlanId(r.plan)) return "trial";
  return r.plan;
}

/** People (owner included, open invites counted) the business may have. A plan that states none (Pause) has the owner only. */
export async function seatsFor(slug: string, opts?: TenantOpts): Promise<number> {
  const plan = await planOf(slug, opts);
  return plan === "trial" ? TRIAL_SEATS : PLAN_BY_ID[plan].allowances.seats ?? 1;
}
