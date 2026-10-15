// The creating tools' production deps, built once per process and shared by the server, the Discord bot and the CLI:
// files under <dataDir>/assets (one directory per business), Claude vision on the subscription behind a disk cache (the
// same one the Studio uses), and the image engine.
//
// The image engine is the Studio's generation engine (src/studio/engine.ts, with its credit caps and quotes). Until that
// engine can make a picture from a description, `studioEngineAdapter` says so honestly: the poster tools then deliver the
// layouts on a brand-colour ground and tell the owner the image generator is not connected, rather than faking a picture.
import { productionStudioDeps } from "../studio/wiring.js";
import { CreditLedger, creditCaps } from "../studio/credits.js";
import { EngineDecline } from "../studio/engine.js";
import { execCli, HiggsfieldEngine } from "../studio/higgsfield.js";
import { sha256Hex } from "../studio/image.js";
import type { GeneratedClip } from "./ports.js";
import sharp from "sharp";
import type { GenerationEngine } from "../studio/engine.js";
import { ClaudeResearch } from "./research.js";
import { realReelVideo } from "./reel/render.js";
import { DEFAULT_MAX_CREDITS_PER_REQUEST, EngineUnavailable, type CreativeDeps, type CreativeEngine, type EngineStatus, type GeneratedImage } from "./ports.js";

// Adapts a Studio GenerationEngine to the creating tools' port. An engine that only edits photos (RecordedEngine, the
// Phase 2 stub) cannot make a picture from a description, which is said in words an owner can read.
export function studioEngineAdapter(engine: GenerationEngine & { generate?: unknown }): CreativeEngine {
  const unavailable = new EngineUnavailable("off", "the image generator isn't connected to this server yet");
  return {
    name: engine.name,
    async status(): Promise<EngineStatus> { return { ok: false, reason: unavailable.reason, plain: unavailable.plain }; },
    async quote(): Promise<number | null> { return null; },
    async generate(): Promise<GeneratedImage> { throw unavailable; },
  };
}

// The Studio's real Higgsfield engine (src/studio/higgsfield.ts: the founder's CLI login, a quote before every job, the per-run
// and daily caps in the shared credit ledger) as the creating tools' engine. Its declines become plain words for the owner.
const DECLINE_WORDS: Record<string, string> = {
  missing: "the Higgsfield tool isn't installed on this computer",
  "not-logged-in": "the Higgsfield account isn't signed in",
  "low-balance": "the Higgsfield credits are running low",
  "run-cap": "that would cost more than one job is allowed",
  "daily-cap": "today's budget for new pictures is used up",
  failed: "the image engine didn't finish the job (nothing extra was charged)",
  timeout: "the image engine is taking longer than expected; ask again in a few minutes and it picks up the same job",
  unavailable: "the image engine didn't answer",
};
const plainDecline = (e: unknown): EngineUnavailable => {
  if (e instanceof EngineDecline) return new EngineUnavailable(e.code === "missing" ? "no_cli" : e.code === "not-logged-in" ? "not_signed_in" : e.code === "low-balance" ? "no_credits" : /cap/.test(e.code) ? "cap" : "error", DECLINE_WORDS[e.code] ?? "the image engine didn't answer");
  return new EngineUnavailable("error", `the image engine failed (${e instanceof Error ? e.message.slice(0, 80) : "unknown"})`);
};

export function higgsfieldCreativeEngine(hf: HiggsfieldEngine, tenant: string): CreativeEngine {
  const blank = sharp({ create: { width: 64, height: 114, channels: 3, background: "#808080" } }).jpeg().toBuffer();
  return {
    name: "higgsfield",
    async status(): Promise<EngineStatus> {
      try { return { ok: true, credits: await hf.preflight() }; } catch (e) { const u = plainDecline(e); return { ok: false, reason: u.reason, plain: u.plain }; }
    },
    async quote(req) { try { return (await hf.drawQuote({ prompt: req.prompt, aspect: req.aspect, tenant })).credits; } catch { return null; } },
    async generate(req): Promise<GeneratedImage> {
      try {
        const r = await hf.draw({ prompt: req.prompt, aspect: req.aspect, tenant });
        return { image: r.image, engine: r.engine, model: r.model, prompt: r.prompt, ...(r.jobId ? { jobId: r.jobId } : {}), ...(r.credits !== undefined ? { credits: r.credits } : {}), recorded: false };
      } catch (e) { throw plainDecline(e); }
    },
    // the clip's price does not depend on the picture, so a plain frame stands in for the quote
    async quoteClip(req) { try { return (await hf.clipQuote({ image: await blank, tenant, sourceSha256: "quote", prompt: "A slow push-in.", seconds: req.seconds, aspect: req.aspect === "9:16" ? "9:16" : "4:5" })).credits; } catch { return null; } },
    async animate(req): Promise<GeneratedClip> {
      try {
        const r = await hf.clip({ image: req.image, tenant, sourceSha256: sha256Hex(req.image), prompt: req.prompt, seconds: req.seconds, aspect: req.aspect === "9:16" ? "9:16" : "4:5" });
        return { video: r.video, engine: "higgsfield", model: r.model, jobId: r.jobId, credits: r.credits, mime: "video/mp4", seconds: req.seconds };
      } catch (e) { throw plainDecline(e); }
    },
  };
}

export function productionCreativeDeps(dataDir: string, o: { engine?: CreativeEngine | null; maxCreditsPerRequest?: number; fetchMissingFonts?: boolean; tenant?: string } = {}): CreativeDeps {
  const studio = productionStudioDeps(dataDir);
  // the live engine when the Studio's is live (ALLEVIA_STUDIO_ENGINE=recorded or ALLEVIA_STUDIO_CACHE_ONLY=1 switch it off)
  const off = /^(recorded|off|none)$/i.test(process.env.ALLEVIA_STUDIO_ENGINE ?? "") || /^(1|true|yes)$/i.test(process.env.ALLEVIA_STUDIO_CACHE_ONLY ?? "");
  const live = off ? null : higgsfieldCreativeEngine(new HiggsfieldEngine({ cli: execCli(), ledger: new CreditLedger(dataDir), caps: creditCaps() }), o.tenant ?? "unknown");
  return {
    store: studio.store, vision: studio.vision,
    engine: o.engine === undefined ? live ?? studioEngineAdapter(studio.engine) : o.engine,
    maxCreditsPerRequest: o.maxCreditsPerRequest ?? DEFAULT_MAX_CREDITS_PER_REQUEST,
    fonts: { fetchMissing: o.fetchMissingFonts ?? true },
    research: new ClaudeResearch(),
    video: realReelVideo(),
  };
}
