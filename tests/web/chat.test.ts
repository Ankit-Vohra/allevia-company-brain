// The chat's logic (web/src/lib/chat.ts): who a thread belongs to, what the team said to each other, how an answer was
// reached in plain words, and what to suggest saying. The words follow docs/owner-words.md.
import { describe, it, expect } from "vitest";
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import { AGENTS } from "../../shared/roster.js";
import { ownerJargon } from "../../src/agent/style.js";
import { codeCatalog } from "../../src/agent/skills/catalog.js";
import { STARTERS } from "../../web/src/lib/starters.js";
import { humanDates } from "../../web/src/lib/words.js";
import {
  LOST_ANSWER, TEAM, TONES, checkLines, checksPass, chatPath, contributions, savedAnswer, dotOf, dotWords, doorWords, howWeGotThis, starterFor, startersFor, teamTalk,
  threadsFor, toneDirective, whoFrom, whoOfThread, workingNow,
} from "../../web/src/lib/chat.js";

const GOOD: TurnChecks = { citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [], simulatedDisclosed: true, freshnessDisclosed: true, modeDisclosed: true };

// One team turn: The Chief plans, Data Detective finds, Miss Influencer builds on it, Number Cruncher and Fact Checker check, The Chief answers.
const RUN: AgentEvent[] = [
  { type: "session", tenant: "t", sessionId: "session:1", turnId: "turn:1", question: "What should we post?" },
  { type: "plan", by: "chief-of-staff", rationale: "A plan question: numbers first, then ideas.", steps: [
    { agent: "data-analyst", task: "Rank our hooks [[observation:hooks]]" },
    { agent: "content-strategist", task: "Write three briefs", after: ["data-analyst"] },
  ] },
  { type: "agent_start", agent: "data-analyst", task: "Rank hooks" },
  { type: "tool_call", agent: "data-analyst", id: "a#1", name: "content_performance", args: {} },
  { type: "tool_result", agent: "data-analyst", id: "a#1", name: "content_performance", summary: "18 reels", nodes: [], edges: [], sources: [{ id: "document:ig", title: "Instagram export" }] },
  { type: "tool_call", agent: "data-analyst", id: "a#2", name: "content_performance", args: {} },
  { type: "tool_result", agent: "data-analyst", id: "a#2", name: "content_performance", summary: "again", nodes: [], edges: [], sources: [{ id: "document:ig", title: "Instagram export" }] },
  { type: "finding", agent: "data-analyst", findingId: "f1", text: "Salary reveals got 3.4 times our median reach [[observation:hooks]].", citations: ["observation:hooks"] },
  { type: "handoff", from: "data-analyst", to: "content-strategist", note: "Lead with salary reveal" },
  { type: "handoff", from: "data-analyst", to: "content-strategist", note: "Lead with salary reveal" },
  { type: "agent_done", agent: "data-analyst", ms: 1, ok: true },
  { type: "agent_start", agent: "content-strategist", task: "Write briefs" },
  { type: "skill_used", agent: "content-strategist", skillId: "reel-script", name: "Reel script craft", source: "code" },
  { type: "tool_call", agent: "content-strategist", id: "t#1", name: "use_skill", args: {} },
  { type: "finding", agent: "content-strategist", findingId: "f2", text: "Three briefs.", citations: [] },
  { type: "review", agent: "fact-checker", findingId: "f2", verdict: "ok", note: "All claims trace." },
  { type: "review", agent: "coe-lead", findingId: "f1", verdict: "fix", note: "Use the 90 day figure." },
  { type: "proposal", agent: "content-strategist", recommendationId: "rec:1", approvalId: "appr:1", title: "Draft 3 reels", kind: "content_draft" },
  { type: "agent_start", agent: "chief-of-staff", task: "Write the answer" },
  { type: "text", agent: "chief-of-staff", delta: "Post three reels." },
];

