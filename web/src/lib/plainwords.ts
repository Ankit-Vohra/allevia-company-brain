// Owner words (docs/owner-words.md): the growth-plan page says what the scorecard means, in the words of a founder
// who is not a marketer or an analyst. Display strings only, built from the scorecard's own fields: no contract field is
// renamed, and every number is the server's. Pure functions with the number formatter passed in, so they run anywhere.
import type { GoalState, ProgramCheckpoint, ProgramGoal, ProgramScorecard } from "../../../shared/contracts.js";

const PLAN_DAYS = 90;

/** "Month 1 · week 2": where the owner is in the three months (months of 30 days, weeks within them). */
export function monthWeek(day: number): string {
  if (day >= PLAN_DAYS) return "All three months done";
  const d = Math.max(0, Math.floor(day));
  return `Month ${Math.floor(d / 30) + 1} · week ${Math.min(4, Math.floor((d % 30) / 7) + 1)}`;
}

export type Tone = "ok" | "warn" | "bad";
type Fmt = (n: number) => string;

export interface GoalView {
  name: string;                           // "Weekly signups"
  title: string;                          // "Get to 360 signups a week"
  status: { word: string; tone: Tone } | null; // null: nothing to say yet (no reading, or a status we don't know)
  why: string;                            // one line: why it is going well, or what is needed
  start: string | null;                   // where you started, formatted; null when it was not measured
  now: string | null;                     // where you are now; null when there is no reading yet
  progress: number | null;                // 0..1 for the bar; null: no bar
  known: boolean;                         // there is a reading to talk about
  owner: string | null;                   // "Rohan"
}

const per = (g: ProgramGoal) => (g.period === "week" ? "a week" : "a month");
const WAIT = "We'll know after your first full week.";

/** Where a straight line from the start to the goal would be on `day` of the 90: the pace the plan was set at. */
function planned(g: ProgramGoal, day: number): number | null {
  if (g.baseline === null || g.target === null) return null;
  return g.baseline + (g.target - g.baseline) * (Math.min(PLAN_DAYS, Math.max(0, day)) / PLAN_DAYS);
}

/** The first full week of the plan. Mirrors src/insights/brief.ts (FIRST_WEEK_DAYS); change both together. */
export const FIRST_WEEK_DAYS = 7;

/**
 * The goal's state as the owner is told it. In the first week a reading of nothing is a count that has not started, not a
 * result: "Going well" at 0 reads oddly (audit #39), so it is "We'll know after your first full week" until the week is over
 * or there is something to talk about. The server says the same on its side; this keeps older answers and sample data honest.
 */
export function goalState(g: Pick<ProgramGoal, "current" | "status">, day: number): GoalState {
  return g.current === null || notStartedYet(g, day) ? "no_data" : g.status;
}

/** A zero in the first week: the count has not started, so there is nothing to say yet. */
export const notStartedYet = (g: Pick<ProgramGoal, "current">, day: number): boolean => g.current !== null && g.current <= 0 && day < FIRST_WEEK_DAYS;

export function goalView(g: ProgramGoal, day: number, fmt: Fmt): GoalView {
  const unit = g.unit ? ` ${g.unit}` : "";
  const title = g.target === null ? g.name : `Get to ${fmt(g.target)}${unit} ${per(g)}`;
  const state = goalState(g, day);
  const hasReading = g.current !== null && !notStartedYet(g, day);
  const progress = !hasReading || g.progress === null || g.baseline === null ? null : Math.max(0, Math.min(1, g.progress));
  const base: Omit<GoalView, "status" | "why"> = {
    name: g.name, title, start: g.baseline === null ? null : fmt(g.baseline), now: hasReading ? fmt(g.current!) : null,
    progress, known: hasReading, owner: g.owner?.name ?? null,
  };
  if (!hasReading) return { ...base, status: null, why: WAIT };

  const move = g.baseline === null ? null : g.current! > g.baseline ? `up from ${fmt(g.baseline)}` : g.current! < g.baseline ? `down from ${fmt(g.baseline)}` : `the same as the ${fmt(g.baseline)} you started at`;
  const plan = planned(g, day);
  const byNow = plan === null ? "" : ` We planned for about ${fmt(Math.round(plan))} by now.`;
  const who = g.owner ? ` ${g.owner.name} is on it.` : "";
  switch (state) {
    case "achieved":
      return { ...base, status: { word: "Going well", tone: "ok" }, why: `You've reached it: ${fmt(g.current!)}${move ? `, ${move}` : ""}.` };
    case "on_track":
      return { ...base, status: { word: "Going well", tone: "ok" }, why: move ? `${cap(move)}, about where we planned.` : "About where we planned." };
    case "at_risk":
      return { ...base, status: { word: "Needs a push", tone: "warn" }, why: `${move ? `${cap(move)}, but a little` : "A little"} slower than planned.${byNow}${who}` };
    case "off_track":
      return { ...base, status: { word: "Behind", tone: "bad" }, why: `${move ? `${cap(move)}, well` : "Well"} below plan.${byNow}${who}` };
    default:
      return { ...base, status: null, why: move ? `${cap(move)}.` : `${fmt(g.current!)} so far.` };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The next monthly check-in that has not happened (the set-up at day 0 is not one). */
export function nextCheckIn(checkpoints: ProgramCheckpoint[]): ProgramCheckpoint | undefined {
  return checkpoints.find((c) => c.day > 0 && c.status !== "done");
}

// The server writes a generic line on each checkpoint ("Day 30 of Allevia 90: report one…"); the owner reads the team's
// own note instead, put together from the goals' real numbers.
const GENERIC = /^Day \d+ of Allevia 90\b/;

/** The team's short note for a monthly check-in: what changed, and what it will do next. */
export function checkInNote(c: ProgramCheckpoint, p: Pick<ProgramScorecard, "day" | "goals">, fmt: Fmt = (n) => String(n)): string {
  if (c.day === 0) return "We set up your plan and wrote down where you started, so every goal is measured from there.";
  if (c.status !== "done") {
    return `${c.status === "due" ? "Due now" : "Coming up"}: we look at where each goal stands, say what changed, and tell you what we'll do next.`;
  }
  if (c.summary && !GENERIC.test(c.summary)) return c.summary;
  const read = p.goals.filter((g) => g.current !== null && g.baseline !== null);
  const changed = read.slice(0, 3).map((g) => `${g.name} went from ${fmt(g.baseline!)} to ${fmt(g.current!)}`);
  const stuck = p.goals.find((g) => g.status === "off_track") ?? p.goals.find((g) => g.status === "at_risk");
  const next = stuck
    ? `Next: more effort on ${stuck.name}${stuck.owner ? `, with ${stuck.owner.name}` : ""}.`
    : "Next: keep doing what's working, and take on the next idea.";
  return `${changed.length ? `${changed.join(". ")}.` : "We're still collecting your first readings."} ${next}`;
}

/** Pricing is shown in the business's currency when we price in it; otherwise in dollars, and it says so. */
const PRICED = new Set(["USD", "GBP", "AED", "AUD"]);
export function usdOnlyNote(currency: string | undefined): string | null {
  if (!currency || PRICED.has(currency.toUpperCase())) return null;
  return `Prices are shown in US dollars. We'll show ${currency.toUpperCase()} when billing opens.`;
}
