// A short clip from a picture the owner likes (founder's brief, 2026-10-15): 5 seconds, 9:16, from the recommended option that
// Nisha passed. It is always an explicit, priced choice: the offer says what it costs and what a clip cannot do, and nothing is
// spent until the owner presses the button. The content trials found 4:5 output with no sound or text and lettering artifacts at
// the edge, so the start frame is cropped to 9:16 here (the aspect is asked for and fixed in code, not hoped for), the clip is
// silent, and the offer says plainly that it has no text, no voice-over and can invent small details.
// A clip has its own per-run cap (ALLEVIA_STUDIO_CLIP_CREDIT_CAP, default 8: a 5 second clip is about 7.5 credits); the daily
// cap still applies. A photo with a child never gets a clip (the offer is the one clean-up sentence).
import sharp from "sharp";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { agentNodeId } from "../agent/memory.js";
import { recordGeneration } from "./lineage.js";
import { entityId } from "../util/ids.js";
import { TARA } from "./assess.js";
import { EngineDecline } from "./engine.js";
import { creditsWords } from "./credits.js";
import type { HiggsfieldEngine } from "./higgsfield.js";
import { sha256Hex } from "./image.js";
import { CHILD_NOTICE } from "./privacy.js";
import { loadRevision } from "./revise.js";
import type { AssetStore } from "./store.js";

export const CLIP_CAPS = "It is 5 seconds, silent, with no text or voice-over, and cropped to the middle of the photo for a tall screen. AI video can invent small details, so watch it before you use it.";
export const CLIP_PROMPT = "A slow, gentle camera push-in on this exact scene. Keep every object, shape, colour and detail exactly as in the picture; no new objects, people or lettering; no cuts.";
// The clip from a premium ad picture (premium.ts): the same slow move, with the feel of a handheld phone shot. The product is the
// subject, so it is told to stay exactly as it is.
export const CLIP_PROMPT_AD = "A short vertical ad shot: a slow, natural handheld-feel push-in with a soft parallax and a gentle shift of daylight on this exact scene. The product stays exactly as in the picture (shape, colour, label); no cuts; no new objects, people or lettering; no text.";

export function clipCap(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ALLEVIA_STUDIO_CLIP_CREDIT_CAP);
  return env.ALLEVIA_STUDIO_CLIP_CREDIT_CAP !== undefined && Number.isFinite(n) && n > 0 ? n : 8;
}

/** The still, cropped to the middle in 9:16 at 1080x1920: the clip's start frame. */
export async function startFrame(image: Buffer): Promise<Buffer> {
  return sharp(image).resize(1080, 1920, { fit: "cover", position: "centre" }).jpeg({ quality: 92 }).toBuffer();
}

export interface ClipRequest { tenant: string; businessId: string; approvalId: string; variantId?: string }
export type ClipOffer = { ok: true; message: string; label: string; variantId: string; credits: number; words: string } | { ok: false; message: string };
export type ClipMade = { ok: true; message: string; video: Buffer; assetId: string; credits: number; jobId: string } | { ok: false; message: string };

/** What the Discord bot and the API need from the clip service. */
export interface ClipPort {
  offer(r: ClipRequest): Promise<ClipOffer>;
  make(r: ClipRequest): Promise<ClipMade>;
}

export class ClipService implements ClipPort {
  constructor(private o: { g: GraphHandle | ((tenant: string) => Promise<GraphHandle>); store: AssetStore; engine: HiggsfieldEngine; cap?: number; now?: () => number }) {}

  private graph(tenant: string): Promise<GraphHandle> | GraphHandle { return typeof this.o.g === "function" ? this.o.g(tenant) : this.o.g; }

