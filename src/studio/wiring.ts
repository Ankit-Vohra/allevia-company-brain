// The Studio's production deps, shared by the API server and scripts/studio-demo.ts: assets under <dataDir>/assets,
// Claude vision on the subscription behind a disk cache (<dataDir>/cache/studio), and the recorded-edit engine
// (<dataDir>/studio/recorded/manifest.json) until the Higgsfield API engine lands in Phase 2.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RecordedEngine, recordingsManifest } from "./engine.js";
import type { StudioDeps } from "./pipeline.js";
import { AssetStore } from "./store.js";
import { CachedVision, ClaudeVision } from "./vision.js";

export const studioCacheDir = (dataDir: string): string => join(dataDir, "cache", "studio");

export function productionStudioDeps(dataDir: string): Omit<StudioDeps, "now" | "signal"> {
  return {
    store: new AssetStore(dataDir),
    vision: new CachedVision(new ClaudeVision(), studioCacheDir(dataDir)),
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
