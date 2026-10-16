// Time zones without a library: a wall-clock time in a named zone as an instant, and an instant as an ISO time with the zone's
// offset. Shared by the calendar tools (free times, bookings) and by scheduled posts (src/publish/when.ts).

function offsetMs(at: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time (YYYY-MM-DD, HH:MM) is in `tz`. */
export function zonedToUtc(date: string, hhmm: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y!, mo! - 1, d!, h!, m!);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO date-time with the zone's offset ("2026-10-16T10:00:00+05:30"). */
export function isoIn(at: number, tz: string): string {
  const off = offsetMs(at, tz);
  const local = new Date(at + off);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off) / 60_000;
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** True when `tz` is a time zone name this runtime knows. */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
