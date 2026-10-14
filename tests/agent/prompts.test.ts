import { describe, it, expect } from "vitest";
import { AGENTS, agentById } from "../../shared/roster.js";
import {
  HOUSE_RULES, PLAN_SCHEMA, agentSystemPrompt, directPrompt, planPrompt, planSystemPrompt, reviewPrompt, revisePrompt,
  synthesisPrompt, workPrompt,
} from "../../src/agent/prompts.js";
import { fakeTool, result, NOW } from "../helpers/agent.js";

const analyst = agentById("data-analyst")!;
const finding = { id: "finding:turn:t1-data-analyst", agent: "data-analyst", text: "Signups fell to 41 [[metric:signups]].", citations: ["metric:signups"] };

describe("prompts", () => {
  it("a department agent's system prompt carries persona, department, tools, date and the house rules", () => {
    const p = agentSystemPrompt(analyst, [fakeTool("metric_trend", result({ data: null }))], { now: NOW, tenant: "aamdani" });
    expect(p).toContain("You are Kabir, Data Analyst in the Analytics department");
    expect(p).toContain(analyst.persona);
    expect(p).toContain("- metric_trend: fake metric_trend");
    expect(p).toContain("Today is 2026-10-15");
    expect(p).toContain('"aamdani"');
    expect(p).toContain(HOUSE_RULES);
    expect(HOUSE_RULES).toMatch(/\[\[id\]\]/);
    expect(HOUSE_RULES).toMatch(/not recorded/);
    expect(HOUSE_RULES).toMatch(/Hindi in, Hindi out/);
  });

  it("the plan prompt lists every desk with its tools and says reviews are automatic", () => {
    const p = planSystemPrompt({ now: NOW, tenant: "aamdani" });
    for (const a of AGENTS) expect(p).toContain(`- ${a.id}:`);
    expect(p).toMatch(/copy editor and fact checker review its work automatically/);
    expect(p).toMatch(/fewest desks/);
    expect(PLAN_SCHEMA.properties.steps.items.properties.agent.enum).toEqual(AGENTS.map((a) => a.id));
    expect(planPrompt({ question: "Why did signups drop?", recall: "" })).toContain("(nothing recorded yet)");
  });

  it("a work prompt hands over dependency findings and names failed dependencies", () => {
    const p = workPrompt({ question: "Why did signups drop?", task: "Find the channel", recall: "- [[turn:old]] earlier", inputs: [finding], failedDeps: ["tech-lead"] });
    expect(p).toContain('The owner asked: "Why did signups drop?"');
    expect(p).toContain("Your task from the Chief of Staff: Find the channel");
    expect(p).toContain("[[turn:old]]");
    expect(p).toContain("### Kabir (Data Analyst) [finding:turn:t1-data-analyst]");
    expect(p).toContain("Arjun (Tech Lead) could not finish");
    expect(p).toMatch(/at most 1200 characters/);
  });

  it("review and revise prompts carry the finding and the notes", () => {
    const r = reviewPrompt({ question: "q", reviewer: agentById("coe-lead")!, finding });
    expect(r).toContain("Review it as CoE Lead");
    expect(r).toContain("the right period");
    expect(r).toContain("It cites: metric:signups");
    const v = revisePrompt({ question: "q", task: "t", finding, notes: [{ reviewer: "coe-lead", verdict: "fix", note: "41 is the week to 2026-10-05" }] });
    expect(v).toContain("- Isha (CoE Lead): fix, 41 is the week to 2026-10-05");
  });

  it("the synthesis prompt shows findings with reviews, marks rejections, names failed desks and requires show_path", () => {
    const p = synthesisPrompt({
      question: "q", recall: "",
      findings: [{ ...finding, reviews: [{ reviewer: "coe-lead", verdict: "ok", note: "checked" }] }, { ...finding, id: "finding:x", agent: "growth-marketer", rejected: true }],
      failed: ["tech-lead"],
    });
    expect(p).toContain("Reviews: Isha (CoE Lead): ok, checked");
    expect(p).toContain("[finding:x] REJECTED");
    expect(p).toContain("Desks that could not finish: Arjun (Tech Lead)");
    expect(p).toMatch(/call show_path once/);
    expect(p).toMatch(/never the finding ids/);
    expect(directPrompt({ question: "q", recall: "" })).toMatch(/call show_path once/);
  });
});
