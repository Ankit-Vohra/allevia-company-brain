// The Studio page's "How this was made" (web/src/lib/lineage.ts): a photo's history told in four plain steps from the lineage read.
// The words are the owner's: no ids, models or edges, costs in Studio credits, the check in Fact Checker's name.
import { describe, expect, it } from "vitest";
import type { Lineage, LineageAsset } from "../../shared/contracts.js";
import { ownerJargon } from "../../src/agent/style.js";
import { lineageStory } from "../../web/src/lib/lineage.js";

const asset = (over: Partial<LineageAsset> & { id: string }): LineageAsset => ({ name: over.id, kind: "variant", mediaType: "image", aiEdited: false, ...over });
const ORIGINAL = asset({ id: "asset:photo", kind: "original", status: "used" });
const A = asset({ id: "asset:a", label: "A", badge: "unchanged", status: "declined" });
const B = asset({ id: "asset:b", label: "B", aiEdited: true, badge: "unchanged", status: "approved" });
const nameOf = (id: string): string | undefined => (id === "fact-checker" ? "Fact Checker" : undefined);

const lineage = (over: Partial<Lineage> = {}): Lineage => ({
  root: ORIGINAL, ancestors: [], descendants: [A, B], steps: [], jobs: [{ assetId: "asset:b", jobId: "job1", model: "gpt_image_2", credits: 6.5, document: "document:higgsfield-job-job1" }], spent: 6.5,
  rules: [{ assetId: "asset:b", ruleId: "brand-rule:tone", name: "Plain, warm words" }, { assetId: "asset:a", ruleId: "brand-rule:tone", name: "Plain, warm words" }],
  reviews: [{ assetId: "asset:b", by: "agent:allevia-fact-checker", verdict: "ok", note: "Building unchanged · same roofline and windows" }, { assetId: "asset:photo", by: "agent:allevia-content-strategist", verdict: "enhance", note: "" }],
  cards: [{ approvalId: "approval:1", status: "approved", title: "Post the photo" }], posts: [{ contentId: "content:p", assetId: "asset:b", name: "Post", status: "draft" }], ...over,
});

describe("lineageStory", () => {
  it("tells it in four steps: your photo, the options, your OK, the post", () => {
    const s = lineageStory(lineage(), nameOf);
    expect(s.steps.map((x) => [x.key, x.state])).toEqual([["photo", "done"], ["options", "done"], ["approved", "done"], ["posted", "done"]]);
    expect(s.steps[0]).toMatchObject({ title: "Your photo", assets: [{ id: "asset:photo", label: "Your photo" }] });
    expect(s.steps[1]!.line).toBe("2 options: A: Free clean-up; B: AI edit, 6.5 Studio credits.");
    expect(s.steps[1]!.assets.map((a) => [a.label, a.check, a.chosen])).toEqual([["A", "ok", false], ["B", "ok", true]]);
    expect(s.steps[2]).toMatchObject({ title: "You said OK", line: "You chose option B." });
    expect(s.steps[3]).toMatchObject({ title: "Saved", line: "Saved as a draft post. Nothing was posted." });
  });

  it("says the cost in Studio credits, the owner's rules once each, and the checker's words in her name", () => {
    const s = lineageStory(lineage(), nameOf);
    expect(s.cost).toBe("About 6.5 Studio credits so far.");
    expect(s.followed).toEqual(["Plain, warm words"]);
    expect(s.checks).toEqual(["Fact Checker on option B: same roofline and windows"]); // Miss Influencer's own read of the photo is not a check of an option
  });

  it("says nothing about cost when nothing was spent, and keeps the plural right for one credit", () => {
    expect(lineageStory(lineage({ spent: 0, jobs: [] }), nameOf).cost).toBeNull();
    expect(lineageStory(lineage({ spent: 1 }), nameOf).cost).toBe("About 1 Studio credit so far.");
  });

  it("before the owner decides: waiting for the OK, nothing posted", () => {
    const s = lineageStory(lineage({ cards: [{ approvalId: "approval:1", status: "pending", title: "Post the photo" }], posts: [], descendants: [A, { ...B, status: "proposed" }] }), nameOf);
    expect(s.steps[2]).toMatchObject({ title: "Your OK", state: "waiting", line: "Waiting for your OK." });
    expect(s.steps[3]).toMatchObject({ state: "none", line: "Nothing is posted until you say OK." });
    expect(s.steps[1]!.assets.some((a) => a.chosen)).toBe(false);
  });

  it("a card turned down is said plainly", () => {
    const s = lineageStory(lineage({ cards: [{ approvalId: "approval:1", status: "rejected", title: "x" }], posts: [] }), nameOf);
    expect(s.steps[2]).toMatchObject({ title: "You said no", line: "You turned it down. Nothing was posted." });
  });

  it("an option the check held back says so, and a clip is counted, not listed as an option", () => {
    const held = asset({ id: "asset:c", label: "C", aiEdited: true, badge: "changed" });
    const clip = asset({ id: "asset:clip", kind: "clip", mediaType: "video", aiEdited: true });
    const s = lineageStory(lineage({ descendants: [A, B, held, clip], posts: [] }), nameOf);
    expect(s.steps[1]!.assets.map((a) => a.label)).toEqual(["A", "B", "C"]);
    expect(s.steps[1]!.assets[2]).toMatchObject({ check: "held", what: "AI edit" });
    expect(s.steps[1]!.line).toContain("1 held back by the check.");
    expect(s.steps[1]!.line).toContain("A 5 second clip was made from one.");
  });

  it("each post status has an owner's sentence", () => {
    const say = (status: string) => lineageStory(lineage({ posts: [{ contentId: "content:p", assetId: "asset:b", name: "Post", status }] }), nameOf).steps[3]!.line;
    expect(say("published")).toBe("Posted.");
    expect(say("scheduled")).toBe("Set to post at the time you chose.");
    expect(say("failed")).toBe("It did not go out.");
    expect(say("dry_run")).toBe("A practice run: it would have posted.");
  });

  it("started from a picture in the middle of the chain, the photo is still the root of the story", () => {
    const s = lineageStory(lineage({ root: B, ancestors: [ORIGINAL], descendants: [] }), nameOf);
    expect(s.steps[0]!.assets[0]!.id).toBe("asset:photo");
  });

  it("uses no word an owner should not meet", () => {
    const s = lineageStory(lineage(), nameOf);
    const words = [...s.steps.flatMap((x) => [x.title, x.line, ...x.assets.map((a) => a.what)]), s.cost ?? "", ...s.followed, ...s.checks].join(" ");
    expect(ownerJargon(words)).toEqual([]);
    expect(words).not.toMatch(/gpt_image|higgsfield|asset:|DERIVED_FROM|job1/i);
  });
});
