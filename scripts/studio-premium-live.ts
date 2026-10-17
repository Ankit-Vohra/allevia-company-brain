// The live check of "photo to premium ad" (founder's brief, 17 Oct): a rough product photo goes through the real Studio on a tenant
// (demo_growth by default), then the real Higgsfield engine makes a premium UGC-style ad picture (product-photoshoot backend) and a
// short vertical clip from it. Every generation is quoted first and the whole run is capped; the script stops before spending if a
// quote is above its cap. Real Claude vision (subscription), real graph (the tenant's), real Higgsfield (the CLI login).
//
//   npx tsx scripts/studio-premium-live.ts <photo> [--tenant demo_growth] [--rough] [--budget 20] [--no-clip] [--words "premium UGC ad"]
//
//   --rough      degrade the photo first (tilt, a stop under, cool cast, soft, noisy), like a bad phone snap
//   --budget     the most this run may spend in Higgsfield credits (default 20; the ledger's daily cap is set to it)
// Outputs (copied into docs/creative-live/premium-ad/): the rough photo, the ad picture, the clip, the lineage as JSON and the card
// as the web and Discord show it. Nothing is posted. The spend is logged by hand in docs/higgsfield-spend.md.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { closeAll, openGraph } from "../src/graph/client.js";
import { getTenant } from "../src/graph/tenants.js";
import { ClipService } from "../src/studio/clip.js";
import { CreditLedger } from "../src/studio/credits.js";
import { ChainEngine, RecordedEngine, recordingsManifest } from "../src/studio/engine.js";
import { execCli, HiggsfieldEngine, premiumCap } from "../src/studio/higgsfield.js";
import { roughen, sha256Hex } from "../src/studio/image.js";
import { assetLineage } from "../src/studio/lineage.js";
import { makePremiumAd } from "../src/studio/premium.js";
import { runStudio } from "../src/studio/pipeline.js";
import { productionStudioDeps } from "../src/studio/wiring.js";
import { studioCard } from "../src/studio/approve.js";
import { approval as readApproval } from "../src/server/reads.js";
import { approvalExtras } from "../src/discord/approval-extras.js";
import { renderApproval } from "../src/discord/approval-card.js";
import { AssetStore } from "../src/studio/store.js";

const args = process.argv.slice(2);
const flag = (k: string): string | undefined => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const has = (k: string): boolean => { const i = args.indexOf(`--${k}`); if (i >= 0) args.splice(i, 1); return i >= 0; };
const tenant = flag("tenant") ?? "demo_growth";
const budget = Number(flag("budget") ?? 20);
const words = flag("words") ?? "make this a premium UGC style ad";
const rough = has("rough");
const noClip = has("no-clip");
const note = flag("note") ?? "Our espresso cup, taken on my phone at the counter.";
const photoPath = args[0];
if (!photoPath || !existsSync(photoPath)) { console.error("usage: npx tsx scripts/studio-premium-live.ts <photo> [--rough] [--tenant demo_growth] [--budget 20]"); process.exit(2); }

