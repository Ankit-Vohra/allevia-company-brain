// Artwork from the image engine, for a poster's background or an image on its own. The one place a request spends credits:
//  - the engine is asked its status first (not installed, not signed in, no credits: said in plain words, nothing spent);
//  - every piece is QUOTED before it is made, and only as many as fit this request's credit limit are made;
//  - pieces are made in parallel, each failure is its own note and never stops the others.
// Nothing is persisted here (the caller saves what it keeps with lineage); nothing is faked: a piece that was not made is not there.
import sharp from "sharp";
import { EngineUnavailable, type CreativeDeps, type GeneratedImage, type ImageRequest } from "./ports.js";

export const UNKNOWN_QUOTE_CREDITS = 3;   // assumed when the engine cannot quote

export interface MadeArtwork { scene: string; img: GeneratedImage; jpeg: Buffer; w: number; h: number }

export interface ArtworkOutcome { made: MadeArtwork[]; notes: string[]; hfCredits: number; engineMissing: boolean }

export async function makeArtworks(
  deps: CreativeDeps, wanted: Array<{ scene: string; r: ImageRequest }>, o: { fallbackSaid: string },
): Promise<ArtworkOutcome> {
  const out: ArtworkOutcome = { made: [], notes: [], hfCredits: 0, engineMissing: false };
  const engine = deps.engine;
  if (!engine) {
    out.engineMissing = true;
    out.notes.push(`Pictures aren't switched on yet${o.fallbackSaid}.`);
    return out;
  }
  const st = await engine.status().catch(() => ({ ok: false as const, plain: undefined, reason: "error" as const }));
  if (!st.ok) {
    out.engineMissing = true;
    out.notes.push(statusNote(st.reason, st.plain, o.fallbackSaid));
    return out;
  }
  // quote each before any credit is spent; keep only what fits this request's limit
  const room = deps.maxCreditsPerRequest - (deps.spent?.credits ?? 0);
  let total = 0;
  const keep: typeof wanted = [];
  for (const q of wanted) {
    const cost = (await engine.quote(q.r).catch(() => null)) ?? UNKNOWN_QUOTE_CREDITS;
    if (total + cost > room) break;
    total += cost;
    keep.push(q);
  }
  if (!keep.length) {
    out.notes.push(`Making a picture would cost more credits than this request is allowed to use (${deps.maxCreditsPerRequest})${o.fallbackSaid}.`);
    return out;
  }
  if (keep.length < wanted.length) out.notes.push(`I made ${keep.length} picture${keep.length === 1 ? "" : "s"}, not ${wanted.length}: the rest would go over this request's credit limit.`);
  const results = await Promise.allSettled(keep.map((q) => engine.generate(q.r)));
  for (const [i, m] of results.entries()) {
    if (m.status === "rejected") {
      const e = m.reason;
      out.notes.push(e instanceof EngineUnavailable ? `One picture wasn't made: ${e.plain}.` : "One picture wasn't made: picture making failed just now.");
      continue;
    }
    const img = m.value;
    if (img.credits) { out.hfCredits += img.credits; if (deps.spent) deps.spent.credits += img.credits; }
    const meta = await sharp(img.image).metadata();
    out.made.push({ scene: keep[i]!.scene, img, jpeg: await sharp(img.image).jpeg({ quality: 92 }).toBuffer(), w: meta.width ?? 0, h: meta.height ?? 0 });
  }
  return out;
}

// Why no picture was made, as one plain sentence: "Pictures aren't switched on yet, so ..." or "Picture making failed just now, so ...".
function statusNote(reason: string | undefined, plain: string | undefined, fallbackSaid: string): string {
  if (reason === "off" || reason === "no_cli") return `Pictures aren't switched on yet${fallbackSaid}.`;
  if (!plain || reason === "error") return `Picture making failed just now${fallbackSaid}.`;
  return `I couldn't make a picture just now (${plain})${fallbackSaid}.`;
}
