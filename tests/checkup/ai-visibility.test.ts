import { describe, expect, it } from "vitest";
import type { LlmRunner, StructuredInput } from "../../src/ingest/llm.js";
import {
  HONEST_NOTE, aiVisibilityReport, aiVisibilityWrite, brandNames, checkAiVisibility, customerQuestions, matchAnswer, mentionSpans,
  type AiBusiness,
} from "../../src/checkup/ai-visibility.js";

const AVS: AiBusiness = { name: "AV's Atelier", domain: "avsatelier.in", category: "interior architect", city: "Raipur" };

const fake = (answers: Array<{ answer: string; named: string[] } | Error>): LlmRunner & { calls: StructuredInput[] } => {
  const calls: StructuredInput[] = [];
  return {
    calls,
    async structured(input) {
      calls.push(input);
      const a = answers[calls.length - 1];
      if (!a || a instanceof Error) throw a ?? new Error("no more answers");
      return a;
    },
  };
};

describe("questions", () => {
  it("asks what a customer would ask, the same way every run", () => {
    const qs = customerQuestions(AVS);
    expect(qs[0]).toBe("Who is the best interior architect in Raipur?");
    expect(qs[1]).toBe("Can you recommend an interior architect in Raipur?");
    expect(qs).toHaveLength(4);
    expect(customerQuestions(AVS)).toEqual(qs);
    expect(customerQuestions({ name: "Aamdani", category: "AI hiring platform" })[0]).toBe("What is the best AI hiring platform?");
  });
});

describe("matching (open-seo method)", () => {
  it("matches the name, the domain and its stem on word boundaries, accents and case ignored", () => {
    expect(brandNames(AVS)).toEqual(["AV's Atelier", "avsatelier.in", "avsatelier"]);
    expect(mentionSpans("Try av's   ATELIER on VIP Road", brandNames(AVS))).toHaveLength(1);
    expect(mentionSpans("see AVSAtelier for details", brandNames(AVS))).toHaveLength(1);
    expect(mentionSpans("the bavsatelierx studio", brandNames(AVS))).toHaveLength(0);
    expect(mentionSpans("Café Décor", ["cafe decor"])).toHaveLength(1);
  });
  it("does not count a URL or an e-mail as a mention by name, but a link to the site is 'cited'", () => {
    const a = matchAnswer("q", "Visit https://www.avsatelier.in/projects for photos.", [], AVS);
    expect(a.mentioned).toBe(false);
    expect(a.cited).toBe(true);
  });
  it("ranks the business among the others named, by first mention", () => {
    const a = matchAnswer("q", "1. Studio Tara. 2. AV's Atelier. 3. Raipur Interiors.", ["Studio Tara", "AV's Atelier", "Raipur Interiors"], AVS);
    expect(a.mentioned).toBe(true);
    expect(a.position).toBe(2);
    expect(a.others).toEqual(["Studio Tara", "Raipur Interiors"]);
  });
});

describe("checkAiVisibility", () => {
  it("asks each question once on the subscription model and counts only answered questions", async () => {
    const runner = fake([
      { answer: "I don't have reliable information on firms in Raipur; check Justdial and Google Maps reviews.", named: [], platforms: ["Justdial", "Google Maps"] } as { answer: string; named: string[] },
      { answer: "Studio Tara and Raipur Interiors are well known.", named: ["Studio Tara", "Raipur Interiors"] },
      new Error("timed out"),
      { answer: "AV's Atelier (avsatelier.in) is known for fibre installations.", named: ["AV's Atelier"] },
    ]);
    const run = await checkAiVisibility(AVS, runner, { now: () => Date.parse("2026-10-15T09:00:00Z") });
    expect(runner.calls).toHaveLength(4);
    expect(runner.calls[0]!.prompt).toBe("Who is the best interior architect in Raipur?");
    expect(runner.calls[0]!.system).not.toContain("AV's Atelier"); // never leads the model to the answer
    expect(run.asked).toBe(4);
    expect(run.answered).toBe(3);
    expect(run.mentioned).toBe(1);
    expect(run.mentionPct).toBe(33);
    expect(run.answers[2]!.error).toBe("timed out");

    const text = aiVisibilityReport(run, { mentionPct: 0, asOf: "2026-09-15T09:00:00Z" });
    expect(text.split("\n")[0]).toBe("Claude named AV's Atelier in 1 of 3 answers.");
    expect(text).toContain("Last time (2026-09-15) it was 0% of answers; now 33%.");
    expect(text).toContain("no answer (not counted)");
    expect(text).toContain("Firms named instead: Raipur Interiors (1), Studio Tara (1).");
    expect(text).toContain(HONEST_NOTE);
    expect(text).toContain("It also sent people to: Google Maps, Justdial.");

    const w = aiVisibilityWrite(run, "business:avs");
    expect(w.nodes[0]!.props!.checkup).toBe("ai-visibility");
    expect(w.observations.find((o) => o.metric === "ai_mention_pct")).toMatchObject({ subject: "business:avs", value: 33, src: w.nodes[0]!.id });
  });

  it("says plainly when AI does not know the business, with what helps", async () => {
    const run = await checkAiVisibility(AVS, fake(Array.from({ length: 4 }, () => ({ answer: "Studio Tara is popular.", named: ["Studio Tara"] }))));
    const text = aiVisibilityReport(run);
    expect(text.split("\n")[0]).toBe("AI does not know AV's Atelier yet: Claude named you in 0 of 4 answers.");
    expect(text).toMatch(/What helps:/);
  });

  it("never invents a percentage when nothing was answered", async () => {
    const run = await checkAiVisibility(AVS, fake([new Error("x"), new Error("x"), new Error("x"), new Error("x")]));
    expect(run.mentionPct).toBeNull();
    expect(aiVisibilityWrite(run, "business:avs").observations.map((o) => o.metric)).toEqual(["ai_questions_answered"]);
  });
});
