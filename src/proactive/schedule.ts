// The stand-up on a clock, inside the server: every 15 minutes it looks at each business, and once the business's own
// morning has come (08:00 in its time zone by default, ALLEVIA_STANDUP_HOUR) and today's stand-up has not run, it runs the
// daily job (stand-up, goals, Today's note). The hub bot then posts the note and its drafts to the business's
// #todays-note. One business at a time, so the subscription is not flooded; one that fails never stops the others.
// ALLEVIA_STANDUP=off switches it off. `npm run cli -- standup <tenant>` runs it now.
import type { GraphHandle } from "../graph/client.js";
import { localDate } from "../onboard/region.js";

export interface ScheduleTenant { slug: string; businessId?: string; timeZone?: string }

export interface StandupScheduleDeps {
  tenants: () => Promise<ScheduleTenant[]>;
  openGraph: (slug: string) => Promise<GraphHandle>;
  run: (t: ScheduleTenant, g: GraphHandle) => Promise<unknown>;
  timeZoneOf?: (t: ScheduleTenant, g: GraphHandle) => Promise<string | undefined>;
  now?: () => number;
  hour?: number;
  log?: (line: string) => void;
}

export function localHour(ms: number, timeZone: string | undefined): number {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "UTC", hour: "2-digit", hourCycle: "h23" }).format(ms);
    return Number(h);
  } catch {
    return new Date(ms).getUTCHours();
  }
}

export function standupHourFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ALLEVIA_STANDUP_HOUR);
  return env.ALLEVIA_STANDUP_HOUR?.trim() && Number.isInteger(n) && n >= 0 && n <= 23 ? n : 8;
}

export const standupScheduleOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(off|0|false|no)$/i.test(env.ALLEVIA_STANDUP ?? "");

/** The businesses whose stand-up is due now; runs each. Returns the slugs it ran. */
export async function standupsDue(d: StandupScheduleDeps): Promise<string[]> {
  const now = (d.now ?? Date.now)();
  const hour = d.hour ?? standupHourFromEnv();
  const ran: string[] = [];
  for (const t of await d.tenants()) {
    try {
      const g = await d.openGraph(t.slug);
      const tz = t.timeZone ?? (await d.timeZoneOf?.(t, g));
      if (localHour(now, tz) < hour) continue;
      const today = localDate(now, tz);
      const [done] = await g.roQuery<{ id: string }>("MATCH (d:Document) WHERE d.kind = 'standup' AND d.localDate = $today RETURN d.id AS id ORDER BY id LIMIT 1", { today });
      if (done) continue;
      await d.run(t, g);
      ran.push(t.slug);
    } catch (e) {
      d.log?.(`[stand-up] ${t.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ran;
}

export function startStandupSchedule(d: StandupScheduleDeps, o: { everyMs?: number; firstDelayMs?: number } = {}): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    standupsDue(d).then((ran) => { for (const s of ran) d.log?.(`[stand-up] ${s}: today's stand-up ran`); }, (e) => d.log?.(`[stand-up] ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = false; });
  };
  const first = setTimeout(tick, o.firstDelayMs ?? 90_000);
  const every = setInterval(tick, o.everyMs ?? 15 * 60_000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
