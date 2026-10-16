// The design engine's parts: the copy rules (one idea, nothing said twice), the layout chooser (real material first, never
// the last layout), colour roles held to contrast, the renderer's own measurements (fit, orphans, contrast behind the
// words, a story's covered band), the fixes the code and the review make, and the reel's word timing.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { contrast } from "../../src/creative/compose/palette.js";
import { paletteFrom } from "../../src/creative/compose/palette.js";
import { loadFont } from "../../src/creative/compose/type.js";
import { chooseLayouts, hasDate } from "../../src/creative/design/choose.js";
import { composeDesign } from "../../src/creative/design/compose.js";
import { blockingCopy, prepareCopy, repeats } from "../../src/creative/design/copy.js";
import { codeFix, reviewFix } from "../../src/creative/design/engine.js";
import { DEFAULT_TUNE, LAYOUTS } from "../../src/creative/design/layouts.js";
import { photoPicture, rankMaterial, scenePrompt } from "../../src/creative/design/material.js";
import { closeSharedRenderer, sharedRenderer } from "../../src/creative/design/render.js";
import { colourRoles, designSystem, typeScale } from "../../src/creative/design/system.js";
import { revealTimes, wordGroups } from "../../src/creative/reel/motion.js";

afterAll(async () => { await closeSharedRenderer(); });

const font = (f: string) => loadFont(readFileSync(`tests/fixtures/fonts/${f}`));
const brand = {
  businessName: "Kestrel & Oak", palette: paletteFrom({ paper: "#f4f1ea", ink: "#191714", accent: "#a8542e" }),
  heading: { regular: font("Fraunces-400.ttf"), bold: font("Fraunces-700.ttf") }, body: { regular: font("Inter-400.ttf"), bold: font("Inter-700.ttf") }, logo: null,
};

describe("copy", () => {
  it("refuses the same phrase in the headline and the button, and drops a label that only repeats the headline", () => {
    const old = { headline: "The Aamdani app is coming soon", eyebrow: "Coming soon", cta: "Coming soon on Google Play and the Apple App Store" };
    expect(repeats(old).map((r) => r.phrase)).toContain("coming soon");
    const p = prepareCopy(old);
    expect(p.copy.eyebrow).toBeUndefined(); // the label was noise
    expect(blockingCopy(p.findings).length).toBeGreaterThan(0); // headline and button still say it twice
    const good = prepareCopy({ headline: "Rooms planned around how your family lives!", support: "Interior design in Raipur.", cta: "Book a site visit" });
    expect(good.copy.headline).toBe("Rooms planned around how your family lives"); // the humanizer: no exclamation, no full stop on a headline
    expect(blockingCopy(good.findings)).toHaveLength(0);
    expect(prepareCopy({ headline: "one two three four five six seven eight nine ten" }).findings.map((f) => f.code)).toEqual(expect.arrayContaining(["long", "no-cta"]));
  });
});

describe("choosing layouts", () => {
  const base = { goal: "sell" as const, copy: { headline: "Homes that feel like you", cta: "Book a visit" }, photos: 0, screens: 0, focusScreens: 0, canGenerate: false, recent: [] as string[], count: 3 };
  it("takes the business's real material first and needs what a layout needs", () => {
    const app = chooseLayouts({ ...base, goal: "announce", screens: 2, focusScreens: 1 });
    expect(app[0]!.key).toBe("device-hero");
    expect(app.every((c) => !c.generateScene)).toBe(true);
    const photos = chooseLayouts({ ...base, photos: 3 });
    expect(photos.map((c) => c.key)).toContain("gallery-trio");
    expect(chooseLayouts({ ...base, photos: 2 }).map((c) => c.key)).not.toContain("gallery-trio"); // a portfolio is never part-generated
    const none = chooseLayouts({ ...base, count: 16 });
    expect(none.every((c) => !LAYOUTS.find((l) => l.key === c.key)!.needs.photos && !LAYOUTS.find((l) => l.key === c.key)!.needs.screens)).toBe(true);
    const gen = chooseLayouts({ ...base, canGenerate: true, count: 16 });
    expect(gen.find((c) => c.key === "photo-full-bleed")?.generateScene).toBe(true);
  });
  it("never repeats the layout used last, and keeps a carousel cover for a carousel someone asked for", () => {
    const first = chooseLayouts({ ...base, photos: 3 })[0]!.key;
    expect(chooseLayouts({ ...base, photos: 3, recent: [first] }).map((c) => c.key)).not.toContain(first);
    expect(chooseLayouts({ ...base, count: 16 }).map((c) => c.key)).not.toContain("carousel-cover");
    expect(chooseLayouts({ ...base, prefer: ["carousel-cover"] })[0]!.key).toBe("carousel-cover");
    expect(hasDate({ headline: "x", details: ["Sat 26 Oct, 11am"] })).toBe(true);
  });
});

describe("design system", () => {
  it("reads roles from a palette with none named, and holds every text pairing to contrast", () => {
    const c = colourRoles(paletteFrom({ extra: ["#4a6741", "#c8a23d", "#fdfcf6", "#1a3c34"] }), ["#4a6741", "#c8a23d", "#fdfcf6", "#1a3c34"], { paper: false, ink: false, accent: false });
    expect(c.ground).toBe("#fdfcf6");
    expect(c.ink).toBe("#1a3c34");
    expect(c.accent).toBe("#c8a23d"); // the most colourful
    expect(contrast(c.ink, c.ground)).toBeGreaterThanOrEqual(7);
    expect(contrast(c.muted, c.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.accentInk, c.ground)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onAccent, c.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.onDeep, c.deep)).toBeGreaterThanOrEqual(7);
    expect(typeScale("insta_portrait").min).toBe(32);
  });
});

