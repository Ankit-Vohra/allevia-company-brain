// The business's north star: derived from the brain at onboarding, backfilled for the first businesses, corrected by the owner in
// their own words ("our main goal is …") through the same preview-and-OK as "Tell your team", and kept with its history.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeAll, type GraphHandle } from "../../src/graph/client.js";
import { writeBatch } from "../../src/graph/upsert.js";
import { backfillNorthStar } from "../../src/northstar/backfill.js";
import { ctaKindOf, ctaServes, deriveNorthStar, loadNorthStar, mainGoalIn, northStarBlock, outcomeKindOf, saveNorthStar } from "../../src/northstar/northstar.js";
import { applyDirective, parseDirective, previewDirective } from "../../src/settings/directives.js";
import { testGraph } from "../helpers/graph.js";

const NOW = Date.parse("2026-10-17T06:00:00Z");

describe("the owner's words", () => {
  it("reads a main goal said in plain words", () => {
    expect(mainGoalIn("Our main goal is more app downloads")).toEqual({ goal: "more app downloads", kind: "downloads" });
    expect(mainGoalIn("main goal: more people in our cafés")?.kind).toBe("visits");
    expect(mainGoalIn("Our goal is to get more interior project enquiries")).toEqual({ goal: "more interior project enquiries", kind: "enquiries" });
    expect(mainGoalIn("no emojis on LinkedIn")).toBeUndefined();
    expect(outcomeKindOf("more online orders")).toBe("orders");
  });
  it("tells what a call to action asks for, and whether it serves the goal", () => {
    expect(ctaKindOf("Visit app.aamdani.ai")).toBe("website");
    expect(ctaKindOf("Download the app")).toBe("download");
    expect(ctaKindOf("Enquire on WhatsApp")).toBe("enquire");
    expect(ctaKindOf("Visit your nearest café")).toBe("visit");
    const app = { outcomeKind: "downloads" as const, cta: { kind: "download" as const, text: "Download the app" } };
    expect(ctaServes(app, "Visit app.aamdani.ai")).toBe(false);
    expect(ctaServes(app, "Get it on Google Play")).toBe(true);
  });
  it("is a patch the owner confirms, for the whole team", () => {
    const p = parseDirective("Our main goal is more café visits");
    expect(p.unparsed).toEqual([]);
    expect(p.patches).toEqual([{ kind: "north_star.set", text: "Our main goal is more café visits.", goal: "more café visits" }]);
  });
});

describe("the north star in the brain", () => {
  let g: GraphHandle;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    ({ g, cleanup } = await testGraph());
    await writeBatch(g, {
      nodes: [
        { type: "Business", id: "business:aamdani", name: "Aamdani", props: { templateKey: "jobs_platform", industry: "jobs" } },
        { type: "Channel", id: "channel:play-store", name: "Play Store", props: { url: "https://play.google.com/store/apps/details?id=ai.aamdani" } },
        { type: "Audience", id: "audience:job-seekers", name: "Job seekers in Raipur" },
        { type: "Product", id: "product:job-feed", name: "Local job feed" },
        { type: "Goal", id: "goal:weekly-signups", name: "Weekly signups", props: { priority: 1 } },
      ],
      edges: [
        { from: "channel:play-store", type: "PART_OF", to: "business:aamdani" },
        { from: "business:aamdani", type: "PURSUES", to: "goal:weekly-signups" },
      ],
    }, NOW);
  }, 60_000);
  afterAll(async () => { await cleanup(); await closeAll(); });

  it("is derived by code from the template, the app-store link, the audiences and the goals", async () => {
    const ns = await deriveNorthStar(g, { businessId: "business:aamdani" });
    expect(ns).toMatchObject({ outcomeKind: "downloads", outcome: "more app downloads", audiences: ["Job seekers in Raipur"], offer: "Local job feed", source: "onboarding" });
    expect(ns.cta).toEqual({ kind: "download", text: "Download the app", url: "https://play.google.com/store/apps/details?id=ai.aamdani" });
  });

  it("is backfilled from the founder's words, once, and its block names the goals", async () => {
    const r = await backfillNorthStar(g, "aamdani", { now: NOW });
    expect(r.status).toBe("written");
    expect(r.errors).toEqual([]);
    expect((await backfillNorthStar(g, "aamdani", { now: NOW + 1000 })).status).toBe("same");
    const ns = (await loadNorthStar(g))!;
    expect(ns).toMatchObject({ outcome: "more app downloads and sign-ups", source: "backfill", audiences: ["Job seekers looking for local work", "Employers hiring nearby"] });
    expect(ns.cta.url).toMatch(/play\.google\.com/); // the link on record is kept
    expect(ns.sourceRef).toMatch(/^document:north-star-backfill-aamdani/);
    const block = northStarBlock(ns, [{ id: "goal:weekly-signups", name: "Weekly signups", priority: 1 }]);
    expect(block).toContain("Outcome: more app downloads and sign-ups");
    expect(block).toContain("Call to action: Download the app");
    expect(block).toContain("Growth-plan goals: Weekly signups [[goal:weekly-signups]]");
  });

  it("is corrected by the owner (preview, then OK), the old one kept as history, and a later backfill keeps the owner's", async () => {
    const before = (await loadNorthStar(g))!;
    const preview = await previewDirective(g, { text: "Our main goal is more employer sign-ups" }, { llm: null, now: NOW + 2000 });
    expect(preview.diff[0]).toMatchObject({ op: "change", before: "more app downloads and sign-ups", after: "more employer sign-ups" });
    const applied = await applyDirective(g, preview.id, { now: NOW + 3000 });
    expect(applied.errors).toEqual([]);
    const ns = (await loadNorthStar(g))!;
    expect(ns).toMatchObject({ outcome: "more employer sign-ups", outcomeKind: "signups", source: "owner" });
    expect(ns.cta.text).toBe("Sign up free");
    const [old] = await g.roQuery<{ status: string; sup: number }>(
      "MATCH (m:Memory {id:$id}) OPTIONAL MATCH (n:Memory)-[:SUPERSEDES]->(m) WITH m, count(n) AS sup RETURN m.status AS status, sup", { id: before.id });
    expect(old).toEqual({ status: "superseded", sup: 1 });
    expect((await backfillNorthStar(g, "aamdani", { now: NOW + 4000 })).status).toBe("kept-owner");
    // saving the same goal again writes nothing
    expect((await saveNorthStar(g, { ...ns, businessId: "business:aamdani", now: NOW + 5000 })).same).toBe(true);
  });
});
