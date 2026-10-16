// Public data for one business, through Apify: the one door every lookup goes through. It checks the actor is on the
// allow-list, caps the results, estimates the cost, reserves it against the business's monthly budget and the daily
// budget for everyone (refusing in plain words when either would be passed), runs the actor with a time limit, and
// records what it cost. With no APIFY_TOKEN it is off: every lookup answers "Public data lookups aren't switched on"
// and nothing else changes.
import { randomBytes } from "node:crypto";
import { loadConfig, type AlleviaConfig } from "../config.js";
import { isTenantSlug } from "../graph/slug.js";
import { ACTORS, capItems, estimateUsd, isAllowedActor, usdWords, type ActorId } from "./actors.js";
import { ApifyError, RestApifyClient, type ApifyClient } from "./apify.js";
import { OverBudget, SpendLedger, spendCaps, type SpendCaps } from "./ledger.js";
import { graphSpend, type SpendRecord } from "./spend.js";
import { openGraph, type GraphHandle } from "../graph/client.js";

export const OFF_WORDS = "Public data lookups aren't switched on.";

export type PublicRunRefusal = "off" | "not_allowed" | "month" | "day" | "error";

export type PublicRun =
  | { ok: true; actor: ActorId; items: unknown[]; usd: number; asOf: string }
  | { ok: false; reason: PublicRunRefusal; why: string; usd?: number };

export interface PublicRunRequest {
  tenant: string;
  actor: string;
  input: Record<string, unknown>;
  maxItems: number;      // dataset results to read at most (capped by the actor's own cap)
  units?: number;        // what the cost is estimated on (default maxItems): a listing with 10 reviews is 11
  signal?: AbortSignal;
}

// What tools and onboarding see: on/off, a quote, a run, and what is left.
export interface PublicDataPort {
  readonly enabled: boolean;
  quote(actor: ActorId, units: number): number;
  run(req: PublicRunRequest): Promise<PublicRun>;
  budget(tenant: string): { spentThisMonth: number; monthly: number; spentToday: number; daily: number };
}

const nextMonthWords = (now: number): string => {
  const d = new Date(now);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return first.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};

export interface PublicDataOptions {
  client: ApifyClient | null;
  ledger: SpendLedger;
  caps: SpendCaps;
  log?: (line: string) => void;
  // The business's own graph (spend.ts): every spend is recorded there as an Observation with a spend Document as its source, and
  // the month's spend is read back from it before a lookup is allowed. Best effort both ways: a graph that cannot be reached
  // never stops a lookup (the file ledger still holds the budgets) or loses a spend (the file has it).
  onSpend?: (r: SpendRecord) => Promise<void>;
  monthSpent?: (tenant: string, at: number) => Promise<number>;
}

export class PublicData implements PublicDataPort {
  readonly enabled: boolean;
  constructor(private readonly o: PublicDataOptions) {
    this.enabled = !!o.client;
  }

  private async record(r: SpendRecord): Promise<void> {
    try {
      await this.o.onSpend?.(r);
    } catch (e) {
      this.o.log?.(`[publicdata] ${r.tenant}: the spend was not written to the graph (${e instanceof Error ? e.message : String(e)}); the budget file has it`);
    }
  }

  quote(actor: ActorId, units: number): number { return estimateUsd(actor, units); }

  budget(tenant: string): { spentThisMonth: number; monthly: number; spentToday: number; daily: number } {
    const s = this.o.ledger.spent(tenant);
    return { spentThisMonth: s.month, monthly: this.o.caps.monthlyPerBusiness, spentToday: s.today, daily: this.o.caps.dailyAll };
  }

