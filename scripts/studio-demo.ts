// Prepares and runs the Studio demo on a real tenant (product design §9 item 4). Nothing here is committed: the photos,
// the recorded edit and the model answers all live under the data dir (gitignored).
//
//   rough  <source image>        make the demo's "rough phone photo" from one of the studio's own website photos:
//                                tilted, underexposed, cool, soft, noisy and awkwardly framed (an honest stand-in)
//   plan                         intake + Miss Influencer's assessment (one live Claude call, then cached) + the straightened 4:5
//                                frame and the graph-built edit prompt, written next to the sample for the Higgsfield run
//   record <file> <model> <jobId> <credits>
//                                register a generated edit with the RecordedEngine, keyed by the sample's original
//   run                          the whole pipeline (Fact Checker's check and Wordsmith's caption are the remaining live calls),
//                                leaving the approval card pending for the owner
//
// Usage: npx tsx scripts/studio-demo.ts <step> [args] [--tenant avs_atelier]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { closeAll, openGraph } from "../src/graph/client.js";
import { getTenant } from "../src/graph/tenants.js";
import { ensureRoster } from "../src/agent/memory.js";
import { assessPhoto, TARA } from "../src/studio/assess.js";
import { loadStudioContext } from "../src/studio/context.js";
import { recordingKey, recordingsDir, recordingsManifest, type Recording } from "../src/studio/engine.js";
import { estimateTilt, planCrop, roughen, sha256Hex, straightenedBase } from "../src/studio/image.js";
import { intake } from "../src/studio/intake.js";
import { assessContextFor, chooseTilt, DEFAULT_MODELS, runStudio } from "../src/studio/pipeline.js";
import { buildEditPrompt, TREATMENTS } from "../src/studio/prompt.js";
import { productionStudioDeps, studioSample } from "../src/studio/wiring.js";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const tenant = flag("tenant") ?? "avs_atelier";
const [step, ...rest] = args;
const cfg = loadConfig();
const sampleDir = join(cfg.dataDir, "studio-demo", tenant);

const NOTE = "Retreat, the farmhouse on VIP Road: the pool and the arched guest rooms. Taken on my phone.";
const CAPTION = "Demo photo: a degraded copy of the studio's own website photo of Retreat (tilted, darkened, cooled and softened in code) to stand in for a phone snap.";
const TREATMENT = TREATMENTS["relight-clean-editorial"]!;

async function tenantInfo() {
  const t = await getTenant(tenant);
  if (!t) throw new Error(`no tenant ${tenant} in the registry`);
  return t;
}

