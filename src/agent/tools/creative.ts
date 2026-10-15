// The tools that CREATE, called by the Chief (or a desk) from any free-form request: no keyword router decides when, the model
// reads these descriptions and the owner's words. Each one makes a real thing live (never a script, never a recording),
// puts it in the graph with lineage and a card waiting for the owner's OK, and posts nothing anywhere.
//   make_poster                  a poster, ad, flyer or social graphic: AI artwork underneath, the real logo and the exact words by code
//   generate_image               a picture from a description, through the capped image engine
//   make_reel_script_and_clip    a reel script, and (priced and agreed) a 5 s 9:16 clip from an approved picture
// When something cannot be done the result says exactly why, in the owner's words, and still delivers what it can. A result
// carries `deliverable` (turned into a `deliverable` event by the orchestrator, for the web app and Discord) and `proposed`
// (the cards raised, which become `proposal` events).
import { z } from "zod";
import type { DeliverableOption, ToolResult } from "../../../shared/contracts.js";
import { FORMAT_KEYS, isFormat, type FormatKey } from "../../creative/compose/formats.js";
import type { Occasion } from "../../creative/compose/compose.js";
import { makeImages, type Aspect } from "../../creative/image.js";
import { makePoster, PosterRefused } from "../../creative/poster.js";
import { makeReel } from "../../creative/reel.js";
import type { SavedDeliverable } from "../../creative/deliverable.js";
import { businessId } from "../../graph/tenants.js";
import type { ToolContext } from "../tool.js";
import { Collector, defineTool, getNodes, refuseIfReadOnly, refuseIfStopped, type NodeRow } from "./common.js";

const NOT_SET_UP = "Making things isn't set up on this server yet, so nothing was made.";

const nodesFor = async (ctx: ToolContext, ids: string[]): Promise<Collector> => {
  const col = new Collector();
  const found = await getNodes(ctx, [...new Set(ids)]);
  for (const id of ids) col.node(found.get(id) as NodeRow | undefined);
  return col;
};

// What a result says about a saved deliverable, for the model and for the `deliverable` event.
function summary(kind: "poster" | "image" | "clip", s: SavedDeliverable, notes: string[]): Record<string, unknown> {
  return { kind, title: s.title, approvalId: s.approvalId, recommended: s.recommended, options: s.options, notes, credits: s.credits };
}

const optionLines = (options: DeliverableOption[]) => options.map((o) => ({ label: o.label, id: o.assetId, check: o.badge === "ok" ? "checked" : o.badge === "held" ? "held back" : "not double-checked", note: o.note, ...(o.layout ? { layout: o.layout } : {}), madeWithAiPicture: o.aiEdited }));

const SAY = "Tell the owner, in plain words: what you made and how many options, which one you suggest, what the check found, and any note below. Say it is waiting for their OK (the Approve button) and that nothing was posted anywhere. Cite the option ids. Never describe a picture you were not given.";

const FORMAT_HELP = FORMAT_KEYS.join(" | ");

async function runPoster(a: {
  headline: string; eyebrow?: string; subline?: string; offer?: string; cta?: string; details?: string[]; format?: string; occasion?: string; scene?: string[] | string;
  artwork?: string; photo_asset_id?: string; options?: number; caption?: string;
}, ctx: ToolContext): Promise<ToolResult> {
  refuseIfReadOnly(ctx, "make_poster");
  refuseIfStopped(ctx, "make_poster");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: NOT_SET_UP }, nodes: [], edges: [], sources: [], note: NOT_SET_UP };
  const format: FormatKey = isFormat(a.format) ? a.format : "insta_portrait";
  const occasion: Occasion = (["festival", "offer", "announcement", "general"] as const).find((o) => o === a.occasion) ?? (a.offer ? "offer" : "general");
  const scenes = Array.isArray(a.scene) ? a.scene : a.scene ? [a.scene] : [];
  const artwork = a.artwork === "none" ? "none" : a.artwork === "photo" && a.photo_asset_id ? { photoAssetId: a.photo_asset_id } : "generate";
  try {
    const r = await makePoster(ctx.graph, {
      tenant: ctx.tenant, businessId: businessId(ctx.tenant), agentId: ctx.agentId, turnId: ctx.turnId, now: ctx.now, question: ctx.question ?? "",
      content: { headline: a.headline, ...(a.eyebrow ? { eyebrow: a.eyebrow } : {}), ...(a.subline ? { subline: a.subline } : {}), ...(a.offer ? { offer: a.offer } : {}), ...(a.cta ? { cta: a.cta } : {}), ...(a.details?.length ? { details: a.details } : {}) },
      format, occasion, count: a.options ?? 2, ...(scenes.length ? { scenes } : {}), artwork, ...(a.caption ? { caption: a.caption } : {}),
    }, d);
    const ids = [...r.saved.options.map((o) => o.assetId), r.saved.approvalId];
    const col = await nodesFor(ctx, ids);
    const deliverable = summary("poster", r.saved, r.notes);
    return col.result(ctx, {
      made: true, kind: "poster", format, approvalId: r.saved.approvalId, recommended: r.saved.recommended, options: optionLines(r.saved.options), notes: r.notes,
      imageEngineCredits: r.hfCredits, picturesMadeNow: r.generated, posted: false, waitingForOk: true, say: SAY, deliverable,
      proposed: [{ recommendationId: r.saved.recommendationId, approvalId: r.saved.approvalId, title: r.saved.title }],
    }, `Made ${r.saved.options.length} poster option${r.saved.options.length === 1 ? "" : "s"}; waiting for the owner's OK. Nothing was posted.`);
  } catch (e) {
    if (e instanceof PosterRefused) return { data: { made: false, why: e.plain, reason: e.code, nothingSpent: true }, nodes: [], edges: [], sources: [], note: e.plain };
    throw e;
  }
}

