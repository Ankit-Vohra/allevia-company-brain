// make a poster, end to end: the brand kit and its design system, the claims check, the copy check, the business's REAL
// material first (its own photos, its real app screens), a generated scene only where a layout needs a picture and none
// exists (quoted, capped, specific to this business and place), layouts chosen by the brief from the library and never
// the one used last, each composed as a real web page in Chromium and measured, fixed by code, reviewed by Rohan and
// revised (design/engine.ts), then Nisha's word-for-word check and the deliverable (assets with lineage, a card waiting
// for the owner). Whatever cannot be done is said in plain words and the rest is still delivered. Never a fake result:
// a picture the engine did not make is never described as one it did.
//
// When this server cannot run Chromium, the earlier SVG composer (compose/compose.ts) makes the posters instead, and the
// result says so.
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { checkPosters, groundClaims, type OptionVerdict } from "./compose/check.js";
import {
  composePoster, layoutOrder, PosterFontMissing, PosterTextDoesNotFit, type LayoutKey as LegacyLayoutKey, type Occasion, type PosterContent, type PosterManifest,
} from "./compose/compose.js";
import { FORMATS, type FormatKey } from "./compose/formats.js";
import { saveArtwork, saveDeliverable, type OptionToSave, type SaveDeps, type SavedDeliverable } from "./deliverable.js";
import { loadComposeKit, type ComposeKit } from "./kit.js";
import { makeArtworks } from "./artwork.js";
import type { CreativeDeps } from "./ports.js";
import { chooseLayouts, type Goal } from "./design/choose.js";
import { blockingCopy, prepareCopy } from "./design/copy.js";
import { runDesign, type DesignOption } from "./design/engine.js";
import { LAYOUT_KEYS, type DesignCopy, type LayoutKey, type Picture } from "./design/layouts.js";
import { findMaterial, photoPicture, scenePrompt } from "./design/material.js";
import { sharedRenderer } from "./design/render.js";
import { designSystem } from "./design/system.js";

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
  scenes?: string[];               // what a generated scene shows, one per option (only when no real picture fits)
  artwork: ArtworkSource;
  caption?: string;
  promoted?: { id?: string; name: string; summary?: string }; // what the brief sells: its words are grounded, it is the hero
  audience?: string;
  goal?: Goal;
  layouts?: string[];              // layouts asked for by name (the library's keys), best first
  pictures?: string[];             // the business's own pictures to use (BrandAsset or Asset ids), in order
  quote?: { text: string; by?: string; illustrative?: boolean };
  pair?: [string, string];
  reuseScenes?: string[];          // generated artwork already made for this business (Asset ids): used again, nothing new is paid for
}

