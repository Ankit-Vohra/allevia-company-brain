// Credits: one pool per business, spent on what the owner asks for or approves (docs/superpowers/specs/
// 2026-10-17-credits-login-subscription-design.md §2). The ledger is in the business's own graph:
//   (:CreditEntry {id, key, at, month, service, credits, reason, by, ref})-[:FOR]->(what it paid for: the Turn, the approved
//   card, the check-up's report)
// so "what used my credits" is a traversal and every spend has its "how we know". The arithmetic is in ledger.ts.
//
// - balance(slug)                the month as it stands: {allowance, rollover, packs, trial, owed, used, left, resetsAt}
// - canSpend(slug, service)      whether work of this kind may start now
// - hold(slug, service)          starts work that is charged at its end (an answer, a check-up): checks and holds the credits
//                                it needs, so two answers at once cannot both spend the last credit; commit() charges, release()
//                                lets go (a failed answer costs nothing)
// - spend(slug, service, {ref})  charges once per (service, ref): a retried approval is not charged twice (the entry's key is
//                                `service:ref`, MERGEd, so this holds across processes too)
// - grant(slug, credits, reason, ref)   adds credits: reason "trial" starts the 14-day trial (the login work calls this at
//                                sign-up), "pack" a bought pack, anything else an addition from the Allevia team
// A month's plan credits are granted lazily on the first read or spend in it, with what carries over from the month before
// (ledger.ts). A per-business lock in this process keeps the writes of one business in order.
//
// The plan comes from the subscription (src/billing/subscription.ts). A business with no subscription record is on Growth:
// that is the founder's own businesses, the demos and every business set up before credits existed, so nothing they do now
// stops. A business that signs up starts on the trial instead (grant "trial" writes its subscription).
//
// Graph rules (src/graph/safety.ts): sums are done here, never in Cypher; every ORDER BY ends in an id; entries are found by
// `key` (indexed), never by an `{id: ...}` anchor, which the codebase keeps for Entity nodes.
import { createHash, randomBytes } from "node:crypto";
import {
  outOfCreditsSentence, nextPlanUp, type BalanceDto, type OutOfCreditsInfo, type SubscriptionStatus,
} from "../../shared/credits.js";
import { CREDIT_PACKS, CREDIT_PRICES, PLAN_BY_ID, TRIAL, isCurrency, type CreditService, type Currency, type PlanId } from "../../shared/plans.js";
import { getSubscription, putSubscription, type Subscription } from "../billing/subscription.js";
import { openGraph, type GraphHandle } from "../graph/client.js";
import { INDEXES, ensureIndexes } from "../graph/indexes.js";
import { getTenant, type TenantOpts } from "../graph/tenants.js";
import { isoDate } from "../util/time.js";
import {
  carryOver, isSpendService, monthOf, monthStart, monthState, monthsAfter, neededFor, nextMonth, prevMonth, totals,
  type EntryRow, type GrantService, type MonthState,
} from "./ledger.js";

export { monthOf } from "./ledger.js";

/** The ledger's indexes (part of the schema in graph/indexes.ts; made here too for a graph made before them). */
export const CREDIT_INDEXES = INDEXES.filter((i) => i.label === "CreditEntry");

/** The plan a business with no subscription record is on. */
export const DEFAULT_PLAN: PlanId = "growth";

/** Out of credits: the API answers 402 with this sentence, and the web app and Discord show it with two buttons. */
export class OutOfCredits extends Error {
  readonly status = 402 as const;
  constructor(readonly info: OutOfCreditsInfo, message: string) {
    super(message);
    this.name = "OutOfCredits";
  }
}

export interface CreditsOptions {
  openGraph?: (slug: string) => Promise<GraphHandle>;  // default: the business's own graph (graph/client.ts)
  tenantOpts?: TenantOpts;                             // where the subscriptions are (the registry graph)
  now?: () => number;
  log?: (line: string) => void;
  defaultPlan?: PlanId;
  holdMs?: number;                                     // how long a hold lasts if nothing commits or releases it (default 30 min)
}

/** Where a call reads and writes: the business's graph when the caller already has it (decide() does). */
export interface At { g?: GraphHandle }

export interface SpendOpts extends At {
  ref: string;                   // what this spend is for, unique per service: the turn id, the approval id, the check-up run
  by?: string;                   // who: a user id, "owner", "member", person:founder, person:discord-member
  for?: string[];                // Entity ids it paid for (the FOR edges)
  allowNegative?: boolean;       // the check was made when the work started (a hold): charge even if that took it below zero
  part?: string;                 // a second charge for the same thing (the clip made with a picture)
  label?: string;                // the reason, in plain words (default: the price list's label)
}

