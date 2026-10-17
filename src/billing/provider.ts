// How a plan change, a credit pack, a pause or a cancel gets paid for. Payments are in test mode until a provider is chosen
// (the founder, 17 October 2026): the `test` provider here, behind the interface a real one (Paddle or Stripe) will fill
// later: a checkout link, a webhook, and cancel.
//   ALLEVIA_BILLING=test-request (the default): the request is recorded (BillingRequest, pending) and the owner is told
//                                "Billing opens soon. We'll switch you by hand within a day."; the operator approves it with
//                                `npm run cli -- billing:approve <id>` (billing:requests lists them).
//   ALLEVIA_BILLING=test-instant (local use only): the request is applied at once.
// Applying is the same either way (applyRequest): a plan change sets the subscription and tops this month's plan credits up
// to the new plan's allowance (Credits.topUpPlan); a pack grants its credits; pause moves to the Pause plan; cancel ends
// the plan (no plan credits from next month). Applying the same request twice changes nothing.
import { TEST_MODE_NOTE, type BillingCycle, type BillingRequestDto, type SubscriptionDto } from "../../shared/credits.js";
import { CREDIT_PACKS, PLAN_BY_ID, type PlanId } from "../../shared/plans.js";
import type { Credits } from "../credits/index.js";
import type { TenantOpts } from "../graph/tenants.js";
import {
  addRequest, decideRequest, getRequest, getSubscription, listRequests, putSubscription, renewalAfter,
  type BillingKind, type BillingRequest, type Subscription,
} from "./subscription.js";

export type BillingMode = "test-request" | "test-instant";

export interface ChangeRequest { slug: string; kind: BillingKind; plan?: PlanId; cycle?: BillingCycle; packId?: string; by?: string }

export interface CheckoutResult {
  request: BillingRequest;
  applied: boolean;               // the change is in effect now
  checkoutUrl?: string;           // a payment provider's page to pay on (none in test mode)
  message: string;                // what happened, in one sentence for the owner
}

export interface BillingProvider {
  readonly name: string;          // "test"
  readonly mode: BillingMode;
  /** Starts a change: a payment provider returns its checkout page; the test provider records it, or applies it at once. */
  checkout(r: ChangeRequest): Promise<CheckoutResult>;
  /** Cancels at the provider (the test provider records or applies it like any other request). */
  cancel(slug: string, by?: string): Promise<CheckoutResult>;
  /** A payment provider's webhook (paid, renewed, cancelled). The test provider has none. */
  webhook?(body: string, headers: Record<string, string>): Promise<void>;
}

export interface BillingDeps { credits: Credits; tenantOpts?: TenantOpts; now?: () => number }

const planName = (p: PlanId | undefined): string => (p ? PLAN_BY_ID[p].name : "your plan");

/** What the request asks for, in the owner's words ("move to Growth, paid yearly"). */
export function requestWords(r: Pick<BillingRequest, "kind" | "plan" | "cycle" | "packId">): string {
  if (r.kind === "pack") return `${CREDIT_PACKS.find((p) => p.id === r.packId)?.credits ?? 100} more credits`;
  if (r.kind === "pause") return "pause your plan";
  if (r.kind === "cancel") return "cancel your plan";
  return `move to ${planName(r.plan)}${r.cycle === "yearly" ? ", paid yearly" : ""}`;
}

function doneWords(r: BillingRequest): string {
  if (r.kind === "pack") return `Done: ${requestWords(r)} are in your account.`;
  if (r.kind === "pause") return "Done: your plan is paused. Your team keeps an eye on things and you have 20 credits a month.";
  if (r.kind === "cancel") return "Done: your plan is cancelled. You keep this month's credits.";
  return `Done: you're on ${planName(r.plan)} now.`;
}

/** Puts a request into effect. Idempotent: the credits it grants are keyed on the request. */
export async function applyRequest(r: BillingRequest, deps: BillingDeps): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  const current: Subscription | null = await getSubscription(r.slug, deps.tenantOpts);
  if (r.kind === "pack") {
    const pack = CREDIT_PACKS.find((p) => p.id === r.packId) ?? CREDIT_PACKS[0]!;
    await deps.credits.grant(r.slug, pack.credits, "pack", r.requestId, { by: r.by ?? "owner" });
    return;
  }
  if (r.kind === "cancel") {
    const base = current ?? { slug: r.slug, plan: "growth" as PlanId, cycle: "monthly" as BillingCycle, status: "active" as const, startedAt: now, provider: "test", updatedAt: now };
    await putSubscription({ ...base, status: "cancelled", updatedAt: now }, deps.tenantOpts);
    return;
  }
  const plan: PlanId = r.kind === "pause" ? "pause" : r.plan ?? "growth";
  const cycle: BillingCycle = plan === "pause" ? "monthly" : r.cycle ?? "monthly";
  await putSubscription({
    slug: r.slug, plan, cycle, status: plan === "pause" ? "paused" : "active", startedAt: now, renewsAt: renewalAfter(now, cycle),
    provider: "test", providerRef: r.requestId, updatedAt: now,
  }, deps.tenantOpts);
  await deps.credits.topUpPlan(r.slug, r.requestId);
}

