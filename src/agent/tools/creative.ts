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
import { goalOccasion, placementFormat, resolveBrief, type BriefInput, type NeedsBrief } from "../../creative/brief.js";
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

// The brief every made thing serves (src/creative/brief.ts). Every field is optional in the schema so a partial brief reaches the
// tool, which then says exactly what is missing instead of guessing.
const BRIEF = z.object({
  goal: z.string().max(40).optional().describe("sell | offer | announce | awareness"),
  promoting: z.string().max(120).optional().describe("What it sells: a product or feature id from the graph (product:...) or its name"),
  audience: z.string().max(120).optional().describe("Who will SEE it and should act: customers or users (an audience from the record), not the team who asked for it"),
  message: z.string().max(140).optional().describe("The one thing it says, the owner's words exactly (the headline)"),
  cta: z.string().max(80).optional().describe("What the viewer should do, exactly (a website or handle only if the owner gave it or the record holds it)"),
  placement: z.string().max(40).optional().describe("insta_post | insta_story | reel | flyer"),
  offer: z.string().max(60).optional().describe("An offer exactly as the owner gave it, e.g. 20% off"),
}).describe("The brief: what it is for and what it sells. Fill what the owner said; leave out what they didn't");

// A brief with something missing: nothing is made, and the owner is asked at most three short questions with tap-to-answer options.
function needsBrief(n: NeedsBrief) {
  const why = `To make this well I need: ${n.missing.join(", ")}.`;
  return {
    data: {
      made: false, needsBrief: true, missing: n.missing, known: n.known, questions: n.questions, quickReplies: n.questions,
      say: "Ask the owner these questions in one short message (each one line, at most three). They can tap an answer or type their own. Don't make anything and don't guess until they answer.",
    },
    nodes: [], edges: [], sources: [], note: why,
  };
}

