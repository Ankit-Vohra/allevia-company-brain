// The answer style: the i-have-adhd shape in the owner's plain words (src/agent/style.ts, docs/owner-words.md), and
// that every prompt which writes to the owner carries it without losing the older rules.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { AGENTS, plainWho } from "../../shared/roster.js";
import { ANSWER_SHAPE, DESK_SHAPE, OWNER_WORDS_RULE, clipToItem, ownerJargon } from "../../src/agent/style.js";
import { HOUSE_RULES, agentSystemPrompt, directPrompt, synthesisPrompt, workPrompt } from "../../src/agent/prompts.js";
import { NOW } from "../helpers/agent.js";

const finding = { id: "finding:turn:t1-data-analyst", agent: "data-analyst", text: "Signups fell to 41 [[metric:signups]].", citations: ["metric:signups"] };
const synthesis = synthesisPrompt({ question: "What's waiting on me?", recall: "", findings: [finding], failed: [] });
const direct = directPrompt({ question: "What's waiting on me?", recall: "" });

describe("vendored i-have-adhd", () => {
  it("is kept with its licence and a notice naming the repository, the commit and MIT", () => {
    const dir = new URL("../../vendor/skills/i-have-adhd/", import.meta.url);
    for (const f of ["SKILL.md", "LICENSE", "NOTICE.md"]) expect(existsSync(new URL(f, dir)), f).toBe(true);
    const notice = readFileSync(new URL("NOTICE.md", dir), "utf8");
    expect(notice).toContain("https://github.com/ayghri/i-have-adhd");
    expect(notice).toMatch(/`[0-9a-f]{40}`/);
    expect(notice).toMatch(/MIT/);
    expect(readFileSync(new URL("LICENSE", dir), "utf8")).toMatch(/^MIT License/);
    expect(readFileSync(new URL("SKILL.md", dir), "utf8")).toContain("name: i-have-adhd");
  });
});

