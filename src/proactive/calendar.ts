// Seasons and festival dates the daily stand-up can plan around, per country (the markets Allevia sells to, plus India).
// A fixed table, not a model: a date an owner reads must be right. Moon-calendar dates (Diwali, Holi, Ramadan, Eid) are
// the published expectations and are marked `approx`, so the note says "around" and the team checks the local calendar.
// Sources checked on 2026-10-16: Hindu festival calendars for 2026 (Dussehra 20 Oct, Dhanteras 6 Nov, Diwali 8 Nov), the UAE
// Astronomy Centre's forecast for Ramadan 2027 (8 Feb) and Eid al-Fitr 2027 (9 or 10 Mar), Holi 2027 (22 Mar). Fixed and
// rule-based days (Christmas, Thanksgiving = 4th Thursday of November, Black Friday the day after) are computed or plain.
import { DAY_MS, dayMs } from "../insights/text.js";

export interface DateEvent {
  key: string;            // stable: "diwali-2026"
  name: string;           // "Diwali"
  date: string;           // YYYY-MM-DD (the main day; for a season, its first day)
  until?: string;         // a season's last day
  approx?: boolean;       // a moon-calendar date: the published expectation
  kind: "festival" | "shopping" | "national" | "season";
  // which kinds of business it suits best; empty = most local businesses
  suits?: string[];
}

const E = (key: string, name: string, date: string, kind: DateEvent["kind"], o: Partial<DateEvent> = {}): DateEvent => ({ key, name, date, kind, ...o });

export const CALENDAR: Readonly<Record<string, DateEvent[]>> = {
  IN: [
    E("dussehra-2026", "Dussehra", "2026-10-20", "festival", { approx: true }),
    E("dhanteras-2026", "Dhanteras", "2026-11-06", "festival", { approx: true, suits: ["retail", "jewellery", "home", "architecture", "interior"] }),
    E("diwali-2026", "Diwali", "2026-11-08", "festival", { approx: true }),
    E("wedding-season-2026", "the wedding season", "2026-11-15", "season", { until: "2027-02-28", suits: ["events", "catering", "fashion", "jewellery", "photography", "jobs"] }),
    E("christmas-2026", "Christmas", "2026-12-25", "festival"),
    E("new-year-2027", "New Year", "2027-01-01", "festival"),
    E("makar-sankranti-2027", "Makar Sankranti", "2027-01-14", "festival"),
    E("republic-day-2027", "Republic Day", "2027-01-26", "national"),
    E("holi-2027", "Holi", "2027-03-22", "festival", { approx: true }),
    E("financial-year-end-2027", "the end of the financial year", "2027-03-31", "season", { suits: ["b2b", "accounting", "jobs"] }),
  ],
  AE: [
    E("uae-national-day-2026", "UAE National Day", "2026-12-02", "national"),
    E("dubai-shopping-festival-2026", "the Dubai Shopping Festival season", "2026-12-15", "season", { until: "2027-01-31", suits: ["retail", "food", "beauty"] }),
    E("new-year-2027", "New Year", "2027-01-01", "festival"),
    E("ramadan-2027", "Ramadan", "2027-02-08", "festival", { approx: true }),
    E("eid-al-fitr-2027", "Eid al-Fitr", "2027-03-09", "festival", { approx: true }),
  ],
  GB: [
    E("halloween-2026", "Halloween", "2026-10-31", "festival"),
    E("bonfire-night-2026", "Bonfire Night", "2026-11-05", "festival"),
    E("black-friday-2026", "Black Friday", "2026-11-27", "shopping"),
    E("christmas-2026", "Christmas", "2026-12-25", "festival"),
    E("boxing-day-2026", "Boxing Day", "2026-12-26", "shopping"),
    E("new-year-2027", "New Year", "2027-01-01", "festival"),
    E("valentines-2027", "Valentine's Day", "2027-02-14", "festival"),
    E("mothering-sunday-2027", "Mothering Sunday", "2027-03-07", "festival"),
  ],
  US: [
    E("halloween-2026", "Halloween", "2026-10-31", "festival"),
    E("thanksgiving-2026", "Thanksgiving", "2026-11-26", "festival"),
    E("black-friday-2026", "Black Friday", "2026-11-27", "shopping"),
    E("small-business-saturday-2026", "Small Business Saturday", "2026-11-28", "shopping"),
    E("cyber-monday-2026", "Cyber Monday", "2026-11-30", "shopping"),
    E("christmas-2026", "Christmas", "2026-12-25", "festival"),
    E("new-year-2027", "New Year", "2027-01-01", "festival"),
    E("valentines-2027", "Valentine's Day", "2027-02-14", "festival"),
    E("mothers-day-2027", "Mother's Day", "2027-05-09", "festival"),
  ],
  AU: [
    E("halloween-2026", "Halloween", "2026-10-31", "festival"),
    E("melbourne-cup-2026", "Melbourne Cup Day", "2026-11-03", "national"),
    E("black-friday-2026", "Black Friday", "2026-11-27", "shopping"),
    E("christmas-2026", "Christmas", "2026-12-25", "festival"),
    E("boxing-day-2026", "Boxing Day", "2026-12-26", "shopping"),
    E("new-year-2027", "New Year", "2027-01-01", "festival"),
    E("australia-day-2027", "Australia Day", "2027-01-26", "national"),
    E("valentines-2027", "Valentine's Day", "2027-02-14", "festival"),
    E("mothers-day-2027", "Mother's Day", "2027-05-09", "festival"),
  ],
};

export interface Upcoming extends DateEvent { inDays: number; ongoing: boolean }

/**
 * What is coming in the next `days` days (default 30) for a country, nearest first. A season that has started and not ended
 * counts as ongoing. `today` is the business's own local date (YYYY-MM-DD).
 */
export function upcomingDates(countryCode: string | undefined, today: string, days = 30): Upcoming[] {
  const list = countryCode ? CALENDAR[countryCode.toUpperCase()] ?? [] : [];
  const t = dayMs(today);
  if (!Number.isFinite(t)) return [];
  const out: Upcoming[] = [];
  for (const e of list) {
    const inDays = Math.round((dayMs(e.date) - t) / DAY_MS);
    const ongoing = inDays <= 0 && !!e.until && dayMs(e.until) >= t;
    if ((inDays >= 0 && inDays <= days) || ongoing) out.push({ ...e, inDays: Math.max(0, inDays), ongoing });
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.key.localeCompare(b.key));
}

/** "in 23 days", "tomorrow", "today", "on now"; "around" for a moon-calendar date. */
export function whenWords(u: Pick<Upcoming, "inDays" | "ongoing" | "approx">): string {
  if (u.ongoing) return "on now";
  const w = u.inDays === 0 ? "today" : u.inDays === 1 ? "tomorrow" : `in ${u.inDays} days`;
  return u.approx && u.inDays > 1 ? `in about ${u.inDays} days` : w;
}
