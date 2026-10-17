// "What your team did this week" (Home): real counts from the business's graph over the last 7 days, read by
// GET /api/:t/week (src/server/routes/week.ts) and drawn by web/src/components/home/WeekRow.tsx. Pure types: no Node or DOM.

export const WEEK_DAYS = 7;

export interface WeekDto {
  /** The start of the 7 days counted (ISO). */
  since: string;
  days: number;
  /** Drafts the owner said OK to (with or without an edit). */
  approved: number;
  /** Emails sent, meetings booked, posts made. `practice`: practice runs (actions not live), counted apart. */
  sent: { done: number; practice: number };
  /** Fixes and tasks the team filed (in the app or on GitHub), and follow-ups it set; `practice` as above. */
  filed: { done: number; practice: number };
  /** New things the team learned about the business: facts, people, products, habits from the owner's edits. */
  learned: number;
  /** Questions the team answered (finished, not failed). */
  answered: number;
}
