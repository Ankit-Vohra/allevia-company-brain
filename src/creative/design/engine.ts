// The design loop: compose, measure, fix what the code can see, have the piece reviewed, revise, and keep only the best.
//   1. each chosen layout is rendered and its code findings fixed for free (a stronger shade under words that measure
//      low, the logo on a plate, a supporting line dropped when the headline cannot breathe...), up to four passes; a
//      layout that still breaks (a headline that cannot fit, words in a story's covered band) is set aside for the next;
//   2. Rohan reviews the clean ones together (critique.ts), and every issue he raises becomes a concrete change (a crop
//      moved, a shade raised, a line dropped, the other photo, the dark ground); the revised piece is checked by code
//      again and reviewed again, at most `rounds` times;
//   3. each option keeps the version with the best review, and the result says honestly what the reviewer still wanted
//      when a piece never passed. Nothing here spends credits: every pass is a free re-render.
import { composeDesign, type ComposedDesign, type DesignSpec, type Finding } from "./compose.js";
import { passes, reviewDesigns, type Review } from "./critique.js";
import type { Choice } from "./choose.js";
import { DEFAULT_TUNE, type DesignCopy, type Picture, type Tune } from "./layouts.js";
import type { HtmlRenderer } from "./render.js";
import type { DesignSystem } from "./system.js";
import type { FormatKey } from "../compose/formats.js";
import { VisionError, type VisionRunner } from "../../studio/vision.js";

export interface DesignBrief { business: string; goal: string; promoting: string; audience: string; cta?: string; placement: string; request?: string }

export interface DesignRequest {
  ds: DesignSystem;
  format: FormatKey;
  copy: DesignCopy;
  photos: Picture[];
  screens: Picture[];
  scenes: Picture[];          // generated scenes already made, for the layouts that need one
  choices: Choice[];          // best first; more than `count` gives reserves
  count: number;
  brief: DesignBrief;
  rounds?: number;            // review-and-revise rounds (default 2)
}

export interface DesignOption {
  label: string;
  design: ComposedDesign;
  review?: Review;
  passed: boolean;
  history: string[];          // what was changed and why, in order
  scene?: Picture;            // the generated scene it stands on, if any
}

export interface DesignOutcome { options: DesignOption[]; notes: string[]; reviewRan: boolean; setAside: Array<{ layout: string; why: string }> }

export interface EngineDeps { renderer: HtmlRenderer; vision?: VisionRunner | null; log?: (s: string) => void }

const FOCAL: Array<Tune["focal"]> = [undefined, "top", "bottom", "left", "right"];

// The change the code makes for what it measured; null when there is nothing left to try.
export function codeFix(f: Finding[], spec: DesignSpec): { tune: Tune; why: string } | null {
  const t = { ...spec.tune };
  const c = spec.copy;
  const textual = f.filter((x) => x.code === "fit" || x.code === "overflow" || x.code === "collide");
  if (textual.length) {
    if (c.support && !t.dropSupport && !c.keep?.includes("support")) return { tune: { ...t, dropSupport: true }, why: `${textual[0]!.detail}: dropped the supporting line` };
    if (c.eyebrow && !t.dropEyebrow && !c.keep?.includes("eyebrow")) return { tune: { ...t, dropEyebrow: true }, why: `${textual[0]!.detail}: dropped the small line` };
    if (t.scale > 0.8) return { tune: { ...t, scale: Math.round((t.scale - 0.1) * 100) / 100 }, why: `${textual[0]!.detail}: smaller headline` };
    return null;
  }
  const contrast = f.filter((x) => x.code === "contrast");
  if (contrast.some((x) => x.role === "logo") && !t.plate) return { tune: { ...t, plate: true }, why: "the logo was hard to see: put it on a plate" };
  if (contrast.length) {
    if (t.scrim < 3) return { tune: { ...t, scrim: t.scrim + 1 }, why: `${contrast[0]!.detail}: stronger shade under the words` };
    if (t.ground !== "deep") return { tune: { ...t, ground: "deep" }, why: `${contrast[0]!.detail}: the dark ground` };
  }
  const hier = f.find((x) => x.code === "hierarchy");
  if (hier) {
    if (t.scale < 1.15) return { tune: { ...t, scale: Math.round((t.scale + 0.1) * 100) / 100 }, why: "the headline did not lead: made it bigger" };
    // dropping a selling line is the review's call (weak_hierarchy), not the code's: the first AVS proof lost "from the first sketch to the last cushion" this way
  }
  const orphan = f.find((x) => x.code === "orphan");
  if (orphan && t.scale > 0.85) return { tune: { ...t, scale: Math.round((t.scale - 0.05) * 100) / 100 }, why: `${orphan.detail}: re-set slightly smaller` };
  return null;
}

