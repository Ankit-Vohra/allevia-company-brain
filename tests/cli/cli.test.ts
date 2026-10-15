import { describe, it, expect } from "vitest";
import type { AgentEvent } from "../../shared/contracts.js";
import { loadCommands } from "../../src/cli.js";
import { hueTo256, workLog } from "../../src/cli/_worklog.js";

describe("CLI registry", () => {
  it("discovers every command file in src/cli (helpers excluded), with unique names", async () => {
    const names = (await loadCommands()).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["ask", "db:check", "replay", "threads", "insights", "brief", "approvals"]));
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("work log", () => {
  const events: AgentEvent[] = [
    { type: "session", tenant: "aamdani", sessionId: "session:s", turnId: "turn:t", question: "Why did signups drop?" },
    { type: "recall", brief: "Earlier threads on this:\n- [[turn:old]] 2026-10-01: asked", ids: ["turn:old"] },
    { type: "plan", by: "chief-of-staff", rationale: "Numbers first", steps: [{ agent: "data-analyst", task: "Explain signups" }, { agent: "growth-marketer", task: "Move", after: ["data-analyst"] }] },
    { type: "agent_start", agent: "data-analyst", task: "Explain signups" },
    { type: "tool_call", agent: "data-analyst", id: "c1", name: "metric_trend", args: { metric: "signups" } },
    { type: "agent_status", agent: "data-analyst", text: "Checking the signups trend" },
    { type: "tool_result", agent: "data-analyst", id: "c1", name: "metric_trend", summary: "2 results · Signups", nodes: [], edges: [], sources: [] },
    { type: "finding", agent: "data-analyst", findingId: "finding:t-data-analyst", text: "Signups fell [[metric:signups]].", citations: ["metric:signups"] },
    { type: "review", agent: "coe-lead", findingId: "finding:t-data-analyst", verdict: "fix", note: "Add the week." },
    { type: "agent_done", agent: "data-analyst", ms: 1500, ok: true },
    { type: "handoff", from: "data-analyst", to: "growth-marketer", note: "Kabir's finding: Signups fell" },
    { type: "agent_done", agent: "growth-marketer", ms: 800, ok: false },
    { type: "text", agent: "chief-of-staff", delta: "Signups fell " },
    { type: "text", agent: "chief-of-staff", delta: "[[metric:signups]]." },
    { type: "path", nodes: [{ id: "metric:signups", label: "Metric", name: "Signups" }, { id: "system:sitemap", label: "System", name: "Sitemap" }], edges: [] },
    { type: "final", turnId: "turn:t", answer: "Signups fell [[metric:signups]].", citations: ["metric:signups"], agents: ["chief-of-staff", "data-analyst"], ms: 4200,
      checks: { citationsValid: true, invalidCitations: [], numbersGrounded: false, ungroundedNumbers: ["56"], simulatedDisclosed: true, freshnessDisclosed: true } },
  ];

  it("prints a readable, attributed log with the streamed answer and the checks", () => {
    let out = "";
    const log = workLog({ color: false, write: (s) => { out += s; } });
    for (const e of events) log(e);
    expect(out).toContain("Why did signups drop?\naamdani · session:s · turn:t");
    expect(out).toContain("Recall: 1 things we already know");
    expect(out).toContain("Meera planned: Numbers first\n  1. Kabir Explain signups\n  2. Rohan Move (after Kabir)");
    expect(out).toContain("> Kabir Data Analyst, Analytics: Explain signups");
    expect(out).toContain("    Kabir -> metric_trend {\"metric\":\"signups\"}");
    expect(out).toContain("    Kabir <- metric_trend: 2 results · Signups");
    expect(out).toContain("  Isha reviewed finding:t-data-analyst: FIX Add the week.");
    expect(out).toContain("< Kabir done in 1.5s");
    expect(out).toContain("< Rohan failed after 0.8s");
    expect(out).toContain("\nAnswer\nSignups fell [[metric:signups]].\nPath: Signups -> Sitemap");
    expect(out).toContain("Checks: citations ok · numbers FAIL (56) · simulated ok · freshness ok");
    expect(out).toContain("4.2s · Meera, Kabir · turn:t");
    expect(out).not.toContain("\x1b[");
  });

  it("colours agents by department when colour is on", () => {
    let out = "";
    const log = workLog({ color: true, write: (s) => { out += s; } });
    log({ type: "agent_start", agent: "data-analyst", task: "x" });
    expect(out).toContain(`\x1b[1;38;5;${hueTo256(230)}mKabir\x1b[0m`);
    expect(hueTo256(0)).not.toBe(hueTo256(160));
  });
});
