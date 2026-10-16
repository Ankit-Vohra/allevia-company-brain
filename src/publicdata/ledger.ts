// What public-data lookups have cost, and the two budgets they must stay inside (docs/apify-setup.md):
//   - each business, per calendar month (UTC): ALLEVIA_APIFY_MONTHLY_USD (default $2);
//   - every business together, per day (UTC): ALLEVIA_APIFY_DAILY_USD (default $3).
// A run is estimated first and reserved at that estimate, inside a lock, so two processes (the web server and a Discord
// bot) cannot both spend the last cents. A run that fails before it is charged is released; a run that reports a higher
// cost than the estimate is recorded at the higher figure.
// The ledger is <dataDir>/apify/spend-ledger.json, outside the repo. It holds a business's slug, the actor, dollars and
// times: no business data and never the token.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_MONTHLY_USD = 2;
export const DEFAULT_DAILY_USD = 3;

export interface SpendCaps { monthlyPerBusiness: number; dailyAll: number }

export interface SpendEntry {
  id: string;            // the reservation id (one per run)
  tenant: string;
  actor: string;
  usd: number;           // estimate while reserved; the higher of estimate and actual once settled
  status: "reserved" | "done" | "released";
  at: number;
  day: string;           // YYYY-MM-DD, UTC
  month: string;         // YYYY-MM, UTC
}

interface LedgerFile { version: 1; entries: SpendEntry[] }

export const spendLedgerPath = (dataDir: string): string => join(dataDir, "apify", "spend-ledger.json");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const counts = (e: SpendEntry): boolean => e.status !== "released";
const sum = (xs: SpendEntry[]): number => Math.round(xs.reduce((s, e) => s + e.usd, 0) * 1000) / 1000;

export class OverBudget extends Error {
  override name = "OverBudget";
  constructor(readonly scope: "month" | "day", readonly spent: number, readonly cap: number, readonly estimate: number) {
    super(`${scope} budget: ${spent} of ${cap} spent, ${estimate} more needed`);
  }
}

export class SpendLedger {
  readonly file: string;
  private readonly lock: string;
  constructor(dataDir: string, private readonly o: { now?: () => number; lockWaitMs?: number } = {}) {
    this.file = spendLedgerPath(dataDir);
    this.lock = `${this.file}.lock`;
  }

  now(): number { return this.o.now?.() ?? Date.now(); }

  private read(): LedgerFile {
    if (!existsSync(this.file)) return { version: 1, entries: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LedgerFile>;
      return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries.filter((e): e is SpendEntry => !!e && typeof e.id === "string" && typeof e.usd === "number") : [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private write(f: LedgerFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  // One writer at a time across processes: an exclusive lock file (stale after 30 s, so a crash cannot jam it).
  private async locked<T>(fn: () => T): Promise<T> {
    mkdirSync(dirname(this.file), { recursive: true });
    const until = Date.now() + (this.o.lockWaitMs ?? 5_000);
    for (;;) {
      try {
        closeSync(openSync(this.lock, "wx"));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try { if (Date.now() - statSync(this.lock).mtimeMs > 30_000) rmSync(this.lock, { force: true }); } catch { /* raced: fine */ }
        if (Date.now() > until) throw new Error("The public-data spend ledger is busy. Try again in a moment.");
        await sleep(15);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(this.lock, { force: true });
    }
  }

  /** Dollars this business has spent (or reserved) this month, and all businesses today. */
  spent(tenant: string, at: number = this.now()): { month: number; today: number } {
    const f = this.read().entries.filter(counts);
    const month = dayOf(at).slice(0, 7);
    const day = dayOf(at);
    return { month: sum(f.filter((e) => e.tenant === tenant && e.month === month)), today: sum(f.filter((e) => e.day === day)) };
  }

  entries(): SpendEntry[] { return this.read().entries; }

  /** Reserve a run's estimate, or throw OverBudget naming the budget it would break (the month's first). */
  async reserve(e: { id: string; tenant: string; actor: string; usd: number }, caps: SpendCaps): Promise<SpendEntry> {
    return this.locked(() => {
      const f = this.read();
      const at = this.now();
      const day = dayOf(at);
      const month = day.slice(0, 7);
      const live = f.entries.filter(counts);
      const monthSpent = sum(live.filter((x) => x.tenant === e.tenant && x.month === month));
      if (monthSpent + e.usd > caps.monthlyPerBusiness + 1e-9) throw new OverBudget("month", monthSpent, caps.monthlyPerBusiness, e.usd);
      const daySpent = sum(live.filter((x) => x.day === day));
      if (daySpent + e.usd > caps.dailyAll + 1e-9) throw new OverBudget("day", daySpent, caps.dailyAll, e.usd);
      const entry: SpendEntry = { ...e, status: "reserved", at, day, month };
      f.entries.push(entry);
      this.write(f);
      return entry;
    });
  }

  /** The run finished: keep the higher of the estimate and what it reported. */
  async settle(id: string, actualUsd?: number): Promise<void> {
    await this.locked(() => {
      const f = this.read();
      const e = f.entries.find((x) => x.id === id);
      if (!e || e.status !== "reserved") return;
      e.status = "done";
      if (actualUsd !== undefined && Number.isFinite(actualUsd) && actualUsd > e.usd) e.usd = Math.round(actualUsd * 1000) / 1000;
      this.write(f);
    });
  }

  /** The run never started or was refused before any charge: it no longer counts. */
  async release(id: string): Promise<void> {
    await this.locked(() => {
      const f = this.read();
      const e = f.entries.find((x) => x.id === id);
      if (!e || e.status !== "reserved") return;
      e.status = "released";
      this.write(f);
    });
  }
}

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** The budgets from config values (strings from the env file), with the defaults. */
export function spendCaps(o: { monthly?: string; daily?: string } = {}): SpendCaps {
  return { monthlyPerBusiness: positive(o.monthly, DEFAULT_MONTHLY_USD), dailyAll: positive(o.daily, DEFAULT_DAILY_USD) };
}
