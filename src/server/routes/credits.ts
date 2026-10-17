// Credits and the plan (docs/superpowers/specs/2026-10-17-credits-login-subscription-design.md §2, §3):
//   GET  /api/:t/credits                     the month's balance, what used the credits by service and by person, this
//                                            month's entries (newest first), and the price list. Anyone who can open the
//                                            business; the public demo view reads it without writing anything.
//   GET  /api/:t/subscription                the plan, how it is paid, and the requests waiting for the Allevia team (owner only)
//   POST /api/:t/subscription/change         {plan, cycle}: move to another plan (owner only)
//   POST /api/:t/credits/packs               {packId}: buy 100 credits (owner only)
//   POST /api/:t/subscription/pause          (owner only)
//   POST /api/:t/subscription/cancel         (owner only)
// Payments are in test mode (src/billing/provider.ts): a change is recorded for the operator, or applied at once with
// ALLEVIA_BILLING=test-instant. Who did what is said in words: "You", a teammate's name, "A teammate", "Allevia".
import type { Hono } from "hono";
import { z } from "zod";
import type { BillingResultDto, CreditEntryDto, CreditsDto, CreditUseRow } from "../../../shared/credits.js";
import { CREDIT_PACKS, CREDIT_PRICES, type CreditService, type PlanId } from "../../../shared/plans.js";
import { requestDto, subscriptionDto, type BillingMode, type BillingProvider, type CheckoutResult } from "../../billing/provider.js";
import { getSubscription } from "../../billing/subscription.js";
import type { Credits } from "../../credits/index.js";
import { isSpendService } from "../../credits/ledger.js";
import { openGraphByName } from "../../graph/client.js";
import { metaName, type TenantOpts } from "../../graph/tenants.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";
import { callerRole, callerUserId, requireOwner } from "../roles.js";

const PLAN_IDS = ["starter", "growth", "pro", "scale", "pause"] as const satisfies readonly PlanId[];
const Change = z.object({ plan: z.enum(PLAN_IDS), cycle: z.enum(["monthly", "yearly"]).optional() });
const Pack = z.object({ packId: z.string().max(40).optional() });
const ENTRIES = 200;

/** Who is asking, as the ledger records it: a signed-in account's id, else the role. */
export const callerBy = (): string => callerUserId() ?? (callerRole() === "member" ? "member" : "owner");

// The names of the people in this business (the login work's (:User)-[:MEMBER_OF]->(:Tenant)); none before it is there.
async function memberNames(slug: string, registry?: TenantOpts): Promise<Map<string, string>> {
  try {
    const meta = await openGraphByName(metaName(registry));
    const rows = await meta.roQuery<{ id: string | null; name: string | null }>(
      "MATCH (u:User)-[m:MEMBER_OF]->(t:Tenant {slug:$slug}) WHERE ID(m) >= 0 RETURN u.id AS id, u.name AS name LIMIT 200", { slug });
    return new Map(rows.filter((r) => r.id && r.name).map((r) => [r.id!, r.name!]));
  } catch {
    return new Map();
  }
}

/** Who, in words, for the person reading the page. */
export function whoWords(by: string, names: ReadonlyMap<string, string>, me: { userId?: string | undefined; role: string }): string {
  if (me.userId && by === me.userId) return "You";
  const named = names.get(by);
  if (named) return named;
  if (by === "owner" || by === "person:founder") return me.role === "owner" && !me.userId ? "You" : "The owner";
  if (by === "member" || by === "person:discord-member" || by.startsWith("person:")) return "A teammate";
  if (by === "allevia" || by === "test-instant") return "Allevia";
  return "Someone on your team";
}

export function useRows(items: Array<{ key: string; label: string; credits: number }>): CreditUseRow[] {
  const by = new Map<string, CreditUseRow>();
  for (const i of items) {
    const r = by.get(i.key) ?? { key: i.key, label: i.label, credits: 0, times: 0 };
    r.credits += i.credits;
    r.times += 1;
    by.set(i.key, r);
  }
  return [...by.values()].sort((a, b) => b.credits - a.credits || a.label.localeCompare(b.label));
}

