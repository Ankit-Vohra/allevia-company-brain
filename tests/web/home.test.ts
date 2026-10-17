// Home's logic (web/src/lib/home.ts): the order drafts wait in, the one-line note, the tool to connect next, who is working,
// the three goals in week one, and a meeting said plainly. Issue #43. The words follow docs/owner-words.md.
import { describe, expect, it } from "vitest";
import type { ProgramGoal } from "../../shared/contracts.js";
import { ownerJargon } from "../../src/agent/style.js";
import { askPath, chatPath, TEAM } from "../../web/src/lib/chat.js";
import {
  briefFirstLine, firstFew, goalsTally, homeStatus, meetingWords, noteLine, notePicks, planSummary, plainTitle, pulseWords, teamStrip, toolsSummary, waitingList, whoIsWorking,
  type StandupLike, type ToolLike,
} from "../../web/src/lib/home.js";

const card = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({ id, status: "pending", createdAt, ...over });

describe("waitingList: the order to say OK in", () => {
  const standup: StandupLike = {
    heading: "Your team noticed 2 things and drafted them",
    items: [
      { key: "a", agent: "content-strategist", title: "A post about the new menu", why: "Menu posts did 3x the usual reach.", status: "drafted", approvalId: "appr:post" },
      { key: "b", agent: "tech-lead", title: "Fix the sitemap", why: "Google cannot find 4 pages.", status: "drafted", approvalId: "appr:site" },
      { key: "c", agent: "growth-marketer", title: "A reply", why: "", status: "failed" },
    ],
    waiting: [{ approvalId: "appr:ad", title: "Pause the weak ad", agent: "growth-marketer", matters: "It spent 120 and brought nothing." }],
  };
  const list = [
    card("appr:old", "2026-10-10T08:00:00Z"),
    card("appr:post", "2026-10-16T07:00:00Z"),
    card("appr:ad", "2026-10-12T07:00:00Z"),
    card("appr:site", "2026-10-16T07:01:00Z"),
    card("appr:done", "2026-10-16T09:00:00Z", { status: "executed" }),
    card("appr:new", "2026-10-15T08:00:00Z", { preview: { why: "Two reviews mention the wait." } }),
  ];

  it("leads with the big problems, then this morning's drafts in the stand-up's order, then the rest newest first", () => {
    expect(waitingList(list, standup).map((w) => w.approval.id)).toEqual(["appr:ad", "appr:post", "appr:site", "appr:new", "appr:old"]);
  });
  it("leaves decided drafts out and says why each matters, from the stand-up first and the idea second", () => {
    const w = waitingList(list, standup);
    expect(w.find((x) => x.approval.id === "appr:done")).toBeUndefined();
    expect(w.map((x) => [x.approval.id, x.why, x.big])).toEqual([
      ["appr:ad", "It spent 120 and brought nothing.", true],
      ["appr:post", "Menu posts did 3x the usual reach.", false],
      ["appr:site", "Google cannot find 4 pages.", false],
      ["appr:new", "Two reviews mention the wait.", false],
      ["appr:old", undefined, false],
    ]);
  });
  it("works with no stand-up and no drafts", () => {
    expect(waitingList(list, null).map((w) => w.approval.id)).toEqual(["appr:site", "appr:post", "appr:new", "appr:ad", "appr:old"]);
    expect(waitingList(undefined, undefined)).toEqual([]);
  });
  it("shows the first three and counts the rest", () => {
    expect(firstFew([1, 2, 3, 4, 5])).toEqual({ shown: [1, 2, 3], more: 2 });
    expect(firstFew([1])).toEqual({ shown: [1], more: 0 });
  });
  it("takes the 'sample numbers' tag out of a title", () => {
    expect(plainTitle("Pause the weak ad (simulated)")).toBe("Pause the weak ad");
    expect(plainTitle("Pause (sample numbers)  the ad")).toBe("Pause the ad");
  });
});

