// make a poster, end to end: the brand kit, the claims check, the artwork (generated through the capped engine, taken from
// the owner's own photo, or none), two or three layouts composed by code, Nisha's check of each, and the deliverable
// (assets with lineage and a card waiting for the owner). Whatever cannot be done is said in plain words and the rest is
// still delivered: with no engine, credits or CLI the layouts stand on a solid or gradient ground in the brand's colours,
// and the result says exactly that. Never a fake result: a picture the engine did not make is never described as one it did.
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { checkPosters, groundClaims, type OptionVerdict } from "./compose/check.js";
import {
  composePoster, layoutOrder, PosterFontMissing, PosterTextDoesNotFit, type ComposedPoster, type LayoutKey, type Occasion, type PosterContent,
} from "./compose/compose.js";
import { FORMATS, type FormatKey } from "./compose/formats.js";
import { saveArtwork, saveDeliverable, type OptionToSave, type SaveDeps, type SavedDeliverable } from "./deliverable.js";
import { loadComposeKit, type ComposeKit } from "./kit.js";
import { makeArtworks } from "./artwork.js";
import type { CreativeDeps } from "./ports.js";

export const MAX_OPTIONS = 3;

export type ArtworkSource = "generate" | "none" | { photoAssetId: string };

export interface PosterRequest {
  tenant: string;
  businessId: string;
  agentId: string;
  turnId: string;
  now: number;
  question: string;                // the owner's own words: what claims may be grounded in
  content: PosterContent;
  format: FormatKey;
  occasion: Occasion;
  count: number;
  scenes?: string[];               // what the artwork shows, one per option (generated artwork only)
  artwork: ArtworkSource;
  caption?: string;
}

// The request could not be made as asked; `plain` says why in the owner's words and what to change.
export class PosterRefused extends Error {
  override name = "PosterRefused";
  constructor(readonly code: "claims" | "fit" | "font" | "photo" | "engine", readonly plain: string) {
    super(plain);
  }
}

export interface PosterResult {
  saved: SavedDeliverable;
  notes: string[];                 // honest remarks for the owner (no logo file, a plain ground, a held option ...)
  hfCredits: number;               // what the image engine charged for this poster
  generated: number;               // artworks the engine made now
  layouts: string[];
  verdicts: OptionVerdict[];
}

const ARTWORK_VARIATIONS = ["", " A different angle and composition from the usual.", " A closer, more intimate view with a different light."];

export function artworkPrompt(kit: ComposeKit, o: { scene: string; occasion: Occasion; format: FormatKey; variation: number }): string {
  const b = kit.ctx.business, st = kit.ctx.brand;
  const F = FORMATS[o.format];
  const colours = [kit.brand.palette.paper, kit.brand.palette.accent, kit.brand.palette.dark].join(", ");
  return [
    `Background artwork for a ${F.label.toLowerCase()} for ${b.name}${b.industry ? `, a ${b.industry}` : ""}${b.city ? ` in ${b.city}` : ""}. Scene: ${o.scene.trim()}.${ARTWORK_VARIATIONS[o.variation % ARTWORK_VARIATIONS.length]}`,
    st.visualStyle ? `Visual style of the brand: ${st.visualStyle}` : "",
    `Colour mood drawn from the brand palette (${colours}).`,
    `Composition: one continuous photograph in a ${F.aspect} frame (a single scene: no panels, borders, frames, split screens or collage). The subject sits in the upper half; the lower part of the same scene falls into calm, softly lit, uncluttered space (a plain wall, a floor, a table top in soft focus), so words can be set over it.`,
    "Strictly: no text, no letters, no numbers, no logos, no watermarks, no signs or labels, no faces of people. A finished, photographic or illustrated picture, not a template.",
  ].filter(Boolean).join(" ");
}

