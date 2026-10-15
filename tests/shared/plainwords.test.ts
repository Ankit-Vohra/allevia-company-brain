// The owner-words helpers the growth-plan page uses (web/src/lib/plainwords.ts): display strings only, built from the
// scorecard's own fields. No contract field is renamed; "Day N of 90" becomes "Month 1 · week 2", "at risk" becomes
// "Needs a push" with a line on why, and so on (docs/owner-words.md).
import { describe, it, expect } from "vitest";
import type { ProgramCheckpoint, ProgramGoal, ProgramScorecard } from "../../shared/contracts.js";
import { checkInNote, goalView, monthWeek, nextCheckIn, usdOnlyNote } from "../../web/src/lib/plainwords.js";

const goal = (over: Partial<ProgramGoal> = {}): ProgramGoal => ({
  id: "goal:weekly-signups", name: "Weekly signups", metricKey: "new_accounts", unit: "signups", period: "week",
  owner: { id: "growth-marketer", name: "Rohan" }, baseline: 264, baselineConf: "measured", baselineAt: "2026-09-20", target: 360, targetBasis: "baseline",
  current: 312, currentAt: "2026-10-14", progress: 0.5, status: "on_track", dueAt: "2026-12-19", ...over,
});

describe("monthWeek: where the owner is in the three months", () => {
  it("counts months of 30 days and weeks within them", () => {
    expect(monthWeek(0)).toBe("Month 1 · week 1");
    expect(monthWeek(6)).toBe("Month 1 · week 1");
    expect(monthWeek(7)).toBe("Month 1 · week 2");
    expect(monthWeek(23)).toBe("Month 1 · week 4");
    expect(monthWeek(29)).toBe("Month 1 · week 4");
    expect(monthWeek(30)).toBe("Month 2 · week 1");
    expect(monthWeek(67)).toBe("Month 3 · week 2");
    expect(monthWeek(75)).toBe("Month 3 · week 3");
    expect(monthWeek(89)).toBe("Month 3 · week 4");
  });
  it("says the plan is done at day 90 and later, and never goes negative", () => {
    expect(monthWeek(90)).toBe("All three months done");
    expect(monthWeek(120)).toBe("All three months done");
    expect(monthWeek(-3)).toBe("Month 1 · week 1");
  });
});

describe("goalView", () => {
  const f = (n: number) => String(n);
  it("reads as a sentence with the numbers, and says where it started and where it is now", () => {
    const v = goalView(goal(), 23, f);
    expect(v).toMatchObject({ name: "Weekly signups", title: "Get to 360 signups a week", start: "264", now: "312", known: true, owner: "Rohan" });
    expect(v.progress).toBe(0.5);
  });
  it("uses 'a month' for monthly goals, and the name alone when there is no target", () => {
    expect(goalView(goal({ period: "month", unit: "accounts", target: 78600 }), 5, f).title).toBe("Get to 78600 accounts a month");
    expect(goalView(goal({ target: null }), 5, f).title).toBe("Weekly signups");
    expect(goalView(goal({ unit: null }), 5, f).title).toBe("Get to 360 a week");
  });
  it("on_track is Going well, with a line on why", () => {
    const v = goalView(goal(), 23, f);
    expect(v.status).toEqual({ word: "Going well", tone: "ok" });
    expect(v.why).toMatch(/up from 264/i);
  });
  it("at_risk is Needs a push and says what was planned by now; off_track is Behind", () => {
    const risk = goalView(goal({ status: "at_risk", current: 270, progress: 0.06 }), 45, f);
    expect(risk.status).toEqual({ word: "Needs a push", tone: "warn" });
    expect(risk.why).toMatch(/312|planned/i);
    const off = goalView(goal({ status: "off_track", current: 250, progress: 0 }), 45, f);
    expect(off.status).toEqual({ word: "Behind", tone: "bad" });
    expect(off.why).toMatch(/down from 264|below/i);
    expect(off.why).toMatch(/Rohan/);
  });
  it("achieved reads as Going well: you've reached it", () => {
    const v = goalView(goal({ status: "achieved", current: 365, progress: 1 }), 60, f);
    expect(v.status?.word).toBe("Going well");
    expect(v.why).toMatch(/reached/i);
  });
  it("a goal with no reading says we'll know after the first full week, and shows no status or bar", () => {
    const v = goalView(goal({ status: "no_data", current: null, progress: null, baseline: null, baselineConf: "unknown" }), 0, f);
    expect(v).toMatchObject({ status: null, known: false, now: null, start: null, progress: null });
    expect(v.why).toBe("We'll know after your first full week.");
  });
  it("a reading but no baseline: the bar is empty and the start is said to be unmeasured", () => {
    const v = goalView(goal({ baseline: null, baselineConf: "unknown", progress: null, status: "no_data" }), 9, f);
    expect(v.progress).toBeNull();
    expect(v.now).toBe("312");
    expect(v.start).toBeNull();
  });
  it("a status this version does not know reads as a neutral line rather than breaking", () => {
    const v = goalView(goal({ status: "mystery" as ProgramGoal["status"] }), 9, f);
    expect(v.status).toBeNull();
  });
  it("clamps progress into 0..1", () => {
    expect(goalView(goal({ progress: 1.8 }), 9, f).progress).toBe(1);
    expect(goalView(goal({ progress: -0.2 }), 9, f).progress).toBe(0);
  });
});

