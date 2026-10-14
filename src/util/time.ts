// Time helpers. The graph stores instants as epoch ms (createdAt, since, until…) and source dates as ISO strings
// (asOf). The founder reads times in IST.
const IST = "Asia/Kolkata";

export const nowMs = (): number => Date.now();

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

// UTC calendar date, "YYYY-MM-DD".
export function isoDate(ms: number): string {
  return toIso(ms).slice(0, 10);
}

// IST calendar date, "YYYY-MM-DD" (what the founder would call "today").
export function istDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

// Epoch ms from an ISO string (date or datetime) or a number.
export function parseTime(t: string | number): number {
  const ms = typeof t === "number" ? t : Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`not a time: ${JSON.stringify(t)}`);
  return ms;
}

// "15 Oct 2026, 01:30 IST"
export function formatIst(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: IST, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(ms);
  const p = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `${p("day")} ${p("month")} ${p("year")}, ${p("hour")}:${p("minute")} IST`;
}