const alt = (c: PosterContent): string => `Poster: ${[c.headline, c.offer, c.cta].filter(Boolean).join(". ")}.`;
const captionOf = (c: PosterContent): string => [c.headline, c.subline, c.offer, ...(c.details ?? []), c.cta].filter((x): x is string => !!x?.trim()).join("\n");
const channelFor = (f: FormatKey): string => (f === "insta_story" ? "instagram story" : f === "flyer" ? "print" : "instagram");

export async function makePoster(g: GraphHandle, req: PosterRequest, deps: CreativeDeps): Promise<PosterResult> {
  const kit = await loadComposeKit(g, req.businessId, { store: deps.store, tenant: req.tenant, businessId: req.businessId, fetchMissingFonts: deps.fonts?.fetchMissing ?? false, now: req.now });
  const notes = [...kit.notes];
  const count = Math.max(1, Math.min(MAX_OPTIONS, Math.round(req.count)));

  // 1. every claim on the poster comes from the owner or from the business's own record
  const words = [["headline", req.content.headline], ["eyebrow", req.content.eyebrow], ["subline", req.content.subline], ["offer", req.content.offer], ["cta", req.content.cta], ...(req.content.details ?? []).map((d) => ["detail", d] as const)]
    .filter((x): x is [string, string] => typeof x[1] === "string" && !!x[1].trim()).map(([role, text]) => ({ role, text }));
  const bad = groundClaims(words, { request: req.question, facts: kit.facts });
  if (bad.length) {
    throw new PosterRefused("claims", `I won't put ${bad.slice(0, 4).map((b) => `"${b.claim}" (in the ${b.role})`).join(", ")} on the poster: ${bad.length === 1 ? "it isn't" : "they aren't"} in what you asked for or in what I know about the business. Tell me the real ${bad.length === 1 ? "detail" : "details"}, or leave ${bad.length === 1 ? "it" : "them"} out.`);
  }

  // 2. the artwork
  const saveDeps: SaveDeps = { store: deps.store, tenant: req.tenant, agentId: req.agentId, turnId: req.turnId, now: req.now };
  const arts: Array<{ buffer: Buffer; id: string }> = [];
  let hfCredits = 0;
  let parentId: string | undefined;
  if (req.artwork === "generate") {
    const scenes = (req.scenes?.filter((s) => s.trim()) ?? []);
    const scene = scenes[0] ?? `a calm, warm, uncluttered scene that suits ${req.occasion === "general" ? "the business" : `a ${req.occasion} post`}`;
    const wanted = Array.from({ length: count }, (_, i) => {
      const sc = scenes[i] ?? scene;
      return { scene: sc, r: { prompt: artworkPrompt(kit, { scene: sc, occasion: req.occasion, format: req.format, variation: scenes[i] ? 0 : i }), aspect: FORMATS[req.format].aspect } };
    });
    const got = await makeArtworks(deps, wanted, { fallbackSaid: ", so these use a plain background in your brand colours" });
    notes.push(...got.notes);
    hfCredits += got.hfCredits;
    for (const m of got.made) {
      const id = await saveArtwork(g, saveDeps, { buffer: m.jpeg, engine: m.img.engine, model: m.img.model, prompt: m.img.prompt, ...(m.img.jobId ? { jobId: m.img.jobId } : {}), ...(m.img.credits !== undefined ? { credits: m.img.credits } : {}), recorded: m.img.recorded, scene: m.scene, w: m.w, h: m.h });
      arts.push({ buffer: m.jpeg, id });
    }
  } else if (typeof req.artwork === "object") {
    const [row] = await g.roQuery<{ key: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key", { id: req.artwork.photoAssetId });
    const bytes = row?.key ? deps.store.get(req.tenant, row.key) : null;
    if (!bytes) throw new PosterRefused("photo", "I can't find that photo any more. Send it again and I'll use it.");
    arts.push({ buffer: bytes, id: req.artwork.photoAssetId });
    parentId = req.artwork.photoAssetId;
  }
  const hasArt = arts.length > 0;
  if (req.artwork === "generate" && !hasArt && !notes.some((n) => /artwork|background/i.test(n))) notes.push("I couldn't make artwork, so these use a plain background in your brand colours.");

  // 3. the layouts, composed by code
  const order = layoutOrder(req.occasion, hasArt);
  const wanted: LayoutKey[] = Array.from({ length: Math.min(count, order.length) }, (_, i) => order[i]!);
  const composed: Array<{ label: string; poster: ComposedPoster; art?: { buffer: Buffer; id: string } }> = [];
  try {
    for (const [i, layout] of wanted.entries()) {
      const art = hasArt ? arts[i % arts.length] : undefined;
      const poster = await composePoster({ format: req.format, layout, content: req.content, brand: kit.brand, artwork: art?.buffer ?? null });
      composed.push({ label: String.fromCharCode(65 + i), poster, ...(art ? { art } : {}) });
    }
  } catch (e) {
    if (e instanceof PosterTextDoesNotFit) throw new PosterRefused("fit", e.message);
    if (e instanceof PosterFontMissing) throw new PosterRefused("font", `${e.message} Send the font file (.ttf or .otf) or use words in the Latin alphabet.`);
    throw e;
  }

  // 4. Nisha's look at each
  const verdicts = await checkPosters(composed.map((c) => ({ label: c.label, image: c.poster.buffer, manifest: c.poster.manifest })), { businessName: kit.brand.businessName, hasLogoFile: !!kit.brand.logo }, { vision: deps.vision });
  if (verdicts.some((v) => v.badge === "unchecked")) notes.push("I couldn't double-check these (the checker wasn't available), so please read the words and the logo yourself before approving.");
  const heldAll = verdicts.every((v) => v.badge === "held");
  if (heldAll) notes.push(`Nisha held every option back: ${[...new Set(verdicts.flatMap((v) => v.reasons))].slice(0, 3).join("; ")}.`);
  for (const c of composed) for (const p of c.poster.manifest.problems.filter((x) => /soft/.test(x))) if (!notes.some((n) => /logo/i.test(n) && /soft|small/i.test(n))) notes.push(`Heads up: ${p}.`);

  // 5. save, with lineage, and the card
  const options: OptionToSave[] = composed.map((c) => {
    const v = verdicts.find((x) => x.label === c.label)!;
    return {
      label: c.label, buffer: c.poster.buffer, mime: c.poster.mime, w: c.poster.w, h: c.poster.h, badge: v.badge,
      note: v.badge === "ok" ? (v.note || "words and logo checked") : v.reasons.join("; ") || v.note, layout: c.poster.manifest.layout, aiEdited: !!c.art && c.art.id !== parentId,
      ...(c.art && c.art.id !== parentId ? { artworkId: c.art.id } : {}),
      words: c.poster.manifest.texts.map((t) => t.shown).join(" · "),
      extra: { manifest: JSON.stringify(c.poster.manifest).slice(0, 6000), logoKind: c.poster.manifest.logo.kind, logoPlate: c.poster.manifest.logo.plate },
    };
  });
  const title = `${FORMATS[req.format].label} poster: ${req.content.headline.slice(0, 60)}`;
  const saved = await saveDeliverable(g, saveDeps, {
    kind: "poster", title, caption: req.caption?.trim() || captionOf(req.content), altText: alt(req.content), aspect: FORMATS[req.format].aspect === "9:16" ? "9:16" : FORMATS[req.format].aspect === "1:1" ? "1:1" : "4:5",
    channel: channelFor(req.format), format: req.format, request: req.question, options, ...(parentId ? { parentId } : {}),
    usesBrand: [...(kit.ids.logo ? [kit.ids.logo] : []), ...kit.ids.fonts], guidedBy: kit.ids.rules, notes, hfCredits,
  });
  return { saved, notes, hfCredits, generated: arts.filter((a) => a.id !== parentId).length, layouts: composed.map((c) => c.poster.manifest.layout), verdicts };
}
