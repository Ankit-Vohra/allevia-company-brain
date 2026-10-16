// Makes a reel draft with the real reel path (makeReelDraft: claims check, price, real photos and screens, HTML captions
// timed to the words, clips and music through a capped engine, Nisha's frame check) and writes it with a contact sheet.
//   ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6411 ALLEVIA_DATA_DIR=~/jarvis/data \
//   npx tsx scripts/creative/reel-proof.ts --tenant avs_atelier --plan plan.json --question "..." --out docs/creative-live/v2/reel --cap 12
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../src/config.js";
import { loadAssetFile } from "../../src/creative/files.js";
import { closeSharedRenderer } from "../../src/creative/design/render.js";
import { makeReelDraft } from "../../src/creative/reel/draft.js";
import { normaliseReelPlan } from "../../src/creative/reel/plan.js";
import { realReelVideo } from "../../src/creative/reel/render.js";
import { closeAll, openGraph } from "../../src/graph/client.js";
import { businessId } from "../../src/graph/tenants.js";
import { AssetStore } from "../../src/studio/store.js";
import { CachedVision, ClaudeVision } from "../../src/studio/vision.js";
import { HiggsfieldTextEngine } from "./hf-text-engine.js";

const { values: a } = parseArgs({ options: { tenant: { type: "string" }, plan: { type: "string" }, question: { type: "string" }, out: { type: "string" }, cap: { type: "string" }, replay: { type: "string" } } });
if (!a.tenant || !a.plan || !a.question || !a.out) throw new Error("usage: --tenant slug --plan plan.json --question text --out dir [--cap 12]");
const out = resolve(a.out);
mkdirSync(out, { recursive: true });
const cfg = loadConfig();
const g = await openGraph(a.tenant);
const store = new AssetStore(cfg.dataDir);
const cap = Number(a.cap ?? 0);
// --replay "seedance_2_0_mini=id1,id2;sonilo_music=id3": jobs already paid for, used again instead of paying twice
const replay = Object.fromEntries((a.replay ?? "").split(";").filter(Boolean).map((p) => { const [m, ids] = p.split("="); return [m!, (ids ?? "").split(",").filter(Boolean)]; }));
const engine = cap > 0 ? new HiggsfieldTextEngine({ cap, replay }) : null;
const t0 = Date.now();
try {
  const plan = normaliseReelPlan(JSON.parse(readFileSync(a.plan, "utf8")), "skill");
  const r = await makeReelDraft(g, { tenant: a.tenant, businessId: businessId(a.tenant), agentId: "content-strategist", turnId: `reel-proof-${t0}`, now: t0, question: a.question, plan, confirmSpend: true },
    { store, vision: new CachedVision(new ClaudeVision(), join(cfg.dataDir, "cache", "vision")), engine, maxCreditsPerRequest: cap, spent: { credits: 0 }, fonts: { fetchMissing: true }, video: realReelVideo() });
  const files: string[] = [];
  const opt = r.saved?.options[0];
  if (opt) {
    const f = await loadAssetFile(g, store, a.tenant, opt.assetId);
    if (f) {
      writeFileSync(join(out, "reel.mp4"), f.data);
      files.push("reel.mp4");
      // a contact sheet: one frame a second
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(out, "reel.mp4"), "-vf", "fps=1,scale=270:-1,tile=6x3:padding=6:color=gray", "-frames:v", "1", join(out, "contact-sheet.jpg")]);
      files.push("contact-sheet.jpg");
    }
  }
  writeFileSync(join(out, "run.json"), JSON.stringify({ at: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000), tenant: a.tenant, question: a.question, plan, status: r.status, why: r.why ?? null, reelSeconds: r.seconds, price: r.priceCredits, spent: r.spentCredits, check: r.verdicts, repaired: r.repaired, notes: r.notes, files, spend: engine?.log ?? [] }, null, 1));
  console.log(r.status, r.why ?? "", "| spent", r.spentCredits, "| check", r.verdicts.map((v) => `${v.label}:${v.badge}`).join(" "), "\n", r.notes.join("\n"));
} finally {
  await closeSharedRenderer();
  await closeAll();
}