describe("addresses and who a thread belongs to", () => {
  it("the team is the default; a roster id is a person; the Chief is the team", () => {
    expect(whoFrom(undefined)).toBe(TEAM);
    expect(whoFrom("team")).toBe(TEAM);
    expect(whoFrom("Growth Hacker")).toBe("growth-marketer"); // a first name in the address works too
    expect(whoFrom("chief-of-staff")).toBe(TEAM);
    expect(whoFrom("content-strategist")).toBe("content-strategist");
    expect(whoFrom("ghost")).toBe(TEAM);
  });
  it("thread ids with colons survive the address", () => {
    expect(chatPath(TEAM)).toBe("/chat/team");
    expect(chatPath("tech-lead", "session:2026-10-15-abc")).toBe("/chat/tech-lead/session%3A2026-10-15-abc");
    expect(decodeURIComponent(chatPath("tech-lead", "session:2026-10-15-abc").split("/")[3]!)).toBe("session:2026-10-15-abc");
  });
  it("a thread is the person's when it was a direct chat with them, and the team's otherwise (from either door)", () => {
    const threads = [{ id: "a", agent: "content-strategist" }, { id: "b" }, { id: "c", agent: "ghost" }, { id: "d", agent: "chief-of-staff" }, { id: "e", agent: "data-analyst" }];
    expect(whoOfThread(threads[0]!)).toBe("content-strategist");
    expect(threadsFor("content-strategist", threads).map((t) => t.id)).toEqual(["a"]);
    expect(threadsFor(TEAM, threads).map((t) => t.id)).toEqual(["b", "c", "d"]);
    expect(threadsFor(TEAM, undefined)).toEqual([]);
  });
});

describe("status", () => {
  it("resting beats working; working beats ready", () => {
    expect(dotOf({ enabled: false }, true)).toBe("off");
    expect(dotOf({ enabled: true, mode: "off" }, false)).toBe("off");
    expect(dotOf({ enabled: true, mode: "full" }, true)).toBe("working");
    expect(dotOf({ enabled: true, mode: "light" }, false)).toBe("idle");
    expect(dotOf(undefined, false)).toBe("idle");
    expect([dotWords("off"), dotWords("working"), dotWords("idle"), dotWords("idle", "light")]).toEqual(["Resting", "Working now", "Ready", "Ready, light touch"]);
  });
  it("works out who is on a run from its events", () => {
    expect(workingNow(RUN)).toEqual(["content-strategist", "chief-of-staff"]);
    expect(workingNow([...RUN, { type: "final", turnId: "turn:1", answer: "x", citations: [], checks: GOOD, agents: [], ms: 1 }])).toEqual([]);
  });
});

describe("watch the team talk", () => {
  const talk = teamTalk(RUN);
  it("reads as a thread: the plan, a handoff once, findings, reviews, and what waits for the owner", () => {
    expect(talk.map((l) => `${l.kind}:${l.from}${l.to ? `>${l.to}` : ""}`)).toEqual([
      "plan:chief-of-staff", "plan:chief-of-staff>data-analyst", "plan:chief-of-staff>content-strategist",
      "finding:data-analyst", "handoff:data-analyst>content-strategist", "skill:content-strategist", "finding:content-strategist",
      "review:fact-checker>content-strategist", "review:coe-lead>data-analyst", "proposal:content-strategist",
    ]);
  });
  it("says it in names and plain sentences, with no [[ids]]", () => {
    expect(talk[0]!.text).toBe("A plan question: numbers first, then ideas. I'm asking Data Detective and Miss Influencer.");
    expect(talk[1]!.text).toBe("Rank our hooks");
    expect(talk[2]!.text).toBe("Write three briefs (after Data Detective)");
    expect(talk.find((l) => l.kind === "finding")!.text).toBe("Salary reveals got 3.4 times our median reach.");
    expect(talk.find((l) => l.kind === "review" && l.from === "coe-lead")).toMatchObject({ verdict: "fix", text: "Sent Data Detective's note back for a fix. Use the 90 day figure." });
    expect(talk.find((l) => l.kind === "review" && l.from === "fact-checker")!.text).toBe("Checked Miss Influencer's note: fine. All claims trace.");
    expect(talk.at(-1)!.text).toBe("Suggests: Draft 3 reels. This waits for your OK.");
    for (const l of talk) expect(ownerJargon(l.text), l.text).toEqual([]);
  });
  it("a team that only answers (no plan with other people) has nothing to watch", () => {
    expect(teamTalk([{ type: "plan", by: "chief-of-staff", rationale: "Direct.", steps: [{ agent: "chief-of-staff", task: "Answer" }] }])).toEqual([]);
    expect(teamTalk([])).toEqual([]);
  });
  it("reads clean as the founder saw it: no bold marks, no repeated '<name>'s finding:', a skill named once, days in words", () => {
    const lines = teamTalk([
      { type: "finding", agent: "oncall-engineer", findingId: "z1", text: "**Most likely still happening today.** The newest crash data is from 2026-10-15.", citations: [] },
      { type: "handoff", from: "oncall-engineer", to: "data-analyst", note: "Firefighter's finding: **Most likely still happening today.**" },
      { type: "skill_used", agent: "qa-release", skillId: "release-check", name: "Did the last release break anything?", source: "code" },
    ]);
    expect(lines.map((l) => l.text)).toEqual([
      "Most likely still happening today. The newest crash data is from 15 Oct.",
      "Most likely still happening today.",
      "Using the skill “Did the last release break anything”.",
    ]);
  });
});

