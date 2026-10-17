// What the owner drops into the brand library (Discord's #studio or #your-team, or the web app): a logo, a palette, a font,
// a brand guide PDF, a product photo, a past design. The rules, in order:
//   1. what a file is comes from its bytes (sniff.ts), never its name or a claimed type; unknown files are refused;
//   2. size limits per kind (checked before anything is decoded);
//   3. images are re-encoded without metadata (EXIF, GPS, XMP, ICC all gone), auto-oriented, capped at 4096 px; an SVG is
//      drawn to a PNG and never kept (a stored SVG could carry script), and an SVG that runs script or fetches anything
//      is refused; WOFF fonts are refused (the poster composer needs the .ttf or .otf);
//   4. Claude vision (Memory Keeper, the librarian) says what an image is; a child's photo is refused and nothing is kept;
//   5. the file is stored under data/assets/<tenant>/ by content address, and a BrandAsset node is written (OWNED by the
//      business, AUTHORED by the owner, a new logo SUPERSEDES the old one). Nothing from a Discord person is stored but
//      the owner entity the caller passes.
// A photo the owner wants worked on ("make this look better") is not brand material: the caller sends it to the Studio.
// Messages are for the owner: plain words, one next step (docs/owner-words.md).
import sharp from "sharp";
import { agentNodeId, ensureRoster } from "../agent/memory.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { sha256Hex } from "../studio/image.js";
import type { AssetStore } from "../studio/store.js";
import type { VisionRunner } from "../studio/vision.js";
import { entityId } from "../util/ids.js";
import { classifyImage, LIBRARIAN, readGuide, type ImageVerdict } from "./classify.js";
import { activeLogo, type BrandKind } from "./library.js";
import { logoQuality, type LogoQuality } from "./quality.js";
import { fontFamilyName, fontWeight, sniffType, type FileType } from "./sniff.js";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_SVG_BYTES = 1024 * 1024;
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_FONT_BYTES = 5 * 1024 * 1024;
export const MAX_PIXELS = 50_000_000;
export const MIN_SIDE = 32;
export const MAX_SIDE = 4096;
export const SVG_WIDTH = 2048;

export class BrandUploadRejected extends Error {
  override name = "BrandUploadRejected";
}

export interface BrandUploadInput {
  tenant: string;
  businessId: string;
  bytes: Buffer;
  filename?: string;
  note?: string;
  ownerId?: string | null;
  source: "discord" | "web";
  // "library" (default): the owner is filing brand material, so a product photo is kept. "any": a photo dropped in a chat
  // channel, where a product photo or an unknown picture is more likely to be for the Studio, which keeps its own,
  // privacy-checked copy (people and plates blurred): the library keeps nothing of it.
  intent?: "library" | "any";
}

export interface BrandUploadDeps { store: AssetStore; vision: VisionRunner; now: number; model?: string }

export interface BrandAssetRecord {
  id: string; kind: BrandKind; storageKey: string; mime: string; w?: number; h?: number; sha256: string; bytes: number;
}

export type BrandUploadResult =
  | { route: "brand"; asset: BrandAssetRecord; kind: BrandKind; message: string; needsBetter: boolean; verdict?: ImageVerdict }
  | { route: "studio"; asset: null; kind: BrandKind; message: string; needsBetter: false; verdict: ImageVerdict };

const mb = (n: number): string => `${Math.round(n / (1024 * 1024))} MB`;
const tooLarge = (what: string, max: number): BrandUploadRejected => new BrandUploadRejected(`That ${what} is too large: send one under ${mb(max)}.`);