async function runPoster(a: {
  brief: BriefInput; eyebrow?: string; subline?: string; details?: string[]; scene?: string[] | string;
  artwork?: string; photo_asset_id?: string; options?: number; caption?: string; square?: boolean;
}, ctx: ToolContext): Promise<ToolResult> {
  refuseIfReadOnly(ctx, "make_poster");
  refuseIfStopped(ctx, "make_poster");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: NOT_SET_UP }, nodes: [], edges: [], sources: [], note: NOT_SET_UP };
  const r0 = await resolveBrief(ctx.graph, "poster", a.brief);
  if (!r0.ok) return needsBrief(r0.needs);
  const brief = r0.brief;
  const format = placementFormat(brief.placement, a.square === true);
  const scenes = Array.isArray(a.scene) ? a.scene : a.scene ? [a.scene] : [];
  const artwork = a.artwork === "none" ? "none" : a.artwork === "photo" && a.photo_asset_id ? { photoAssetId: a.photo_asset_id } : "generate";
  try {
    const r = await makePoster(ctx.graph, {
      tenant: ctx.tenant, businessId: businessId(ctx.tenant), agentId: ctx.agentId, turnId: ctx.turnId, now: ctx.now, question: ctx.question ?? "",
      content: {
        headline: brief.message, eyebrow: a.eyebrow ?? brief.promoting.name, ...(a.subline ? { subline: a.subline } : {}), ...(brief.offer ? { offer: brief.offer } : {}),
        cta: brief.cta, ...(a.details?.length ? { details: a.details } : {}),
      },
      format, occasion: goalOccasion(brief.goal), count: a.options ?? 2, ...(scenes.length ? { scenes } : {}), artwork, ...(a.caption ? { caption: a.caption } : {}),
      promoted: brief.promoting, audience: brief.audience,
    }, d);
    const ids = [...r.saved.options.map((o) => o.assetId), r.saved.approvalId, ...(brief.promoting.id ? [brief.promoting.id] : [])];
    const col = await nodesFor(ctx, ids);
    const notes = [...r.notes, ...(r0.defaulted.length ? [`I assumed ${r0.defaulted.map((f) => `the ${f} (${f === "placement" ? brief.placement : brief[f as "goal"]})`).join(" and ")}.`] : [])];
    return col.result(ctx, {
      made: true, kind: "poster", format, brief: { goal: brief.goal, promoting: brief.promoting, audience: brief.audience, message: brief.message, cta: brief.cta, placement: brief.placement },
      approvalId: r.saved.approvalId, recommended: r.saved.recommended, options: optionLines(r.saved.options), notes,
      imageEngineCredits: r.hfCredits, picturesMadeNow: r.generated, posted: false, waitingForOk: true, say: SAY, deliverable: summary("poster", r.saved, notes),
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
    "Make a poster or ad that sells something, live: AI artwork of the thing promoted, the real logo and exact words by code, offer badge, call-to-action strip. Needs a brief; if part is missing it returns questions to ask. 2 checked options; waits for the owner's OK. Example: {\"brief\":{\"goal\":\"sell\",\"promoting\":\"product:interior-design\",\"message\":\"Homes that feel like you\",\"cta\":\"Book a visit\"}}",
  input: {
    brief: BRIEF,
    eyebrow: z.string().max(60).optional().describe("A small line above the headline (default: the thing promoted)"),
    subline: z.string().max(200).optional(),
    details: z.array(z.string().max(100)).max(3).optional().describe("Date, time or place, exactly as given"),
    scene: z.union([z.string().max(300), z.array(z.string().max(300)).max(3)]).optional().describe("What the artwork shows (default: the thing promoted). No words in it"),
    artwork: z.enum(["generate", "none", "photo"]).optional().describe("generate (default), none (brand-colour ground), photo (the owner's photo, with photo_asset_id)"),
    photo_asset_id: z.string().optional(),
    options: z.number().int().min(1).max(3).optional().describe("How many options (default 2: each costs image credits)"),
    square: z.boolean().optional().describe("A square post instead of portrait"),
    caption: z.string().max(1500).optional(),
  },
  writes: true,
  external: true,
  run: runPoster,
});

async function runImage(a: { brief: BriefInput; scene?: string; aspect?: string; options?: number; caption?: string }, ctx: ToolContext): Promise<ToolResult> {
  refuseIfReadOnly(ctx, "generate_image");
  refuseIfStopped(ctx, "generate_image");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: NOT_SET_UP }, nodes: [], edges: [], sources: [], note: NOT_SET_UP };
  const r0 = await resolveBrief(ctx.graph, "image", a.brief);
  if (!r0.ok) return needsBrief(r0.needs);
  const brief = r0.brief;
  const aspect: Aspect = (["1:1", "4:5", "9:16", "3:4"] as const).find((x) => x === a.aspect) ?? (brief.placement === "insta_story" || brief.placement === "reel" ? "9:16" : brief.placement === "flyer" ? "3:4" : "4:5");
  const scene = a.scene?.trim() || `${brief.promoting.name}${brief.promoting.summary ? `: ${brief.promoting.summary}` : ""}`;
  const r = await makeImages(ctx.graph, { tenant: ctx.tenant, businessId: businessId(ctx.tenant), agentId: ctx.agentId, turnId: ctx.turnId, now: ctx.now, question: ctx.question ?? "", scene, aspect, count: a.options ?? 2, ...(a.caption ? { caption: a.caption } : {}) }, d);
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
    "Make a picture of the thing being promoted, in the brand's look, through the capped image engine (quoted first; says why if it can't). No words in it; for text or the logo use make_poster. Needs a brief (goal, promoting, placement). Waits for the owner's OK. Example: {\"brief\":{\"goal\":\"sell\",\"promoting\":\"Interior Design\",\"placement\":\"insta_post\"}}",
  input: {
    brief: BRIEF,
    scene: z.string().min(5).max(400).optional().describe("What the picture shows (default: the thing promoted)"),
    aspect: z.enum(["1:1", "4:5", "9:16", "3:4"]).optional().describe("Default 4:5; 9:16 for a story"),
    options: z.number().int().min(1).max(2).optional().describe("How many (default 2: each costs image credits)"),
    caption: z.string().max(1500).optional(),
  },
  writes: true,
  external: true,
  run: runImage,
});