async function main(): Promise<void> {
  if (step === "rough") {
    const src = rest[0];
    if (!src || !existsSync(src)) throw new Error("usage: rough <source image>");
    mkdirSync(sampleDir, { recursive: true });
    const out = await roughen(readFileSync(src), { tiltDeg: 5, crop: { x: 0.22, y: 0.08, w: 0.78, h: 0.92 } });
    writeFileSync(join(sampleDir, "rough.jpg"), out);
    writeFileSync(join(sampleDir, "sample.json"), JSON.stringify({ note: NOTE, caption: CAPTION, from: basename(src) }, null, 2));
    const e = await estimateTilt(out);
    console.log(`rough.jpg: ${out.length} bytes; edges say ${e.deg}° (confidence ${e.confidence})`);
    return;
  }

  const t = await tenantInfo();
  const g = await openGraph(tenant);
  const deps = productionStudioDeps(cfg.dataDir, { cacheOnly: /^(1|true|yes)$/i.test(process.env.ALLEVIA_STUDIO_CACHE_ONLY ?? ""), liveEngine: false }); // replays recordings only: these scripts never spend credits
  const sample = studioSample(cfg.dataDir, tenant);
  if (!sample) throw new Error(`no sample for ${tenant}: run the rough step first`);
  const bytes = readFileSync(sample.file);

  if (step === "plan") {
    const now = Date.now();
    await ensureRoster(g, { businessId: t.businessId }, now);
    const ctx = await loadStudioContext(g, t.businessId, sample.note);
    const got = await intake(g, { tenant, bytes, note: sample.note, ownerId: ctx.owner?.id ?? null }, { store: deps.store, now, agent: TARA });
    const a = await assessPhoto(g, got.asset.id, got.normalized.buffer, assessContextFor(ctx, sample.note, got.asset), { vision: deps.vision, model: DEFAULT_MODELS.assess, now });
    const tilt = chooseTilt(await estimateTilt(got.normalized.buffer), a.quality.tiltDeg);
    const plan = planCrop({ w: got.asset.w, h: got.asset.h }, tilt.deg, a.overlays);
    const base = await straightenedBase(got.normalized.buffer, plan, a.overlays.filter((o) => o.kind === "privacy"));
    const prompt = await buildEditPrompt(g, ctx, a, TREATMENT, now);
    writeFileSync(join(sampleDir, "base.jpg"), base);
    writeFileSync(join(sampleDir, "prompt.txt"), prompt.prompt);
    writeFileSync(join(sampleDir, "plan.json"), JSON.stringify({ original: got.asset, owner: ctx.owner, project: ctx.project, tilt, plan, assessment: a, sources: prompt.sources }, null, 2));
    console.log(JSON.stringify({ original: got.asset.id, sha256: got.asset.sha256, owner: ctx.owner, project: ctx.project, tilt, plan, assessment: a }, null, 2));
    console.log(`\nbase.jpg (${base.length} bytes) and prompt.txt written to ${sampleDir}\n\n${prompt.prompt}`);
    return;
  }

  if (step === "record") {
    const [file, model, jobId, credits] = rest;
    if (!file || !existsSync(file) || !model) throw new Error("usage: record <file> <model> <jobId> <credits>");
    const planJson = JSON.parse(readFileSync(join(sampleDir, "plan.json"), "utf8")) as { original: { sha256: string } };
    const dir = recordingsDir(cfg.dataDir);
    mkdirSync(dir, { recursive: true });
    const name = `${planJson.original.sha256.slice(0, 16)}-${TREATMENT.key}${file.endsWith(".png") ? ".png" : ".jpg"}`;
    copyFileSync(resolve(file), join(dir, name));
    const manifest = recordingsManifest(cfg.dataDir);
    const recs = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { recordings: Recording[] }).recordings : [];
    const key = recordingKey(planJson.original.sha256, TREATMENT.key);
    const entry: Recording = {
      key, file: name, engine: "higgsfield", model, prompt: readFileSync(join(sampleDir, "prompt.txt"), "utf8"),
      ...(jobId ? { jobId } : {}), ...(credits ? { credits: Number(credits) } : {}),
      inputSha256: sha256Hex(readFileSync(join(sampleDir, "base.jpg"))), createdAt: new Date().toISOString(),
      note: "Generated once with the founder's approval through the Higgsfield MCP tools; replayed by RecordedEngine.",
    };
    writeFileSync(manifest, JSON.stringify({ recordings: [...recs.filter((r) => r.key !== key), entry] }, null, 2));
    console.log(`recorded ${name} under ${key}`);
    return;
  }

  if (step === "run") {
    const r = await runStudio(g, { tenant, businessId: t.businessId, bytes, note: sample.note }, deps, (e) => {
      if (e.type === "agent_status") console.log(`  ${e.agent}: ${e.text}`);
      else if (e.type !== "text") console.log(`[${e.type}]${"assetId" in e ? ` ${e.assetId}` : ""}${e.type === "review" ? ` ${e.verdict}: ${e.note}` : ""}`);
    });
    const summary = {
      original: r.original.id, tilt: r.tilt, assessment: r.assessment,
      variants: r.variants.map((v) => ({ id: v.id, label: v.label, treatment: v.treatment, engine: v.engine, recorded: v.recorded ?? false })),
      fidelity: r.fidelity, caption: r.caption, approvalId: r.approvalId,
    };
    writeFileSync(join(sampleDir, "run.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    const v = deps.vision as unknown as { hits?: number; misses?: number };
    console.log(`vision cache: ${v.hits ?? 0} hits, ${v.misses ?? 0} live calls`);
    return;
  }
  throw new Error("steps: rough <src> | plan | record <file> <model> <jobId> <credits> | run");
}

try {
  await main();
} finally {
  await closeAll();
}
