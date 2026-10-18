// Meeting capture on a clock, inside the server: every 15 minutes (ALLEVIA_MEETINGS_EVERY_MIN) it looks at each business that has
// a meeting recorder connected (Fireflies or Granola, in its sealed connections) and runs one capture (capture.ts) for it. One
// business at a time, so the subscription is not flooded; a business that fails never stops the others; a meeting already saved is
// skipped before anything is fetched. A demo business's sample recorder is not polled (it has no real calls): its sample meeting
// arrives when someone runs `npm run cli -- meetings ingest <tenant>` or presses "Check for new meetings".
// ALLEVIA_MEETINGS=off switches it off.
import type { GraphHandle } from "../graph/client.js";
import type { CaptureReport } from "./capture.js";
import { RECORDERS } from "./recorders.js";

export interface MeetingScheduleDeps {
  tenants: () => Promise<Array<{ slug: string }>>;
  /** The connection ids a business has stored (cheap: no call to any recorder). */
  connected: (slug: string) => Promise<string[]>;
  isSample: (slug: string) => boolean;
  openGraph: (slug: string) => Promise<GraphHandle>;
  run: (slug: string, g: GraphHandle) => Promise<CaptureReport>;
  log?: (line: string) => void;
}

export const meetingScheduleOn = (env: NodeJS.ProcessEnv = process.env): boolean => !/^(off|0|false|no)$/i.test(env.ALLEVIA_MEETINGS ?? "");

export function meetingEveryMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ALLEVIA_MEETINGS_EVERY_MIN);
  return (env.ALLEVIA_MEETINGS_EVERY_MIN?.trim() && Number.isFinite(n) && n >= 5 ? n : 15) * 60_000;
}

const RECORDER_IDS = new Set(RECORDERS.map((r) => r.connectionId));

/** One pass over every business: the slugs whose recorders were read. */
export async function captureDue(d: MeetingScheduleDeps): Promise<string[]> {
  const ran: string[] = [];
  for (const t of await d.tenants()) {
    try {
      if (d.isSample(t.slug)) continue;
      if (!(await d.connected(t.slug)).some((id) => RECORDER_IDS.has(id))) continue;
      const r = await d.run(t.slug, await d.openGraph(t.slug));
      ran.push(t.slug);
      if (r.saved.length) d.log?.(`[meetings] ${t.slug}: ${r.saved.length} new meeting${r.saved.length === 1 ? "" : "s"} saved`);
    } catch (e) {
      d.log?.(`[meetings] ${t.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return ran;
}

export function startMeetingSchedule(d: MeetingScheduleDeps, o: { everyMs?: number; firstDelayMs?: number } = {}): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    captureDue(d).catch((e) => d.log?.(`[meetings] ${e instanceof Error ? e.message : String(e)}`)).finally(() => { running = false; });
  };
  const first = setTimeout(tick, o.firstDelayMs ?? 120_000);
  const every = setInterval(tick, o.everyMs ?? meetingEveryMs());
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
