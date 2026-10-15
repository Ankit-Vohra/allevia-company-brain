// The creating tools' production deps, built once per process and shared by the server, the Discord bot and the CLI:
// files under <dataDir>/assets (one directory per business), Claude vision on the subscription behind a disk cache (the
// same one the Studio uses), and the image engine.
//
// The image engine is the Studio's generation engine (src/studio/engine.ts, with its credit caps and quotes). Until that
// engine can make a picture from a description, `studioEngineAdapter` says so honestly: the poster tools then deliver the
// layouts on a brand-colour ground and tell the owner the image generator is not connected, rather than faking a picture.
import { productionStudioDeps } from "../studio/wiring.js";
import type { GenerationEngine } from "../studio/engine.js";
import { ClaudeResearch } from "./research.js";
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

export function productionCreativeDeps(dataDir: string, o: { engine?: CreativeEngine | null; maxCreditsPerRequest?: number; fetchMissingFonts?: boolean } = {}): CreativeDeps {
  const studio = productionStudioDeps(dataDir);
  return {
    store: studio.store, vision: studio.vision,
    engine: o.engine === undefined ? studioEngineAdapter(studio.engine) : o.engine,
    maxCreditsPerRequest: o.maxCreditsPerRequest ?? DEFAULT_MAX_CREDITS_PER_REQUEST,
    fonts: { fetchMissing: o.fetchMissingFonts ?? true },
    research: new ClaudeResearch(),
  };
}