// An SVG that runs script or reaches outside itself is refused, not cleaned: the owner can send the artwork as a PNG.
export function checkSvg(text: string): void {
  if (/<script[\s>]|<!ENTITY|<foreignObject|\son[a-z]+\s*=/i.test(text) || /(?:xlink:)?href\s*=\s*["'](?!#|data:image\/(?:png|jpe?g|webp);)/i.test(text) || /url\(\s*["']?(?!#)/i.test(text)) {
    throw new BrandUploadRejected("That SVG has scripts or links to other files in it, so I didn't open it. Send the logo as a PNG instead, or export a plain SVG.");
  }
}

export interface Prepared { buffer: Buffer; ext: "png" | "jpg" | "webp"; mime: "image/png" | "image/jpeg"; w: number; h: number; convertedFrom?: "svg" }

export async function prepareImage(bytes: Buffer, type: FileType): Promise<Prepared> {
  const damaged = new BrandUploadRejected("That file looks damaged: it didn't finish uploading or the file is broken. Send it again.");
  try {
    if (type === "svg") {
      const text = bytes.toString("utf8");
      checkSvg(text);
      const probe = await sharp(bytes, { density: 72, limitInputPixels: MAX_PIXELS }).metadata();
      const density = Math.min(1200, Math.max(72, Math.round((72 * SVG_WIDTH) / Math.max(1, probe.width ?? 100))));
      const { data, info } = await sharp(bytes, { density, limitInputPixels: MAX_PIXELS }).resize({ width: SVG_WIDTH, withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true });
      return { buffer: data, ext: "png", mime: "image/png", w: info.width, h: info.height, convertedFrom: "svg" };
    }
    const meta = await sharp(bytes, { limitInputPixels: false }).metadata();
    const w0 = meta.width ?? 0, h0 = meta.height ?? 0;
    if (!w0 || !h0) throw damaged;
    if (w0 * h0 > MAX_PIXELS) throw new BrandUploadRejected(`That image is too large (${w0}×${h0}). Send one under ${Math.round(MAX_PIXELS / 1e6)} megapixels.`);
    if (Math.min(w0, h0) < MIN_SIDE) throw new BrandUploadRejected(`That image is too small (${w0}×${h0}) to use. Send one at least ${MIN_SIDE} pixels on its short side.`);
    // transparency is kept (a logo needs it); sharp drops EXIF, XMP, IPTC and ICC unless asked to keep them
    const pipeline = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true }).toColourspace("srgb");
    const keepsPng = type === "png" || meta.hasAlpha === true;
    const { data, info } = keepsPng
      ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
      : await pipeline.jpeg({ quality: 90, chromaSubsampling: "4:4:4" }).toBuffer({ resolveWithObject: true });
    return keepsPng
      ? { buffer: data, ext: "png", mime: "image/png", w: info.width, h: info.height }
      : { buffer: data, ext: "jpg", mime: "image/jpeg", w: info.width, h: info.height };
  } catch (e) {
    if (e instanceof BrandUploadRejected) throw e;
    throw damaged;
  }
}

const KIND_OF: Record<string, BrandKind> = {
  logo: "logo", palette: "palette", font_sample: "font-sample", product_photo: "product-photo", app_screen: "app-screen", past_design: "past-design", other: "other",
};

function limitFor(type: FileType): { what: string; max: number } {
  if (type === "pdf") return { what: "file", max: MAX_PDF_BYTES };
  if (type === "ttf" || type === "otf") return { what: "font", max: MAX_FONT_BYTES };
  if (type === "svg") return { what: "SVG", max: MAX_SVG_BYTES };
  return { what: "image", max: MAX_IMAGE_BYTES };
}

const NOT_ALLOWED = "I can use pictures (PNG, JPEG, WebP or SVG), fonts (.ttf or .otf) and PDFs here. That file is none of those, so I left it alone.";

