// A business's subscription and its billing requests, in the registry graph (allevia_meta) next to its (:Tenant):
//   (:Tenant)-[:HAS_SUBSCRIPTION]->(:Subscription {slug, plan, cycle, status, startedAt, renewsAt, trialEndsAt, provider, providerRef, updatedAt})
//   (:Tenant)-[:REQUESTED]->(:BillingRequest {requestId, slug, kind, plan, cycle, packId, at, status, by, decidedAt, decidedBy})
// One Subscription per business, found by its `slug` (indexed), so a trial can start before onboarding has registered the
// Tenant; the edge is added whenever the Tenant is there (linkSubscriptions). A request's own id is `requestId`: the
// codebase keeps `id` for Entity nodes, whose id index every `{id: ...}` lookup is held to (tests/helpers/cypher-lint.ts).
//
// Payments are in test mode (src/billing/provider.ts): a request waits for the operator (`billing:approve`) or, with
// ALLEVIA_BILLING=test-instant, is applied at once. A business with no Subscription runs on the plan it has always had
// (src/credits: Growth), so the founder's own businesses and the demos keep working.
import { randomBytes } from "node:crypto";
import type { BillingCycle, SubscriptionStatus } from "../../shared/credits.js";
import { PLAN_BY_ID, type PlanId } from "../../shared/plans.js";
import { openGraphByName, type GraphHandle } from "../graph/client.js";
import { ensureIndexes } from "../graph/indexes.js";
import { metaName, type TenantOpts } from "../graph/tenants.js";

export interface Subscription {
  slug: string;
  plan: PlanId | null;             // null on a trial that has not chosen a plan
  cycle: BillingCycle;
  status: SubscriptionStatus;
  startedAt: number;
  renewsAt?: number;
  trialEndsAt?: number;
  provider: string;                // "test" until a payment provider is connected
  providerRef?: string;
  updatedAt: number;
}

export type BillingKind = "change" | "pack" | "pause" | "cancel";
export type RequestStatus = "pending" | "done" | "declined";

export interface BillingRequest {
  requestId: string;
  slug: string;
  kind: BillingKind;
  plan?: PlanId;
  cycle?: BillingCycle;
  packId?: string;
  at: number;
  status: RequestStatus;
  by?: string;
  decidedAt?: number;
  decidedBy?: string;
}

const PLAN_IDS = new Set<string>(Object.keys(PLAN_BY_ID));
export const isPlanId = (s: unknown): s is PlanId => typeof s === "string" && PLAN_IDS.has(s);

const missingGraph = (e: unknown): boolean => /empty key/i.test(String((e as Error)?.message));

