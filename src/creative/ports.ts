// What the creating tools need from the outside, as small ports so they are tested with fakes and wired in one place:
//  - CreativeEngine: the image (and clip) generator. It belongs to the Studio's generation engine (src/studio/engine.ts,
//    with its credit caps and quotes); this is the narrow shape the creating tools use, and creativeEngineFrom() in
//    wiring.ts adapts the real engine to it. Nothing here spends credits by itself: every call goes through the engine's
//    own cap, and a tool quotes before it generates.
//  - CreativeDeps: everything one request can use (files, vision, the engine, limits). Absent from the tool context means
//    "creating is not set up on this server", which the tools say in plain words.
import type { AssetStore } from "../studio/store.js";
import type { VisionRunner } from "../studio/vision.js";
import type { PosterFormat } from "./compose/formats.js";
import type { ResearchRunner } from "./research.js";
import type { ReelVideo } from "./reel/render.js";
import type { HtmlRenderer } from "./design/render.js";

export interface ImageRequest {
  prompt: string;
  aspect: PosterFormat["aspect"];
  references?: Buffer[];          // the owner's own pictures to start from (never a picture with a person in it)
}

export interface GeneratedImage {
  image: Buffer;
  engine: string;
  model: string;
  prompt: string;
  jobId?: string;
  credits?: number;               // what it cost, in the engine's credits
  recorded: boolean;              // replayed from an earlier generation, not made now
}

export interface ClipRequest { image: Buffer; prompt: string; seconds: number; aspect: PosterFormat["aspect"] }
export interface GeneratedClip { video: Buffer; engine: string; model: string; jobId?: string; credits?: number; mime: "video/mp4"; seconds: number; width?: number; height?: number }

export type UnavailableReason = "off" | "no_cli" | "not_signed_in" | "no_credits" | "cap" | "error";

// The engine said no, in words an owner can read. `reason` lets the tool choose what to still deliver.
export class EngineUnavailable extends Error {
  override name = "EngineUnavailable";
  constructor(readonly reason: UnavailableReason, readonly plain: string) {
    super(plain);
  }
}

export interface EngineStatus { ok: boolean; reason?: UnavailableReason; plain?: string; credits?: number }

export interface CreativeEngine {
  readonly name: string;
  status(): Promise<EngineStatus>;
  // What this would cost, in credits, before any is spent. null when the engine cannot say.
  quote(req: ImageRequest): Promise<number | null>;
  generate(req: ImageRequest): Promise<GeneratedImage>;
  quoteClip?(req: Pick<ClipRequest, "seconds" | "aspect">): Promise<number | null>;
  animate?(req: ClipRequest): Promise<GeneratedClip>;
  // A short instrumental bed for a reel (no voice, no lyrics), priced first like everything else.
  quoteMusic?(req: MusicRequest): Promise<number | null>;
  music?(req: MusicRequest): Promise<GeneratedMusic>;
}

export interface MusicRequest { prompt: string; seconds: number }
export interface GeneratedMusic { audio: Buffer; model: string; jobId?: string; credits?: number }

export interface CreativeDeps {
  store: AssetStore;
  vision: VisionRunner;
  engine: CreativeEngine | null;          // null: no image engine here (posters still work on a brand-colour ground)
  // Most credits one request may spend in all; a quote above what is left is refused before generating.
  maxCreditsPerRequest: number;
  // Fetches a Google font family into the brand library when the business has none (the website step normally did). Off in tests.
  fonts?: { fetchMissing: boolean };
  // Web research for the research tool (Claude on the subscription, read-only); absent: the tool says it isn't set up.
  research?: ResearchRunner;
  // ffmpeg, for reel drafts; absent: the reel tool writes the script and the scenes and says it can't make video here.
  video?: ReelVideo | null;
  // Set by the orchestrator for each turn: credits already spent by this request, so the cap is per request.
  spent?: { credits: number };
  log?: (line: string) => void;
  // The page renderer for posters (headless Chromium); absent: the process's shared one.
  renderer?: HtmlRenderer;
}

// A poster with two pieces of artwork is about 3 credits and a 5 s clip about 7.5, so one request may use up to 10.
export const DEFAULT_MAX_CREDITS_PER_REQUEST = 10;