export const makePosterTool = defineTool({
  name: "make_poster",
  description:
    "Make a poster, ad, flyer or social graphic on request, live: AI artwork underneath, the owner's real logo and the exact words put on by code. Gives 2 checked options and waits for the owner's OK; posts nothing. Use for any such request, however phrased. Example: {\"headline\":\"Diwali sale\",\"offer\":\"20% off\",\"occasion\":\"offer\",\"scene\":\"warm lamps on a wooden table\"}",
  input: {
    headline: z.string().min(2).max(140).describe("Exact words for the headline, from the owner's request. Never invent an offer, price, date, address or contact detail: leave it out, or ask the owner"),
    eyebrow: z.string().max(60).optional().describe("A small line above, e.g. the festival or the kind of post"),
    subline: z.string().max(200).optional(),
    offer: z.string().max(60).optional().describe("The offer exactly as the owner gave it, e.g. 20% off"),
    cta: z.string().max(80).optional().describe("Call to action; a website or handle only if the owner gave it or the business record holds it"),
    details: z.array(z.string().max(100)).max(3).optional().describe("Date, time or place, exactly as given"),
    format: z.string().optional().describe(`${FORMAT_HELP} (default insta_portrait; use insta_story for stories)`),
    occasion: z.enum(["festival", "offer", "announcement", "general"]).optional(),
    scene: z.union([z.string().max(300), z.array(z.string().max(300)).max(3)]).optional().describe("What the artwork shows (one scene, or one per option). No words in it. Omit for a plain brand-colour ground"),
    artwork: z.enum(["generate", "none", "photo"]).optional().describe("generate (default), none (plain brand-colour ground), or photo (the owner's own photo, with photo_asset_id)"),
    photo_asset_id: z.string().optional().describe("An Asset id from a photo the owner sent, when artwork is photo"),
    options: z.number().int().min(1).max(3).optional().describe("How many options (default 2: each costs image credits)"),
    caption: z.string().max(1500).optional().describe("The post text to go with it"),
  },
  writes: true,
  external: true,
  run: runPoster,
});

async function runImage(a: { scene: string; aspect?: string; options?: number; caption?: string }, ctx: ToolContext): Promise<ToolResult> {
  refuseIfReadOnly(ctx, "generate_image");
  refuseIfStopped(ctx, "generate_image");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: NOT_SET_UP }, nodes: [], edges: [], sources: [], note: NOT_SET_UP };
  const aspect: Aspect = (["1:1", "4:5", "9:16", "3:4"] as const).find((x) => x === a.aspect) ?? "4:5";
  const r = await makeImages(ctx.graph, { tenant: ctx.tenant, businessId: businessId(ctx.tenant), agentId: ctx.agentId, turnId: ctx.turnId, now: ctx.now, question: ctx.question ?? "", scene: a.scene, aspect, count: a.options ?? 2, ...(a.caption ? { caption: a.caption } : {}) }, d);
  if (!r.saved) return { data: { made: false, why: r.notes.join(" ") || "No picture was made.", nothingMadeNothingCharged: true, say: "Tell the owner exactly why, in plain words, and what they can do next. Do not describe a picture." }, nodes: [], edges: [], sources: [], note: r.notes.join(" ") };
  const col = await nodesFor(ctx, [...r.saved.options.map((o) => o.assetId), r.saved.approvalId]);
  return col.result(ctx, {
    made: true, kind: "image", approvalId: r.saved.approvalId, recommended: r.saved.recommended, options: optionLines(r.saved.options), notes: r.notes, imageEngineCredits: r.hfCredits,
    posted: false, waitingForOk: true, say: SAY, deliverable: summary("image", r.saved, r.notes),
    proposed: [{ recommendationId: r.saved.recommendationId, approvalId: r.saved.approvalId, title: r.saved.title }],
  }, `Made ${r.made} picture${r.made === 1 ? "" : "s"}; waiting for the owner's OK. Nothing was posted.`);
}

