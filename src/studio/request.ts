// What the owner's words under the options ask for, decided in code (founder's brief, 2026-10-15): light and colour words
// ("warmer", "a bit darker") stay on the free local path; "try again" retries a held-back AI edit; "make this into an ad
// saying ..." is an ad; everything else ("make it festive", "change the background", "remove the pole") goes to the
// generative engine with the business's brand rules and the photo as the reference. Pure functions: the callers do the work.
import { beyondAdjustments, parseAdjustment, type Adjustment } from "./revise.js";

export type StudioRequest =
  | { kind: "adjust"; adjustment: Adjustment }
  | { kind: "premium"; words: string; headline?: string; sub?: string }
  | { kind: "ad"; words: string; headline?: string; sub?: string }
  | { kind: "retry" }
  | { kind: "clip" }
  | { kind: "chat" }
  | { kind: "generate"; words: string };

const CHATTER = /^(?:thanks?(?: you)?|thank u|ok(?:ay)?|great|nice|cool|good|love it|perfect|awesome|hi|hello|hey|yes|no|sure|done)[\s!.]*$/i;
const RETRY = /^(?:please\s+)?(?:try again|retry|try that again|do it again|redo(?: it)?|have another go|another go|one more try)\b/i;
const CLIP = /\b(?:clip|reel|video|animate|animation|short film)\b/i;
const AD = /\b(?:ad|ads|advert|advertisement|promo|promotion|poster|flyer|banner)\b/i;
// "make this a premium ad", "UGC style", "lifestyle shot", "a proper photoshoot": a premium, UGC-style ad picture of the product
// (premium.ts: Higgsfield's product-photoshoot backend), not a light-and-colour change and not a clean-up.
const PREMIUM = /\b(?:ugc|premium|lifestyle|luxury|high[- ]end|studio[- ]quality|photo ?shoot|product shoot|brand shoot|campaign (?:photo|image|shot))\b/i;

// The message an ad should carry, from the owner's words: in quotes, or after "saying", "that says", "with the offer", "offer:".
export function adMessage(words: string): { headline?: string; sub?: string } {
  const t = words.trim();
  const quoted = /["“]([^"“”]{3,100})["”]/.exec(t);
  const said = /\b(?:saying|that says|which says|with the (?:words|text|message|line|offer)|with the offer of|the offer is|offer\s*[:\-]|with offer|message\s*[:\-]|text\s*[:\-])\s*[:\-]?\s*(.{3,100})$/i.exec(t);
  const raw = (quoted?.[1] ?? said?.[1])?.trim().replace(/[.!\s]+$/, "");
  if (!raw) return {};
  const [head, ...rest] = raw.split(/\s+[|·]\s+|\s+-\s+|;\s*/);
  return { headline: head!.trim(), ...(rest.length ? { sub: rest.join(" · ").trim().slice(0, 80) } : {}) };
}

export function routeRequest(words: string): StudioRequest {
  const t = words.trim();
  if (!t || CHATTER.test(t)) return { kind: "chat" };
  if (RETRY.test(t)) return { kind: "retry" };
  if (PREMIUM.test(t) && /\b(?:make|turn|create|build|design|into|as|for|want|give|need|shoot)\b/i.test(t)) return { kind: "premium", words: t.slice(0, 300), ...adMessage(t) };
  if (AD.test(t) && /\b(?:make|turn|create|build|design|into|as|for|want)\b/i.test(t)) return { kind: "ad", words: t, ...adMessage(t) };
  if (CLIP.test(t) && /\b(?:make|turn|create|want|can|could)\b/i.test(t)) return { kind: "clip" };
  const adjustment = parseAdjustment(t);
  if (adjustment && beyondAdjustments(t).length === 0) return { kind: "adjust", adjustment };
  return { kind: "generate", words: t.slice(0, 300) };
}
