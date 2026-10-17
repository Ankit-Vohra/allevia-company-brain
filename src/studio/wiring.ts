// The Studio's production deps, shared by the API server, the Discord hub and scripts: assets under <dataDir>/assets,
// Claude vision on the subscription behind a disk cache (<dataDir>/cache/studio), and the generative engine: recorded
// edits first (free, <dataDir>/studio/recorded/manifest.json: the demo photos), then the real Higgsfield engine, quoted, capped
// per run and per day, and kept in a ledger (<dataDir>/studio/credit-ledger.json). Its backend is chosen per business: the
// business's own Higgsfield connected through Composio (app-higgsfield_mcp, paid from its subscription credits) first, then the
// founder's CLI where the CLI can run (never on Linux ARM), else "picture making isn't switched on yet" in plain words.
// ALLEVIA_STUDIO_ENGINE=recorded (or ALLEVIA_STUDIO_CACHE_ONLY=1) switches the live engine off: nothing is ever spent.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { productionConnections } from "../connections/production.js";
import { isTenantSlug } from "../graph/slug.js";
import { ChainEngine, RecordedEngine, recordingsManifest, type GenerationEngine } from "./engine.js";
import { CreditLedger, creditCaps } from "./credits.js";
import { CliBackend, cliProbe, execCli, HiggsfieldEngine, pickBackend, type HiggsfieldBackend } from "./higgsfield.js";
import { ComposioHiggsfieldBackend, HIGGSFIELD_CONNECTION } from "./higgsfield-composio.js";
import type { ConnectionsPort } from "../connections/service.js";
import type { ComposioSession } from "../connections/composio.js";
import type { GraphHandle } from "../graph/client.js";
import { ClipService, type ClipPort } from "./clip.js";
import type { StudioDeps } from "./pipeline.js";
import { AssetStore } from "./store.js";
import { CachedVision, ClaudeVision, VisionError, type VisionRunner } from "./vision.js";

export const studioCacheDir = (dataDir: string): string => join(dataDir, "cache", "studio");

// The business's connected Higgsfield as a backend, or null when it has none (or connections are not set up here).
export async function connectedHiggsfield(port: ConnectionsPort | undefined, o: { log?: (line: string) => void } = {}): Promise<HiggsfieldBackend | null> {
  if (!port) return null;
  const st = await port.status(HIGGSFIELD_CONNECTION).catch(() => null);
  if (st?.state !== "connected") return null;
  return new ComposioHiggsfieldBackend({
    session: (op, fn) => port.run(HIGGSFIELD_CONNECTION, `studio: ${op}`, (s: ComposioSession) => fn((tool, args) => s.execute(tool, args)), { actor: "studio" }),
    ...(o.log ? { log: o.log } : {}),
  });
}

let probe: (() => Promise<boolean>) | undefined;
/** The live Higgsfield engine for this data dir: one ledger, the caps, and the backend chosen per business. */
export function liveHiggsfield(dataDir: string, o: { log?: (line: string) => void; connections?: (tenant: string) => ConnectionsPort | undefined } = {}): HiggsfieldEngine {
  const cli = execCli();
  probe ??= cliProbe(cli);
  const portFor = o.connections ?? ((tenant: string) => { try { return productionConnections().port(tenant); } catch { return undefined; } });
  return new HiggsfieldEngine({
    backend: pickBackend({ connected: (t) => connectedHiggsfield(portFor(t), o), cli: new CliBackend({ cli, ...(o.log ? { log: o.log } : {}) }), cliUsable: probe, ...(o.log ? { log: o.log } : {}) }),
    ledger: new CreditLedger(dataDir), caps: creditCaps(), ...(o.log ? { log: o.log } : {}),
  });
}

// ALLEVIA_STUDIO_CACHE_ONLY=1 replays recorded answers and never calls Claude (a miss fails closed: the assessment
// errors, Fact Checker's check is "unchecked"); for demos and screenshots that must not spend the subscription.
// The edit engine for a data dir. `live: false` is the recordings only.
export function studioEngine(dataDir: string, o: { live?: boolean; log?: (line: string) => void } = {}): GenerationEngine {
  const recorded = new RecordedEngine(recordingsManifest(dataDir));
  const live = o.live ?? !/^(recorded|off|none)$/i.test(process.env.ALLEVIA_STUDIO_ENGINE ?? "");
  if (!live) return recorded;
  return new ChainEngine([recorded, liveHiggsfield(dataDir, o)]);
}

// The 5 second clip option, on the same login, ledger and daily cap as the image edits. Absent when the live engine is off.
export function studioClip(dataDir: string, graphFor: (tenant: string) => Promise<GraphHandle>, o: { log?: (line: string) => void } = {}): ClipPort | undefined {
  if (/^(recorded|off|none)$/i.test(process.env.ALLEVIA_STUDIO_ENGINE ?? "") || /^(1|true|yes)$/i.test(process.env.ALLEVIA_STUDIO_CACHE_ONLY ?? "")) return undefined;
  const engine = liveHiggsfield(dataDir, o);
  return new ClipService({ g: graphFor, store: new AssetStore(dataDir), engine });
}

export function productionStudioDeps(dataDir: string, o: { cacheOnly?: boolean; liveEngine?: boolean } = { cacheOnly: /^(1|true|yes)$/i.test(process.env.ALLEVIA_STUDIO_CACHE_ONLY ?? "") }): Omit<StudioDeps, "now" | "signal"> {
  const live: VisionRunner = o.cacheOnly
    ? { see: async (i) => { throw new VisionError(`${i.agent}: no recorded answer and live calls are off (ALLEVIA_STUDIO_CACHE_ONLY)`); } }
    : new ClaudeVision();
  return {
    store: new AssetStore(dataDir),
    vision: new CachedVision(live, studioCacheDir(dataDir)),
    engine: studioEngine(dataDir, { live: o.liveEngine !== false && !o.cacheOnly && !/^(recorded|off|none)$/i.test(process.env.ALLEVIA_STUDIO_ENGINE ?? "") }),
    // the business's own connections: with Instagram connected, the card waiting for the OK posts after it (src/publish)
    connections: (tenant) => productionConnections().port(tenant),
  };
}

// The demo sample for a tenant, when one has been prepared (scripts/studio-demo.ts): the photo, the note it was sent
// with, and the honest line the page shows under it.
export interface StudioSample { file: string; note: string; caption: string }

export function studioSample(dataDir: string, tenant: string): StudioSample | null {
  if (!isTenantSlug(tenant)) return null;
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
