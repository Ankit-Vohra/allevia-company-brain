import { describe, it, expect } from "vitest";
import { classifyHook, voiceLint } from "../../src/ingest/sources/playbooks.js";
import { entityId } from "../../src/util/ids.js";

describe("classifyHook", () => {
  const cases: Array<[string, string]> = [
    ["₹40,000 is what one wrong hire cost me.", "Cost Confession"],
    ["Nobody tells you this about getting a job in Raipur.", "Nobody Tells You"],
    ["73% of job seekers never hear back after applying.", "The Statistic"],
    ["Stop sending your resume to every company.", "Negative Command"],
    ["If you are hiring in Raipur, watch this.", "If This, Then Watch"],
  ];
  it.each(cases)("%s -> %s", (caption, name) => {
    expect(classifyHook(caption)).toEqual({ ruleId: entityId("Rule", `hook ${name}`), name });
  });

  it("returns null when no formula matches", () => {
    expect(classifyHook("Good morning Raipur! New openings today.")).toBeNull();
    expect(classifyHook("")).toBeNull();
    expect(classifyHook("   \n ")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(classifyHook("NOBODY TELLS YOU THIS")?.name).toBe("Nobody Tells You");
  });

  it("looks at the opening of a caption, not the body", () => {
    const body = "Good morning Raipur! New openings today.\n\n" + "x ".repeat(200) + "\nNobody tells you this.";
    expect(classifyHook(body)).toBeNull();
  });
});

describe("voiceLint", () => {
  it("flags AI vocabulary with a suggestion", () => {
    const hits = voiceLint("Let's delve into this robust and seamless solution.");
    expect(hits).toContainEqual({ category: "tier1", match: "delve", suggestion: "explore, dig into, look at" });
    expect(hits).toContainEqual({ category: "tier1", match: "robust", suggestion: "strong, reliable, solid" });
    expect(hits.some((h) => h.category === "tier1" && h.match.toLowerCase() === "delve into")).toBe(true);
  });

  it("flags chatbot artifacts, transitions and formulaic openers", () => {
    const hits = voiceLint("Great question! In the rapidly evolving world of hiring, furthermore, we hire fast. I hope this helps.");
    const cats = new Set(hits.map((h) => h.category));
    expect(cats).toContain("chatbot");
    expect(cats).toContain("formulaic-opener");
    expect(cats).toContain("transition");
  });

  it("flags tier-2 words only when two or more share a paragraph", () => {
    expect(voiceLint("We want to foster trust.").filter((h) => h.category === "tier2")).toEqual([]);
    const hits = voiceLint("We foster trust and empower owners.").filter((h) => h.category === "tier2");
    expect(hits.map((h) => h.match).sort()).toEqual(["empower", "foster"]);
    expect(hits.every((h) => typeof h.suggestion === "string")).toBe(true);
  });

  it("does not flag the noun 'features' and leaves clean copy alone", () => {
    expect(voiceLint("Three new features shipped today, and the team fixed the sitemap bug on Tuesday.")).toEqual([]);
    expect(voiceLint("Raipur ke 40 companies hire kar rahi hain. Apply karo aaj hi.")).toEqual([]);
    expect(voiceLint("")).toEqual([]);
  });

  it("reports each distinct hit once", () => {
    const hits = voiceLint("Delve. Delve. DELVE deep. Moreover this. Moreover that.");
    expect(hits.filter((h) => h.category === "tier1" && h.match === "delve")).toHaveLength(1);
    expect(hits.filter((h) => h.category === "transition")).toHaveLength(1);
  });
});