  async run(req: PublicRunRequest): Promise<PublicRun> {
    const log = this.o.log ?? (() => {});
    if (!this.o.client) return { ok: false, reason: "off", why: OFF_WORDS };
    if (!isAllowedActor(req.actor)) return { ok: false, reason: "not_allowed", why: "That public-data source is not one Allevia uses." };
    if (!isTenantSlug(req.tenant)) return { ok: false, reason: "error", why: "That business could not be identified." };
    const actor = req.actor;
    const spec = ACTORS[actor];
    const maxItems = capItems(actor, req.maxItems);
    const usd = estimateUsd(actor, req.units ?? maxItems);
    const id = `apify_${randomBytes(6).toString("hex")}`;
    let graphMonth: number | undefined;
    try {
      graphMonth = await this.o.monthSpent?.(req.tenant, this.o.ledger.now());
    } catch (e) {
      log(`[publicdata] ${req.tenant}: this month's spend could not be read from the graph (${e instanceof Error ? e.message : String(e)}); using the budget file`);
    }
    try {
      await this.o.ledger.reserve({ id, tenant: req.tenant, actor, usd }, this.o.caps, graphMonth !== undefined ? { monthSpent: graphMonth } : {});
    } catch (e) {
      if (e instanceof OverBudget) {
        const left = Math.max(0, Math.round((e.cap - e.spent) * 1000) / 1000);
        const why = e.scope === "month"
          ? `This lookup would cost about ${usdWords(usd)}, and this month's budget for public lookups (${usdWords(e.cap)}) has ${usdWords(left)} left. It starts again on ${nextMonthWords(this.o.ledger.now())}.`
          : `Today's limit for public lookups (${usdWords(e.cap)} across all businesses) is used up. Try again tomorrow.`;
        return { ok: false, reason: e.scope, why, usd };
      }
      return { ok: false, reason: "error", why: "The public-data budget could not be checked, so nothing was looked up. Try again in a moment." };
    }
    try {
      const r = await this.o.client.run({ actor, input: req.input, maxItems, maxUsd: usd, timeoutMs: spec.timeoutMs, ...(req.signal ? { signal: req.signal } : {}) });
      await this.o.ledger.settle(id, r.usd);
      log(`[publicdata] ${req.tenant} ${actor}: ${r.items.length} result(s), estimate $${usd}${r.usd !== undefined ? `, reported $${r.usd.toFixed(4)}` : ""}`);
      const counted = Math.max(usd, r.usd ?? 0);
      await this.record({ tenant: req.tenant, id, actor, usd: counted, at: this.o.ledger.now(), ok: true });
      return { ok: true, actor, items: r.items.slice(0, maxItems), usd: counted, asOf: new Date(this.o.ledger.now()).toISOString() };
    } catch (e) {
      const started = e instanceof ApifyError && e.started;
      if (started) {
        await this.o.ledger.settle(id);
        await this.record({ tenant: req.tenant, id, actor, usd, at: this.o.ledger.now(), ok: false }); // it started, so it is charged at its estimate
      } else await this.o.ledger.release(id);
      const kind = e instanceof ApifyError ? e.kind : "http";
      log(`[publicdata] ${req.tenant} ${actor} failed: ${kind}${e instanceof Error ? ` (${e.message})` : ""}`);
      const why = kind === "auth" ? "The public-data account refused our key, so nothing was looked up. The founder needs to check APIFY_TOKEN."
        : kind === "no_credit" ? "The public-data account is out of credit, so nothing was looked up."
        : kind === "timeout" ? `The lookup took too long and was stopped after ${Math.round(spec.timeoutMs / 1000)} seconds.`
        : kind === "stopped" ? "The lookup was stopped."
        : "The public-data lookup didn't finish, so there is nothing new to show.";
      return { ok: false, reason: "error", why };
    }
  }
}

/** The server's public-data door from config: off (no client) when APIFY_TOKEN is not set. The token stays in here. */
export function productionPublicData(cfg: AlleviaConfig = loadConfig(), o: { log?: (line: string) => void } = {}): PublicData {
  const caps = spendCaps({ ...(cfg.apify.monthlyUsd ? { monthly: cfg.apify.monthlyUsd } : {}), ...(cfg.apify.dailyUsd ? { daily: cfg.apify.dailyUsd } : {}) });
  const open = (tenant: string): Promise<GraphHandle> => openGraph(tenant);
  return new PublicData({ client: cfg.apify.token ? new RestApifyClient(cfg.apify.token) : null, ledger: new SpendLedger(cfg.dataDir), caps, ...graphSpend(open), ...(o.log ? { log: o.log } : {}) });
}