const indexed = new Set<string>();
async function meta(opts?: TenantOpts, write = false): Promise<GraphHandle> {
  const g = await openGraphByName(metaName(opts));
  if (write && !indexed.has(g.name)) {
    await ensureIndexes(g, [
      { label: "Subscription", prop: "slug", type: "RANGE" },
      { label: "BillingRequest", prop: "requestId", type: "RANGE" },
      { label: "BillingRequest", prop: "slug", type: "RANGE" },
    ]);
    indexed.add(g.name);
  }
  return g;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function toSubscription(p: Record<string, unknown>): Subscription {
  const status = (["trial", "active", "paused", "cancelled"] as const).find((s) => s === p.status) ?? "active";
  return {
    slug: String(p.slug), plan: isPlanId(p.plan) ? p.plan : null, cycle: p.cycle === "yearly" ? "yearly" : "monthly", status,
    startedAt: num(p.startedAt) ?? 0, provider: typeof p.provider === "string" ? p.provider : "test", updatedAt: num(p.updatedAt) ?? 0,
    ...(num(p.renewsAt) !== undefined ? { renewsAt: num(p.renewsAt)! } : {}),
    ...(num(p.trialEndsAt) !== undefined ? { trialEndsAt: num(p.trialEndsAt)! } : {}),
    ...(typeof p.providerRef === "string" ? { providerRef: p.providerRef } : {}),
  };
}

function toRequest(p: Record<string, unknown>): BillingRequest {
  return {
    requestId: String(p.requestId), slug: String(p.slug), kind: (["change", "pack", "pause", "cancel"] as const).find((k) => k === p.kind) ?? "change",
    at: num(p.at) ?? 0, status: (["pending", "done", "declined"] as const).find((s) => s === p.status) ?? "pending",
    ...(isPlanId(p.plan) ? { plan: p.plan } : {}), ...(p.cycle === "monthly" || p.cycle === "yearly" ? { cycle: p.cycle } : {}),
    ...(typeof p.packId === "string" ? { packId: p.packId } : {}), ...(typeof p.by === "string" ? { by: p.by } : {}),
    ...(num(p.decidedAt) !== undefined ? { decidedAt: num(p.decidedAt)! } : {}), ...(typeof p.decidedBy === "string" ? { decidedBy: p.decidedBy } : {}),
  };
}

export async function getSubscription(slug: string, opts?: TenantOpts): Promise<Subscription | null> {
  try {
    const [row] = await (await meta(opts)).roQuery<{ p: Record<string, unknown> }>(
      "MATCH (s:Subscription {slug:$slug}) RETURN properties(s) AS p LIMIT 1", { slug });
    return row ? toSubscription(row.p) : null;
  } catch (e) {
    if (missingGraph(e)) return null;
    throw e;
  }
}

/** Writes the whole record (absent optional fields are removed), and links it to its Tenant when the Tenant is registered. */
export async function putSubscription(s: Subscription, opts?: TenantOpts): Promise<Subscription> {
  const g = await meta(opts, true);
  await g.query(
    `MERGE (s:Subscription {slug:$slug})
     SET s.plan = $plan, s.cycle = $cycle, s.status = $status, s.startedAt = $startedAt, s.renewsAt = $renewsAt, s.trialEndsAt = $trialEndsAt,
         s.provider = $provider, s.providerRef = $providerRef, s.updatedAt = $updatedAt
     WITH s MATCH (t:Tenant {slug:$slug}) MERGE (t)-[r:HAS_SUBSCRIPTION]->(s) ON CREATE SET r.since = $updatedAt`,
    {
      slug: s.slug, plan: s.plan, cycle: s.cycle, status: s.status, startedAt: s.startedAt, renewsAt: s.renewsAt ?? null, trialEndsAt: s.trialEndsAt ?? null,
      provider: s.provider, providerRef: s.providerRef ?? null, updatedAt: s.updatedAt,
    });
  return s;
}

/** Adds the Tenant edges that subscriptions and requests written before their Tenant was registered lack. Idempotent. */
export async function linkSubscriptions(opts?: TenantOpts & { now?: number }): Promise<void> {
  const g = await meta(opts, true);
  const now = opts?.now ?? Date.now();
  await g.query("MATCH (s:Subscription) MATCH (t:Tenant) WHERE t.slug = s.slug MERGE (t)-[r:HAS_SUBSCRIPTION]->(s) ON CREATE SET r.since = $now", { now });
  await g.query("MATCH (b:BillingRequest) MATCH (t:Tenant) WHERE t.slug = b.slug MERGE (t)-[r:REQUESTED]->(b) ON CREATE SET r.at = b.at", {});
}

export async function addRequest(r: Omit<BillingRequest, "requestId" | "status"> & { requestId?: string }, opts?: TenantOpts): Promise<BillingRequest> {
  const req: BillingRequest = { ...r, requestId: r.requestId ?? `bill_${randomBytes(5).toString("hex")}`, status: "pending" };
  const g = await meta(opts, true);
  await g.query(
    `CREATE (b:BillingRequest {requestId:$requestId, slug:$slug, kind:$kind, at:$at, status:'pending'})
     SET b.plan = $plan, b.cycle = $cycle, b.packId = $packId, b.by = $by
     WITH b MATCH (t:Tenant {slug:$slug}) MERGE (t)-[r:REQUESTED]->(b) ON CREATE SET r.at = $at`,
    { requestId: req.requestId, slug: req.slug, kind: req.kind, at: req.at, plan: req.plan ?? null, cycle: req.cycle ?? null, packId: req.packId ?? null, by: req.by ?? null });
  return req;
}

export async function getRequest(requestId: string, opts?: TenantOpts): Promise<BillingRequest | null> {
  try {
    const [row] = await (await meta(opts)).roQuery<{ p: Record<string, unknown> }>(
      "MATCH (b:BillingRequest {requestId:$requestId}) RETURN properties(b) AS p LIMIT 1", { requestId });
    return row ? toRequest(row.p) : null;
  } catch (e) {
    if (missingGraph(e)) return null;
    throw e;
  }
}

/** Requests, oldest first: every business's, or one business's; all statuses, or one. */
export async function listRequests(o: { slug?: string; status?: RequestStatus; limit?: number } = {}, opts?: TenantOpts): Promise<BillingRequest[]> {
  try {
    const rows = await (await meta(opts)).roQuery<{ p: Record<string, unknown> }>(
      `MATCH (b:BillingRequest) WHERE ($slug IS NULL OR b.slug = $slug) AND ($status IS NULL OR b.status = $status)
       RETURN properties(b) AS p, b.at AS at, id(b) AS rid ORDER BY at, rid LIMIT $limit`,
      { slug: o.slug ?? null, status: o.status ?? null, limit: o.limit ?? 200 });
    return rows.map((r) => toRequest(r.p));
  } catch (e) {
    if (missingGraph(e)) return [];
    throw e;
  }
}

/** Moves a pending request to done or declined. False when it was not pending (decided already, or no such request). */
export async function decideRequest(requestId: string, status: "done" | "declined", o: { now: number; by?: string }, opts?: TenantOpts): Promise<boolean> {
  const g = await meta(opts, true);
  const rows = await g.query<{ n: number }>(
    "MATCH (b:BillingRequest {requestId:$requestId}) WHERE b.status = 'pending' SET b.status = $status, b.decidedAt = $now, b.decidedBy = $by RETURN count(b) AS n",
    { requestId, status, now: o.now, by: o.by ?? null });
  return (rows[0]?.n ?? 0) > 0;
}

/** When a period that started at `from` renews: a month or a year later (the same day of the month, clamped). */
export function renewalAfter(from: number, cycle: BillingCycle): number {
  const d = new Date(from);
  const months = cycle === "yearly" ? 12 : 1;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}