  // The option the clip comes from: the one named, else the recommended one, and it must have passed Nisha's check.
  private async source(r: ClipRequest) {
    const g = await this.graph(r.tenant);
    const loaded = await loadRevision(g, r, { store: this.o.store });
    if (!loaded.ok) return { err: loaded.message } as const;
    if (loaded.r.privacy.localOnly) return { err: `${CHILD_NOTICE} That includes video.` } as const;
    const s = loaded.r.s;
    const v = s.variants.find((x) => x.id === (r.variantId ?? s.recommended));
    if (!v || v.badge !== "unchanged") return { err: "A clip needs an option Nisha has checked and passed. Pick one of those first." } as const;
    const [row] = await g.roQuery<{ key: string | null; step: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.step AS step", { id: v.id });
    const bytes = row?.key ? this.o.store.get(r.tenant, row.key) : null;
    if (!bytes) return { err: "I can't find that option's picture any more." } as const;
    return { g, v, bytes, s, original: loaded.r.original, card: loaded.r.card, prompt: row?.step === "premium-ad" ? CLIP_PROMPT_AD : CLIP_PROMPT } as const;
  }

  async offer(r: ClipRequest): Promise<ClipOffer> {
    const src = await this.source(r);
    if ("err" in src) return { ok: false, message: String(src.err) };
    try {
      const frame = await startFrame(src.bytes);
      const q = await this.o.engine.clipQuote({ image: frame, tenant: r.tenant, sourceSha256: sha256Hex(src.bytes), prompt: src.prompt, aspect: "9:16", maxCredits: this.o.cap ?? clipCap() });
      return {
        ok: true, label: src.v.label, variantId: src.v.id, credits: q.credits, words: q.words,
        message: `I can make a 5 second clip from option ${src.v.label}. It would use ${q.words}. ${CLIP_CAPS} Press the button if you want it.`,
      };
    } catch (e) {
      if (e instanceof EngineDecline) return { ok: false, message: e.message.replace(/, so I (?:made|kept to) the simple clean-up( only)?\.?/i, ".") };
      return { ok: false, message: "I couldn't price a clip just now. Try again in a moment." };
    }
  }

  async make(r: ClipRequest): Promise<ClipMade> {
    const src = await this.source(r);
    if ("err" in src) return { ok: false, message: String(src.err) };
    try {
      const frame = await startFrame(src.bytes);
      const out = await this.o.engine.clip({ image: frame, tenant: r.tenant, sourceSha256: sha256Hex(src.bytes), prompt: src.prompt, aspect: "9:16", maxCredits: this.o.cap ?? clipCap() });
      const now = this.o.now?.() ?? Date.now();
      const sha = sha256Hex(out.video);
      const storageKey = this.o.store.put(r.tenant, sha, out.video, "mp4");
      const id = entityId("Asset", `clip-${src.original.sha256.slice(0, 12)}-${sha.slice(0, 8)}`);
      await upsertNode(src.g, {
        type: "Asset", id, name: `Clip from option ${src.v.label} (5 s, 9:16, Higgsfield, AI-made)`,
        props: { kind: "final", mediaType: "video", mime: "video/mp4", storageKey, sha256: sha, source: "higgsfield", aiEdited: true, step: "clip", hfJobId: out.jobId, hfCredits: out.credits, model: out.model, status: "proposed", seconds: 5, aspect: "9:16" },
      }, now);
      await upsertEdge(src.g, { from: id, type: "DERIVED_FROM", to: src.v.id, props: { step: "clip" } }, now);
      await upsertEdge(src.g, { from: agentNodeId(TARA), type: "PRODUCED", to: id, props: { step: "clip" } }, now).catch(() => undefined);
      // the job, its cost and the picture it started from are facts in the graph (lineage.ts), and the clip goes with the card
      await recordGeneration(src.g, { assetId: id, jobId: out.jobId, model: out.model, credits: out.credits, mode: "clip", prompt: src.prompt, now });
      const payload = {
        ...src.card.payload,
        studio: {
          ...src.s,
          extras: [...(src.s.extras ?? []).filter((x) => x.id !== id), { id, label: "Clip", kind: "clip" as const, from: src.v.id, note: `5 seconds, silent, made from option ${src.v.label}`, seconds: 5, credits: out.credits }],
        },
      };
      const [ap] = await src.g.roQuery<{ name: string | null; rec: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name, a.recommendation AS rec", { id: r.approvalId });
      await upsertNode(src.g, { type: "Approval", id: r.approvalId, name: ap?.name ?? r.approvalId, props: { payload: JSON.stringify(payload) } }, now);
      if (ap?.rec) await upsertEdge(src.g, { from: ap.rec, type: "EVIDENCED_BY", to: id, props: { part: "clip" } }, now).catch(() => undefined);
      return { ok: true, video: out.video, assetId: id, credits: out.credits, jobId: out.jobId, message: `Here is your 5 second clip from option ${src.v.label}. It used ${creditsWords(out.credits, { about: true })}. ${CLIP_CAPS}` };
    } catch (e) {
      if (e instanceof EngineDecline) return { ok: false, message: e.message.replace(/, so I (?:made|kept to) the simple clean-up( only)?\.?/i, ".") };
      return { ok: false, message: "The clip stopped on a problem, so nothing was added. Try again in a moment." };
    }
  }
}
