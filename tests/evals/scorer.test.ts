import { describe, it, expect } from "vitest";
import type { AgentEvent, TurnChecks } from "../../shared/contracts.js";
import { citeMatcher, compilePattern, excerpt, scoreTurn, summarize, type TurnObservation } from "../../evals/scorer.js";
import type { EvalItem } from "../../evals/set.js";

const okChecks: TurnChecks = {
  citationsValid: true, invalidCitations: [], numbersGrounded: true, ungroundedNumbers: [],
  simulatedDisclosed: true, freshnessDisclosed: true, modeDisclosed: true,
};

const events: AgentEvent[] = [
  { type: "plan", by: "chief-of-staff", steps: [{ agent: "librarian", task: "Trace it" }], rationale: "why" },
  { type: "tool_call", agent: "librarian", id: "c1", name: "trace_decision", args: { query: "stories" } },
  { type: "tool_result", agent: "librarian", id: "c1", name: "trace_decision", summary: "1 result", edges: [], sources: [],
    nodes: [
      { id: "decision:pause-daily-stories", label: "Decision", name: "Pause daily stories" },
      { id: "obs:stories_never_reviewed_30d:business:aamdani:2026-10-05", label: "Observation", name: "Stories never reviewed" },
    ] },
  { type: "tool_call", agent: "chief-of-staff", id: "c2", name: "show_path", args: { ids: [] } },
  { type: "tool_call", agent: "librarian", id: "c3", name: "trace_decision", args: { query: "again" } },
];

const turn = (over: Partial<TurnObservation> = {}): TurnObservation => ({
  ok: true, turnId: "turn:2026-10-15-aa", ms: 41_200, agents: ["chief-of-staff", "librarian"], events, checks: okChecks,
  answer: "We paused daily stories because the output stayed poor after much effort [[decision:pause-daily-stories]]; nobody reviewed them for 30 days [[obs:stories_never_reviewed_30d:business:aamdani:2026-10-05]].",
  citations: ["decision:pause-daily-stories", "obs:stories_never_reviewed_30d:business:aamdani:2026-10-05"],
  ...over,
});

const item = (expect: Partial<EvalItem["expect"]> = {}): EvalItem => ({
  id: "why-stories", question: "Why did we pause daily stories?", tags: ["why"],
  expect: { mustCite: [], mustMatch: [], mustUseTools: [], mustUseAgents: [], forbid: [], simulated: false, ...expect },
});

