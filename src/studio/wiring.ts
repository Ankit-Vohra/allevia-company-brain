// The Studio's production deps, shared by the API server and scripts/studio-demo.ts: assets under <dataDir>/assets,
// Claude vision on the subscription behind a disk cache (<dataDir>/cache/studio), and the recorded-edit engine
// (<dataDir>/studio/recorded/manifest.json) until the Higgsfield API engine lands in Phase 2.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordedEngine, recordingsManifest } from "./engine.js";
import type { StudioDeps } from "./pipeline.js";
import { AssetStore } from "./store.js";
import { CachedVision, ClaudeVision, VisionError, type VisionRunner } from "./vision.js";

export const studioCacheDir = (dataDir: string): string => join(dataDir, "cache", "studio");

// ALLEVIA_STUDIO_CACHE_ONLY=1 replays recorded answers and never calls Claude (a miss fails closed: the assessment
// errors, Nisha's check is "unchecked"); for demos and screenshots that must not spend the subscription.
export function productionStudioDeps(dataDir: string, o: { cacheOnly?: boolean } = { cacheOnly: /^(1|true|yes)$/i.test(process.env.ALLEVIA_STUDIO_CACHE_ONLY ?? "") }): Omit<StudioDeps, "now" | "signal"> {
  const live: VisionRunner = o.cacheOnly
    ? { see: async (i) => { throw new VisionError(`${i.agent}: no recorded answer and live calls are off (ALLEVIA_STUDIO_CACHE_ONLY)`); } }
    : new ClaudeVision();
  return {
    store: new AssetStore(dataDir),
    vision: new CachedVision(live, studioCacheDir(dataDir)),
    engine: new RecordedEngine(recordingsManifest(dataDir)),
  };
}

// The demo sample for a tenant, when one has been prepared (scripts/studio-demo.ts): the photo, the note it was sent
// with, and the honest line the page shows under it.
export interface StudioSample { file: string; note: string; caption: string }

export function studioSample(dataDir: string, tenant: string): StudioSample | null {
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(tenant)) return null;
  const dir = join(dataDir, "studio-demo", tenant);
  const file = join(dir, "rough.jpg");
  const meta = join(dir, "sample.json");
  if (!existsSync(file) || !existsSync(meta)) return null;
  try {
    const m = JSON.parse(readFileSync(meta, "utf8")) as Partial<StudioSample>;
    return { file, note: typeof m.note === "string" ? m.note : "", caption: typeof m.caption === "string" ? m.caption : "" };
  } catch {
    return null;
  }
}
