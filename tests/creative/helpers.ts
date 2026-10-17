// Fixtures for the creating tools: a business with a brand kit (colours, fonts as real files, a real logo), a fake image engine
// that counts what it was asked and charges credits, and a fake Fact Checker that reads a poster back exactly as it was set.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { ensureRoster } from "../../src/agent/memory.js";
import type { GraphHandle } from "../../src/graph/client.js";
import { upsertEdge, upsertNode } from "../../src/graph/upsert.js";
import { ingestBrandUpload } from "../../src/brand/upload.js";
import { NISHA } from "../../src/creative/compose/check.js";
import { EngineUnavailable, type ClipRequest, type CreativeEngine, type EngineStatus, type GeneratedClip, type GeneratedImage, type ImageRequest } from "../../src/creative/ports.js";
import { sha256Hex } from "../../src/studio/image.js";
import type { AssetStore } from "../../src/studio/store.js";
import { FakeVision, type VisionInput } from "../../src/studio/vision.js";
import { crispLogo } from "../brand/helpers.js";

export const TENANT = "kestrel_oak";
export const BIZ = "business:kestrel-oak";
export const NOW = Date.parse("2026-10-15T09:00:00Z");

export async function seedKit(g: GraphHandle, store: AssetStore, o: { logo?: boolean; fonts?: boolean } = {}): Promise<void> {
  await upsertNode(g, { type: "Business", id: BIZ, name: "Kestrel & Oak", props: { industry: "architecture studio", city: "Bristol", country: "United Kingdom" } }, NOW);
  await upsertNode(g, { type: "Person", id: "person:sam-example", name: "Sam Example", summary: "Founder and owner of Kestrel & Oak." }, NOW);
  await upsertEdge(g, { from: "person:sam-example", type: "MEMBER_OF", to: BIZ }, NOW);
  const colours: Array<[string, string, string]> = [["Background colour", "#f4f1ea", "background"], ["Text colour", "#6b6457", "text"], ["Primary colour", "#a8542e", "primary"], ["Neutral colour", "#191714", "neutral"]];
  for (const [name, hex, role] of colours) await upsertNode(g, { type: "BrandAsset", id: `brand-asset:colour-${hex.slice(1)}`, name: `${name} ${hex}`, props: { kind: "colour", value: hex, role, origin: "website" } }, NOW);
  await upsertNode(g, { type: "BrandAsset", id: "brand-asset:font-fraunces", name: "Fraunces (heading font)", props: { kind: "font", value: "Fraunces", role: "heading", origin: "website" } }, NOW);
  await upsertNode(g, { type: "BrandAsset", id: "brand-asset:font-inter", name: "Inter (body font)", props: { kind: "font", value: "Inter", role: "body", origin: "website" } }, NOW);
  await upsertNode(g, { type: "BrandRule", id: "brand-rule:visual-style", name: "Visual style", summary: "Warm off-white, deep brown-grey text, rust accent; quiet and photographic.", props: { kind: "visual-style" } }, NOW);
  await upsertNode(g, { type: "BrandRule", id: "brand-rule:tone-of-voice", name: "Tone of voice", summary: "Calm, warm and unhurried.", props: { kind: "tone" } }, NOW);
  await upsertNode(g, { type: "Page", id: "page:kestrel.example", name: "Home", props: { url: "https://kestrel.example/" } }, NOW);
  await upsertNode(g, { type: "Channel", id: "channel:instagram", name: "Instagram", props: { handle: "kestrel.oak" } }, NOW);
  if (o.fonts !== false) {
    for (const [family, weight, file] of [["Fraunces", 400, "Fraunces-400.ttf"], ["Fraunces", 700, "Fraunces-700.ttf"], ["Inter", 400, "Inter-400.ttf"], ["Inter", 700, "Inter-700.ttf"]] as const) {
      const bytes = readFileSync(`tests/fixtures/fonts/${file}`);
      const sha = sha256Hex(bytes);
      const key = store.put(TENANT, sha, bytes, "ttf");
      await upsertNode(g, { type: "BrandAsset", id: `brand-asset:font-file-${family.toLowerCase()}-${weight}`, name: `${family} ${weight} (font file)`, props: { kind: "font-file", family, weight, mime: "font/ttf", storageKey: key, sha256: sha, origin: "google-fonts", status: "active" } }, NOW);
    }
  }
  if (o.logo !== false) {
    const vision = new FakeVision({ librarian: { kind: "logo", confidence: 0.95, description: "A rust square with two bars.", containsPerson: false, containsChild: false, colours: [], workOnIt: false } });
    await ingestBrandUpload(g, { tenant: TENANT, businessId: BIZ, bytes: await crispLogo(1600, 520), source: "web", ownerId: "person:sam-example" }, { store, vision, now: NOW });
  }
  await ensureRoster(g, { businessId: BIZ }, NOW);
}

export class FakeCreativeEngine implements CreativeEngine {
  readonly name = "fake";
  readonly generated: ImageRequest[] = [];
  readonly clips: ClipRequest[] = [];
  statusNow: EngineStatus = { ok: true, credits: 500 };
  cost = 1.5;
  clipCost = 7.5;
  failNext = 0;
  async status(): Promise<EngineStatus> { return this.statusNow; }
  async quote(): Promise<number | null> { return this.cost; }
  async quoteClip(): Promise<number | null> { return this.clipCost; }
  async generate(req: ImageRequest): Promise<GeneratedImage> {
    if (!this.statusNow.ok) throw new EngineUnavailable(this.statusNow.reason ?? "error", this.statusNow.plain ?? "not available");
    if (this.failNext > 0) { this.failNext--; throw new Error("the generator crashed"); }
    this.generated.push(req);
    const n = this.generated.length;
    const hue = ["#7a8a6a", "#8a6a5a", "#5a6a8a"][n % 3]!;
    const image = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: hue } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><circle cx="${300 + n * 150}" cy="380" r="${150 + n * 20}" fill="#f0d9a0"/><rect y="700" width="1024" height="324" fill="#2c2018"/></svg>`) }]).jpeg().toBuffer();
    return { image, engine: "fake", model: "fake-image", prompt: req.prompt, jobId: `job-${n}`, credits: this.cost, recorded: false };
  }
  async animate(req: ClipRequest): Promise<GeneratedClip> {
    if (!this.statusNow.ok) throw new EngineUnavailable(this.statusNow.reason ?? "error", this.statusNow.plain ?? "not available");
    this.clips.push(req);
    return { video: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(64, 7)]), engine: "fake", model: "fake-video", jobId: "clip-1", credits: this.clipCost, mime: "video/mp4", seconds: req.seconds };
  }
}

const GOOD = { garbled: false, logoVisible: true, logoIntact: true, extraText: [] as string[], inventedClaims: [] as string[], note: "clean" };

// Fact Checker reads each poster back exactly as the expected text in the prompt says it was set, unless `over` changes an option.
export function nishaReads(over: Record<string, Partial<typeof GOOD> & { textRead?: string }> = {}): (i: VisionInput) => unknown {
  return (input) => ({
    posters: input.images.map((img) => {
      const m = new RegExp(`Poster ${img.label}, expected text:\\n(".*")`).exec(input.prompt);
      const expected = m ? (JSON.parse(m[1]!) as string) : "";
      return { label: img.label, textRead: expected.replace(/\n/g, " "), ...GOOD, ...(over[img.label] ?? {}) };
    }),
  });
}

export const fakeVisionFor = (nisha: (i: VisionInput) => unknown = nishaReads()): FakeVision => new FakeVision({ [NISHA]: nisha });
