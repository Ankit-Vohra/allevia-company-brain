// The committed eval sets parse, cover every job (spec §1: why, growth/SEO, content briefs, ads) plus memory, and only
// name real tools, roster agents and valid regexes.
import { describe, it, expect } from "vitest";
import { AGENTS } from "../../shared/roster.js";
import { ALL_TOOLS } from "../../src/agent/tools/index.js";
import { compilePattern } from "../../evals/scorer.js";
import { findSet, parseSet, selectItems } from "../../evals/set.js";

const sets = { aamdani: findSet("aamdani"), avs: findSet("avs") };
const tools = new Set(ALL_TOOLS.map((t) => t.name));
const agents = new Set(AGENTS.map((a) => a.id));

describe("eval sets", () => {
  it("finds each set by file name and by tenant", () => {
    expect(sets.aamdani.set.tenant).toBe("aamdani");
    expect(sets.avs.set.tenant).toBe("avs_atelier");
    expect(findSet("avs_atelier").path).toBe(sets.avs.path);
    expect(() => findSet("nobody")).toThrow(/No eval set/);
  });

  it("has about 30 aamdani and about 10 avs questions", () => {
    expect(sets.aamdani.set.items.length).toBeGreaterThanOrEqual(28);
    expect(sets.aamdani.set.items.length).toBeLessThanOrEqual(35);
    expect(sets.avs.set.items.length).toBeGreaterThanOrEqual(9);
    expect(sets.avs.set.items.length).toBeLessThanOrEqual(12);
  });

  it("covers the four jobs, memory, who owns/knows, impact, goals, Hindi, a trap and a two-hop question", () => {
    const tags = new Set(sets.aamdani.set.items.flatMap((i) => i.tags));
    for (const t of ["why", "who", "impact", "growth", "seo", "content", "ads", "goals", "memory", "hindi", "hinglish", "trap", "two-hop", "multi-desk"]) {
      expect(tags, t).toContain(t);
    }
    const avs = new Set(sets.avs.set.items.flatMap((i) => i.tags));
    for (const t of ["seo", "content", "ads", "goals", "trap", "hindi"]) expect(avs, t).toContain(t);
    // every ad question demands the word "simulated" (aamdani's ad data is simulated)
    for (const it of sets.aamdani.set.items.filter((i) => i.tags.includes("ads") && i.expect.mustCite.some((c) => c.startsWith("campaign:")))) {
      expect(it.expect.simulated, it.id).toBe(true);
    }
  });

  it("names only real tools and roster agents, and every pattern compiles", () => {
    for (const { set } of Object.values(sets)) {
      for (const it of set.items) {
        for (const t of it.expect.mustUseTools.flatMap((x) => x.split("|"))) expect(tools, `${it.id}: ${t}`).toContain(t);
        for (const a of it.expect.mustUseAgents.flatMap((x) => x.split("|"))) expect(agents, `${it.id}: ${a}`).toContain(a);
        for (const p of [...it.expect.mustMatch, ...it.expect.forbid]) expect(() => compilePattern(p), `${it.id}: ${p}`).not.toThrow();
        expect(it.expect.mustCite.length + it.expect.mustMatch.length, `${it.id} expects something`).toBeGreaterThan(0);
      }
    }
  });

  it("the trap questions accept 'not recorded' and refuse an invented figure", () => {
    const trap = sets.aamdani.set.items.find((i) => i.id === "trap-nps")!;
    const ok = (answer: string) => trap.expect.mustMatch.every((p) => compilePattern(p).test(answer)) && !trap.expect.forbid.some((p) => compilePattern(p).test(answer));
    expect(ok("NPS is not recorded anywhere in the company brain.")).toBe(true);
    expect(ok("We don't have a customer survey on record.")).toBe(true);
    expect(ok("Our NPS is 42, as of the last survey.")).toBe(false);
  });

  it("rejects a malformed set and selects by --only, --tags and --limit", () => {
    expect(() => parseSet("tenant: x\nitems:\n  - id: a\n    question: Why?\n    tags: [why]\n    expect: {}\n  - id: a\n    question: Why again?\n    tags: [why]\n    expect: {}\n")).toThrow(/duplicate id "a"/);
    expect(() => parseSet("tenant: x\nitems:\n  - id: Bad Id\n    question: Why?\n    tags: [why]\n    expect: {}\n")).toThrow(/items\.0\.id/);
    const items = sets.aamdani.set.items;
    expect(selectItems(items, { only: ["trap-nps", "why-stories-paused"] }).map((i) => i.id)).toEqual(["trap-nps", "why-stories-paused"]);
    expect(selectItems(items, { tags: ["trap"] }).every((i) => i.tags.includes("trap"))).toBe(true);
    expect(selectItems(items, { limit: 2 })).toHaveLength(2);
    expect(() => selectItems(items, { only: ["nope"] })).toThrow(/unknown eval id: nope/);
  });
});