describe("a saved answer without its work log", () => {
  it("stands in as the final event, so the chat shows the answer and never an empty grey box", () => {
    const t = { id: "turn:x", answer: "Crash-free sessions fell to 92%.", citations: [], checks: GOOD, agents: ["chief-of-staff" as const], ms: 900 };
    expect(savedAnswer(t)).toEqual([{ type: "final", turnId: "turn:x", answer: t.answer, citations: [], checks: GOOD, agents: ["chief-of-staff"], ms: 900 }]);
    expect(savedAnswer({ ...t, answer: "  " })).toEqual([]);
    expect(LOST_ANSWER).toMatch(/never got an answer/);
  });
});

describe("what each person contributed", () => {
  it("lists their notes with who checked them, never the Chief's answer", () => {
    expect(contributions(RUN)).toEqual([
      { agent: "data-analyst", text: "Salary reveals got 3.4 times our median reach.", checks: [{ by: "coe-lead", verdict: "fix" }] },
      { agent: "content-strategist", text: "Three briefs.", checks: [{ by: "fact-checker", verdict: "ok" }] },
    ]);
  });
});

describe("a note read by an owner (audit #39)", () => {
  const events = (text: string): AgentEvent[] => [{ type: "finding", agent: "data-analyst", findingId: "f9", text, citations: [] }];
  it("has no bold marks, no label, no run-on bullets and no machine dates", () => {
    const [n] = contributions(events("Findings: **Sign-ups broke on 2026-10-07.** - Views held at 397. - People got stuck [[obs:x:2026-10-07]]."));
    expect(n!.text).toBe(`Sign-ups broke on 7 Oct${new Date().getFullYear() === 2026 ? "" : " 2026"}. Views held at 397. People got stuck.`);
    expect(n!.text).not.toMatch(/\*\*|Findings|2026-10/);
  });
  it("humanDates leaves the ids inside [[source]] markers alone", () => {
    expect(humanDates("fell on 2026-10-07 [[obs:a:2026-10-07]]", new Date("2026-11-01"))).toBe("fell on 7 Oct [[obs:a:2026-10-07]]");
    expect(humanDates("on 2025-12-31", new Date("2026-11-01"))).toBe("on 31 Dec 2025");
    expect(humanDates("not a date 2026-13-45")).toBe("not a date 2026-13-45");
  });
});