export async function ingestBrandUpload(g: GraphHandle, input: BrandUploadInput, deps: BrandUploadDeps): Promise<BrandUploadResult> {
  const { bytes } = input;
  if (!bytes.length) throw new BrandUploadRejected("That file arrived empty. Try sending it again.");
  // the hard ceiling first: nothing larger than the biggest allowed kind is even looked at
  if (bytes.length > MAX_PDF_BYTES) throw tooLarge("file", MAX_PDF_BYTES);
  const type = sniffType(bytes);
  if (type === "unknown") throw new BrandUploadRejected(NOT_ALLOWED);
  if (type === "woff" || type === "woff2") throw new BrandUploadRejected("I can't use that font format for posters yet. Send the .ttf or .otf file of the same font.");
  const lim = limitFor(type);
  if (bytes.length > lim.max) throw tooLarge(lim.what, lim.max);

  const asOf = new Date(deps.now).toISOString().slice(0, 10);
  const note = (input.note ?? "").trim().slice(0, 500);
  const common = { origin: "upload", source: input.source, uploadedAt: deps.now, status: "active", ...(note ? { note } : {}) };

  const owns = async (id: string): Promise<void> => {
    await upsertEdge(g, { from: input.businessId, type: "OWNS", to: id, src: `upload:${input.source}`, asOf }, deps.now);
    if (input.ownerId) await upsertEdge(g, { from: input.ownerId, type: "AUTHORED", to: id, props: { via: `${input.source}-upload` }, src: `upload:${input.source}`, asOf }, deps.now).catch(() => undefined);
  };
  const keep = async (o: {
    kind: BrandKind; buffer: Buffer; ext: "png" | "jpg" | "pdf" | "ttf" | "otf"; mime: string; w?: number; h?: number; name: string; summary: string;
    props?: Record<string, string | number | boolean | string[]>;
  }): Promise<BrandAssetRecord> => {
    const sha256 = sha256Hex(o.buffer);
    const storageKey = deps.store.put(input.tenant, sha256, o.buffer, o.ext);
    const id = entityId("BrandAsset", `${o.kind} ${sha256.slice(0, 12)}`);
    await upsertNode(g, {
      type: "BrandAsset", id, name: o.name, summary: o.summary, src: `upload:${input.source}`, asOf,
      props: { kind: o.kind, mediaType: o.ext === "pdf" ? "document" : o.ext === "ttf" || o.ext === "otf" ? "font" : "image", mime: o.mime, bytes: o.buffer.length, sha256, storageKey,
        ...(o.w ? { w: o.w } : {}), ...(o.h ? { h: o.h } : {}), metadataStripped: o.ext === "png" || o.ext === "jpg", ...common, ...(o.props ?? {}) },
    }, deps.now);
    await owns(id);
    return { id, kind: o.kind, storageKey, mime: o.mime, ...(o.w ? { w: o.w } : {}), ...(o.h ? { h: o.h } : {}), sha256, bytes: o.buffer.length };
  };

  // ----- fonts: known from the bytes, no model call -----
  if (type === "ttf" || type === "otf") {
    const family = fontFamilyName(bytes);
    if (!family) throw new BrandUploadRejected("I couldn't read that font file. Send the .ttf or .otf again, or tell me the font's name.");
    // what the font is for, when the owner's note says ("for headlines", "body text"); its weight from the file itself
    const note = (input.note ?? "").toLowerCase();
    const role = /head|display|title|logo/.test(note) ? "heading" : /body|text|paragraph/.test(note) ? "body" : undefined;
    const weight = fontWeight(bytes);
    const asset = await keep({ kind: "font", buffer: bytes, ext: type, mime: type === "ttf" ? "font/ttf" : "font/otf", name: `${family} (font file)`, summary: `The ${family} font file the owner sent.`, props: { family, format: type, ...(weight ? { weight } : {}), ...(role ? { role } : {}) } });
    return { route: "brand", asset, kind: "font", needsBetter: false, message: `Got your font, ${family}. Posters will use it for ${role === "heading" ? "headlines" : role === "body" ? "body text" : "headlines and text"}.` };
  }

  // ----- a brand guide PDF -----
  if (type === "pdf") {
    const read = await readGuide(deps.vision, bytes, deps.model);
    const colours = read?.colours ?? [];
    const asset = await keep({
      kind: "guide", buffer: bytes, ext: "pdf", mime: "application/pdf", name: "Brand guide", summary: read?.summary || "A brand guide the owner sent.",
      props: { guideRead: !!read, ...(colours.length ? { guideColours: colours } : {}), ...(read?.fonts.length ? { guideFonts: read.fonts } : {}), ...(read?.summary ? { description: read.summary } : {}) },
    });
    const said = read
      ? `Saved your brand guide.${colours.length ? ` I read these colours in it: ${colours.join(", ")}.` : ""}${read.fonts.length ? ` Fonts: ${read.fonts.join(", ")}.` : ""}`
      : "Saved your brand guide, but I couldn't read it (it may be scanned or locked), so I'm not using it yet. If you tell me the colours and fonts, I will.";
    return { route: "brand", asset, kind: "guide", needsBetter: false, message: said };
  }

  // ----- pictures -----
  const img = await prepareImage(bytes, type);
  const verdict = await classifyImage(deps.vision, { image: img.buffer, ...(note ? { note } : {}), ...(input.filename ? { filename: input.filename } : {}), ...(deps.model ? { model: deps.model } : {}) });
  if (verdict.containsChild) {
    throw new BrandUploadRejected("This picture shows a child, so I can't keep it or use it. Nothing was saved. Send one without a child in it.");
  }
  const kind = KIND_OF[verdict.kind] ?? "other";
  if ((kind === "product-photo" || kind === "other") && (verdict.workOnIt || input.intent === "any")) {
    return { route: "studio", asset: null, kind, needsBetter: false, verdict, message: "This one is for editing, so I'm handing it to the Studio." };
  }

  let quality: LogoQuality | undefined;
  if (kind === "logo") quality = await logoQuality(img.buffer);
  const needsBetter = !!quality && (quality.lowRes || quality.blurry);
  const display = kind === "logo" ? "Logo" : kind === "palette" ? "Colour palette" : kind === "product-photo" ? "Product photo" : kind === "app-screen" ? "App screen" : kind === "past-design" ? "Past design" : kind === "font-sample" ? "Font sample" : "Brand file";
  const asset = await keep({
    kind, buffer: img.buffer, ext: img.ext as "png" | "jpg", mime: img.mime, w: img.w, h: img.h,
    name: `${display}: ${verdict.description.slice(0, 60) || img.w + "×" + img.h}`, summary: verdict.description || `${display} the owner sent.`,
    props: {
      description: verdict.description, confidence: verdict.confidence, classifiedBy: agentNodeId(LIBRARIAN),
      ...(verdict.colours.length ? { colours: verdict.colours } : {}), ...(verdict.containsPerson ? { containsPerson: true } : {}),
      ...(img.convertedFrom ? { convertedFrom: img.convertedFrom, step: "svg-to-png" } : {}),
      ...(quality ? { hasAlpha: quality.hasAlpha, sharpness: quality.sharpness, lowRes: quality.lowRes, blurry: quality.blurry, needsBetter } : {}),
    },
  });
  await ensureRoster(g, { businessId: input.businessId }, deps.now).catch(() => undefined);
  await upsertEdge(g, { from: agentNodeId(LIBRARIAN), type: "REVIEWED", to: asset.id, src: `upload:${input.source}`, asOf }, deps.now).catch(() => undefined);

  if (kind === "logo") {
    // The newest uploaded logo is the one in use; what it replaces stays as history.
    const rows = await g.roQuery<{ id: string }>(
      "MATCH (a:BrandAsset) WHERE a.kind = 'logo' AND coalesce(a.status, 'active') = 'active' AND a.id <> $id RETURN a.id AS id ORDER BY a.id LIMIT 50", { id: asset.id });
    for (const old of rows) {
      await upsertNode(g, { type: "BrandAsset", id: old.id, name: (await g.roQuery<{ n: string }>("MATCH (a:Entity:BrandAsset {id:$id}) RETURN a.name AS n", { id: old.id }))[0]?.n ?? old.id, props: { status: "superseded" } }, deps.now);
      await upsertEdge(g, { from: asset.id, type: "SUPERSEDES", to: old.id, src: `upload:${input.source}`, asOf }, deps.now).catch(() => undefined);
    }
  }
  void activeLogo; // (kept next to the code that decides which logo is in use)

  const parts: string[] = [];
  if (kind === "logo") {
    parts.push(img.convertedFrom ? "Got your logo (I turned the SVG into a sharp PNG). I'll put it on every poster and ad." : "Got your logo. I'll put it on every poster and ad.");
    if (needsBetter) {
      parts.push(quality!.lowRes
        ? `It is small (${quality!.w} px wide), so it may look soft on a big poster. If you have a bigger file, an SVG or a PDF logo, send it here and I'll use that instead.`
        : "It looks a little blurry, so it may look soft on a big poster. If you have a sharper file or an SVG, send it here and I'll use that instead.");
    }
  } else if (kind === "palette") {
    parts.push(verdict.colours.length ? `Got your colours: ${verdict.colours.join(", ")}. I'll use them on posters.` : "Saved your colour picture. I couldn't pick out exact colours from it, so tell me the main ones if you want them used.");
  } else if (kind === "product-photo") parts.push("Saved your product photo with your brand pictures. I can use it in posters and ads.");
  else if (kind === "app-screen") parts.push("Saved your app screen. Posters and reels about the app will show this real screen in a phone, never a drawn one.");
  else if (kind === "past-design") parts.push("Saved your past design. I'll use it to match your style when I make new ones.");
  else if (kind === "font-sample") parts.push("Saved your font picture. If you send the font file (.ttf or .otf), I'll use that font on posters.");
  else parts.push("Saved it with your brand files. I'm not sure what it's for, so tell me what to do with it.");
  if (verdict.containsPerson) parts.push("A person is in this picture, so I'll only use it as it is and won't send it to an image generator.");
  return { route: "brand", asset, kind, message: parts.join(" "), needsBetter, verdict };
}