describe("rendering and measuring", () => {
  it("sets real type in a layout, and the code sees fit, contrast and the story's covered band", async () => {
    const ds = await designSystem(brand, ["#f4f1ea", "#191714", "#a8542e"], "insta_portrait");
    const photo = await photoPicture(await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#d9cdb8" } }).jpeg().toBuffer(), { label: "The studio" });
    const r = await composeDesign({ layout: "editorial-frame", format: "insta_portrait", copy: { headline: "Homes that feel like you", support: "One team from sketch to handover.", cta: "Book a visit at kestrel.example" }, photos: [photo], screens: [], tune: DEFAULT_TUNE }, ds, sharedRenderer());
    expect((await sharp(r.jpeg).metadata()).width).toBe(1080);
    const head = r.boxes.find((b) => b.role === "headline")!;
    expect(head.fontSize).toBeGreaterThan(70);
    expect(head.contrast!).toBeGreaterThanOrEqual(4.5);
    expect(r.findings.filter((f) => f.blocking)).toEqual([]);
    expect(r.manifest.texts.map((t) => t.role)).toEqual(expect.arrayContaining(["headline", "support", "cta"]));
    // a headline that cannot fit is reported, never cut off
    const long = await composeDesign({ layout: "big-type", format: "insta_square", copy: { headline: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") }, photos: [], screens: [], tune: DEFAULT_TUNE }, ds, sharedRenderer());
    expect(long.findings.some((f) => f.code === "fit" && f.blocking)).toBe(true);
    // pale words on a pale photo are measured as such
    const pale = await composeDesign({ layout: "photo-full-bleed", format: "insta_story", copy: { headline: "Light rooms" }, photos: [await photoPicture(await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#ffffff" } }).jpeg().toBuffer())], screens: [], tune: { ...DEFAULT_TUNE, scrim: 0 } }, { ...ds, colour: { ...ds.colour, deep: "#f0f0f0", onDeep: "#ffffff" } }, sharedRenderer());
    expect(pale.findings.some((f) => f.code === "contrast")).toBe(true);
  }, 60_000);

  it("the code's and the review's fixes are concrete, and never drop the news an announcement exists for", () => {
    const spec = { layout: "device-hero" as const, format: "insta_portrait" as const, copy: { headline: "x", eyebrow: "On Google Play next week", support: "y", keep: ["eyebrow" as const] }, photos: [], screens: [], tune: DEFAULT_TUNE };
    const f = codeFix([{ code: "overflow", role: "headline", detail: "the headline runs out of its space", blocking: true }], spec);
    expect(f!.tune.dropSupport).toBe(true);
    const g = codeFix([{ code: "overflow", role: "headline", detail: "d", blocking: true }], { ...spec, tune: { ...DEFAULT_TUNE, dropSupport: true } });
    expect(g!.tune.dropEyebrow).toBe(false); // protected: it shrinks the headline instead
    expect(g!.tune.scale).toBeLessThan(1);
    const review = { label: "A", scores: {} as never, issues: [{ code: "crowded" as const, detail: "busy" }], takeaway: "", verdict: "revise" as const, mean: 3, reviewed: true };
    expect(reviewFix(review, spec, 0)!.tune.dropEyebrow).toBe(false);
    expect(reviewFix({ ...review, issues: [{ code: "words_hard_to_read", detail: "" }] }, spec, 1)!.tune.scrim).toBe(2);
    expect(reviewFix({ ...review, issues: [{ code: "bad_crop", detail: "" }] }, spec, 0)).toBeNull(); // nothing to re-crop on an app screen
  });
});

describe("material and reels", () => {
  it("ranks the business's own pictures by what is sold, people last, and writes a scene prompt for this place", () => {
    const rows = [
      { id: "a", kind: "product-photo", name: "Product photo: a kitchen", summary: null, storageKey: "k", crop: null, focus: null, containsPerson: true, status: null },
      { id: "b", kind: "product-photo", name: "Product photo: a bedroom", summary: "bedroom interior design", storageKey: "k", crop: null, focus: null, containsPerson: null, status: null },
    ];
    expect(rankMaterial(rows, "Interior design for a bedroom")[0]!.id).toBe("b");
    const p = scenePrompt({ business: "Aamdani", industry: "jobs", city: "Raipur", country: "India", idea: "a young man at a tea stall", aspect: "4:5", calm: "bottom" });
    expect(p).toMatch(/Raipur, India/);
    expect(p).toMatch(/no letters/);
    expect(p).toMatch(/back or the edge/);
  });
  it("reveals a line a few words at a time at reading pace, breaking at punctuation", () => {
    expect(wordGroups("Light first: the bed faces the window")).toEqual(["Light first:", "the bed faces", "the window"]);
    const t = revealTimes(wordGroups("Colour that calms, chosen with you"), 3);
    expect(t[0]).toBe(0.15);
    expect(t[t.length - 1]!).toBeLessThan(3 * 0.7);
  });
});