/** The operator's OK on a request (test-request mode): applied, then marked done. False when it was not pending. */
export async function approveRequest(requestId: string, deps: BillingDeps & { by?: string }): Promise<{ ok: boolean; request: BillingRequest | null; why?: string }> {
  const r = await getRequest(requestId, deps.tenantOpts);
  if (!r) return { ok: false, request: null, why: `No billing request ${requestId}.` };
  if (r.status !== "pending") return { ok: false, request: r, why: `${requestId} was already ${r.status}.` };
  await applyRequest(r, deps);
  await decideRequest(requestId, "done", { now: deps.now?.() ?? Date.now(), ...(deps.by ? { by: deps.by } : {}) }, deps.tenantOpts);
  return { ok: true, request: (await getRequest(requestId, deps.tenantOpts)) ?? r };
}

export async function declineRequest(requestId: string, deps: BillingDeps & { by?: string }): Promise<boolean> {
  return decideRequest(requestId, "declined", { now: deps.now?.() ?? Date.now(), ...(deps.by ? { by: deps.by } : {}) }, deps.tenantOpts);
}

const same = (a: BillingRequest, b: ChangeRequest): boolean =>
  a.kind === b.kind && (a.plan ?? null) === (b.plan ?? null) && (a.cycle ?? null) === (b.cycle ?? null) && (a.packId ?? null) === (b.packId ?? null);

/** The test provider. Nothing is charged: a request waits for the operator, or (test-instant) is applied at once. */
export function testProvider(mode: BillingMode, deps: BillingDeps): BillingProvider {
  const now = () => deps.now?.() ?? Date.now();
  async function checkout(c: ChangeRequest): Promise<CheckoutResult> {
    // the same request twice (a double tap) is one request
    const waiting = (await listRequests({ slug: c.slug, status: "pending" }, deps.tenantOpts)).find((r) => same(r, c));
    const request = waiting ?? await addRequest({
      slug: c.slug, kind: c.kind, at: now(), ...(c.plan ? { plan: c.plan } : {}), ...(c.cycle ? { cycle: c.cycle } : {}),
      ...(c.packId ? { packId: c.packId } : {}), ...(c.by ? { by: c.by } : {}),
    }, deps.tenantOpts);
    if (mode === "test-instant") {
      const done = await approveRequest(request.requestId, { ...deps, by: "test-instant" });
      const r = done.request ?? request;
      return { request: r, applied: true, message: doneWords(r) };
    }
    return { request, applied: false, message: `We've noted that you want to ${requestWords(request)}. ${TEST_MODE_NOTE}` };
  }
  return {
    name: "test", mode, checkout,
    cancel: (slug, by) => checkout({ slug, kind: "cancel", ...(by ? { by } : {}) }),
  };
}

// ---------- what the API sends ----------

export const requestDto = (r: BillingRequest): BillingRequestDto => ({
  id: r.requestId, kind: r.kind, at: new Date(r.at).toISOString(), status: r.status,
  ...(r.plan ? { plan: r.plan } : {}), ...(r.cycle ? { cycle: r.cycle } : {}), ...(r.packId ? { packId: r.packId } : {}),
});

export async function subscriptionDto(slug: string, o: { mode: BillingMode; tenantOpts?: TenantOpts; defaultPlan?: PlanId }): Promise<SubscriptionDto> {
  const [s, pending] = await Promise.all([getSubscription(slug, o.tenantOpts), listRequests({ slug, status: "pending" }, o.tenantOpts)]);
  const iso = (n?: number): string | undefined => (n !== undefined && n > 0 ? new Date(n).toISOString() : undefined);
  if (!s) return { plan: o.defaultPlan ?? "growth", cycle: "monthly", status: "active", provider: "test", billing: o.mode, pending: pending.map(requestDto), implicit: true };
  return {
    plan: s.status === "paused" ? "pause" : s.plan, cycle: s.cycle, status: s.status, provider: s.provider, billing: o.mode, pending: pending.map(requestDto),
    ...(iso(s.startedAt) ? { startedAt: iso(s.startedAt)! } : {}), ...(iso(s.renewsAt) ? { renewsAt: iso(s.renewsAt)! } : {}),
    ...(iso(s.trialEndsAt) ? { trialEndsAt: iso(s.trialEndsAt)! } : {}),
  };
}