// The change for what the reviewer saw; null when none of his issues is something the composer can change.
export function reviewFix(r: Review, spec: DesignSpec, pictures: number): { tune: Tune; why: string } | null {
  const t = { ...spec.tune };
  for (const is of r.issues) {
    switch (is.code) {
      case "words_hard_to_read":
        if (t.scrim < 3) return { tune: { ...t, scrim: t.scrim + 1 }, why: `review: ${is.detail || "words hard to read"}; stronger shade` };
        if (t.ground !== "deep") return { tune: { ...t, ground: "deep" }, why: `review: ${is.detail}; dark ground` };
        break;
      case "text_too_small": case "empty_space":
        if (t.scale < 1.15) return { tune: { ...t, scale: Math.round(Math.min(1.15, t.scale + 0.1) * 100) / 100 }, why: `review: ${is.detail || is.code}; bigger headline` };
        break;
      case "weak_hierarchy":
        if (spec.copy.support && !t.dropSupport && !spec.copy.keep?.includes("support")) return { tune: { ...t, dropSupport: true, scale: Math.min(1.15, t.scale + 0.05) }, why: `review: ${is.detail || "nothing leads"}; dropped the supporting line` };
        if (t.scale < 1.15) return { tune: { ...t, scale: Math.min(1.15, t.scale + 0.1) }, why: `review: ${is.detail}; bigger headline` };
        break;
      case "crowded":
        if (spec.copy.eyebrow && !t.dropEyebrow && !spec.copy.keep?.includes("eyebrow")) return { tune: { ...t, dropEyebrow: true }, why: `review: ${is.detail || "crowded"}; dropped the small line` };
        if (spec.copy.support && !t.dropSupport && !spec.copy.keep?.includes("support")) return { tune: { ...t, dropSupport: true }, why: `review: ${is.detail || "crowded"}; dropped the supporting line` };
        break;
      case "bad_crop": case "words_over_subject": {
        if (!pictures || !spec.photos.length && !spec.scene) break; // nothing to re-crop: an app screen is shown whole
        const next = FOCAL[(FOCAL.indexOf(t.focal) + 1) % FOCAL.length];
        return { tune: { ...t, focal: next }, why: `review: ${is.detail || "bad crop"}; moved the crop ${next ?? "back to the centre"}` };
      }
      case "logo_problem":
        if (!t.plate) return { tune: { ...t, plate: true }, why: `review: ${is.detail || "logo"}; logo on a plate` };
        break;
      case "repetition":
        if (spec.copy.eyebrow && !t.dropEyebrow && !spec.copy.keep?.includes("eyebrow")) return { tune: { ...t, dropEyebrow: true }, why: `review: ${is.detail || "repetition"}; dropped the small line` };
        break;
      case "ai_artefact": case "generic_picture": case "picture_unrelated":
        if (pictures > 1 && !t.swapPhotos) return { tune: { ...t, swapPhotos: true }, why: `review: ${is.detail || is.code}; used the other picture` };
        break;
      case "off_brand":
        return { tune: { ...t, ground: t.ground === "deep" ? "ground" : "deep" }, why: `review: ${is.detail || "off brand"}; the other ground` };
      default:
        break;
    }
  }
  return null;
}

const sameTune = (a: Tune, b: Tune): boolean => JSON.stringify(a) === JSON.stringify(b);
const blocking = (d: ComposedDesign): Finding[] => d.findings.filter((f) => f.blocking);
const badness = (d: ComposedDesign): number => blocking(d).length * 10 + d.findings.length;

// Render and fix what the code can see, up to four passes. Returns the best version and what was changed.
async function codeLoop(spec: DesignSpec, ds: DesignSystem, deps: EngineDeps, history: string[]): Promise<ComposedDesign> {
  let best = await composeDesign(spec, ds, deps.renderer);
  let cur = best;
  for (let pass = 0; pass < 4 && cur.findings.length; pass++) {
    const fix = codeFix(cur.findings, cur.spec);
    if (!fix || sameTune(fix.tune, cur.spec.tune)) break;
    cur = await composeDesign({ ...cur.spec, tune: fix.tune }, ds, deps.renderer);
    history.push(fix.why);
    if (badness(cur) <= badness(best)) best = cur;
  }
  return best;
}