describe("how we got this", () => {
  const how = howWeGotThis(RUN, { agents: ["chief-of-staff", "data-analyst", "content-strategist"], checks: GOOD });
  it("names the people, what they looked at (once per tool, with a count), the skills they opened and the sources", () => {
    expect(how.people).toEqual(["chief-of-staff", "data-analyst", "content-strategist"]);
    expect(how.tools).toEqual([{ agent: "data-analyst", words: "Compare how posts and reels did", times: 2 }]); // use_skill is plumbing, not a look-up
    expect(how.skills).toEqual([{ agent: "content-strategist", name: "Reel script craft" }]);
    expect(how.sources).toEqual([{ id: "document:ig", title: "Instagram export" }]);
  });
  it("says what was checked in plain words, and flags what was not", () => {
    expect(how.checks.every((c) => c.ok)).toBe(true);
    expect(checksPass(GOOD)).toBe(true);
    const bad = checkLines({ ...GOOD, numbersGrounded: false, ungroundedNumbers: ["56", "9"], citationsValid: false, invalidCitations: ["x:y"] });
    expect(bad.filter((c) => !c.ok).map((c) => c.text)).toEqual(["It pointed to a source we could not find: 1", "2 numbers could not be matched to a source"]);
    expect(checksPass({ ...GOOD, freshnessDisclosed: false })).toBe(false);
    for (const c of [...bad, ...how.checks]) expect(ownerJargon(c.text), c.text).toEqual([]);
  });
  it("an unknown tool gets a readable name, not its code name", () => {
    const h = howWeGotThis([{ type: "tool_call", agent: "librarian", id: "x", name: "trace_the_thing", args: {} }]);
    expect(h.tools[0]!.words).toBe("Trace the thing");
  });
});

describe("what to say", () => {
  const shipped = AGENTS.flatMap((a) => codeCatalog().forAgent(a.id));
  it("every shipped skill has a first sentence in the owner's voice, and none is left over", () => {
    expect(shipped.length).toBeGreaterThan(40);
    expect(shipped.filter((s) => !STARTERS[s.id]).map((s) => s.id)).toEqual([]);
    const ids = new Set(shipped.map((s) => s.id));
    expect(Object.keys(STARTERS).filter((id) => !ids.has(id))).toEqual([]);
    for (const [id, p] of Object.entries(STARTERS)) {
      expect(p.length, id).toBeGreaterThan(8);
      expect(p.length, id).toBeLessThan(110);
      expect(ownerJargon(p), id).toEqual([]);
    }
  });
  it("a chip is the skill's name and its sentence; a skill we have no sentence for still gets one", () => {
    expect(starterFor({ id: "instagram-post", name: "Instagram post craft" })).toEqual({ id: "instagram-post", label: "Instagram post craft", prompt: "Write me an Instagram post for this week." });
    expect(starterFor({ id: "weekly-content-plan", name: "A week of posts (content plan)" }).label).toBe("A week of posts");
    expect(starterFor({ id: "festival-post", name: "Festival post", makes: "A festive caption, with hashtags" }).prompt).toBe("Make me a festive caption.");
    expect(starterFor({ id: "our-thing", name: "Our own check" }).prompt).toBe("Help me with: our own check.");
  });
  it("an empty chat shows the skills that are on, capped; with none, what the person handles", () => {
    const skills = codeCatalog().forAgent("content-strategist").map((s) => ({ ...s, rules: [], learned: [], source: "code" as const }));
    const chips = startersFor("content-strategist", skills);
    expect(chips).toHaveLength(6);
    const off = startersFor("content-strategist", skills.map((s, i) => (i === 0 ? { ...s, on: false } : s)), 20);
    expect(off).toHaveLength(skills.length - 1);
    expect(off.some((c) => c.id === skills[0]!.id)).toBe(false);
    expect(startersFor("librarian", [])[0]).toMatchObject({ label: "Why did we", prompt: "Help me with why did we." });
  });
  it("the tone sentences are one instruction each, naming the person", () => {
    expect(TONES.map((t) => t.id)).toEqual(["warm", "direct", "playful", "formal"]);
    expect(toneDirective("Miss Influencer", TONES[0]!)).toBe("Miss Influencer, always write in a warm, friendly tone, like a good neighbour");
  });
  it("only the Discord door is called out", () => {
    expect(doorWords("discord")).toBe("From Discord");
    expect(doorWords("web")).toBeUndefined();
    expect(doorWords(undefined)).toBeUndefined();
  });
});