async function runReel(a: { brief: BriefInput; idea?: string; seconds?: number; image_asset_id?: string; make_clip?: boolean; plan?: unknown; picture_ids?: string[]; confirm_spend?: boolean }, ctx: ToolContext): Promise<ToolResult> {
  refuseIfReadOnly(ctx, "make_reel_script_and_clip");
  refuseIfStopped(ctx, "make_reel_script_and_clip");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: NOT_SET_UP }, nodes: [], edges: [], sources: [], note: NOT_SET_UP };
  const r0 = await resolveBrief(ctx.graph, "reel", a.brief);
  if (!r0.ok) return needsBrief(r0.needs);
  const brief = r0.brief;
  const idea = a.idea?.trim() || `${brief.message}. It sells ${brief.promoting.name}${brief.promoting.summary ? ` (${brief.promoting.summary})` : ""} to ${brief.audience}; it ends with: ${brief.cta}.`;
  const r = await makeReel(ctx.graph, {
    tenant: ctx.tenant, businessId: businessId(ctx.tenant), agentId: ctx.agentId, turnId: ctx.turnId, now: ctx.now, question: `${ctx.question ?? ""}\n${brief.message}\n${brief.cta}\n${brief.promoting.name}`, idea, seconds: a.seconds ?? 5,
    ...(a.image_asset_id ? { imageAssetId: a.image_asset_id } : {}), makeClip: a.make_clip === true, ...(a.plan !== undefined ? { plan: a.plan } : {}),
    ...(a.picture_ids?.length ? { pictureIds: a.picture_ids } : {}), confirmSpend: a.confirm_spend === true, endLine: brief.cta,
  }, d);
  if (!r.ok || !r.script) return { data: { made: false, why: r.why ?? "No script was made." }, nodes: [], edges: [], sources: [], note: r.why ?? "No script was made." };
  const proposed = [
    ...(r.textCard ? [{ recommendationId: r.textCard.recommendationId, approvalId: r.textCard.approvalId, title: `Reel script: ${r.script.title}` }] : []),
    ...(r.clip.saved ? [{ recommendationId: r.clip.saved.recommendationId, approvalId: r.clip.saved.approvalId, title: r.clip.saved.title }] : []),
    ...(r.reel?.saved ? [{ recommendationId: r.reel.saved.recommendationId, approvalId: r.reel.saved.approvalId, title: r.reel.saved.title }] : []),
  ];
  const col = await nodesFor(ctx, [...(r.clip.saved?.options.map((o) => o.assetId) ?? []), ...(r.reel?.saved?.options.map((o) => o.assetId) ?? []), ...proposed.map((p) => p.approvalId)]);
  const price = r.clip.priceCredits;
  return col.result(ctx, {
    made: true, kind: "reel", script: r.script.text, caption: r.script.caption, scriptWarnings: r.script.warnings,
    scriptCard: r.textCard?.approvalId ?? null,
    clip: { made: r.clip.made, ...(price !== null ? { priceInImageCredits: price } : {}), ...(r.clip.why ? { why: r.clip.why } : {}), ...(r.clip.saved ? { approvalId: r.clip.saved.approvalId, id: r.clip.saved.options[0]?.assetId } : {}) },
    ...(r.reel ? { reel: { status: r.reel.status, seconds: r.reel.seconds, priceInImageCredits: r.reel.priceCredits, spent: r.reel.spentCredits, ...(r.reel.why ? { why: r.reel.why } : {}), repaired: r.reel.repaired, check: r.reel.verdicts.map((v) => `${v.label}: ${v.badge}`), ...(r.reel.saved ? { approvalId: r.reel.saved.approvalId, id: r.reel.saved.options[0]?.assetId } : {}) } } : {}),
    notes: [...r.notes, ...(r.reel?.notes ?? [])], posted: false, waitingForOk: true,
    say: "Give the owner the script word for word in order. Say what the reel draft is (made and checked, or priced and waiting for their OK on the price, or why not). Say plainly what the clip is: made (watch it before approving), or not made and why, with its price in credits when there is one. Nothing is posted.",
    ...(r.reel?.saved ? { deliverable: summary("clip", r.reel.saved, r.reel.notes) } : r.clip.saved ? { deliverable: summary("clip", r.clip.saved, r.notes) } : {}), proposed,
  }, r.clip.made ? "Wrote the script and made the clip; waiting for the owner's OK." : "Wrote the script; waiting for the owner's OK. No clip was made.");
}

export const makeReelTool = defineTool({
  name: "make_reel_script_and_clip",
  description:
    "A short vertical reel that sells something: a timed script, scenes from approved pictures or brand cards, words and logo set by code, checked and repaired. New pictures or clips are quoted first: set confirm_spend only after the owner agrees. Needs a brief; takes a skill's plan. Example: {\"brief\":{\"promoting\":\"Interior Design\",\"message\":\"Rooms that feel calm\",\"cta\":\"Book a visit\"}}",
  input: {
    brief: BRIEF,
    idea: z.string().min(5).max(600).optional().describe("The owner's idea, in their words (default: from the brief)"),
    plan: z.record(z.string(), z.unknown()).optional().describe("A reel plan from a reel skill: {title, hook, scenes:[{seconds, onScreen, voiceOver?, film?, visual:{kind:asset|generate|card,...}, clip?}], caption, endCard}"),
    picture_ids: z.array(z.string()).max(6).optional().describe("Approved picture Asset ids to build the scenes from (free)"),
    confirm_spend: z.boolean().optional().describe("true only after the owner agreed to the reel's quoted price"),
    seconds: z.number().int().min(3).max(10).optional().describe("Length (default 5)"),
    image_asset_id: z.string().optional().describe("An approved picture's Asset id to animate"),
    make_clip: z.boolean().optional().describe("true only when the owner has agreed to the quoted price"),
  },
  writes: true,
  external: true,
  run: runReel,
});