export async function runDesign(req: DesignRequest, deps: EngineDeps): Promise<DesignOutcome> {
  const log = deps.log ?? (() => {});
  const notes: string[] = [];
  const setAside: DesignOutcome["setAside"] = [];
  const options: DesignOption[] = [];
  let sceneAt = 0;
  // 1. render the choices in order, keeping the first `count` that come out clean
  for (const ch of req.choices) {
    if (options.length >= req.count) break;
    let scene: Picture | undefined;
    if (ch.generateScene) {
      scene = req.scenes[sceneAt % Math.max(1, req.scenes.length)];
      if (!scene) { setAside.push({ layout: ch.key, why: "it needs a picture and none could be made" }); continue; }
      sceneAt++;
    }
    const history: string[] = [];
    const spec: DesignSpec = { layout: ch.key, format: req.format, copy: req.copy, photos: req.photos, screens: req.screens, ...(scene ? { scene } : {}), tune: { ...DEFAULT_TUNE } };
    const d = await codeLoop(spec, req.ds, deps, history);
    const b = blocking(d);
    log(`${ch.key}: ${b.length ? `set aside (${b.map((x) => x.code).join(", ")})` : "clean"}${history.length ? ` after: ${history.join("; ")}` : ""}`);
    if (b.length) { setAside.push({ layout: ch.key, why: b.map((x) => x.detail).join("; ") }); continue; }
    options.push({ label: String.fromCharCode(65 + options.length), design: d, passed: false, history, ...(scene ? { scene } : {}) });
  }
  if (!options.length) return { options, notes, reviewRan: false, setAside };

  // 2. review, revise, review again
  let reviewRan = false;
  if (deps.vision) {
    const rounds = req.rounds ?? 2;
    const pictures = req.photos.length + (req.scenes.length ? 1 : 0);
    for (let round = 0; round <= rounds; round++) {
      const todo = options.filter((o) => !o.passed);
      if (!todo.length) break;
      // a revised version waiting for its first look
      const pending = todo.map((o) => ({ o, d: (o as DesignOption & { next?: ComposedDesign; nextWhy?: string }).next ?? o.design }));
      let reviews: Review[];
      try {
        reviews = await reviewDesigns(deps.vision, pending.map((p) => ({ label: p.o.label, jpeg: p.d.jpeg })), req.brief);
      } catch (e) {
        if (!(e instanceof VisionError)) throw e;
        notes.push(`The design review couldn't run (${e.message.slice(0, 80)}), so these passed the code's own checks only.`);
        break;
      }
      if (reviews.some((r) => r.reviewed)) reviewRan = true;
      for (const p of pending) {
        const o = p.o as DesignOption & { next?: ComposedDesign; nextWhy?: string };
        const r = reviews.find((x) => x.label === o.label);
        if (!r?.reviewed) { delete o.next; continue; }
        // keep the revision only when the reviewer liked it more
        if (o.next) {
          if (!o.review || r.mean >= o.review.mean) { o.design = o.next; o.review = r; o.history.push(`${o.nextWhy} (review ${r.mean.toFixed(1)})`); }
          else o.history.push(`tried: ${o.nextWhy}; the review liked it less (${r.mean.toFixed(1)}), kept the earlier one`);
          delete o.next; delete o.nextWhy;
        } else o.review = r;
        o.passed = passes(o.review!);
        log(`${o.label} ${o.design.spec.layout} round ${round}: ${o.review!.mean.toFixed(2)} ${o.review!.verdict}${o.review!.issues.length ? ` [${o.review!.issues.map((x) => x.code).join(", ")}]` : ""}`);
        if (o.passed || round === rounds) continue;
        const fix = reviewFix(o.review!, o.design.spec, pictures);
        if (!fix || sameTune(fix.tune, o.design.spec.tune)) continue;
        const h: string[] = [];
        const next = await codeLoop({ ...o.design.spec, tune: fix.tune }, req.ds, deps, h);
        if (blocking(next).length) { o.history.push(`tried: ${fix.why}; it broke the layout, kept the earlier one`); continue; }
        o.next = next; o.nextWhy = [fix.why, ...h].join("; ");
      }
    }
    for (const o of options) delete (o as { next?: unknown }).next;
    const unreviewed = options.filter((o) => !o.review);
    if (reviewRan && unreviewed.length) notes.push(`The design review said nothing about option ${unreviewed.map((o) => o.label).join(" and ")}; it passed the code's checks only.`);
    for (const o of options.filter((x) => x.review && !x.passed)) {
      const wants = [...new Set(o.review!.issues.map((x) => x.detail).filter(Boolean))].slice(0, 2);
      notes.push(`Option ${o.label} didn't fully pass the design review (${o.review!.mean.toFixed(1)} of 5)${wants.length ? `: ${wants.join("; ")}` : ""}.`);
    }
  }
  // the best first
  options.sort((a, b) => Number(b.passed) - Number(a.passed) || (b.review?.mean ?? 0) - (a.review?.mean ?? 0));
  options.forEach((o, i) => { o.label = String.fromCharCode(65 + i); });
  return { options, notes, reviewRan, setAside };
}