describe("the note, in one line", () => {
  const s = (over: Partial<StandupLike> = {}): StandupLike => ({ heading: "Your team noticed 2 things and drafted them", items: [
    { key: "a", agent: "content-strategist", title: "A post (simulated)", why: "Menu posts did well.", status: "drafted", approvalId: "appr:post" },
    { key: "b", agent: "tech-lead", title: "x", why: "y", status: "failed" },
  ], ...over });
  it("says what the team noticed, or that it was quiet, or that the note is coming", () => {
    expect(noteLine(s())).toBe("Your team noticed 2 things and drafted them");
    expect(noteLine(s({ items: [] }))).toBe("Nothing new worth your time today.");
    expect(noteLine(null)).toMatch(/every morning/);
    expect(noteLine(s({ heading: "" }))).toBe("Your team noticed 1 thing worth doing today");
  });
  it("lists the picks with their reasons, drafted ones only", () => {
    expect(notePicks(s())).toEqual([{ key: "a", agent: "content-strategist", title: "A post", why: "Menu posts did well.", approvalId: "appr:post" }]);
    expect(notePicks(null)).toEqual([]);
  });
});

describe("your plan, in week one", () => {
  const goal = (over: Partial<ProgramGoal> = {}): ProgramGoal => ({
    id: "g1", name: "Search clicks", metricKey: "gsc_clicks", unit: "clicks", period: "month", owner: null, baseline: null, baselineConf: "unknown", baselineAt: null,
    target: 50, targetBasis: "template", current: 0, currentAt: null, progress: 0, status: "on_track", dueAt: null, ...over,
  });
  const f = (n: number) => String(n);
  it("never says 'Going well' at 0 in week one: we'll know after the first full week", () => {
    const p = planSummary({ day: 3, goals: [goal(), goal({ id: "g2", name: "Enquiries", metricKey: "enquiries", current: null, status: "no_data" })] }, f)!;
    expect(p.when).toBe("Month 1 · week 1");
    expect(p.allWaiting).toBe(true);
    expect(p.goals.map((g) => g.status)).toEqual([null, null]);
    expect(p.goals.every((g) => g.why === "We'll know after your first full week.")).toBe(true);
    expect(p.goals.map((g) => g.title)).toEqual(["Get to 50 clicks a month", "Get to 50 clicks a month"]);
  });
  it("shows the plan in its usual words once there are readings, at most three goals", () => {
    const g = (n: number, over: Partial<ProgramGoal> = {}) => goal({ id: `g${n}`, baseline: 20, baselineConf: "measured", current: 35, progress: 0.5, ...over });
    const p = planSummary({ day: 40, goals: [g(1), g(2), g(3, { status: "at_risk" }), g(4)] }, f)!;
    expect(p.allWaiting).toBe(false);
    expect(p.goals).toHaveLength(3);
    expect(p.goals.map((x) => x.status?.word)).toEqual(["Going well", "Going well", "Needs a push"]);
    expect(p.when).toBe("Month 2 · week 2");
  });
  it("is nothing before the business has a plan", () => {
    expect(planSummary(null, f)).toBeNull();
    expect(planSummary(undefined, f)).toBeNull();
  });
  it("comes down to one figure for Home's tile: how many are going well, or that the first reading is coming", () => {
    const g = (n: number, over: Partial<ProgramGoal> = {}) => goal({ id: `g${n}`, baseline: 20, baselineConf: "measured", current: 35, progress: 0.5, ...over });
    expect(goalsTally(planSummary({ day: 40, goals: [g(1), g(2), g(3, { status: "at_risk" })] }, f))).toEqual({ big: "2 of 3", line: "going well" });
    expect(goalsTally(planSummary({ day: 3, goals: [goal(), goal({ id: "g2" })] }, f))).toEqual({ big: "2 goals", line: "First reading next week" });
    expect(goalsTally(null)).toBeNull();
    expect(goalsTally(planSummary({ day: 3, goals: [] }, f))).toBeNull();
  });
});

describe("Home's status line", () => {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  it("says what needs the owner, then how the business is doing, in a few words", () => {
    const goals = [{ name: "Weekly signups", current: 312, baseline: 264 }];
    expect(homeStatus(3, pulseWords(goals, pct))).toBe("3 things need you · Weekly signups up 18%");
    expect(homeStatus(1, pulseWords([{ name: "Enquiries", current: 38, baseline: 40 }], pct))).toBe("1 thing needs you · Enquiries down 5%");
    expect(homeStatus(0, pulseWords([{ name: "Enquiries", current: 40, baseline: 40 }], pct))).toBe("Nothing needs you · Enquiries level");
  });
  it("leaves the business half out before a first reading", () => {
    expect(pulseWords([{ name: "Enquiries", current: null, baseline: 40 }, { name: "Visits", current: 10, baseline: 0 }], pct)).toBeNull();
    expect(pulseWords(undefined, pct)).toBeNull();
    expect(homeStatus(2, null)).toBe("2 things need you");
  });
});

