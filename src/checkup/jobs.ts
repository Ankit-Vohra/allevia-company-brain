// Check-ups in the background: the web app's "Check my website" button, Discord's /checkup and the weekly schedule all
// start `checkup --tenant <slug>` here and are told when it is done. A crawl plus Lighthouse takes a few minutes and a
// browser, so each run is its own child process (a browser crash never takes the server or the bot down), one run at a
// time on this process (the rest wait their turn), at most one per business, and a run that goes past MAX_RUN_MS is
// stopped. Whoever asked while a business's run was already going is told when that run ends.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isTenantSlug } from "../graph/slug.js";

export const MAX_RUN_MS = 15 * 60_000;

export type CheckupTrigger = "owner" | "schedule";
export interface CheckupOutcome { ok: boolean; error?: string }
export interface CheckupJob {
  tenant: string;
  trigger: CheckupTrigger;
  status: "waiting" | "running" | "done" | "failed";
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;              // in plain words
}

// Runs one check-up for a business to the end (stores it in the business's graph). Production spawns the CLI.
export type CheckupRunner = (tenant: string) => Promise<void>;

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// `checkup --tenant <slug> --quiet` in a child process. The child is started the way this process was (tsx's loader is in
// execArgv, both in development and in the container), so it runs the same TypeScript source.
export const spawnCheckup: CheckupRunner = (tenant) => new Promise<void>((resolve, reject) => {
  if (!isTenantSlug(tenant)) return reject(new Error("bad tenant"));
  const child = spawn(process.execPath, [...process.execArgv, CLI, "checkup", "--tenant", tenant, "--quiet"], {
    cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], env: process.env,
  });
  let tail = "";
  child.stderr.on("data", (d: Buffer) => { tail = (tail + d.toString("utf8")).slice(-2000); });
  const timer = setTimeout(() => child.kill("SIGTERM"), MAX_RUN_MS);
  timer.unref();
  child.once("error", (e) => { clearTimeout(timer); reject(e); });
  child.once("exit", (code, signal) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(signal ? `stopped (${signal})` : `exit ${code}: ${tail.trim().split("\n").at(-1) ?? ""}`));
  });
});

const PLAIN_FAILURE = "The check-up couldn't finish this time. We'll try again; nothing on your site was changed.";

export class CheckupJobs {
  private jobs = new Map<string, CheckupJob>();
  private waiters = new Map<string, Array<(o: CheckupOutcome) => void>>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private o: { run?: CheckupRunner; now?: () => number; log?: (line: string) => void } = {}) {}

  private now(): number { return (this.o.now ?? Date.now)(); }
  private log(line: string): void { (this.o.log ?? ((l: string) => console.error(l)))(`[checkup] ${line}`); }

  state(tenant: string): CheckupJob | undefined {
    return this.jobs.get(tenant);
  }

  busy(tenant: string): boolean {
    const j = this.jobs.get(tenant);
    return !!j && (j.status === "waiting" || j.status === "running");
  }

  // Starts a check-up for the business unless one is already waiting or running; either way `onDone` hears how it ended.
  start(tenant: string, trigger: CheckupTrigger, onDone?: (o: CheckupOutcome) => void): { started: boolean; job: CheckupJob } {
    if (onDone) this.waiters.set(tenant, [...(this.waiters.get(tenant) ?? []), onDone]);
    if (this.busy(tenant)) return { started: false, job: this.jobs.get(tenant)! };
    const job: CheckupJob = { tenant, trigger, status: "waiting", queuedAt: this.now() };
    this.jobs.set(tenant, job);
    const run = async () => {
      job.status = "running";
      job.startedAt = this.now();
      this.log(`${tenant}: started (${trigger})`);
      let outcome: CheckupOutcome;
      try {
        await (this.o.run ?? spawnCheckup)(tenant);
        job.status = "done";
        outcome = { ok: true };
      } catch (e) {
        job.status = "failed";
        job.error = PLAIN_FAILURE;
        outcome = { ok: false, error: PLAIN_FAILURE };
        this.log(`${tenant}: failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      job.finishedAt = this.now();
      if (outcome.ok) this.log(`${tenant}: done in ${Math.round((job.finishedAt - job.startedAt!) / 1000)}s`);
      const ws = this.waiters.get(tenant) ?? [];
      this.waiters.delete(tenant);
      for (const w of ws) {
        try {
          w(outcome);
        } catch (e) {
          this.log(`${tenant}: telling the owner failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    this.queue = this.queue.then(run, run);
    return { started: true, job };
  }

  // Resolves when everything started so far has finished (tests, shutdown).
  idle(): Promise<void> {
    return this.queue;
  }
}

let shared: CheckupJobs | undefined;
// One queue per process: the web button and the weekly schedule (server), or /checkup (the bot).
export const checkupJobs = (): CheckupJobs => (shared ??= new CheckupJobs());