export const generateImageTool = defineTool({
  name: "generate_image",
  description:
    "Make a picture from a description, in the brand's look, through the capped image engine (quoted first; says exactly why if it can't). No words in the picture. For a poster with text or the logo use make_poster instead. Waits for the owner's OK. Example: {\"scene\":\"a quiet reading corner with a brass lamp at dusk\",\"aspect\":\"4:5\"}",
  input: {
    scene: z.string().min(5).max(400).describe("What the picture shows"),
    aspect: z.enum(["1:1", "4:5", "9:16", "3:4"]).optional().describe("Default 4:5; 9:16 for a story"),
    options: z.number().int().min(1).max(2).optional().describe("How many (default 2: each costs image credits)"),
    caption: z.string().max(1500).optional(),
  },
  writes: true,
  external: true,
  run: runImage,
});

async function runReel(a: { idea: string; seconds?: number; image_asset_id?: string; make_clip?: boolean }, ctx: ToolContext): Promise<ToolResult> {
  refuseIfReadOnly(ctx, "make_reel_script_and_clip");
  refuseIfStopped(ctx, "make_reel_script_and_clip");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: NOT_SET_UP }, nodes: [], edges: [], sources: [], note: NOT_SET_UP };
  const r = await makeReel(ctx.graph, { tenant: ctx.tenant, businessId: businessId(ctx.tenant), agentId: ctx.agentId, turnId: ctx.turnId, now: ctx.now, question: ctx.question ?? "", idea: a.idea, seconds: a.seconds ?? 5, ...(a.image_asset_id ? { imageAssetId: a.image_asset_id } : {}), makeClip: a.make_clip === true }, d);
  if (!r.ok || !r.script) return { data: { made: false, why: r.why ?? "No script was made." }, nodes: [], edges: [], sources: [], note: r.why ?? "No script was made." };
  const proposed = [
    ...(r.textCard ? [{ recommendationId: r.textCard.recommendationId, approvalId: r.textCard.approvalId, title: `Reel script: ${r.script.title}` }] : []),
    ...(r.clip.saved ? [{ recommendationId: r.clip.saved.recommendationId, approvalId: r.clip.saved.approvalId, title: r.clip.saved.title }] : []),
  ];
  const col = await nodesFor(ctx, [...(r.clip.saved?.options.map((o) => o.assetId) ?? []), ...proposed.map((p) => p.approvalId)]);
  const price = r.clip.priceCredits;
  return col.result(ctx, {
    made: true, kind: "reel", script: r.script.text, caption: r.script.caption, scriptWarnings: r.script.warnings,
    scriptCard: r.textCard?.approvalId ?? null,
    clip: { made: r.clip.made, ...(price !== null ? { priceInImageCredits: price } : {}), ...(r.clip.why ? { why: r.clip.why } : {}), ...(r.clip.saved ? { approvalId: r.clip.saved.approvalId, id: r.clip.saved.options[0]?.assetId } : {}) },
    notes: r.notes, posted: false, waitingForOk: true,
    say: "Give the owner the script word for word in order. Say plainly what the clip is: made (watch it before approving), or not made and why, with its price in credits when there is one. Nothing is posted.",
    ...(r.clip.saved ? { deliverable: summary("clip", r.clip.saved, r.notes) } : {}), proposed,
  }, r.clip.made ? "Wrote the script and made the clip; waiting for the owner's OK." : "Wrote the script; waiting for the owner's OK. No clip was made.");
}

export const makeReelTool = defineTool({
  name: "make_reel_script_and_clip",
  description:
    "Write a timed reel script in the brand's voice, and a 5 s 9:16 clip from a picture the owner approved. Without make_clip it only quotes the clip's price: tell the owner, then set make_clip true only after they agree. Example: {\"idea\":\"the new menu, shot in the morning light\",\"seconds\":5}",
  input: {
    idea: z.string().min(5).max(600).describe("The owner's idea, in their words"),
    seconds: z.number().int().min(3).max(10).optional().describe("Length (default 5)"),
    image_asset_id: z.string().optional().describe("An approved picture's Asset id to animate"),
    make_clip: z.boolean().optional().describe("true only when the owner has agreed to the quoted price"),
  },
  writes: true,
  external: true,
  run: runReel,
});