describe("your tools: what is connected and what would help most", () => {
  const t = (id: string, name: string, state: ToolLike["state"] = "not_connected", over: Partial<ToolLike> = {}): ToolLike => ({ id, name, state, available: true, ...over });
  const rows = [t("gmail", "Gmail", "connected"), t("google-analytics", "Google Analytics"), t("search-console", "Google Search Console"), t("instagram", "Instagram")];
  it("offers the first tool in the recommended order, in the owner's words", () => {
    const s = toolsSummary(rows);
    expect(s.connected.map((r) => r.id)).toEqual(["gmail"]);
    expect(s.next).toMatchObject({ tool: { id: "google-analytics" }, line: "Connect Google Analytics to see visits", reconnect: false });
  });
  it("offers the tool that would give a goal its first numbers before the usual order", () => {
    const s = toolsSummary(rows, [{ metricKey: "gsc_clicks", current: null, status: "no_data" }, { metricKey: "account_reach", current: 12, status: "on_track" }]);
    expect(s.next?.tool.id).toBe("search-console");
    expect(s.next?.line).toBe("Connect Google Search Console to see what people search to find you");
  });
  it("puts a tool that stopped working first, and says connect again", () => {
    const s = toolsSummary([...rows, t("hubspot", "HubSpot", "needs_attention")]);
    expect(s.next).toMatchObject({ tool: { id: "hubspot" }, reconnect: true });
    expect(s.next?.line).toBe("Connect HubSpot again so your team can follow up on every lead");
  });
  it("never offers a tool that is not switched on or is coming soon, and says nothing when all is connected", () => {
    expect(toolsSummary([t("gmail", "Gmail", "connected"), t("slack", "Slack", "not_connected", { available: false }), t("tiktok", "TikTok", "not_connected", { soon: true })]).next).toBeNull();
    expect(toolsSummary(undefined)).toEqual({ connected: [], next: null });
  });
  it("has a line for every tool the catalogue offers, in plain words", async () => {
    const { TOOLKIT_CATALOG } = await import("../../shared/connection-map.js");
    for (const e of TOOLKIT_CATALOG) {
      const line = toolsSummary([t(e.id, e.name)]).next?.line ?? "";
      expect(line, e.id).toMatch(new RegExp(`^Connect ${e.name.replace(/[()]/g, "")} (to|so) `));
      expect(line, e.id).not.toBe(`Connect ${e.name} so your team can see more`);
    }
  });
});

describe("your team: who is working", () => {
  const settings = [{ id: "growth-marketer", enabled: true }, { id: "content-strategist", enabled: true, mode: "light" as const }, { id: "tech-lead", enabled: false }];
  it("puts the people working first, then the rest, resting last, and says it in a line", () => {
    const s = teamStrip(settings, new Set(["content-strategist", "growth-marketer"]));
    expect(s.people.slice(0, 2).map((p) => p.id)).toEqual(["growth-marketer", "content-strategist"]);
    expect(s.people.at(-1)!.dot).toBe("off");
    expect(s.line).toBe("Rohan and Tara are working.");
    expect(s.working).toBe(2);
    expect(s.resting).toBe(1);
  });
  it("is calm when nobody is working", () => {
    expect(teamStrip(settings, new Set()).line).toBe("Your team is ready.");
    expect(teamStrip([], new Set()).line).toBe("Your team is ready.");
    expect(teamStrip(undefined, new Set(["chief-of-staff"])).line).toBe("Meera is working.");
  });
  it("counts more than two", () => {
    expect(teamStrip(undefined, new Set(["chief-of-staff", "growth-marketer", "content-strategist", "tech-lead"])).line).toMatch(/^\w+, \w+ and 2 more are working\.$/);
  });
  it("reads who is working from live runs in this tab and from the server's running threads", () => {
    const runs = [
      { kind: "live", tenant: "t", status: "running", target: undefined, events: [{ type: "agent_start", agent: "data-analyst", task: "x" }] },
      { kind: "live", tenant: "other", status: "running", target: "tech-lead", events: [] },
      { kind: "replay", tenant: "t", status: "running", target: "tech-lead", events: [] },
      { kind: "live", tenant: "t", status: "done", target: "tech-lead", events: [] },
    ] as Parameters<typeof whoIsWorking>[0];
    const on = whoIsWorking(runs, [{ running: true, agent: "growth-marketer" }, { running: true }, { running: false, agent: "ops-manager" }], "t");
    expect([...on].sort()).toEqual(["chief-of-staff", "data-analyst", "growth-marketer"]);
    expect(whoIsWorking([], undefined, "t").size).toBe(0);
  });
});