describe("patterns", () => {
  it("compiles plain regex sources case-insensitively and /body/flags literally", () => {
    expect(compilePattern("poor|effort").test("POOR output")).toBe(true);
    expect(compilePattern("/Poor/").test("poor")).toBe(false);
    expect(compilePattern("/poor/i").test("POOR")).toBe(true);
    expect(compilePattern("[\\u0900-\\u097F]").test("स्टोरीज़")).toBe(true);
  });

  it("matches citations by id glob, by label, and by alternatives", () => {
    const labels = new Map([["decision:pause-daily-stories", "Decision"], ["goal:weekly-signups", "Goal"]]);
    expect(citeMatcher("decision:*paus*")("decision:pause-daily-stories", labels)).toBe(true);
    expect(citeMatcher("decision:*paus*")("decision:post-reels-only", labels)).toBe(false);
    expect(citeMatcher("Decision")("decision:pause-daily-stories", labels)).toBe(true);
    expect(citeMatcher("Decision")("goal:weekly-signups", labels)).toBe(false);
    expect(citeMatcher("Observation|goal:*")("goal:weekly-signups", labels)).toBe(true);
    // a label falls back to the id's prefix when no tool result named it
    expect(citeMatcher("Campaign")("campaign:youtube-shorts-brand", new Map())).toBe(true);
    expect(citeMatcher("goal:weekly-signups")("goal:weekly-signups-2", labels)).toBe(false); // exact unless a * is given
  });

  it("makes a one-line excerpt without citation markers, clipped to the limit", () => {
    expect(excerpt("**Paused** daily stories [[decision:x]].\n\n- Next: reels [[a:b|B]]", 300)).toBe("**Paused** daily stories. - Next: reels");
    const long = excerpt("word ".repeat(200), 300);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("scoreTurn", () => {
  it("passes a turn whose checks pass and whose expectations all hit", () => {
    const s = scoreTurn(item({
      mustCite: ["decision:*paus*", "Observation"], mustMatch: ["poor|effort", "/30 days/"], mustUseTools: ["trace_decision"],
      mustUseAgents: ["librarian"], forbid: ["\\b\\d+% of stories"],
    }), turn());
    expect(s.pass).toBe(true);
    expect(s.hits).toBe(7);
    expect(s.total).toBe(7);
    expect(s.expectations.every((e) => e.ok)).toBe(true);
    expect(s.checks).toEqual({ citationsValid: true, numbersGrounded: true, simulatedDisclosed: true, freshnessDisclosed: true, modeDisclosed: true });
    expect(s.tools).toEqual(["trace_decision", "show_path"]); // unique, in first-use order
    expect(s.toolCalls).toBe(3);
    expect(s.citations).toBe(2);
    expect(s.agents).toEqual(["chief-of-staff", "librarian"]);
    expect(s.ms).toBe(41_200);
    expect(s.excerpt).toMatch(/^We paused daily stories because/);
    expect(s.excerpt).not.toContain("[[");
  });

  it("reports each missed expectation with what the turn did instead", () => {
    const s = scoreTurn(item({
      mustCite: ["goal:*"], mustMatch: ["simulated budget"], mustUseTools: ["impact_of|who_owns"], mustUseAgents: ["tech-lead"],
      forbid: ["poor"], simulated: true,
    }), turn());
    expect(s.pass).toBe(false);
    expect(s.hits).toBe(0);
    expect(s.total).toBe(6);
    const by = Object.fromEntries(s.expectations.map((e) => [e.kind, e]));
    expect(by.cite).toMatchObject({ want: "goal:*", ok: false });
    expect(by.cite!.got).toContain("decision:pause-daily-stories");
    expect(by.tool).toMatchObject({ want: "impact_of|who_owns", ok: false, got: "trace_decision, show_path" });
    expect(by.agent).toMatchObject({ want: "tech-lead", ok: false, got: "chief-of-staff, librarian" });
    expect(by.forbid).toMatchObject({ want: "poor", ok: false, got: "poor" });
    expect(by.simulated).toMatchObject({ ok: false });
  });

  it("matches answer text without the citation ids, so an id can't satisfy a regex", () => {
    const s = scoreTurn(item({ mustMatch: ["stories_never_reviewed"] }), turn());
    expect(s.expectations[0]!.ok).toBe(false);
  });

  it("does not count an invalid citation towards mustCite", () => {
    const s = scoreTurn(item({ mustCite: ["decision:made-up"] }), turn({
      answer: "Paused [[decision:made-up]].", citations: ["decision:made-up"],
      checks: { ...okChecks, citationsValid: false, invalidCitations: ["decision:made-up"] },
    }));
    expect(s.expectations[0]!.ok).toBe(false);
    expect(s.checks.citationsValid).toBe(false);
    expect(s.failedChecks).toEqual(["citations: decision:made-up"]);
    expect(s.pass).toBe(false);
  });

  it("fails a turn with a failed check even when every expectation hits, and lists the check's evidence", () => {
    const s = scoreTurn(item({ mustMatch: ["poor"] }), turn({ checks: { ...okChecks, numbersGrounded: false, ungroundedNumbers: ["56", "12%"], freshnessDisclosed: false } }));
    expect(s.hits).toBe(1);
    expect(s.pass).toBe(false);
    expect(s.failedChecks).toEqual(["numbers: 56, 12%", "freshness"]);
  });

  it("treats a missing modeDisclosed (older turns) as passed, and a failed turn as failed", () => {
    const { modeDisclosed: _m, ...older } = okChecks;
    expect(scoreTurn(item(), turn({ checks: older })).checks.modeDisclosed).toBe(true);
    const failed = scoreTurn(item(), turn({ ok: false, error: "The Chief of Staff could not write the answer." }));
    expect(failed.pass).toBe(false);
    expect(failed.error).toBe("The Chief of Staff could not write the answer.");
  });
});

describe("summarize", () => {
  it("aggregates pass rates per check, expectation hits, latency and agent use", () => {
    const a = scoreTurn(item({ mustMatch: ["poor"] }), turn({ ms: 30_000 }));
    const b = scoreTurn(item({ mustMatch: ["nope"], mustUseTools: ["trace_decision"] }), turn({
      ms: 50_000, agents: ["chief-of-staff"], checks: { ...okChecks, numbersGrounded: false, ungroundedNumbers: ["9"] },
    }));
    const c = scoreTurn(item(), turn({ ms: 100_000, ok: false }));
    const s = summarize([a, b, c]);
    expect(s.n).toBe(3);
    expect(s.turnsOk).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.checkRates.numbersGrounded).toBeCloseTo(2 / 3);
    expect(s.checkRates.citationsValid).toBe(1);
    expect(s.hits).toBe(2);
    expect(s.total).toBe(3);
    expect(s.byKind.match).toEqual({ hits: 1, total: 2 });
    expect(s.byKind.tool).toEqual({ hits: 1, total: 1 });
    expect(s.meanMs).toBe(60_000);
    expect(s.medianMs).toBe(50_000);
    expect(s.maxMs).toBe(100_000);
    expect(s.meanToolCalls).toBe(3);
    expect(s.agentUse).toEqual({ "chief-of-staff": 3, librarian: 2 });
  });

  it("is empty-safe", () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.meanMs).toBe(0);
    expect(s.checkRates.citationsValid).toBe(0);
  });
});
