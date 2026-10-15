// Dates as they appear in a spreadsheet. A cell is a day, a whole month ("Oct 2026"), an ISO week ("2026-W41") or a range
// with both ends ("05/10/2026 - 11/10/2026"). The only real ambiguity is 05/10/2026: day-first or month-first.
// detectDateOrder settles it from the values when it can (a 13 anywhere) and says when it only guessed, so the preview
// can ask instead of deciding for the owner.
export type DateOrder = "dmy" | "mdy";
export type DateGrain = "day" | "week" | "month" | "range";
export interface ParsedDate { start: string; end: string; grain: DateGrain }

const DAY_MS = 86_400_000;
const WEEKDAY = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
const RANGE_SPLIT = /\s*(?:–|—|\s-\s|\sto\s)\s*/i;
const MAX_RANGE_DAYS = 400;

const pad = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m))) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const year = (s: string): number => (s.length === 2 ? 2000 + Number(s) : Number(s));
const FULL_MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "Oct", "Sept", "October" -> 10; anything else (including "Octopus") -> 0
const monthNo = (w: string): number => {
  const t = w.toLowerCase();
  if (t.length < 3) return 0;
  const i = FULL_MONTHS.findIndex((f) => f.startsWith(t));
  return i >= 0 ? i + 1 : 0;
};
const addDays = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function isoWeekStart(y: number, w: number): string | null {
  if (!(y >= 1990 && y <= 2100 && w >= 1 && w <= 53)) return null;
  const jan4 = Date.UTC(y, 0, 4);
  const mondayOfWeek1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(mondayOfWeek1 + (w - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

// One date (a day, a month or a week) with no range in it. `inherit` supplies a missing year from the other end of a range.
function single(raw: string, order: DateOrder, inherit?: number): ParsedDate | null {
  const s = raw.replace(WEEKDAY, "").trim();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s))) {
    const d = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    return d ? { start: d, end: d, grain: "day" } : null;
  }
  if ((m = /^(\d{4})-?W(\d{1,2})(?:-[1-7])?$/i.exec(s))) {
    const start = isoWeekStart(Number(m[1]), Number(m[2]));
    return start ? { start, end: addDays(start, 6), grain: "week" } : null;
  }
  if ((m = /^W(\d{1,2})[ -](\d{4})$/i.exec(s))) {
    const start = isoWeekStart(Number(m[2]), Number(m[1]));
    return start ? { start, end: addDays(start, 6), grain: "week" } : null;
  }
  if ((m = /^(\d{4})[-/](\d{1,2})$/.exec(s))) {
    const y = Number(m[1]), mo = Number(m[2]);
    const a = ymd(y, mo, 1), b = ymd(y, mo, daysIn(y, mo));
    return a && b ? { start: a, end: b, grain: "month" } : null;
  }
  if ((m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/.exec(s))) {
    const a = Number(m[1]), b = Number(m[3]);
    const dotted = m[2] === ".";
    const d = (dotted || order === "dmy") ? ymd(year(m[4]!), b, a) : ymd(year(m[4]!), a, b);
    return d ? { start: d, end: d, grain: "day" } : null;
  }
  if ((m = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([A-Za-z]{3,9})\.?,?(?:[ -](\d{2}|\d{4}))?$/.exec(s))) {
    const mo = monthNo(m[2]!);
    const y = m[3] ? year(m[3]) : inherit;
    const d = mo && y ? ymd(y, mo, Number(m[1])) : null;
    return d ? { start: d, end: d, grain: "day" } : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(s))) {
    const mo = monthNo(m[1]!);
    const y = m[3] ? year(m[3]) : inherit;
    const d = mo && y ? ymd(y, mo, Number(m[2])) : null;
    return d ? { start: d, end: d, grain: "day" } : null;
  }
  if ((m = /^([A-Za-z]{3,9})\.?[ -](\d{4})$/.exec(s))) {
    const mo = monthNo(m[1]!);
    if (!mo) return null;
    const y = Number(m[2]);
    const a = ymd(y, mo, 1), b = ymd(y, mo, daysIn(y, mo));
    return a && b ? { start: a, end: b, grain: "month" } : null;
  }
  return null;
}

const yearOf = (s: string): number | undefined => {
  const m = /(?:^|[^\d])(\d{4})(?:[^\d]|$)/.exec(s) ?? /[-/.](\d{2})$/.exec(s);
  return m ? year(m[1]!) : undefined;
};

export function parseDateCell(raw: string | null | undefined, order: DateOrder): ParsedDate | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 60) return null;
  const whole = single(s, order);
  if (whole) return whole;
  const parts = s.split(RANGE_SPLIT);
  if (parts.length !== 2) return null;
  const [a, b] = parts as [string, string];
  const endYear = yearOf(b);
  const second = single(b, order);
  const first = single(a, order) ?? (endYear ? single(a, order, endYear) : null);
  if (!first || !second || first.grain === "month" || second.grain === "month") return null;
  const start = first.start, end = second.end;
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
  return span >= 0 && span <= MAX_RANGE_DAYS ? { start, end, grain: "range" } : null;
}

// Day-first or month-first, from the values: a first part above 12 means day-first, a second part above 12 month-first.
// With neither, it is a guess from `fallback` (the owner's country) and `certain` is false.
export function detectDateOrder(values: readonly string[], fallback: DateOrder): { order: DateOrder; certain: boolean } {
  let dayFirst = false, monthFirst = false, numeric = false;
  for (const raw of values) {
    for (const part of raw.trim().split(RANGE_SPLIT)) {
      const m = /^(?:[A-Za-z]+,?\s+)?(\d{1,2})([-/.])(\d{1,2})\2(\d{2}|\d{4})$/.exec(part.trim());
      if (!m) continue;
      numeric = true;
      if (m[2] === ".") { dayFirst = true; continue; }
      if (Number(m[1]) > 12) dayFirst = true;
      else if (Number(m[3]) > 12) monthFirst = true;
    }
  }
  if (dayFirst && !monthFirst) return { order: "dmy", certain: true };
  if (monthFirst && !dayFirst) return { order: "mdy", certain: true };
  return { order: fallback, certain: !numeric };
}

/** Countries that write the month first. Everyone else is read day-first until the values say otherwise. */
export const MONTH_FIRST_COUNTRIES = new Set(["US", "PH", "CA"]);
export const defaultDateOrder = (countryCode: string | undefined): DateOrder => (countryCode && MONTH_FIRST_COUNTRIES.has(countryCode.toUpperCase()) ? "mdy" : "dmy");
