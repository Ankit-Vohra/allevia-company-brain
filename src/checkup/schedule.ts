// The weekly website check-up, per business. Every hour (first look a few minutes after start) the server goes through the
// registered businesses and starts a check-up (jobs.ts, one at a time) for each one that:
//   - has it switched on: on by default for a real business, off by default for a demo business; the owner switches it
//     with PUT /api/:t/checkup/schedule, the operator with `checkup --tenant <slug> --weekly on|off` (tenant.ts);
//   - has a website stored at onboarding;
//   - was last checked 7 days ago or more (or never), and has no run going.
// Only the server runs it (never the bots), and never in public mode. ALLEVIA_CHECKUP_SCHEDULE=0 switches it off.
import type { GraphHandle } from "../graph/client.js";
import type { CheckupJobs } from "./jobs.js";
import { storedCheckups } from "./run.js";
import { tenantSite, weeklyOn } from "./tenant.js";

export const WEEK_MS = 7 * 86_400_000;

export interface ScheduleTenant { slug: string; businessId: string; demo?: boolean }
export interface CheckupScheduleDeps {
  tenants: () => Promise<ScheduleTenant[]>;
  openGraph: (slug: string) => Promise<GraphHandle>;
  jobs: CheckupJobs;
  now?: () => number;
  log?: (line: string) => void;
}

// The businesses due a check-up now (and starts them). Returns their slugs.
export async function startDueCheckups(d: CheckupScheduleDeps): Promise<string[]> {
  const now = (d.now ?? Date.now)();
  const started: string[] = [];
  for (const t of await d.tenants()) {
    try {
      if (d.jobs.busy(t.slug)) continue;
      const g = await d.openGraph(t.slug);
      const site = await tenantSite(g, t.slug, t.businessId);
      if (!site?.url || !weeklyOn(site, !!t.demo)) continue;
      const [last] = await storedCheckups(g, 1);
      if (last && now - Date.parse(last.asOf) < WEEK_MS) continue;
      if (d.jobs.start(t.slug, "schedule").started) started.push(t.slug);
    } catch (e) {
      (d.log ?? console.error)(`[checkup] schedule: ${t.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return started;
}

export function startCheckupSchedule(d: CheckupScheduleDeps, o: { everyMs?: number; firstDelayMs?: number } = {}): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    startDueCheckups(d)
      .catch((e) => (d.log ?? console.error)(`[checkup] schedule: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, o.firstDelayMs ?? 5 * 60_000);
  const every = setInterval(tick, o.everyMs ?? 3_600_000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
