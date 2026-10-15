// The generative edit's prompt, built from the graph (product design §6, step 5): LOCK · SCOPE · STYLE · AUDIENCE ·
// SEASON · FORMAT · NEGATIVES. LOCK comes from Tara's assessment and the fidelity rules (Rule{kind:'fidelity'} plus the
// defaults below, which always apply); STYLE from the brand kit; AUDIENCE from Audience -> Need; past winners from
// Content measured by Observations; FORMAT from the playbook's platform rules. Image models never render text: our code
// draws any overlay. Every node used is returned in `sources`, so the prompt has provenance like an answer does.
import type { GraphHandle } from "../graph/client.js";
import type { PhotoAssessment } from "./assess.js";
import type { StudioContext } from "./context.js";

export const FIDELITY_DEFAULTS = [
  "Do not add, remove or alter architectural elements: walls, roofline, arches, window and door openings, glazing bars, columns, steps and edges stay exactly where and how they are.",
  "Keep the camera position, perspective and framing; no new objects, people, plants or furniture, and nothing removed except noise.",
];

export interface EditTreatment { key: string; label: string; scope: string }

export const TREATMENTS: Record<string, EditTreatment> = {
  "relight-clean-editorial": {
    key: "relight-clean-editorial",
    label: "Relight, clean sky, editorial grade",
    scope: "relight to soft, warm late-afternoon daylight; lift the shadows and correct the cool colour cast; clean the sky to a soft, even tone; remove sensor noise; a calm, premium editorial architecture-magazine look",
  },
};

