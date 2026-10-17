// Shared fixtures for the Studio tests: a synthetic "phone photo" of a building (with EXIF GPS planted, tilted 5°), a
// small brand graph for a made-up studio (Kestrel & Oak, Bristol), and scripted answers for Miss Influencer, Fact Checker and Wordsmith.
import sharp from "sharp";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";

export const BIZ = "business:kestrel-oak";
export const OWNER = "person:sam-example";
export const PROJECT = "content:harbour-house";
export const PAGE = "page:kestrel.example/projects/harbour-house";
export const NOW = Date.parse("2026-10-15T09:00:00Z");

export async function facadePhoto(opts: { tilt?: number; gps?: boolean } = {}): Promise<Buffer> {
  const w = 900, h = 680;
  const bars = Array.from({ length: 7 }, (_, i) => `<rect x="${360 + i * 62}" y="230" width="16" height="300" fill="#2b2620"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="${w}" height="${h}" fill="#8da2b8"/>
    <rect x="320" y="190" width="520" height="380" fill="#dcd6cc"/>
    <rect x="300" y="170" width="560" height="22" fill="#4b3d30"/>
    ${bars}
    <rect x="110" y="380" width="40" height="150" fill="#c9b23a"/>
    <rect x="0" y="570" width="${w}" height="110" fill="#5d7a8a"/>
  </svg>`;
  let img = sharp(Buffer.from(svg)).modulate({ brightness: 0.6 }).tint("#9ab4ff");
  const flat = await img.png().toBuffer();
  const tilted = opts.tilt
    ? await sharp(flat).rotate(opts.tilt, { background: "#8da2b8" }).toBuffer({ resolveWithObject: true }).then(async (r) =>
      sharp(r.data).extract({ left: Math.round((r.info.width - w * 0.86) / 2), top: Math.round((r.info.height - h * 0.86) / 2), width: Math.round(w * 0.86), height: Math.round(h * 0.86) }).png().toBuffer())
    : flat;
  img = sharp(tilted).jpeg({ quality: 88 });
  if (opts.gps !== false) img = img.withExif({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 27/1 0/1" } });
  return img.toBuffer();
}

export async function seedBrand(g: GraphHandle): Promise<void> {
  const t = NOW - 86_400_000;
  await upsertNode(g, { type: "Business", id: BIZ, name: "Kestrel & Oak", props: { industry: "architecture studio", city: "Bristol", country: "United Kingdom" } }, t);
  const colours: Array<[string, string]> = [["Background colour", "#f4f1ea"], ["Text colour", "#6b6457"], ["Primary colour", "#a8542e"], ["Neutral colour", "#191714"]];
  for (const [role, hex] of colours) {
    await upsertNode(g, { type: "BrandAsset", id: `brand-asset:colour-${hex.slice(1)}`, name: `${role} ${hex}`, props: { kind: "colour", value: hex } }, t);
  }
  await upsertNode(g, { type: "BrandAsset", id: "brand-asset:font-fraunces", name: "Fraunces (heading font)", props: { kind: "font", value: "Fraunces" } }, t);
  await upsertNode(g, { type: "BrandRule", id: "brand-rule:tone-of-voice", name: "Tone of voice", summary: "Calm, warm and unhurried.", props: { kind: "tone" } }, t);
  await upsertNode(g, { type: "BrandRule", id: "brand-rule:visual-style", name: "Visual style", summary: "Warm off-white, deep brown-grey text, rust accent.", props: { kind: "visual-style" } }, t);
  await upsertNode(g, { type: "BrandRule", id: "brand-rule:voice-no-hard-sell", name: "No hard sell", summary: "Don't use hard-sell language or urgency.", props: { kind: "voice" } }, t);
  await upsertNode(g, { type: "Rule", id: "rule:fidelity-window-count", name: "Window count", summary: "Never change the number of windows.", props: { kind: "fidelity" } }, t);
  await upsertNode(g, { type: "Person", id: OWNER, name: "Sam Example", summary: "Architect who founded and runs Kestrel & Oak." }, t);
  await upsertNode(g, { type: "Person", id: "person:jo-example", name: "Jo Example", summary: "Designer on the team." }, t);
  await upsertEdge(g, { from: "person:jo-example", type: "MEMBER_OF", to: BIZ }, t);
  await upsertEdge(g, { from: OWNER, type: "MEMBER_OF", to: BIZ }, t);
  await upsertNode(g, { type: "Content", id: PROJECT, name: "Harbour House", summary: "A Victorian terrace opened to the garden.", props: { format: "project" } }, t);
  await upsertNode(g, { type: "Page", id: PAGE, name: "Harbour House — Kestrel & Oak", props: { url: "https://kestrel.example/projects/harbour-house" } }, t);
}

export const TARA_ANSWER = {
  subject: "a two-storey facade with seven tall windows",
  subjectKind: "exterior",
  angle: "Eye level from across the street, rolled to the right.",
  lighting: "Dull and about a stop under, with a cool cast.",
  clutter: "A yellow bin at the left edge.",
  resolution: "Enough for a 1080x1350 post.",
  quality: { tiltDeg: 5, exposure: "under", cast: "cool", sharpness: "sharp" },
  salvageable: ["the window rhythm", "clean roofline"],
  locks: ["seven windows, evenly spaced", "the dark roofline band"],
  verdict: "enhance",
  overlays: [
    { kind: "lock", x: 0.34, y: 0.24, w: 0.6, h: 0.6, note: "the facade and its seven windows" },
    { kind: "privacy", x: 0.1, y: 0.55, w: 0.06, h: 0.2, note: "a person by the gate" },
    { kind: "clutter", x: 1.2, y: 0.5, w: 0.1, h: 0.1, note: "off the frame: dropped" },
    { kind: "nonsense", x: 0.05, y: 0.05, w: 0.1, h: 0.1, note: "unknown kind becomes clutter" },
  ],
  textInImage: [],
  story: "The terrace's tall windows, seen from the street before the garden work.",
  caption: "It's not just a facade, it's a promise. Seven tall windows let the afternoon in. Book now for limited slots!\n\nHarbour House, Bristol",
  altText: "A pale two-storey facade with seven tall dark windows.",
};

export const nishaAnswer = (bChanged: boolean) => ({
  variants: [
    { label: "A", sameBuilding: true, structuralChange: false, added: [], removed: [], note: "straightened and warmed; nothing added" },
    { label: "Variant B", sameBuilding: true, structuralChange: bChanged, added: bChanged ? ["a second roofline"] : [], removed: [], note: bChanged ? "a second roofline appeared" : "relit; nothing added" },
  ],
});

export const DEV_ANSWER = {
  caption: "Nestled on a quiet street, Harbour House seamlessly opens to its garden! Light moves slowly across the seven windows in the afternoon.\n\nHarbour House, Bristol",
  altText: "A pale two-storey facade with seven tall dark windows under a brown roofline.",
  hashtags: ["bristolarchitecture", "#victorianterrace", "x"],
};
