// Real free times for the owner's calendar, for the stand-up (the agents use calendar_free_slots; this is the same arithmetic for
// a job that has no turn): three times on different days, inside working hours, never in the next hour, from what the connected
// calendar says is busy. Nothing is invented: with no calendar connected the answer is "none" and the draft asks when suits them.
import { freeSlots, isoIn, zonedToUtc } from "../agent/tools/connections.js";
import type { ConnectionsPort } from "../connections/service.js";
import type { GoogleSession } from "../connections/google/product.js";

export interface OfferedTime { start: string; end: string; label: string }

const day = (ms: number, tz: string): string => isoIn(ms, tz).slice(0, 10);
// "Friday 16 October, 11:00 to 11:30 GMT+5:30": the zone is always named, so a customer in another country is never guessing
const label = (ms: number, tz: string, minutes: number): string => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const e = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(new Date(ms + minutes * 60_000)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} to ${e.hour}:${e.minute} ${e.timeZoneName}`;
};

/** The first free time of each of the next days with one, up to `count`, spread between morning and afternoon. [] when the calendar can't be read. */
export async function proposeTimes(port: ConnectionsPort | undefined, now: number, o: { tz?: string; minutes?: number; count?: number; days?: number } = {}): Promise<OfferedTime[]> {
  if (!port) return [];
  const tz = o.tz ?? "UTC", minutes = o.minutes ?? 30, count = o.count ?? 3, days = o.days ?? 7;
  const fromDate = day(now, tz);
  const timeMin = zonedToUtc(fromDate, "00:00", tz), timeMax = timeMin + days * 86_400_000;
  let busy: Array<{ start: number; end: number }>;
  try {
    const blocks = await port.run<GoogleSession, Array<{ start: string; end: string }>>("google-calendar", "find free times", (s) => s.apis.freeBusy(s.accessToken, { timeMin: new Date(timeMin).toISOString(), timeMax: new Date(timeMax).toISOString(), timeZone: tz }), { actor: "sales-lead" });
    busy = blocks.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
  } catch {
    return [];
  }
  const all = freeSlots({ fromDate, days, minutes, workStart: "09:00", workEnd: "18:00", tz, busy, notBefore: now + 3_600_000, weekends: false, max: 400 });
  const out: OfferedTime[] = [];
  const seen = new Set<string>();
  for (const s of all) {
    const d = day(s.start, tz);
    if (seen.has(d)) continue;
    // alternate: the first offer is the earliest, the next prefers the afternoon, then the morning again
    const afternoon = Number(isoIn(s.start, tz).slice(11, 13)) >= 13;
    if (out.length % 2 === 1 && !afternoon && all.some((x) => day(x.start, tz) === d && Number(isoIn(x.start, tz).slice(11, 13)) >= 13)) continue;
    seen.add(d);
    out.push({ start: isoIn(s.start, tz), end: isoIn(s.end, tz), label: label(s.start, tz, minutes) });
    if (out.length >= count) break;
  }
  return out;
}

/** [start, end) of the business's tomorrow, in its own time zone. */
export function tomorrowWindow(now: number, tz: string): { from: number; to: number } {
  const today = day(now, tz);
  const next = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const after = new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  return { from: zonedToUtc(next, "00:00", tz), to: zonedToUtc(after, "00:00", tz) };
}
