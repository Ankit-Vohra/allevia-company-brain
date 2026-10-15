// Studio credits: what a generative edit may cost and what has been spent (founder's brief, 2026-10-15).
// - Two caps, from the environment: ALLEVIA_STUDIO_RUN_CREDIT_CAP (one generation, default 5) and
//   ALLEVIA_STUDIO_DAILY_CREDIT_CAP (everything the Studio spends on any business in a day, default 25).
// - The ledger is a small JSON file in the data dir (<dataDir>/studio/credit-ledger.json), outside the repo, written
//   atomically under a lock file so the web server and the Discord bot (two processes) share one count.
// - A job is reserved in the ledger the moment it exists (its job id), before the wait, so a timed-out job stays counted
//   and is joined again instead of being created twice. Reserving the same job id again changes nothing (idempotent).
//   A job that failed is marked failed and no longer counts: it was never charged.
// - creditsWords says a number of credits the way the owner reads it ("1 Studio credit", "about 2 Studio credits").
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localDate } from "../agent/prompts.js";

export const DEFAULT_RUN_CAP = 5;
export const DEFAULT_DAILY_CAP = 25;

export interface CreditCaps { run: number; daily: number }

const positive = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && v.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
};

export function creditCaps(env: NodeJS.ProcessEnv = process.env): CreditCaps {
  return { run: positive(env.ALLEVIA_STUDIO_RUN_CREDIT_CAP, DEFAULT_RUN_CAP), daily: positive(env.ALLEVIA_STUDIO_DAILY_CREDIT_CAP, DEFAULT_DAILY_CAP) };
}

/** "1 Studio credit", "2 Studio credits", "about 2.5 Studio credits". */
export function creditsWords(n: number, o: { about?: boolean } = {}): string {
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, "");
  return `${o.about ? "about " : ""}${shown} Studio credit${n === 1 ? "" : "s"}`;
}

export interface LedgerEntry {
  jobId: string;
  key: string;                       // what the job is for (photo + prompt + model): the same key joins the same job
  tenant: string;
  model: string;
  credits: number;
  status: "reserved" | "done" | "failed";
  at: number;
  day: string;
}

interface LedgerFile { version: 1; entries: LedgerEntry[] }

export const ledgerPath = (dataDir: string): string => join(dataDir, "studio", "credit-ledger.json");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class CreditLedger {
  readonly file: string;
  private lock: string;
  constructor(dataDir: string, private o: { now?: () => number; timeZone?: string; lockWaitMs?: number } = {}) {
    this.file = ledgerPath(dataDir);
    this.lock = `${this.file}.lock`;
  }

  private now(): number { return this.o.now?.() ?? Date.now(); }
  dayOf(ms: number = this.now()): string { return localDate(ms, this.o.timeZone); }

  private read(): LedgerFile {
    if (!existsSync(this.file)) return { version: 1, entries: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LedgerFile>;
      return { version: 1, entries: Array.isArray(raw.entries) ? raw.entries.filter((e): e is LedgerEntry => !!e && typeof e.jobId === "string" && typeof e.credits === "number") : [] };
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
        if (Date.now() > until) throw new Error("The Studio's credit ledger is busy. Try again in a moment.");
        await sleep(15);
      }
    }
    try {
      return fn();
    } finally {
      rmSync(this.lock, { force: true });
    }
  }

  /** Credits spent (reserved or done) on a day: failed jobs never count. */
  spentOn(day: string = this.dayOf()): number {
    return this.read().entries.filter((e) => e.day === day && e.status !== "failed").reduce((s, e) => s + e.credits, 0);
  }

  entries(): LedgerEntry[] { return this.read().entries; }

  /** The job already made for this key that still counts (reserved or done), so it is joined, not created again. */
  existing(key: string): LedgerEntry | undefined {
    return this.read().entries.find((e) => e.key === key && e.status !== "failed");
  }

  /** What is left of today's cap. */
  remainingToday(cap: number): number { return Math.max(0, cap - this.spentOn()); }

  /**
   * Reserve a job. Idempotent by job id: the same id again returns the entry it already has and spends nothing more.
   * `cap`, when given, is the daily cap checked inside the lock, so two processes cannot both spend the last credits.
   */
  async reserve(e: Omit<LedgerEntry, "status" | "at" | "day">, dailyCap?: number): Promise<{ entry: LedgerEntry; created: boolean }> {
    return this.locked(() => {
      const f = this.read();
      const same = f.entries.find((x) => x.jobId === e.jobId);
      if (same) return { entry: same, created: false };
      const at = this.now();
      const day = this.dayOf(at);
      if (dailyCap !== undefined) {
        const spent = f.entries.filter((x) => x.day === day && x.status !== "failed").reduce((s, x) => s + x.credits, 0);
        if (spent + e.credits > dailyCap) throw new DailyCapReached(spent, dailyCap);
      }
      const entry: LedgerEntry = { ...e, status: "reserved", at, day };
      f.entries.push(entry);
      this.write(f);
      return { entry, created: true };
    });
  }

  async mark(jobId: string, status: "done" | "failed"): Promise<void> {
    await this.locked(() => {
      const f = this.read();
      const e = f.entries.find((x) => x.jobId === jobId);
      if (!e || e.status === status) return;
      if (e.status === "done" && status === "failed") return; // a finished job is never un-spent
      e.status = status;
      this.write(f);
    });
  }
}

export class DailyCapReached extends Error {
  constructor(public spent: number, public cap: number) {
    super(`The Studio's daily budget is used up (${spent} of ${cap} credits).`);
  }
}
