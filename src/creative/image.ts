// generate_image, end to end: a picture from a description, in the brand's look, through the capped engine (quoted first),
// looked at by Nisha (no lettering that was not asked for, no obvious defects, shows what was asked), saved as Asset{kind:
// image} with its prompt, model, job and cost, and a card waiting for the owner. When the engine is not available it says
// so, exactly, and makes nothing: there is no stand-in picture.
import type { GraphHandle } from "../graph/client.js";
import { checkPictures } from "./compose/check-pictures.js";
import type { SaveDeps, SavedDeliverable, OptionToSave } from "./deliverable.js";
import { saveDeliverable } from "./deliverable.js";
import { makeArtworks } from "./artwork.js";
import { loadComposeKit } from "./kit.js";
import type { CreativeDeps, ImageRequest } from "./ports.js";

export type Aspect = ImageRequest["aspect"];

export interface ImageJob {
  tenant: string; businessId: string; agentId: string; turnId: string; now: number;
  question: string; scene: string; aspect: Aspect; count: number; caption?: string;
}

export interface ImageResult { saved: SavedDeliverable | null; notes: string[]; hfCredits: number; made: number }

const VARIATIONS = ["", " A different angle and composition from the usual.", " A closer, more intimate view with a different light."];

export function imagePrompt(kit: Awaited<ReturnType<typeof loadComposeKit>>, o: { scene: string; aspect: Aspect; variation: number }): string {
  const b = kit.ctx.business, st = kit.ctx.brand;
  return [
    `A picture for ${b.name}${b.industry ? `, a ${b.industry}` : ""}${b.city ? ` in ${b.city}` : ""}. ${o.scene.trim()}.${VARIATIONS[o.variation % VARIATIONS.length]}`,
    st.visualStyle ? `Visual style of the brand: ${st.visualStyle}` : "",
    `Colour mood drawn from the brand palette (${[kit.brand.palette.paper, kit.brand.palette.accent, kit.brand.palette.dark].join(", ")}).`,
    `${o.aspect} frame.`,
    "Strictly: no text, no letters, no numbers, no logos, no watermarks, no signs or labels. A finished, natural-looking picture, not a template.",
  ].filter(Boolean).join(" ");
}

export async function makeImages(g: GraphHandle, job: ImageJob, deps: CreativeDeps): Promise<ImageResult> {
  const kit = await loadComposeKit(g, job.businessId, { store: deps.store, tenant: job.tenant, businessId: job.businessId, now: job.now });
  const count = Math.max(1, Math.min(2, Math.round(job.count)));
  const wanted = Array.from({ length: count }, (_, i) => ({ scene: job.scene, r: { prompt: imagePrompt(kit, { scene: job.scene, aspect: job.aspect, variation: i }), aspect: job.aspect } }));
  const got = await makeArtworks(deps, wanted, { fallbackSaid: ". Nothing was made, and nothing was charged" });
  if (!got.made.length) return { saved: null, notes: got.notes, hfCredits: got.hfCredits, made: 0 };
  const labels = got.made.map((_, i) => String.fromCharCode(65 + i));
  const verdicts = await checkPictures(got.made.map((m, i) => ({ label: labels[i]!, image: m.jpeg })), { brief: job.scene }, { vision: deps.vision });
  const notes = [...got.notes];
  if (verdicts.some((v) => v.badge === "unchecked")) notes.push("I couldn't double-check these pictures (the checker wasn't available), so please look them over before approving.");
  if (verdicts.every((v) => v.badge === "held")) notes.push(`Nisha held every picture back: ${[...new Set(verdicts.flatMap((v) => v.reasons))].slice(0, 3).join("; ")}.`);
  const saveDeps: SaveDeps = { store: deps.store, tenant: job.tenant, agentId: job.agentId, turnId: job.turnId, now: job.now };
  const options: OptionToSave[] = got.made.map((m, i) => {
    const v = verdicts[i]!;
    return {
      label: labels[i]!, buffer: m.jpeg, mime: "image/jpeg", w: m.w, h: m.h, badge: v.badge, note: v.badge === "ok" ? (v.note || "checked: no lettering, no defects") : v.reasons.join("; ") || v.note, aiEdited: true,
      extra: { model: m.img.model, prompt: m.img.prompt.slice(0, 4000), recorded: m.img.recorded, generatedAt: job.now, ...(m.img.jobId ? { hfJobId: m.img.jobId } : {}), ...(m.img.credits !== undefined ? { hfCredits: m.img.credits } : {}) },
    };
  });
  const aspect = job.aspect === "9:16" ? "9:16" : job.aspect === "1:1" ? "1:1" : "4:5";
  const saved = await saveDeliverable(g, saveDeps, {
    kind: "image", title: `Picture: ${job.scene.slice(0, 60)}`, caption: job.caption?.trim() || `Picture: ${job.scene.trim()}`, altText: job.scene.trim().slice(0, 200), aspect, channel: aspect === "9:16" ? "instagram story" : "instagram",
    request: job.question, options, usesBrand: [], guidedBy: kit.ids.rules, notes, hfCredits: got.hfCredits,
  });
  return { saved, notes, hfCredits: got.hfCredits, made: got.made.length };
}