// The request could not be made as asked; `plain` says why in the owner's words and what to change.
export class PosterRefused extends Error {
  override name = "PosterRefused";
  constructor(readonly code: "claims" | "fit" | "font" | "photo" | "engine" | "copy", readonly plain: string) {
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
  reviews: Array<{ label: string; layout: string; mean?: number; passed: boolean; history: string[] }>;
}

const ARTWORK_VARIATIONS = ["", " A different angle and composition from the usual.", " A closer, more intimate view with a different light."];

// The legacy composer's artwork prompt (kept for the SVG fallback and its tests).
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
const goalOf = (o: Occasion): Goal => (o === "offer" ? "offer" : o === "announcement" ? "announce" : "sell");

// The layouts this business's last posters used, newest first: the chooser never repeats the last one.
async function recentLayouts(g: GraphHandle): Promise<string[]> {
  const rows = await g.roQuery<{ layout: string | null }>(
    "MATCH (a:Asset) WHERE a.kind = 'poster' AND a.layout IS NOT NULL RETURN a.layout AS layout, a.createdAt AS at, a.id AS id ORDER BY at DESC, id LIMIT 12").catch(() => []);
  const out: string[] = [];
  for (const r of rows) if (r.layout && !out.includes(r.layout)) out.push(r.layout);
  return out;
}

const chromiumMissing = (e: unknown): boolean => e instanceof Error && /Executable doesn't exist|browserType\.launch|Failed to launch|playwright install/i.test(e.message);

export async function makePoster(g: GraphHandle, req: PosterRequest, deps: CreativeDeps): Promise<PosterResult> {
  const printed = [req.content.headline, req.content.eyebrow, req.content.subline, req.content.offer, req.content.cta, ...(req.content.details ?? [])].filter((x): x is string => !!x?.trim());
  const kit = await loadComposeKit(g, req.businessId, { store: deps.store, tenant: req.tenant, businessId: req.businessId, fetchMissingFonts: deps.fonts?.fetchMissing ?? false, now: req.now, cover: printed });
  const notes = [...kit.notes];
  const count = Math.max(1, Math.min(MAX_OPTIONS, Math.round(req.count)));

  // 1. every claim on the poster comes from the owner or from the business's own record
  const words = [["headline", req.content.headline], ["eyebrow", req.content.eyebrow], ["subline", req.content.subline], ["offer", req.content.offer], ["cta", req.content.cta], ["quote", req.quote?.text], ...(req.content.details ?? []).map((d) => ["detail", d] as const)]
    .filter((x): x is [string, string] => typeof x[1] === "string" && !!x[1].trim()).map(([role, text]) => ({ role, text }));
  const facts = [...kit.facts, ...(req.promoted ? [req.promoted.name, req.promoted.summary ?? ""] : [])];
  const bad = groundClaims(words, { request: req.question, facts });
  if (bad.length) {
    throw new PosterRefused("claims", `I won't put ${bad.slice(0, 4).map((b) => `"${b.claim}" (in the ${b.role})`).join(", ")} on the poster: ${bad.length === 1 ? "it isn't" : "they aren't"} in what you asked for or in what I know about the business. Tell me the real ${bad.length === 1 ? "detail" : "details"}, or leave ${bad.length === 1 ? "it" : "them"} out.`);
  }

  // 2. the words, held to the craft: one line, one support, one action, nothing said twice
  const prepared = prepareCopy({
    headline: req.content.headline, ...(req.content.subline ? { support: req.content.subline } : {}), ...(req.content.eyebrow ? { eyebrow: req.content.eyebrow } : {}),
    ...(req.content.cta ? { cta: req.content.cta } : {}), ...(req.content.offer ? { offer: req.content.offer } : {}), ...(req.content.details?.length ? { details: req.content.details } : {}),
    ...(req.quote ? { quote: req.quote } : {}), ...(req.pair ? { pair: req.pair } : {}),
  });
  const stop = blockingCopy(prepared.findings);
  if (stop.length) throw new PosterRefused("copy", `The words repeat themselves: ${stop.map((f) => f.detail).join("; ")}. Say each thing once (the headline sells, the button says what to do) and I'll make it.`);
  const copy: DesignCopy = prepared.copy;
  // an announcement's small line usually IS the news ("coming soon on Google Play"): it is never dropped to make room
  if ((req.goal ?? goalOf(req.occasion)) === "announce" && copy.eyebrow) copy.keep = ["eyebrow"];
  notes.push(...prepared.findings.filter((f) => f.code === "repeat" || f.code === "long").map((f) => `Words: ${f.detail}.`));

  const saveDeps: SaveDeps = { store: deps.store, tenant: req.tenant, agentId: req.agentId, turnId: req.turnId, now: req.now };
  let hfCredits = 0;
  let generated = 0;

  // 3. real material first: the owner's chosen photo, then the business's own pictures and app screens
  let parentId: string | undefined;
  const about = [req.promoted?.name, req.promoted?.summary, req.content.headline, req.content.subline].filter(Boolean).join(" ");
  const material = await findMaterial(g, deps.store, req.tenant, { about, ...(req.pictures?.length ? { include: req.pictures } : {}) });
  const photos: Picture[] = req.artwork === "none" ? [] : [...material.photos];
  if (typeof req.artwork === "object") {
    const [row] = await g.roQuery<{ key: string | null; name: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.name AS name", { id: req.artwork.photoAssetId });
    const bytes = row?.key ? deps.store.get(req.tenant, row.key) : null;
    if (!bytes) throw new PosterRefused("photo", "I can't find that photo any more. Send it again and I'll use it.");
    photos.unshift(await photoPicture(bytes, { id: req.artwork.photoAssetId }));
    parentId = req.artwork.photoAssetId;
  }
  const screens = material.screens;
  notes.push(...material.notes);

  // 4. the layouts, by the brief and the material; a generated scene only for a layout that needs a picture none exists for
  const ds = await designSystem(kit.brand, kit.colours, req.format, kit.named);
  const recent = await recentLayouts(g);
  const prefer = (req.layouts ?? []).filter((k): k is LayoutKey => (LAYOUT_KEYS as string[]).includes(k));
  const goal = req.goal ?? goalOf(req.occasion);
  const chooseWith = (canGenerate: boolean) => chooseLayouts({ goal, copy, photos: photos.length, screens: screens.length, focusScreens: screens.filter((s) => s.focus).length, canGenerate, recent, prefer, count: count + 3 });
  let choices = chooseWith(req.artwork === "generate");
  const scenes: Array<Picture & { artworkId?: string }> = [];
  for (const id of req.reuseScenes ?? []) {
    const [row] = await g.roQuery<{ key: string | null }>("MATCH (a:Entity:Asset {id:$id}) WHERE a.kind = 'artwork' RETURN a.storageKey AS key", { id });
    const bytes = row?.key ? deps.store.get(req.tenant, row.key) : null;
    if (bytes) scenes.push({ ...(await photoPicture(bytes, { id, kind: "scene" })), artworkId: id });
  }
  const needScenes = Math.max(0, Math.min(count, choices.slice(0, count).filter((c) => c.generateScene).length) - scenes.length);
  if (req.artwork === "generate" && needScenes > 0) {
    const b = kit.ctx.business;
    const wanted = Array.from({ length: needScenes }, (_, i) => {
      const idea = req.scenes?.[i]?.trim() || req.scenes?.[0]?.trim()
        || (req.promoted ? `${req.promoted.name}${req.promoted.summary ? ` (${req.promoted.summary})` : ""} in real use${req.audience ? `, with ${req.audience}` : ""}` : `the everyday work of ${b.name}`);
      const prompt = scenePrompt({ business: b.name, ...(b.industry ? { industry: b.industry } : {}), ...(b.city ? { city: b.city } : {}), ...(b.country ? { country: b.country } : {}), idea: `${idea}${ARTWORK_VARIATIONS[req.scenes?.[i] ? 0 : i % ARTWORK_VARIATIONS.length]}`, ...(req.audience ? { audience: req.audience } : {}), aspect: FORMATS[req.format].aspect, calm: "bottom", ...(kit.ctx.brand.visualStyle ? { style: kit.ctx.brand.visualStyle } : {}) });
      return { scene: idea, r: { prompt, aspect: FORMATS[req.format].aspect } };
    });
    const got = await makeArtworks(deps, wanted, { fallbackSaid: ", so these use a plain background in your brand colours" });
    notes.push(...got.notes);
    hfCredits += got.hfCredits;
    for (const m of got.made) {
      const id = await saveArtwork(g, saveDeps, { buffer: m.jpeg, engine: m.img.engine, model: m.img.model, prompt: m.img.prompt, ...(m.img.jobId ? { jobId: m.img.jobId } : {}), ...(m.img.credits !== undefined ? { credits: m.img.credits } : {}), recorded: m.img.recorded, scene: m.scene, w: m.w, h: m.h });
      scenes.push({ ...(await photoPicture(m.jpeg, { id, kind: "scene" })), artworkId: id });
      generated++;
    }
    if (!scenes.length) choices = chooseWith(false);
  } else if (scenes.length) {
    notes.push("I reused the scene already made for you, so no new picture was paid for.");
  } else if (req.artwork === "generate" && photos.length) {
    notes.push(`I used your own ${photos.length === 1 ? "photo" : "photos"} instead of generating a picture: real work sells better than a made-up scene, and it cost nothing.`);
  }

  // 5. compose, measure, fix, review, revise (design/engine.ts)
  let options: DesignOption[] = [];
  let legacy: Array<{ label: string; buffer: Buffer; manifest: PosterManifest; artworkId?: string }> | null = null;
  try {
    const outcome = await runDesign({ ds, format: req.format, copy, photos, screens, scenes, choices, count, brief: { business: kit.brand.businessName, goal, promoting: req.promoted?.name ?? "the business", audience: req.audience ?? "customers", ...(copy.cta ? { cta: copy.cta } : {}), placement: FORMATS[req.format].label, request: req.question } }, { renderer: deps.renderer ?? sharedRenderer(), vision: deps.vision, ...(deps.log ? { log: deps.log } : {}) });
    options = outcome.options;
    notes.push(...outcome.notes);
    if (!options.length) {
      const why = outcome.setAside.map((s) => s.why).find((w) => /fit|runs out/.test(w));
      throw new PosterRefused("fit", why ? `The words don't fit at a readable size (${why}). Shorten the headline to about 7 words.` : "None of the layouts could hold these words cleanly. Shorten the headline to about 7 words.");
    }
  } catch (e) {
    if (e instanceof PosterRefused) throw e;
    if (!chromiumMissing(e)) throw e;
    legacy = await legacyCompose(req, kit, count, scenes.length ? scenes : photos);
    notes.push("This server can't run the page renderer, so these were made with the simpler composer.");
  }

  // 6. Nisha's word-for-word look at each
  const toCheck = legacy ?? options.map((o) => ({ label: o.label, buffer: o.design.jpeg, manifest: o.design.manifest }));
  const verdicts = await checkPosters(toCheck.map((c) => ({ label: c.label, image: c.buffer, manifest: c.manifest })), { businessName: kit.brand.businessName, hasLogoFile: !!kit.brand.logo }, { vision: deps.vision });
  if (verdicts.some((v) => v.badge === "unchecked")) notes.push("I couldn't double-check these (the checker wasn't available), so please read the words and the logo yourself before approving.");
  if (verdicts.every((v) => v.badge === "held")) notes.push(`Nisha held every option back: ${[...new Set(verdicts.flatMap((v) => v.reasons))].slice(0, 3).join("; ")}.`);
  if (kit.logoRow?.needsBetter && !notes.some((n) => /logo/i.test(n) && /soft|small/i.test(n))) notes.push("Heads up: the logo file is small, so it may look soft.");

  // 7. save, with lineage, and the card
  const usedBrand = [...new Set([...(kit.ids.logo ? [kit.ids.logo] : []), ...kit.ids.fonts, ...material.used.filter((id) => id.startsWith("brand-asset:"))])];
  const opts: OptionToSave[] = legacy
    ? legacy.map((c) => {
      const v = verdicts.find((x) => x.label === c.label)!;
      return { label: c.label, buffer: c.buffer, mime: "image/jpeg", w: FORMATS[req.format].w, h: FORMATS[req.format].h, badge: v.badge, note: v.badge === "ok" ? (v.note || "words and logo checked") : v.reasons.join("; ") || v.note, layout: c.manifest.layout, aiEdited: !!c.artworkId, ...(c.artworkId ? { artworkId: c.artworkId } : {}), words: c.manifest.texts.map((t) => t.shown).join(" · "), extra: { logoKind: c.manifest.logo.kind, composer: "svg" } };
    })
    : options.map((o) => {
      const v = verdicts.find((x) => x.label === o.label)!;
      const sceneId = (o.scene as (Picture & { artworkId?: string }) | undefined)?.artworkId;
      const review = o.review ? `Design review ${o.review.mean.toFixed(1)}/5${o.passed ? "" : " (didn't fully pass)"}.` : "";
      return {
        label: o.label, buffer: o.design.jpeg, mime: "image/jpeg", w: o.design.w, h: o.design.h, badge: v.badge,
        note: [v.badge === "ok" ? (v.note || "words and logo checked") : v.reasons.join("; ") || v.note, review].filter(Boolean).join(" "),
        layout: o.design.spec.layout, aiEdited: !!sceneId, ...(sceneId ? { artworkId: sceneId } : {}),
        words: o.design.manifest.texts.map((t) => t.shown).join(" · "),
        extra: {
          manifest: JSON.stringify(o.design.manifest).slice(0, 6000), logoKind: o.design.manifest.logo.kind, composer: "html",
          ...(o.review ? { reviewMean: o.review.mean, reviewPassed: o.passed, reviewTakeaway: o.review.takeaway } : {}),
          revisions: o.history.slice(0, 12), realPictures: [...o.design.spec.photos.slice(0, 3), ...o.design.spec.screens.slice(0, 2)].map((p) => p.id ?? "").filter(Boolean),
        },
      };
    });
  const title = `${FORMATS[req.format].label} poster: ${req.content.headline.slice(0, 60)}`;
  const saved = await saveDeliverable(g, saveDeps, {
    kind: "poster", title, caption: req.caption?.trim() || captionOf(req.content), altText: alt(req.content), aspect: FORMATS[req.format].aspect === "9:16" ? "9:16" : FORMATS[req.format].aspect === "1:1" ? "1:1" : "4:5",
    channel: channelFor(req.format), format: req.format, request: req.question, options: opts, ...(parentId ? { parentId } : {}),
    usesBrand: usedBrand, guidedBy: kit.ids.rules, notes, hfCredits,
    ...(req.promoted?.id ? { promotes: req.promoted.id } : {}),
  });
  return {
    saved, notes, hfCredits, generated, verdicts,
    layouts: legacy ? legacy.map((c) => c.manifest.layout) : options.map((o) => o.design.spec.layout),
    reviews: options.map((o) => ({ label: o.label, layout: o.design.spec.layout, ...(o.review ? { mean: o.review.mean } : {}), passed: o.passed, history: o.history })),
  };
}

// The SVG composer, for a server without Chromium.
async function legacyCompose(req: PosterRequest, kit: ComposeKit, count: number, pictures: Array<Picture & { artworkId?: string }>): Promise<Array<{ label: string; buffer: Buffer; manifest: PosterManifest; artworkId?: string }>> {
  const arts = await Promise.all(pictures.map(async (p) => ({ buffer: await sharp(Buffer.from(p.url.split(",")[1] ?? "", "base64")).jpeg().toBuffer(), artworkId: p.artworkId })));
  const order = layoutOrder(req.occasion, arts.length > 0);
  const out: Array<{ label: string; buffer: Buffer; manifest: PosterManifest; artworkId?: string }> = [];
  try {
    for (let i = 0; i < Math.min(count, order.length); i++) {
      const art = arts.length ? arts[i % arts.length] : undefined;
      const p = await composePoster({ format: req.format, layout: order[i] as LegacyLayoutKey, content: req.content, brand: kit.brand, artwork: art?.buffer ?? null });
      out.push({ label: String.fromCharCode(65 + i), buffer: p.buffer, manifest: p.manifest, ...(art?.artworkId ? { artworkId: art.artworkId } : {}) });
    }
  } catch (e) {
    if (e instanceof PosterTextDoesNotFit) throw new PosterRefused("fit", e.message);
    if (e instanceof PosterFontMissing) throw new PosterRefused("font", `${e.message} Send the font file (.ttf or .otf) or use words in the Latin alphabet.`);
    throw e;
  }
  return out;
}
