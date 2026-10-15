// The words on a design, held to the craft before they are set: ONE sharp selling line (the headline), at most one
// supporting line, ONE call to action, and an eyebrow only when it adds a fact. Code does what code can be trusted with:
//   - Dev's humanizer pass (cleanVoice: no emojis, no exclamation marks, no hard sell, AI-sounding words swapped);
//   - no phrase twice: two words in a row shared by any two blocks ("coming soon" in the eyebrow, the headline AND the
//     button was the founder's complaint), and an eyebrow that only repeats the headline is dropped;
//   - lengths a phone can take in at a glance: a headline over 9 words, a support line over 22, a button over 6 words.
// Judgement (is this the right selling idea?) belongs to the writer and the design review, not to this file.
import { cleanVoice } from "../../studio/caption.js";
import type { DesignCopy } from "./layouts.js";

export interface CopyFinding { code: "repeat" | "long" | "no-cta" | "edited"; field: string; detail: string }

const STOP = new Set(["the", "and", "for", "you", "your", "our", "with", "from", "that", "this", "are", "now", "get", "all", "its", "into", "out", "per",
  "के", "की", "का", "में", "पर", "और", "से", "को", "है", "हैं", "भी", "एक", "अब", "आप", "अपनी", "अपना"]);
const tokens = (s: string): string[] => (s.toLowerCase().normalize("NFC").match(/[\p{L}\p{M}\p{N}]+/gu) ?? []);
const content = (s: string): string[] => tokens(s).filter((w) => w.length > 2 && !STOP.has(w));
const bigrams = (s: string): string[] => { const t = tokens(s).filter((w) => !STOP.has(w)); return t.slice(1).map((w, i) => `${t[i]} ${w}`); };
const count = (s: string | undefined): number => tokens(s ?? "").length;

const FIELDS = ["eyebrow", "headline", "support", "cta", "offer"] as const;
type Field = (typeof FIELDS)[number];

// The shared two-word phrases between every pair of blocks.
export function repeats(c: DesignCopy): Array<{ a: Field; b: Field; phrase: string }> {
  const out: Array<{ a: Field; b: Field; phrase: string }> = [];
  for (let i = 0; i < FIELDS.length; i++) {
    for (let j = i + 1; j < FIELDS.length; j++) {
      const a = FIELDS[i]!, b = FIELDS[j]!;
      const x = c[a], y = c[b];
      if (!x || !y) continue;
      const shared = bigrams(x).filter((p) => bigrams(y).includes(p));
      if (shared.length) out.push({ a, b, phrase: shared[0]! });
    }
  }
  return out;
}

const tidy = (s: string, field: string, findings: CopyFinding[]): string => {
  const r = cleanVoice(s);
  let t = r.text || s;
  if (field !== "support") t = t.replace(/\.$/, "");
  if (r.edits.length) findings.push({ code: "edited", field, detail: `${field}: ${r.edits.join(", ")}` });
  return t;
};

// The copy, cleaned, with the eyebrow dropped when it only repeats; plus what the writer should still fix.
export function prepareCopy(c: DesignCopy): { copy: DesignCopy; findings: CopyFinding[] } {
  const findings: CopyFinding[] = [];
  const copy: DesignCopy = { ...c, headline: tidy(c.headline, "headline", findings) };
  for (const f of ["support", "eyebrow", "cta"] as const) {
    const v = c[f]?.trim();
    if (v) copy[f] = tidy(v, f, findings); else delete copy[f];
  }
  // an eyebrow that says what the headline already says is noise: drop it
  if (copy.eyebrow) {
    const head = new Set(content(copy.headline));
    const eb = content(copy.eyebrow);
    if (eb.length && eb.every((w) => head.has(w))) { findings.push({ code: "repeat", field: "eyebrow", detail: `the small line "${copy.eyebrow}" only repeats the headline, so it was left out` }); delete copy.eyebrow; }
  }
  for (const r of repeats(copy)) {
    if (r.a === "eyebrow" || r.b === "eyebrow") { findings.push({ code: "repeat", field: "eyebrow", detail: `"${r.phrase}" was in the small line and the ${r.a === "eyebrow" ? r.b : r.a}, so the small line was left out` }); delete copy.eyebrow; continue; }
    findings.push({ code: "repeat", field: r.b, detail: `"${r.phrase}" appears in both the ${r.a} and the ${r.b}: say it once` });
  }
  if (count(copy.headline) > 9) findings.push({ code: "long", field: "headline", detail: `the headline is ${count(copy.headline)} words; 7 or fewer read at a glance` });
  if (count(copy.support) > 22) findings.push({ code: "long", field: "support", detail: `the supporting line is ${count(copy.support)} words; keep it to one short sentence` });
  if (count(copy.cta) > 6) findings.push({ code: "long", field: "cta", detail: "the call to action is long; a button is a few words" });
  if (!copy.cta) findings.push({ code: "no-cta", field: "cta", detail: "there is no call to action: say what the viewer should do" });
  return { copy, findings };
}

// What still has to change before it can be set (a phrase said twice outside the eyebrow).
export const blockingCopy = (f: CopyFinding[]): CopyFinding[] => f.filter((x) => x.code === "repeat" && x.field !== "eyebrow");
