// "Tuesday 7 pm" as an instant, in the business's own time zone, and an instant as words an owner reads. A post is scheduled for
// a wall-clock time where the business is (7 pm in Dubai is not 7 pm in Mumbai), so the zone always comes with it.
import { isoIn, validZone, zonedToUtc } from "../util/zones.js";

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A post may not be set for less than two minutes ahead (that is "now"), or more than 90 days ahead. */
export const MIN_LEAD_MS = 2 * 60_000;
export const MAX_AHEAD_MS = 90 * 86_400_000;

export interface WhenInput {
  /** An exact instant with its offset ("2026-10-20T19:00:00+04:00"). */
  at?: string;
  /** A calendar date in the business's zone, with `time`. */
  date?: string;
  /** The next such weekday in the business's zone, with `time`. */
  weekday?: Weekday;
  /** "19:00", "7pm", "7:30 pm". */
  time?: string;
}

/** "19:00", "7pm", "7:30 pm", "7 PM" as "HH:MM"; null for anything else. */
export function parseClock(s: string | undefined): string | null {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i.exec(s ?? "");
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? "0");
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayOfWeek = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay();

export type Resolved = { ok: true; at: number } | { ok: false; error: string };

/** The instant the owner meant, or why it can't be: always in plain words. */
export function resolveWhen(w: WhenInput, tz: string, now: number): Resolved {
  if (!validZone(tz)) return { ok: false, error: "I don't know this business's time zone, so I can't set a time. Ask the owner to set it first." };
  let at: number;
  if (w.at) {
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(w.at.trim())) return { ok: false, error: "A time needs its zone, like 2026-10-20T19:00:00+04:00. Or give a date or weekday with a time like 7pm." };
    at = Date.parse(w.at);
    if (!Number.isFinite(at)) return { ok: false, error: "I couldn't read that time." };
  } else {
    const clock = parseClock(w.time);
    if (!clock) return { ok: false, error: "What time? Something like 7pm or 19:00." };
    if (w.date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date) || Number.isNaN(Date.parse(`${w.date}T12:00:00Z`))) return { ok: false, error: "I couldn't read that date. Use a day like 2026-10-20." };
      at = zonedToUtc(w.date, clock, tz);
    } else if (w.weekday) {
      const want = WEEKDAYS.indexOf(w.weekday);
      if (want < 0) return { ok: false, error: "I didn't recognise that day of the week." };
      const today = isoIn(now, tz).slice(0, 10);
      let found: number | undefined;
      for (let d = 0; d <= 7 && found === undefined; d++) {
        const date = addDays(today, d);
        if (dayOfWeek(date) !== want) continue;
        const t = zonedToUtc(date, clock, tz);
        if (t >= now + MIN_LEAD_MS) found = t;
      }
      if (found === undefined) return { ok: false, error: "I couldn't find that day." };
      at = found;
    } else {
      return { ok: false, error: "Say when: a weekday and a time (Tuesday 7pm), or a date and a time." };
    }
  }
  if (at < now + MIN_LEAD_MS) return { ok: false, error: "That time has already passed (or is too close). Pick a time a little later." };
  if (at > now + MAX_AHEAD_MS) return { ok: false, error: "That is more than 90 days away. Pick a nearer day." };
  return { ok: true, at };
}

/** "Tue 20 Oct, 7:00 pm", or "today at 7:00 pm" / "tomorrow at 7:00 pm" when `now` is given, in the business's zone. */
export function whenWords(at: number, tz: string, now?: number): string {
  const zone = validZone(tz) ? tz : "UTC";
  const parts = (opts: Intl.DateTimeFormatOptions) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const t = parts({ hour: "numeric", minute: "2-digit", hour12: true });
  const clock = `${t.hour}:${t.minute} ${String(t.dayPeriod ?? "").toLowerCase()}`;
  if (now !== undefined) {
    const day = isoIn(at, zone).slice(0, 10);
    const today = isoIn(now, zone).slice(0, 10);
    if (day === today) return `today at ${clock}`;
    if (day === addDays(today, 1)) return `tomorrow at ${clock}`;
  }
  const d = parts({ weekday: "short", day: "numeric", month: "short" });
  return `${d.weekday} ${d.day} ${d.month}, ${clock}`;
}