const log = (s: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const t = await getTenant(tenant);
  if (!t) throw new Error(`no tenant ${tenant}`);
  const g = await openGraph(tenant);
  const out = resolve("docs/creative-live/premium-ad");
  mkdirSync(out, { recursive: true });

  let bytes = readFileSync(photoPath!);
  if (rough) bytes = await roughen(bytes, { tiltDeg: 4, crop: { x: 0.03, y: 0.03, w: 0.94, h: 0.94 } });
  writeFileSync(join(out, "00-rough-photo.jpg"), bytes);
  log(`photo ${bytes.length} bytes, sha ${sha256Hex(bytes).slice(0, 12)}${rough ? " (roughened)" : ""}`);

  // the base run: real Claude vision, recordings only for the engine (the free local clean-up; nothing is spent here)
  const base = productionStudioDeps(cfg.dataDir, { liveEngine: false });
  const ledger = new CreditLedger(cfg.dataDir);
  const before = ledger.spentOn();
  const caps = { run: Math.max(premiumCap(), 5), daily: before + budget };
  const hf = new HiggsfieldEngine({ cli: execCli(), ledger, caps, balanceFloor: 20, log });
  const live = new ChainEngine([new RecordedEngine(recordingsManifest(cfg.dataDir)), hf]);

  log("Studio run: Miss Influencer looks, the free clean-up, Fact Checker checks, Wordsmith writes the caption");
  const events: string[] = [];
  const r = await runStudio(g, { tenant, businessId: t.businessId, bytes, note }, { ...base, now: () => Date.now() }, (e) => {
    if (e.type === "agent_status") events.push(`${e.agent}: ${e.text}`);
  });
  for (const e of events.slice(0, 40)) log(`  ${e}`);
  if (r.stopped) throw new Error(`the Studio stopped: ${r.stopped.message}`);
  log(`Miss Influencer: ${r.assessment.verdict} (${r.assessment.subjectKind}: ${r.assessment.subject}); card ${r.approvalId}; variants ${r.variants.map((v) => v.label).join(", ")}`);

  // the premium ad: quote first, stop above the cap
  const ids = { tenant, businessId: t.businessId, approvalId: r.approvalId };
  const deps = { store: base.store, vision: base.vision, engine: live, now: Date.now(), status: (s: string) => log(`  ${s}`) };
  log(`Premium ad request: "${words}"`);
  const premium = await makePremiumAd(g, { ...ids, request: { words } }, deps);
  if (!premium.ok) throw new Error(`premium ad: ${premium.message}`);
  log(`Option ${premium.variant.label} (${premium.mode}): Fact Checker says ${premium.fidelity.badge}: ${premium.fidelity.note}; credits ${premium.variant.credits ?? 0}; job ${premium.variant.jobId ?? "-"}`);
  writeFileSync(join(out, "01-premium-ad.jpg"), premium.variant.buffer);

  let clipAsset: string | undefined;
  if (!noClip && premium.passed) {
    const clip = new ClipService({ g, store: base.store as AssetStore, engine: hf, cap: 8 });
    const offer = await clip.offer({ ...ids, variantId: premium.variant.id });
    if (!offer.ok) throw new Error(`clip offer: ${offer.message}`);
    log(`Clip offer: ${offer.message}`);
    const spent = ledger.spentOn() - before;
    if (spent + offer.credits > budget) throw new Error(`the clip (${offer.credits}) would take this run past its budget of ${budget} (spent ${spent})`);
    const made = await clip.make({ ...ids, variantId: premium.variant.id });
    if (!made.ok) throw new Error(`clip: ${made.message}`);
    log(`Clip made: ${made.assetId}, ${made.credits} credits, job ${made.jobId}`);
    writeFileSync(join(out, "02-clip.mp4"), made.video);
    clipAsset = made.assetId;
  } else if (!premium.passed) log("Fact Checker held the picture back, so no clip was offered.");

  const lineage = await assetLineage(g, clipAsset ?? premium.variant.id);
  writeFileSync(join(out, "lineage.json"), JSON.stringify(lineage, null, 1));
  log(`Lineage: ${lineage.ancestors.length} ancestor(s), ${lineage.jobs.length} job(s), spent ${lineage.spent} credits, ${lineage.rules.length} guiding rule(s), cards ${lineage.cards.map((c) => c.approvalId).join(", ")}`);

  // the card as the web and Discord show it
  const dto = await readApproval(g, r.approvalId);
  if (dto) {
    writeFileSync(join(out, "card-web.json"), JSON.stringify({ title: dto.title, preview: dto.preview }, null, 1));
    const extras = await approvalExtras(dto, { graph: g, store: base.store as AssetStore, tenant });
    const msg = renderApproval(dto, extras);
    writeFileSync(join(out, "card-discord.txt"), `${msg.first.content}\n\n[files: ${(msg.first.files ?? []).map((f) => `${f.name} (${f.data.length} bytes)`).join(", ")}]\n[buttons: ${msg.first.buttons.map((b) => b.label).join(" | ")}]\n`);
    log(`Card on Discord: ${(msg.first.files ?? []).map((f) => f.name).join(", ")}; buttons ${msg.first.buttons.map((b) => b.label).join(" | ")}`);
  }
  const card = await studioCard(g, r.approvalId);
  log(`Card still pending: ${card?.status}; recommended ${card?.payload.studio.recommended}; extras ${(card?.payload.studio.extras ?? []).length}`);
  log(`Ledger: ${ledger.spentOn() - before} credits this run (file ${ledger.file})`);
  void copyFileSync;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => closeAll());
