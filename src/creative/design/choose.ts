// Choosing layouts by the brief and the material at hand. A layout is only eligible when its needs are met (a real app
// screen, three real photos, an offer the owner gave...). Among the eligible ones the score favours, in order: what the
// owner or the skill asked for; the business's REAL material (a real screen, its own photos) over a generated scene; the
// brief's goal; and structural variety: the layout this business used last is never used again straight away, and the
// last few are pushed down. Options in one request are always different layouts.
import { LAYOUTS, type DesignCopy, type LayoutDef, type LayoutKey } from "./layouts.js";

export type Goal = "sell" | "offer" | "announce" | "awareness";

export interface ChooseInput {
  goal: Goal;
  copy: DesignCopy;
  photos: number;              // the business's own photos available
  screens: number;             // real app screens available
  focusScreens: number;        // screens with a focus box
  canGenerate: boolean;        // a scene can be generated for a layout that needs a picture
  recent: string[];            // layouts this business used, newest first
  prefer?: LayoutKey[];
  count: number;
}

export interface Choice { key: LayoutKey; generateScene: boolean; score: number; why: string }

const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\d{1,2}[/.-]\d{1,2}|जनवरी|फ़रवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|अक्टूबर|नवंबर|दिसंबर/i;
export const hasDate = (c: DesignCopy): boolean => (c.details ?? []).some((d) => /\d/.test(d) && MONTH.test(d));
const words = (s: string): number => (s.trim().match(/\S+/g) ?? []).length;

export function eligible(def: LayoutDef, i: ChooseInput): { ok: boolean; generateScene: boolean } {
  const n = def.needs;
  if (n.screens && i.screens < n.screens) return { ok: false, generateScene: false };
  if (n.offer && !i.copy.offer?.trim()) return { ok: false, generateScene: false };
  if (n.quote && !i.copy.quote?.text?.trim()) return { ok: false, generateScene: false };
  if (n.pair && !i.copy.pair) return { ok: false, generateScene: false };
  if (n.date && !hasDate(i.copy)) return { ok: false, generateScene: false };
  if (n.details && (i.copy.details?.length ?? 0) < n.details) return { ok: false, generateScene: false };
  if (n.photos) {
    if (i.photos >= n.photos) return { ok: true, generateScene: false };
    // one missing picture can be a generated scene; a portfolio or a before/after must be real
    if (n.photos - i.photos === 1 && i.canGenerate && def.key !== "gallery-trio" && def.key !== "before-after") return { ok: true, generateScene: true };
    return { ok: false, generateScene: false };
  }
  return { ok: true, generateScene: false };
}

export function chooseLayouts(i: ChooseInput): Choice[] {
  const last = i.recent[0];
  const scored: Choice[] = [];
  for (const def of LAYOUTS) {
    const e = eligible(def, i);
    if (!e.ok) continue;
    if (def.key === last && !i.prefer?.includes(def.key)) continue; // never the same layout twice in a row
    if (def.key === "carousel-cover" && !i.prefer?.includes(def.key)) continue; // only for a carousel someone asked for
    let score = 0;
    const why: string[] = [];
    if (i.prefer?.includes(def.key)) { score += 20 - i.prefer.indexOf(def.key); why.push("asked for"); }
    if (def.needs.screens) { score += 6; why.push("shows the real app"); }
    if (def.needs.screens && def.key === "feature-callout" && !i.focusScreens) score -= 4;
    if (def.needs.photos && !e.generateScene) { score += 4 + Math.min(2, i.photos - 1); why.push("uses the business's own photos"); }
    if (e.generateScene) { score -= 1; why.push("needs a generated scene"); }
    if (def.goals.includes(i.goal)) { score += 3; why.push(`fits '${i.goal}'`); }
    if (def.key === "offer-card" && i.goal === "offer") score += 5;
    if (def.key === "quote-card") score += 5;
    if (def.key === "date-announcement" && i.goal === "announce") score += 4;
    if (def.key === "hiring-card" && /hiring|vacanc|job opening|we're looking|भर्ती|वैकेंसी/i.test(`${i.copy.headline} ${i.copy.eyebrow ?? ""}`)) score += 6;
    if (def.key === "big-type") score += words(i.copy.headline) <= 5 ? 2 : -3;
    if (def.key === "carousel-cover" || def.key === "event-poster" || def.key === "local-place") score -= 2; // only when the brief says so
    const age = i.recent.indexOf(def.key);
    if (age >= 0 && age < 4) { score -= 3 - Math.min(2, age); why.push("used recently"); }
    scored.push({ key: def.key, generateScene: e.generateScene, score, why: why.join(", ") });
  }
  scored.sort((a, b) => b.score - a.score || LAYOUTS.findIndex((l) => l.key === a.key) - LAYOUTS.findIndex((l) => l.key === b.key));
  return scored.slice(0, Math.max(1, i.count));
}