describe("check-ins", () => {
  const cp = (day: ProgramCheckpoint["day"], status: ProgramCheckpoint["status"], summary?: string): ProgramCheckpoint =>
    ({ day, dueDate: `2026-10-${10 + day / 30}`, status, ...(summary ? { summary } : {}) });
  const card = (day: number, goals: ProgramGoal[]): Pick<ProgramScorecard, "day" | "goals"> => ({ day, goals });

  it("the next check-in is the first one not done, skipping the set-up", () => {
    expect(nextCheckIn([cp(0, "done"), cp(30, "upcoming"), cp(60, "upcoming"), cp(90, "upcoming")])?.day).toBe(30);
    expect(nextCheckIn([cp(0, "done"), cp(30, "done"), cp(60, "done"), cp(90, "done")])).toBeUndefined();
  });
  it("the set-up check-in reads as the plan being set up", () => {
    expect(checkInNote(cp(0, "done", "Day 0 of Allevia 90: goals set and baselines locked from the data on hand."), card(0, [goal()]))).toMatch(/set up your plan/i);
  });
  it("a done monthly check-in is the team's own note: what changed, and what it does next", () => {
    const note = checkInNote(cp(30, "done", "Day 30 of Allevia 90: report one."), card(35, [goal(), goal({ id: "g2", name: "Search clicks", unit: "clicks", status: "at_risk", baseline: 9800, current: 10100, owner: { id: "data-analyst", name: "Kabir" } })]));
    expect(note).toMatch(/Weekly signups/);
    expect(note).toMatch(/264/);
    expect(note).toMatch(/Next:.*Search clicks.*Kabir/);
    expect(note).not.toMatch(/Allevia 90|Day 30/);
  });
  it("keeps a summary that is already in the team's own words", () => {
    expect(checkInNote(cp(60, "done", "Signups are up. Next month we push the reels."), card(65, [goal()]))).toBe("Signups are up. Next month we push the reels.");
  });
  it("a check-in not done yet says when and what it will cover", () => {
    expect(checkInNote(cp(30, "upcoming"), card(10, [goal()]))).toMatch(/where each goal stands/i);
  });
});

describe("usdOnlyNote", () => {
  it("labels prices shown in dollars for a business that reports in another currency", () => {
    expect(usdOnlyNote("INR")).toMatch(/US dollars/);
    expect(usdOnlyNote("JPY")).toMatch(/US dollars/);
    expect(usdOnlyNote(undefined)).toBeNull();
    expect(usdOnlyNote("GBP")).toBeNull();
    expect(usdOnlyNote("usd")).toBeNull();
  });
});
