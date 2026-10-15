// The daily pull. `pullDue` visits every business that has Search Console connected and reads the ones whose last read is
// more than `minHours` old (one bad business never stops the others); `startSchedule` calls it on a timer inside the server.
// Cron or a scheduled task can call the same thing with `npm run cli -- connect pull --all`.
import type { GraphHandle } from "../../graph/client.js";
import { CONNECTOR, pullSearchConsole, readSystem, type GoogleDeps, type PullResult } from "./searchconsole.js";

export interface ScheduleDeps {
  google: GoogleDeps;
  tenants: () => Promise<Array<{ slug: string; businessId?: string }>>;
  openGraph: (slug: string) => Promise<GraphHandle>;
  log?: (line: string) => void;
  minHours?: number;       // default 20: a pull a day, with room for the clock to drift
}

export type DueOutcome = { tenant: string; result: PullResult } | { tenant: string; skipped: string };

export async function pullDue(d: ScheduleDeps): Promise<DueOutcome[]> {
  const log = d.log ?? ((l: string) => console.error(l));
  const min = (d.minHours ?? 20) * 3_600_000;
  const out: DueOutcome[] = [];
  if (!d.google.settings.configured) return out;
  for (const t of await d.tenants()) {
    try {
      const tokens = await d.google.store.get(t.slug, CONNECTOR).catch(() => null);
      if (!tokens) continue; // never connected: nothing to say
      const g = await d.openGraph(t.slug);
      const sys = await readSystem(g);
      if (sys?.status !== "ok" || !sys.property) { out.push({ tenant: t.slug, skipped: sys?.status === "expired" ? "needs the owner to connect again" : "no website chosen" }); continue; }
      if (sys.lastPullAt && d.google.now() - sys.lastPullAt < min) { out.push({ tenant: t.slug, skipped: "read recently" }); continue; }
      const result = await pullSearchConsole(d.google, g, t.slug, t.businessId ? { businessId: t.businessId } : {});
      if (result.status !== "ok") log(`[search-console] ${t.slug}: ${result.status}: ${result.message}`);
      out.push({ tenant: t.slug, result });
    } catch (e) {
      log(`[search-console] ${t.slug}: ${e instanceof Error ? e.message : String(e)}`);
      out.push({ tenant: t.slug, result: { status: "error", message: "Something went wrong reading Search Console. We will try again." } });
    }
  }
  return out;
}

// Starts the timer (unref'd, so it never keeps the process alive) and returns stop(). The first look is shortly after start.
export function startSchedule(d: ScheduleDeps, o: { everyMs?: number; firstDelayMs?: number } = {}): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    pullDue(d).catch((e) => (d.log ?? console.error)(`[search-console] schedule: ${e instanceof Error ? e.message : String(e)}`)).finally(() => { running = false; });
  };
  const first = setTimeout(tick, o.firstDelayMs ?? 60_000);
  const every = setInterval(tick, o.everyMs ?? 3_600_000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