describe("a meeting, said plainly", () => {
  it("is the day and the time on the owner's clock", () => {
    const w = meetingWords({ start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T10:30:00.000Z", timeZone: "Asia/Kolkata" }, { locale: "en-GB" });
    expect(w).toBe("Wednesday 21 October, 15:30 to 16:00"); // en-GB reads a 24-hour clock; 10:00 UTC is 15:30 in Kolkata
    expect(meetingWords({ start: "2026-10-21T10:00:00.000Z", end: "2026-10-21T10:30:00.000Z", timeZone: "Asia/Kolkata" }, { locale: "en-AU" }))
      .toMatch(/^Wednesday 21 October, 3:30\s?pm to 4:00\s?pm$/i);
  });
  it("uses the owner's time zone when the meeting names none, and works without an end", () => {
    expect(meetingWords({ start: "2026-10-21T14:00:00.000Z" }, { timeZone: "America/New_York", locale: "en-US" })).toMatch(/^Wednesday October 21, 10:00\s?AM$/);
    expect(meetingWords({ start: "nonsense" })).toBe("");
    expect(meetingWords({ start: "2026-10-21T10:00:00.000Z", timeZone: "Not/AZone" }, { locale: "zz-nope-" })).toMatch(/21 October/);
  });
});

describe("the ask box", () => {
  it("sends the question to the team's chat at once, and the question survives the address", () => {
    expect(askPath("  Why did enquiries drop? ")).toBe("/chat/team?ask=Why%20did%20enquiries%20drop%3F");
    expect(askPath("hi", "tech-lead")).toBe(`${chatPath("tech-lead")}?ask=hi`);
    expect(askPath("a&b=c#d")).toBe(`${chatPath(TEAM)}?ask=a%26b%3Dc%23d`);
    expect(decodeURIComponent(askPath("a&b=c#d").split("ask=")[1]!)).toBe("a&b=c#d");
  });
});

describe("the words on Home are the owner's words", () => {
  it("no jargon in any line Home writes", () => {
    const lines = [
      noteLine(null), noteLine({ heading: "", items: [] }),
      toolsSummary([{ id: "google-analytics", name: "Google Analytics", state: "not_connected", available: true }]).next!.line,
      teamStrip(undefined, new Set()).line,
      homeStatus(3, "Weekly signups up 18%"), homeStatus(0, null),
      "First reading next week", "going well",
    ];
    for (const l of lines) expect(ownerJargon(l), l).toEqual([]);
  });
});

describe("today's note in one line (Insights)", () => {
  it("skips the note's own title and reads the first thing it says", () => {
    const brief = "Today's note, Shiftly (synthetic demo), 17 Oct 2026\n\nYour team met this morning\n- Nothing new worth your time today.\n\nYour goals\n- Weekly signups: Goal: 20. [[goal:weekly-signups]]";
    expect(briefFirstLine(brief)).toBe("Your team met this morning: Nothing new worth your time today.");
  });
  it("says a numbered list by its heading alone, not as one long paragraph", () => {
    const brief = "Today's note, Aamdani, 17 Oct 2026\n\nTwo big things are waiting for your OK; here's why they matter this week\n1. Seekers signup funnel: 80% drop: Only 16 of 80 seekers apply. [[approval:x]]\n2. Seekers signup funnel: 72.7% drop. [[approval:y]]";
    expect(briefFirstLine(brief)).toBe("Two big things are waiting for your OK; here's why they matter this week");
  });
  it("keeps a prose opening whole, without marks or [[ids]]", () => {
    expect(briefFirstLine("**Good morning.** Reels are carrying Instagram [[observation:ig]].\n\nMore later.")).toBe("Good morning. Reels are carrying Instagram.");
  });
});