export interface SpendResult { charged: number; duplicate?: boolean; key?: string }

export interface CreditEntryRow {
  key: string; id: string; at: number; service: string; credits: number; by: string; reason: string; for?: { id: string; name: string };
}

export interface Hold {
  readonly service: CreditService;
  readonly needed: number;
  commit(o: SpendOpts & { service?: CreditService }): Promise<SpendResult>;
  release(): void;
}

interface Plan { plan: PlanId | null; status: SubscriptionStatus; allowance: number; implicit: boolean; trialEndsAt?: number }

interface Row extends EntryRow { opens?: boolean | null; implicit?: boolean | null; id: string }

interface NewEntry {
  key: string; month: string; service: GrantService | CreditService; credits: number; reason: string; by: string; ref: string; at: number;
  opens?: boolean; implicit?: boolean; for?: string[];
}

const PAGE = 2000;
const entryId = (key: string): string => `credit:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
const whole = (n: number): number => Math.trunc(n);

export class Credits {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly holds = new Map<string, Set<{ amount: number; until: number }>>();
  private readonly indexed = new Set<string>();

  constructor(private readonly o: CreditsOptions = {}) {}

  private now(): number { return (this.o.now ?? Date.now)(); }
  private log(line: string): void { (this.o.log ?? ((l: string) => console.error(l)))(`[credits] ${line}`); }
  private graph(slug: string, at?: At): Promise<GraphHandle> { return at?.g ? Promise.resolve(at.g) : (this.o.openGraph ?? openGraph)(slug); }

  // One business's writes in order, in this process.
  private locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(name, settled);
    void settled.then(() => { if (this.locks.get(name) === settled) this.locks.delete(name); });
    return next;
  }

  private held(name: string): number {
    const set = this.holds.get(name);
    if (!set) return 0;
    const now = this.now();
    let n = 0;
    for (const h of set) if (h.until > now) n += h.amount; else set.delete(h);
    return n;
  }

  private async ready(g: GraphHandle): Promise<void> {
    if (this.indexed.has(g.name)) return;
    await ensureIndexes(g, CREDIT_INDEXES);
    this.indexed.add(g.name);
  }

  // ---------- the plan ----------

  async subscription(slug: string): Promise<Subscription | null> {
    return getSubscription(slug, this.o.tenantOpts);
  }

  private planOf(sub: Subscription | null): Plan {
    const def = this.o.defaultPlan ?? DEFAULT_PLAN;
    const trial = sub?.trialEndsAt !== undefined ? { trialEndsAt: sub.trialEndsAt } : {};
    if (!sub) return { plan: def, status: "active", allowance: PLAN_BY_ID[def].allowances.creditsPerMonth, implicit: true };
    if (sub.status === "trial") return { plan: sub.plan, status: "trial", allowance: 0, implicit: false, ...trial };
    if (sub.status === "cancelled") return { plan: sub.plan, status: "cancelled", allowance: 0, implicit: false, ...trial };
    if (sub.status === "paused") return { plan: "pause", status: "paused", allowance: PLAN_BY_ID.pause.allowances.creditsPerMonth, implicit: false, ...trial };
    const plan = sub.plan ?? def;
    return { plan, status: "active", allowance: PLAN_BY_ID[plan].allowances.creditsPerMonth, implicit: false, ...trial };
  }

  // ---------- reading ----------

  private async readMonth(g: GraphHandle, month: string): Promise<Row[]> {
    const out: Row[] = [];
    try {
      for (let after = ""; ;) {
        const rows = await g.roQuery<{ key: string; id: string; service: string; credits: number; at: number; by: string | null; opens: boolean | null; implicit: boolean | null }>(
          `MATCH (e:CreditEntry) WHERE e.month = $month AND e.key > $after
           RETURN e.key AS key, e.id AS id, e.service AS service, e.credits AS credits, e.at AS at, e.by AS by, e.opens AS opens, e.implicit AS implicit
           ORDER BY key, id LIMIT $limit`, { month, after, limit: PAGE });
        out.push(...rows);
        if (rows.length < PAGE) return out;
        after = rows[rows.length - 1]!.key;
      }
    } catch (e) {
      if (/empty key/i.test(String((e as Error).message))) return out; // the graph has nothing yet
      throw e;
    }
  }

  private async lastOpened(g: GraphHandle, before: string): Promise<string | null> {
    try {
      const [row] = await g.roQuery<{ month: string }>(
        "MATCH (e:CreditEntry) WHERE e.month < $before AND e.opens = true RETURN e.month AS month, e.id AS id ORDER BY month DESC, id LIMIT 1", { before });
      return row?.month ?? null;
    } catch (e) {
      if (/empty key/i.test(String((e as Error).message))) return null;
      throw e;
    }
  }

  private stateOf(rows: readonly EntryRow[], plan: Plan, at: number): MonthState {
    const ended = plan.trialEndsAt !== undefined && at >= plan.trialEndsAt;
    return monthState(totals(rows, plan.trialEndsAt), { trialEnded: ended });
  }

  // The entries that open `month`: its plan credits (also the marker that it is open) and what carries over. Months skipped
  // since the last one opened are opened in turn (up to two years), so a quiet month's unused credits still roll over.
  private async openingRows(g: GraphHandle, month: string, plan: Plan, by: string): Promise<NewEntry[]> {
    const at = this.now();
    const last = await this.lastOpened(g, month);
    const reason = (m: string) => plan.allowance > 0 ? `${PLAN_BY_ID[plan.plan ?? DEFAULT_PLAN].name} plan, ${m}` : `No plan credits for ${m}`;
    const marker = (m: string): NewEntry => ({
      key: `plan:${m}`, month: m, service: "plan", credits: plan.allowance, reason: reason(m), by, ref: m, at, opens: true, ...(plan.implicit ? { implicit: true } : {}),
    });
    if (!last) return [marker(month)];
    const gap = monthsAfter(last, month, 1000);
    const steps = gap.slice(-24);
    let prevRows: EntryRow[] = await this.readMonth(g, last);
    const out: NewEntry[] = [];
    for (let i = 0; i < steps.length; i++) {
      const m = steps[i]!;
      const p = prevMonth(m);
      const state = this.stateOf(prevRows, plan, monthStart(m));
      const carry = carryOver(state, { nextAllowance: plan.allowance, trialRuns: plan.trialEndsAt !== undefined && plan.trialEndsAt > monthStart(m), gap: i === 0 && gap.length > steps.length });
      const rows: NewEntry[] = [marker(m)];
      if (carry.rollover > 0) rows.push({ key: `rollover:${m}`, month: m, service: "rollover", credits: carry.rollover, reason: `Unused plan credits from ${p}`, by, ref: m, at });
      if (carry.packs > 0) rows.push({ key: `packs:${m}`, month: m, service: "pack_carry", credits: carry.packs, reason: `Bought credits carried from ${p}`, by, ref: m, at });
      if (carry.trial > 0) rows.push({ key: `trial:${m}`, month: m, service: "trial_carry", credits: carry.trial, reason: `Trial credits carried from ${p}`, by, ref: m, at });
      if (carry.owed > 0) rows.push({ key: `owed:${m}`, month: m, service: "owed", credits: -carry.owed, reason: `Went over in ${p}`, by, ref: m, at });
      out.push(...rows);
      prevRows = rows.map((r) => ({ key: r.key, service: r.service, credits: r.credits, at: r.at }));
    }
    return out;
  }

  private async write(g: GraphHandle, entries: NewEntry[]): Promise<Map<string, boolean>> {
    const created = new Map<string, boolean>();
    if (!entries.length) return created;
    await this.ready(g);
    const rows = entries.map((e) => ({
      key: e.key, id: entryId(e.key), month: e.month, service: e.service, credits: whole(e.credits), reason: e.reason.slice(0, 200), by: e.by, ref: e.ref.slice(0, 300), at: e.at,
      opens: e.opens ?? null, implicit: e.implicit ?? null, nonce: randomBytes(6).toString("hex"),
    }));
    const out = await g.query<{ key: string; created: boolean }>(
      `UNWIND $rows AS r
       MERGE (e:CreditEntry {key: r.key})
       ON CREATE SET e.id = r.id, e.month = r.month, e.service = r.service, e.credits = r.credits, e.reason = r.reason, e.by = r.by, e.ref = r.ref,
                     e.at = r.at, e.opens = r.opens, e.implicit = r.implicit, e.nonce = r.nonce
       RETURN r.key AS key, e.nonce = r.nonce AS created`, { rows });
    for (const r of out) created.set(r.key, r.created === true);
    const links = entries.flatMap((e) => (created.get(e.key) ? (e.for ?? []) : []).map((f) => ({ key: e.key, for: f, at: e.at, asOf: isoDate(e.at) })));
    if (links.length) {
      // what it paid for, when that node is in the graph (a missing one is simply not linked)
      await g.query(
        `UNWIND $links AS l
         MATCH (e:CreditEntry {key: l.key})
         MATCH (x:Entity {id: l.for})
         MERGE (e)-[f:FOR]->(x) ON CREATE SET f.recordedAt = l.at, f.asOf = l.asOf`, { links });
    }
    return created;
  }

  // This month's entries, opening the month first when it is not open yet (or, read-only, adding what opening would write).
  private async month(g: GraphHandle, slug: string, plan: Plan, o: { readOnly?: boolean } = {}): Promise<{ month: string; rows: Row[] }> {
    const month = monthOf(this.now());
    let rows = await this.readMonth(g, month);
    if (!rows.some((r) => r.opens === true)) {
      const opening = await this.openingRows(g, month, plan, "allevia");
      if (o.readOnly) {
        rows = [...rows, ...opening.filter((e) => e.month === month).map((e) => ({ key: e.key, id: entryId(e.key), service: e.service, credits: e.credits, at: e.at, opens: e.opens ?? null, implicit: e.implicit ?? null }))];
      } else {
        await this.write(g, opening);
        this.log(`${slug}: opened ${month} (${opening.length} entr${opening.length === 1 ? "y" : "ies"})`);
        rows = await this.readMonth(g, month);
      }
    }
    return { month, rows };
  }

  private dto(month: string, s: MonthState, plan: Plan): BalanceDto {
    return {
      month, plan: plan.plan, status: plan.status, allowance: s.allowance, rollover: s.rollover, packs: s.packs, trial: s.trial, owed: s.owed, used: s.used, left: s.left,
      resetsAt: new Date(monthStart(nextMonth(month))).toISOString(),
      ...(plan.trialEndsAt !== undefined ? { trialEndsAt: new Date(plan.trialEndsAt).toISOString() } : {}),
    };
  }

  /** The month as it stands. `readOnly` (the public demo view) writes nothing: a month not opened yet is worked out as if it were. */
  async balance(slug: string, o: At & { readOnly?: boolean } = {}): Promise<BalanceDto> {
    const g = await this.graph(slug, o);
    const plan = this.planOf(await this.subscription(slug));
    const read = async () => {
      const { month, rows } = await this.month(g, slug, plan, o);
      return this.dto(month, this.stateOf(rows, plan, this.now()), plan);
    };
    return o.readOnly ? read() : this.locked(g.name, read);
  }

  /**
   * A month's entries for the credits page, each with what it paid for (its FOR edge): every row, oldest first, paged by
   * key. A business has a few thousand at most a month (Scale's 4,000 credits).
   */
  async entries(slug: string, month: string, o: At = {}): Promise<CreditEntryRow[]> {
    const g = await this.graph(slug, o);
    const byKey = new Map<string, CreditEntryRow>();
    try {
      for (let after = ""; ;) {
        const rows = await g.roQuery<{ key: string; id: string; at: number; service: string; credits: number; by: string | null; reason: string | null; forId: string | null; forName: string | null }>(
          `MATCH (e:CreditEntry) WHERE e.month = $month AND e.key > $after
           OPTIONAL MATCH (e)-[f:FOR]->(x:Entity) WHERE ID(f) >= 0
           RETURN e.key AS key, e.id AS id, e.at AS at, e.service AS service, e.credits AS credits, e.by AS by, e.reason AS reason, x.id AS forId, x.name AS forName
           ORDER BY key, id, forId LIMIT $limit`, { month, after, limit: PAGE });
        for (const r of rows) {
          if (byKey.has(r.key)) continue; // a second FOR edge: the first one names it
          byKey.set(r.key, {
            key: r.key, id: r.id, at: Number(r.at) || 0, service: r.service, credits: whole(Number(r.credits) || 0), by: r.by ?? "", reason: r.reason ?? "",
            ...(r.forId ? { for: { id: r.forId, name: r.forName ?? r.forId } } : {}),
          });
        }
        if (rows.length < PAGE) break;
        after = rows[rows.length - 1]!.key;
      }
    } catch (e) {
      if (!/empty key/i.test(String((e as Error).message))) throw e;
    }
    return [...byKey.values()].sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  }

  private async currency(slug: string): Promise<Currency> {
    try {
      const t = await getTenant(slug, this.o.tenantOpts);
      const c = t?.currency?.toUpperCase();
      return c && isCurrency(c) ? c : "USD";
    } catch {
      return "USD";
    }
  }

  async outOfCredits(slug: string, service: CreditService, b: BalanceDto, heldNow = 0): Promise<OutOfCredits> {
    const info: OutOfCreditsInfo = {
      left: b.left - heldNow, needed: neededFor(service), service, packId: CREDIT_PACKS[0]!.id, nextPlan: nextPlanUp(b.status === "trial" ? null : b.plan),
    };
    return new OutOfCredits(info, outOfCreditsSentence({ plan: b.plan, trial: b.status === "trial", currency: await this.currency(slug) }));
  }

  /** Whether work of this kind may start now, and what is left (after what running work holds). */
  async check(slug: string, service: CreditService, o: At = {}): Promise<{ ok: boolean; left: number; needed: number; balance: BalanceDto }> {
    const needed = neededFor(service);
    const g = await this.graph(slug, o);
    const b = await this.balance(slug, { g });
    const left = b.left - this.held(g.name);
    return { ok: needed === 0 || left >= needed, left, needed, balance: b };
  }

  async canSpend(slug: string, service: CreditService, o: At = {}): Promise<boolean> {
    return (await this.check(slug, service, o)).ok;
  }

  /** Throws OutOfCredits (402) unless work of this kind may start now. */
  async assertCanSpend(slug: string, service: CreditService, o: At = {}): Promise<void> {
    const c = await this.check(slug, service, o);
    if (!c.ok) throw await this.outOfCredits(slug, service, c.balance, c.balance.left - c.left);
  }

  /**
   * Starts work charged when it ends: checks the credits it needs (402 when they are not there) and holds them until
   * commit() charges or release() lets go, so two answers at once cannot both spend the last credit.
   */
  async hold(slug: string, service: CreditService, o: At = {}): Promise<Hold> {
    const g = await this.graph(slug, o);
    const needed = neededFor(service);
    const rec = { amount: needed, until: this.now() + (this.o.holdMs ?? 30 * 60_000) };
    await this.locked(g.name, async () => {
      if (needed === 0) return;
      const plan = this.planOf(await this.subscription(slug));
      const { month, rows } = await this.month(g, slug, plan);
      const b = this.dto(month, this.stateOf(rows, plan, this.now()), plan);
      const heldNow = this.held(g.name);
      if (b.left - heldNow < needed) throw await this.outOfCredits(slug, service, b, heldNow);
      const set = this.holds.get(g.name) ?? new Set();
      set.add(rec);
      this.holds.set(g.name, set);
    });
    let open = true;
    const release = () => { if (open) { open = false; this.holds.get(g.name)?.delete(rec); } };
    return {
      service, needed,
      commit: async (c) => {
        try {
          return await this.spend(slug, c.service ?? service, { ...c, g, allowNegative: true });
        } finally {
          release();
        }
      },
      release,
    };
  }

  /** Charges a service once per (service, ref). Free services write nothing. */
  async spend(slug: string, service: CreditService, o: SpendOpts): Promise<SpendResult> {
    const price = CREDIT_PRICES[service]?.credits ?? 0;
    if (!isSpendService(service) || price <= 0) return { charged: 0 };
    if (!o.ref) throw new Error("a spend needs a ref (what it is for)");
    const g = await this.graph(slug, o);
    const key = `${service}:${o.ref}${o.part ? `:${o.part}` : ""}`;
    return this.locked(g.name, async () => {
      const plan = this.planOf(await this.subscription(slug));
      const { month, rows } = await this.month(g, slug, plan);
      if (rows.some((r) => r.key === key) || (await this.exists(g, key))) return { charged: 0, duplicate: true, key };
      if (!o.allowNegative) {
        const b = this.dto(month, this.stateOf(rows, plan, this.now()), plan);
        const heldNow = this.held(g.name);
        if (b.left - heldNow < neededFor(service)) throw await this.outOfCredits(slug, service, b, heldNow);
      }
      const created = await this.write(g, [{
        key, month, service, credits: -price, reason: o.label ?? CREDIT_PRICES[service].label, by: o.by ?? "owner", ref: o.ref, at: this.now(), ...(o.for?.length ? { for: o.for } : {}),
      }]);
      return created.get(key) ? { charged: price, key } : { charged: 0, duplicate: true, key };
    });
  }

  private async exists(g: GraphHandle, key: string): Promise<boolean> {
    try {
      return (await g.roQuery<{ k: string }>("MATCH (e:CreditEntry {key:$key}) RETURN e.key AS k LIMIT 1", { key })).length > 0;
    } catch (e) {
      if (/empty key/i.test(String((e as Error).message))) return false;
      throw e;
    }
  }

  /**
   * Adds credits. reason "trial" starts the trial (TRIAL.days, a trial subscription when the business has none), "pack" is
   * a bought pack, "plan" tops this month's plan credits up to the plan's allowance (after an upgrade), anything else is
   * an addition from the Allevia team. Once per ref for each reason.
   */
  async grant(slug: string, credits: number, reason: string, ref: string, o: At & { by?: string } = {}): Promise<{ granted: number; duplicate?: boolean }> {
    if (!Number.isInteger(credits) || credits === 0) throw new Error(`credits must be a whole number other than 0, got ${credits}`);
    if (!ref) throw new Error("a grant needs a ref");
    const now = this.now();
    let sub = await this.subscription(slug);
    if (reason === "trial" && !sub) {
      sub = await putSubscription({ slug, plan: null, cycle: "monthly", status: "trial", startedAt: now, trialEndsAt: now + TRIAL.days * 86_400_000, provider: "test", updatedAt: now }, this.o.tenantOpts);
    }
    const g = await this.graph(slug, o);
    return this.locked(g.name, async () => {
      const plan = this.planOf(sub);
      const { month, rows } = await this.month(g, slug, plan);
      const entries: NewEntry[] = [];
      const by = o.by ?? "allevia";
      if (reason === "trial") {
        // a month opened on the default plan before the trial started (the business was read during set-up) is taken back
        const planned = rows.filter((r) => r.service === "plan").reduce((s, r) => s + whole(r.credits), 0);
        if (planned > 0 && rows.some((r) => r.opens === true && r.implicit === true) && sub?.status === "trial") {
          entries.push({ key: `plan:${month}:trial-start`, month, service: "plan", credits: -planned, reason: "The trial starts instead of a plan", by, ref, at: now });
        }
        entries.push({ key: `trial:${ref}`, month, service: "trial", credits, reason: `Your ${TRIAL.days}-day trial`, by, ref, at: now });
      } else if (reason === "pack") {
        entries.push({ key: `pack:${ref}`, month, service: "pack", credits, reason: `${credits} credits bought`, by, ref, at: now });
      } else if (reason === "plan") {
        entries.push({ key: `plan:${month}:${ref}`, month, service: "plan", credits, reason: `${PLAN_BY_ID[plan.plan ?? DEFAULT_PLAN].name} plan: this month's credits topped up`, by, ref, at: now });
      } else {
        entries.push({ key: `grant:${ref}`, month, service: "grant", credits, reason: reason.slice(0, 200) || "Added by the Allevia team", by, ref, at: now });
      }
      const created = await this.write(g, entries);
      const main = entries[entries.length - 1]!;
      return created.get(main.key) ? { granted: credits } : { granted: 0, duplicate: true };
    });
  }

  /** After a plan change: this month's plan credits go up to the new plan's allowance (never down). */
  async topUpPlan(slug: string, ref: string, o: At = {}): Promise<number> {
    const g = await this.graph(slug, o);
    const plan = this.planOf(await this.subscription(slug));
    const granted = await this.locked(g.name, async () => {
      const { rows } = await this.month(g, slug, plan);
      return rows.filter((r) => r.service === "plan").reduce((s, r) => s + whole(r.credits), 0);
    });
    const add = plan.allowance - Math.max(0, granted);
    if (add <= 0) return 0;
    return (await this.grant(slug, add, "plan", ref, { g })).granted;
  }
}

// ---------- the process's own instance, and the functions the rest of the code calls ----------

let shared: Credits | undefined;
/** The credits of this process (the business's graph from graph/client.ts, subscriptions in the registry). */
export const credits = (): Credits => (shared ??= new Credits());
/** Tests and the server replace it (the server passes its own openGraph). */
export const setCredits = (c: Credits | undefined): void => { shared = c; };

export const balance = (slug: string): Promise<BalanceDto> => credits().balance(slug);
export const canSpend = (slug: string, service: CreditService): Promise<boolean> => credits().canSpend(slug, service);
export const spend = (slug: string, service: CreditService, o: SpendOpts): Promise<SpendResult> => credits().spend(slug, service, o);
/** Adds credits to a business (the login work calls grant(slug, TRIAL.credits, "trial", userId) at sign-up). */
export const grant = (slug: string, n: number, reason: string, ref: string): Promise<{ granted: number; duplicate?: boolean }> => credits().grant(slug, n, reason, ref);