describe("the answer shape reaches the Chief's synthesis and direct prompts", () => {
  for (const [name, prompt] of [["synthesis", synthesis], ["direct", direct]] as const) {
    it(`${name}: leads with the answer or next action, numbers steps, ranks at most 5 items, ends on one next action`, () => {
      expect(prompt).toContain(ANSWER_SHAPE);
      expect(ANSWER_SHAPE).toMatch(/First line: the answer, or the one thing to do/);
      expect(ANSWER_SHAPE).toMatch(/numbered list, one small action per step/);
      expect(ANSWER_SHAPE).toMatch(/at most 5 items per group, most important first/);
      expect(ANSWER_SHAPE).toMatch(/The last line is ONE next action the owner can take in under two minutes/);
    });
    it(`${name}: no preamble, recap or closer; real time estimates; wins visible; flat tone for errors`, () => {
      expect(ANSWER_SHAPE).toMatch(/No preamble/);
      expect(ANSWER_SHAPE).toMatch(/no recap/);
      expect(ANSWER_SHAPE).toMatch(/No closer/);
      expect(ANSWER_SHAPE).toMatch(/real time estimates/);
      expect(ANSWER_SHAPE).toMatch(/already done or going well/);
      // citations render as small numbers after a clause: a [[id]] never stands in for a noun
      expect(ANSWER_SHAPE).toMatch(/never stands in for a noun/);
      expect(ANSWER_SHAPE).toContain('Right: "I made one poster option, waiting for your OK. [[asset:…]] [[approval:…]]"');
      expect(ANSWER_SHAPE).toMatch(/No "uh oh"/);
    });
    it(`${name}: the plain-words table is in the prompt`, () => {
      expect(prompt).toContain(OWNER_WORDS_RULE);
      for (const w of ["baseline", "Day 0", "first-pass", "capability", "approval card", "finding", "detector", "agent", "desk"]) expect(OWNER_WORDS_RULE).toContain(w);
      for (const w of ["where you started", "monthly check-in", "waiting for your OK", "what we noticed", "how we know", "sample numbers", "Miss Influencer, content"]) {
        expect(OWNER_WORDS_RULE, w).toContain(w);
      }
    });
    it(`${name}: keeps the older rules (citations, dated numbers, language, simulated and mode disclosure, show_path once)`, () => {
      expect(prompt).toMatch(/Cite \[\[id\]\] for every claim/);
      expect(prompt).toMatch(/Numbers with their dates/);
      expect(prompt).toMatch(/"simulated", "as of <date>" and data-source rules apply \(to the owner, simulated data is "sample numbers"/);
      expect(prompt).toMatch(/call show_path once/);
      expect(prompt).toMatch(/Write the answer exactly once/);
    });
  }
  it("synthesis still carries the data-source disclosure for a mode that is not live", () => {
    const p = synthesisPrompt({ question: "q", recall: "", findings: [finding], failed: [], sources: [{ key: "gbp", name: "Google Business Profile", accessMode: "public" }] });
    expect(p).toContain("Where this data comes from");
    expect(p).toContain("from your public profile or website");
  });
  it("the answer language rule: the question's own language and script, so Hindi in is Hindi out and English in is English out (house rules)", () => {
    expect(HOUSE_RULES).toMatch(/Write in the language and script the owner wrote the question in/);
    expect(HOUSE_RULES).toMatch(/never Hinglish/);
  });
});

describe("the desks write concise, complete, plain findings", () => {
  const work = workPrompt({ question: "q", task: "t", recall: "", inputs: [], failedDeps: [] });
  it("a work prompt: the finding first, at most 5 whole points, never cut mid-item", () => {
    expect(work).toContain(DESK_SHAPE);
    expect(DESK_SHAPE).toMatch(/at most 5 supporting points, most important first/);
    expect(DESK_SHAPE).toMatch(/never stop in the middle of one/);
    expect(work).toMatch(/Every claim cited as \[\[id\]\]/);
  });
  it("the house rules keep the brevity shape and cap lists at 5", () => {
    expect(HOUSE_RULES).toMatch(/the answer first, then bullets \(at most 5 per group\), then one next action/);
    expect(HOUSE_RULES).toMatch(/sample numbers/);
  });
  it("every desk's system prompt names people by name and job in the plain-words rule", () => {
    const p = agentSystemPrompt(AGENTS[2]!, [], { now: NOW, tenant: "aamdani" });
    expect(p).toContain(OWNER_WORDS_RULE);
  });
});

describe("ownerJargon", () => {
  it("finds the words the owner must never read, and skips [[ids]]", () => {
    expect(ownerJargon("Your baseline at Day 0 and the first-pass rate")).toEqual(["baseline", "Day 0", "first-pass"]);
    expect(ownerJargon("An approval card from the Tech desk, a finding from the agent, via the knowledge graph")).toEqual(
      expect.arrayContaining(["approval card", "finding", "agent", "desk", "graph"]));
    expect(ownerJargon("Signups are up, you started at 5. Waiting for your OK: a draft post. [[approval:x]] [[finding:y]]")).toEqual([]);
    expect(ownerJargon("Miss Influencer, content, has 3 ideas. These are sample numbers.")).toEqual([]);
    expect(ownerJargon("Needs a push")).toEqual([]);
    expect(ownerJargon("On track, simulated")).toEqual(["simulated", "on track / at risk / off track"]);
  });
});

describe("plainWho", () => {
  it("is the role name and the team beside it, for every person on the team", () => {
    expect(plainWho("content-strategist")).toBe("Miss Influencer · Content Studio");
    expect(plainWho("oncall-engineer")).toBe("Firefighter · Tech");
    expect(plainWho("qa-release")).toBe("Bug Hunter · Tech");
    expect(plainWho("nobody")).toBe("nobody");
    for (const a of AGENTS) expect(ownerJargon(plainWho(a.id)), a.id).toEqual([]);
  });
});

describe("clipToItem", () => {
  const items = ["- First, the biggest thing: signups fell from 55 to 41 in the week to 2026-10-05. [[metric:signups]]", "- Second: Instagram reach held at 6,000.", "- Third: the sitemap is back."];
  it("returns a text that fits unchanged", () => {
    expect(clipToItem(items.join("\n"), 1_000)).toBe(items.join("\n"));
  });
  it("cuts between items, never inside one, and adds no ellipsis", () => {
    const text = items.join("\n");
    const out = clipToItem(text, items[0]!.length + items[1]!.length + 5);
    expect(out).toBe(`${items[0]}\n${items[1]}`);
    expect(clipToItem(text, items[0]!.length)).toBe(items[0]);
    expect(out.endsWith("…")).toBe(false);
  });
  it("one long item is cut at the last whole sentence", () => {
    const long = "Signups fell. The sitemap broke on 2026-10-05. Fix it first, then re-submit it in Search Console and wait for a crawl.";
    expect(clipToItem(long, 60)).toBe("Signups fell. The sitemap broke on 2026-10-05.");
  });
  it("a single sentence longer than the room is cut at a whole word with an ellipsis, never inside a source tag", () => {
    const sentence = "Signups fell because the sitemap broke and nobody noticed for a long time [[metric:signups-weekly-from-search-console]] and then more";
    const out = clipToItem(sentence, 95);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\[\[[^\]]*…$/);
    expect(out.length).toBeLessThanOrEqual(96);
    expect(sentence.startsWith(out.slice(0, -1))).toBe(true);
  });
});