export interface EditPrompt {
  prompt: string;
  sections: Record<"lock" | "scope" | "style" | "audience" | "season" | "format" | "negatives", string>;
  sources: string[];
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export async function buildEditPrompt(
  g: GraphHandle, ctx: StudioContext, a: PhotoAssessment, treatment: EditTreatment, now: number,
): Promise<EditPrompt> {
  const sources = new Set<string>(ctx.brand.ids);
  const fidelity = await g.roQuery<{ id: string; text: string | null }>(
    "MATCH (r:Rule) WHERE r.kind = 'fidelity' AND coalesce(r.status, 'active') <> 'retired' RETURN r.id AS id, coalesce(r.summary, r.name) AS text ORDER BY r.id LIMIT 6");
  fidelity.forEach((r) => sources.add(r.id));
  const audiences = await g.roQuery<{ id: string; name: string | null }>("MATCH (a:Audience) RETURN a.id AS id, a.name AS name ORDER BY a.id LIMIT 3");
  const needs = audiences.length
    ? await g.roQuery<{ name: string | null }>("MATCH (a:Entity:Audience)-[:HAS_NEED]->(n:Need) WHERE a.id IN $ids RETURN n.name AS name ORDER BY n.name, n.id LIMIT 4", { ids: audiences.map((x) => x.id) })
    : [];
  audiences.forEach((x) => sources.add(x.id));
  const winners = await g.roQuery<{ id: string; name: string | null; v: number }>(
    `MATCH (o:Observation)-[:MEASURES]->(c:Content) WHERE o.metric IN ['reach', 'saves', 'engagement', 'likes', 'views']
     RETURN c.id AS id, c.name AS name, max(o.value) AS v ORDER BY v DESC, id LIMIT 3`);
  winners.forEach((w) => sources.add(w.id));
  const format = await g.roQuery<{ id: string }>(
    "MATCH (r:Rule) WHERE r.summary CONTAINS '4:5' RETURN r.id AS id ORDER BY r.id LIMIT 2");
  format.forEach((r) => sources.add(r.id));
  const horizon = now + 21 * 86_400_000;
  const season = await g.roQuery<{ id: string; name: string | null }>(
    "MATCH (e:Event) WHERE e.kind IN ['season', 'holiday'] AND coalesce(e.at, 0) >= $now AND coalesce(e.at, 0) <= $horizon RETURN e.id AS id, e.name AS name ORDER BY e.at, e.id LIMIT 2",
    { now, horizon });
  season.forEach((e) => sources.add(e.id));
  if (ctx.project) sources.add(ctx.project.contentId);

  const b = ctx.brand;
  const palette = [b.paper, b.ink, b.accent, b.neutral].filter(Boolean).join(", ");
  const sections: EditPrompt["sections"] = {
    lock: [
      a.locks.length ? `Keep exactly as they are: ${a.locks.join("; ")}.` : "Keep the building exactly as it is.",
      ...FIDELITY_DEFAULTS, ...fidelity.map((r) => r.text ?? "").filter(Boolean),
    ].join(" "),
    scope: `${treatment.scope}.`,
    // The palette and the tone, not the website's typography: an image model has no use for fonts.
    style: [
      palette ? `Grade toward the brand palette (${palette}): earthy and muted, never bright or saturated.` : "",
      b.tone ? `The mood of the brand: ${clip(b.tone, 160)}` : "",
    ].filter(Boolean).join(" "),
    audience: audiences.length
      ? `For ${audiences.map((x) => x.name).filter(Boolean).join(", ")}${needs.length ? `, who want ${needs.map((n) => n.name).filter(Boolean).join(", ")}` : ""}.`
      : `For people looking for ${ctx.business.industry ? `${/^[aeiou]/i.test(ctx.business.industry) ? "an" : "a"} ${ctx.business.industry}` : "a business like this"}${ctx.business.city ? ` in ${ctx.business.city}` : ""}.`,
    season: season.length ? `In season: ${season.map((e) => e.name).filter(Boolean).join(", ")}.` : "No seasonal cue.",
    format: "Keep the input's framing and aspect ratio exactly; do not straighten, crop, extend or reframe (the studio straightens and crops it to a 4:5 feed post afterwards).",
    negatives: "No text, letters, numbers, logos, watermarks or borders. No added or removed structures, people or objects. No HDR halos, lens flare, fake sunset or oversharpening.",
  };
  const subject = ctx.project ? `${a.subject} (the ${ctx.project.name} project)` : a.subject;
  const prompt = [
    `Edit this photo of ${subject} by ${ctx.business.name} into a finished post.`,
    `LOCK: ${sections.lock}`,
    `SCOPE: ${sections.scope}`,
    sections.style ? `STYLE: ${sections.style}` : "",
    `AUDIENCE: ${sections.audience}`,
    winners.length ? `PAST WINNERS: posts like ${winners.map((w) => w.name).filter(Boolean).join(", ")} did best.` : "",
    `SEASON: ${sections.season}`,
    `FORMAT: ${sections.format}`,
    `NEGATIVES: ${sections.negatives}`,
  ].filter(Boolean).join("\n");
  return { prompt, sections, sources: [...sources] };
}

// ---------- the owner's own requests ("make it festive", "change the background", "turn it into an ad") ----------

export type RequestMode = "request" | "ad" | "retry";

export interface RequestPromptInput {
  words: string;                      // what the owner asked for (data, quoted, never an instruction to the studio)
  mode: RequestMode;
  /** Retry: what Nisha found the last attempt added and removed, so the new attempt is told to leave those alone. */
  retry?: { added: string[]; removed: string[] };
}

// The owner explicitly asked for a change, so the architectural locks of the default edit do not apply; the subject
// itself, the framing, people and the brand still do.
export const REQUEST_LOCKS = [
  "Change only what the request names. Keep the subject itself (the building, product, room or place), its shape, proportions, materials and details exactly as they are, and keep the camera position, perspective and framing.",
  "Do not invent logos, signs, lettering, brand marks or extra people. Never alter, replace or reshape any person's face, body or clothing.",
];

export function buildRequestPrompt(ctx: StudioContext, a: PhotoAssessment, o: RequestPromptInput): EditPrompt {
  const b = ctx.brand;
  const palette = [b.paper, b.ink, b.accent, b.neutral].filter(Boolean).join(", ");
  const words = o.words.replace(/\s+/g, " ").trim().slice(0, 300);
  const subject = ctx.project ? `${a.subject} (the ${ctx.project.name} project)` : a.subject;
  const sections: EditPrompt["sections"] = {
    lock: [
      ...REQUEST_LOCKS,
      a.locks.length ? `What must stay recognisable: ${a.locks.join("; ")}, except where the request changes it.` : "",
      ...(o.retry && (o.retry.added.length || o.retry.removed.length)
        ? [`The last attempt went wrong: it ${[o.retry.added.length ? `added ${o.retry.added.join(", ")}` : "", o.retry.removed.length ? `removed ${o.retry.removed.join(", ")}` : ""].filter(Boolean).join(" and ")}. This time keep those exactly as they are in the photo and change nothing beyond the request.`]
        : []),
    ].filter(Boolean).join(" "),
    scope: o.mode === "ad"
      ? `Make this a clean advertising image for ${ctx.business.name}: ${words}. Compose it so the bottom third is calm, plain space for a message that will be added afterwards (leave it completely empty: no letters, no numbers), with the subject sharp and unchanged above it.`
      : `Apply this change and nothing else: ${words}.`,
    style: [
      palette ? `Where colour is free to change, lean toward the brand palette (${palette}): earthy and muted, never garish.` : "",
      b.tone ? `The mood of the brand: ${clip(b.tone, 160)}` : "",
      ...b.visualRules.slice(0, 3).map((r) => clip(r.text, 160)),
    ].filter(Boolean).join(" "),
    audience: `For people looking for ${ctx.business.industry ? `${/^[aeiou]/i.test(ctx.business.industry) ? "an" : "a"} ${ctx.business.industry}` : "a business like this"}${ctx.business.city ? ` in ${ctx.business.city}` : ""}.`,
    season: "",
    format: "Keep the input's framing and aspect ratio exactly; do not crop, extend or reframe.",
    negatives: "No text, letters, numbers, logos, watermarks or borders. No extra people. No HDR halos, lens flare or oversharpening. The result must look like a real photograph of the same place.",
  };
  const prompt = [
    `Edit this photo of ${subject} by ${ctx.business.name}.`,
    `REQUEST: ${sections.scope}`,
    `LOCK: ${sections.lock}`,
    sections.style ? `STYLE: ${sections.style}` : "",
    `FORMAT: ${sections.format}`,
    `NEGATIVES: ${sections.negatives}`,
  ].filter(Boolean).join("\n");
  return { prompt, sections, sources: [...b.ids] };
}