export function registerCreditRoutes(app: Hono, ctx: RouteCtx, o: { credits: Credits; billing: () => BillingProvider; registry?: TenantOpts }): void {
  app.get("/api/:t/credits", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const readOnly = ctx.publicMode;
    const balance = await o.credits.balance(reg.slug, { g, readOnly });
    const [rows, names] = await Promise.all([o.credits.entries(reg.slug, balance.month, { g }), readOnly ? new Map<string, string>() : memberNames(reg.slug, o.registry)]);
    const me = { userId: callerUserId(), role: callerRole() };
    const spent = rows.filter((r) => r.credits < 0 && isSpendService(r.service));
    const label = (service: string) => (isSpendService(service) ? CREDIT_PRICES[service].label : service);
    const entries: CreditEntryDto[] = rows.slice(-ENTRIES).reverse().map((r) => ({
      id: r.id, at: new Date(r.at).toISOString(), service: r.service, credits: r.credits,
      label: isSpendService(r.service) ? label(r.service) : r.reason || "Credits added",
      by: whoWords(r.by, names, me), ...(r.for ? { for: r.for } : {}),
    }));
    const dto: CreditsDto = {
      balance,
      byService: useRows(spent.map((r) => ({ key: r.service, label: label(r.service), credits: -r.credits }))),
      byPerson: useRows(spent.map((r) => { const who = whoWords(r.by, names, me); return { key: who, label: who, credits: -r.credits }; })),
      entries,
      prices: (Object.keys(CREDIT_PRICES) as CreditService[]).map((s) => ({ service: s, label: CREDIT_PRICES[s].label, credits: CREDIT_PRICES[s].credits, charged: CREDIT_PRICES[s].charged })),
    };
    return c.json(dto);
  });

  const mode = (): BillingMode => o.billing().mode;

  app.get("/api/:t/subscription", async (c) => {
    const { reg } = await ctx.tenantOf(c);
    requireOwner();
    return c.json(await subscriptionDto(reg.slug, { mode: mode(), ...(o.registry ? { tenantOpts: o.registry } : {}) }));
  });

  const answer = async (slug: string, r: CheckoutResult): Promise<BillingResultDto> => ({
    done: r.applied, message: r.message, request: requestDto(r.request),
    subscription: await subscriptionDto(slug, { mode: mode(), ...(o.registry ? { tenantOpts: o.registry } : {}) }),
  });

  // The owner's own changes: refused in the demo view, and for a teammate.
  const ownerChange = async (c: import("hono").Context) => {
    const t = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    requireOwner();
    return t;
  };

  app.post("/api/:t/subscription/change", async (c) => {
    const { reg } = await ownerChange(c);
    const body = await readBody(c, Change);
    const cycle = body.plan === "pause" ? "monthly" : body.cycle ?? "monthly";
    const sub = await getSubscription(reg.slug, o.registry);
    const on = sub ? (sub.status === "paused" ? "pause" : sub.status === "active" ? sub.plan : null) : "growth";
    if (on === body.plan && (sub?.cycle ?? "monthly") === cycle) throw new HttpError(409, "You're already on that plan.");
    const r = await o.billing().checkout({ slug: reg.slug, kind: body.plan === "pause" ? "pause" : "change", plan: body.plan, cycle, by: callerBy() });
    ctx.log(`[billing] ${reg.slug}: ${r.applied ? "applied" : "recorded"} ${r.request.kind} ${body.plan} (${r.request.requestId})`);
    return c.json(await answer(reg.slug, r), r.applied ? 200 : 202);
  });

  app.post("/api/:t/credits/packs", async (c) => {
    const { reg } = await ownerChange(c);
    const body = await readBody(c, Pack);
    const pack = CREDIT_PACKS.find((p) => p.id === (body.packId ?? CREDIT_PACKS[0]!.id));
    if (!pack) throw new HttpError(400, "There is no such pack.");
    const r = await o.billing().checkout({ slug: reg.slug, kind: "pack", packId: pack.id, by: callerBy() });
    ctx.log(`[billing] ${reg.slug}: ${r.applied ? "applied" : "recorded"} pack ${pack.id} (${r.request.requestId})`);
    return c.json(await answer(reg.slug, r), r.applied ? 200 : 202);
  });

  app.post("/api/:t/subscription/pause", async (c) => {
    const { reg } = await ownerChange(c);
    const sub = await getSubscription(reg.slug, o.registry);
    if (sub?.status === "paused") throw new HttpError(409, "Your plan is already paused.");
    const r = await o.billing().checkout({ slug: reg.slug, kind: "pause", plan: "pause", by: callerBy() });
    return c.json(await answer(reg.slug, r), r.applied ? 200 : 202);
  });

  app.post("/api/:t/subscription/cancel", async (c) => {
    const { reg } = await ownerChange(c);
    const sub = await getSubscription(reg.slug, o.registry);
    if (sub?.status === "cancelled") throw new HttpError(409, "Your plan is already cancelled.");
    const r = await o.billing().cancel(reg.slug, callerBy());
    return c.json(await answer(reg.slug, r), r.applied ? 200 : 202);
  });
}
