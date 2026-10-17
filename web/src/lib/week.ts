// Home's "Your team this week" row (components/home/WeekRow.tsx), as words: five plain counts from GET /api/:t/week, each a
// link to the list behind it (Needs your OK's history, Chat, or the Brain). Practice runs (actions not live yet) are said
// apart, never counted as sent. A quiet week is plain zeros and one calm line. Words follow docs/owner-words.md.
import type { WeekDto } from "../../../shared/week.js";

export type WeekKey = "approved" | "sent" | "filed" | "learned" | "answered";
export interface WeekItem { key: WeekKey; n: number; label: string; note?: string; to: string }

/** Needs your OK, with what was decided open. */
export const DECIDED_PATH = "/approvals?show=decided";
/** The Brain, on "How it grew". */
export const GROWTH_PATH = "/brain?tab=growth";
export const CHAT_PATH = "/chat";

const practice = (n: number): string | undefined => (n > 0 ? `${n} practice run${n === 1 ? "" : "s"}` : undefined);
const one = (n: number, single: string, many: string): string => (n === 1 ? single : many);

export function weekItems(w: WeekDto): WeekItem[] {
  const items: WeekItem[] = [
    { key: "approved", n: w.approved, label: one(w.approved, "draft approved", "drafts approved"), to: DECIDED_PATH },
    { key: "sent", n: w.sent.done, label: "sent or booked", to: DECIDED_PATH },
    { key: "filed", n: w.filed.done, label: one(w.filed.done, "fix or task filed", "fixes or tasks filed"), to: DECIDED_PATH },
    { key: "learned", n: w.learned, label: one(w.learned, "new fact learned", "new facts learned"), to: GROWTH_PATH },
    { key: "answered", n: w.answered, label: one(w.answered, "question answered", "questions answered"), to: CHAT_PATH },
  ];
  const notes: Partial<Record<WeekKey, string | undefined>> = { sent: practice(w.sent.practice), filed: practice(w.filed.practice) };
  return items.map((i) => (notes[i.key] ? { ...i, note: notes[i.key]! } : i));
}

/** Nothing done and nothing practised in the 7 days. */
export const quietWeek = (w: WeekDto): boolean =>
  w.approved + w.sent.done + w.sent.practice + w.filed.done + w.filed.practice + w.learned + w.answered === 0;

/** The line under the title: calm on a quiet week, nothing otherwise (the numbers say it). */
export const weekLine = (w: WeekDto): string | null => (quietWeek(w) ? "A quiet week so far. Your team is ready when you need it." : null);

/** What a screen reader hears for one count. */
export const weekItemLabel = (i: WeekItem): string => `${i.n} ${i.label} this week${i.note ? `, plus ${i.note}` : ""}`;
