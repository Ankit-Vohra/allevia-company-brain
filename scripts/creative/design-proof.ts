// Makes posters with the real composer (makePoster: real material, layouts, code checks, Growth Hacker's review and revisions,
// Fact Checker's check) on a tenant graph, and writes the options and a run record to a folder. For the side-by-side proofs in
// docs/creative-live/v2/. Run it against a COPY of the tenant graph on a throwaway server (ALLEVIA_FALKORDB_URL); the files
// go through the product's own store under ALLEVIA_DATA_DIR. Generated scenes use the founder's Higgsfield CLI with a hard cap.
//   ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6411 ALLEVIA_DATA_DIR=~/jarvis/data \
//   npx tsx scripts/creative/design-proof.ts --tenant aamdani --spec proof.json --out docs/creative-live/v2/aamdani [--cap 6]
// proof.json: { "question": "...", "content": {...PosterContent}, "format": "insta_portrait", "occasion": "announcement",
//   "goal": "announce", "count": 2, "artwork": "generate"|"none", "scenes": ["..."], "layouts": [..], "pictures": [..],
//   "promoted": {"id": "...", "name": "...", "summary": "..."}, "audience": "...", "quote": {...} }
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../src/config.js";
import { makePoster, type PosterRequest } from "../../src/creative/poster.js";
import { loadAssetFile } from "../../src/creative/files.js";
import { closeSharedRenderer } from "../../src/creative/design/render.js";
import { closeAll, openGraph } from "../../src/graph/client.js";
import { businessId } from "../../src/graph/tenants.js";
import { AssetStore } from "../../src/studio/store.js";
import { CachedVision, ClaudeVision } from "../../src/studio/vision.js";
import { HiggsfieldTextEngine } from "./hf-text-engine.js";

const { values: a } = parseArgs({ options: { tenant: { type: "string" }, spec: { type: "string" }, out: { type: "string" }, cap: { type: "string" }, model: { type: "string" }, resolution: { type: "string" } } });
if (!a.tenant || !a.spec || !a.out) throw new Error("usage: --tenant slug --spec proof.json --out dir [--cap 6]");
const spec = JSON.parse(readFileSync(a.spec, "utf8")) as Partial<PosterRequest> & { question: string };
const out = resolve(a.out);
mkdirSync(out, { recursive: true });
const cfg = loadConfig();
const g = await openGraph(a.tenant);
const store = new AssetStore(cfg.dataDir);
const vision = new CachedVision(new ClaudeVision(), join(cfg.dataDir, "cache", "vision"));
const cap = Number(a.cap ?? 0);
const engine = cap > 0 ? new HiggsfieldTextEngine({ cap, model: a.model ?? "nano_banana_2_1", resolution: a.resolution ?? "2k" }) : null;
const t0 = Date.now();
const log: string[] = [];
try {
  const r = await makePoster(g, {
    tenant: a.tenant, businessId: businessId(a.tenant), agentId: "content-strategist", turnId: `proof-${t0}`, now: t0,
    format: "insta_portrait", occasion: "general", count: 2, artwork: "generate", ...spec,
    content: spec.content!, question: spec.question,
  } as PosterRequest, { store, vision, engine, maxCreditsPerRequest: cap || 0, spent: { credits: 0 }, fonts: { fetchMissing: true }, log: (l) => { log.push(l); console.log(l); } });
  const files: string[] = [];
  for (const o of r.saved.options) {
    const f = await loadAssetFile(g, store, a.tenant, o.assetId);
    if (!f) continue;
    const name = `${o.label.toLowerCase()}-${o.layout}${o.assetId === r.saved.recommended ? "-pick" : ""}.jpg`;
    writeFileSync(join(out, name), f.data);
    files.push(name);
  }
  writeFileSync(join(out, "run.json"), JSON.stringify({
    at: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), tenant: a.tenant, request: spec,
    files, layouts: r.layouts, notes: r.notes, reviews: r.reviews, check: r.verdicts.map((v) => ({ label: v.label, badge: v.badge, reasons: v.reasons, note: v.note })),
    generated: r.generated, credits: r.hfCredits, spend: engine?.log ?? [], log,
  }, null, 1));
  console.log(`\n${files.join(", ")} | credits ${r.hfCredits} | ${Math.round((Date.now() - t0) / 1000)} s\n${r.notes.join("\n")}`);
} finally {
  await closeSharedRenderer();
  await closeAll();
}
