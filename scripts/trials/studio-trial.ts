// Content trials, Studio side (docs/content-trials.md): one photo at a time through the real pipeline, with the live Claude
// vision calls on the subscription (cached under the data dir) and the Higgsfield edit recorded once and replayed.
// Nothing here is committed: photos, recordings and outputs live under <dataDir>/trials (gitignored).
//
//   plan <photo> --name p1 --note "..."   intake + Tara's assessment + the straightened frame + the graph-built edit prompt
//   record <name> <file> <model> <jobId> <credits>
//                                          register a generated edit with the RecordedEngine, keyed by the original
//   run <name>                             the whole pipeline; writes variants, Nisha's verdicts and a side-by-side image
//
// Usage: npx tsx scripts/trials/studio-trial.ts <step> [args] [--tenant avs_atelier]
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { loadConfig } from "../../src/config.js";
import { closeAll, openGraph } from "../../src/graph/client.js";
import { getTenant } from "../../src/graph/tenants.js";
import { ensureRoster } from "../../src/agent/memory.js";
import { assessPhoto, TARA } from "../../src/studio/assess.js";
import { loadStudioContext } from "../../src/studio/context.js";
import { recordingKey, recordingsDir, recordingsManifest, type Recording } from "../../src/studio/engine.js";
import { estimateTilt, planCrop, sha256Hex, straightenedBase } from "../../src/studio/image.js";
import { intake } from "../../src/studio/intake.js";
import { assessContextFor, chooseTilt, DEFAULT_MODELS, runStudio } from "../../src/studio/pipeline.js";
import { buildEditPrompt, TREATMENTS } from "../../src/studio/prompt.js";
import { productionStudioDeps } from "../../src/studio/wiring.js";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const tenant = flag("tenant") ?? "avs_atelier";
const name = flag("name");
const note = flag("note") ?? "";
const [step, ...rest] = args;
const cfg = loadConfig();
const TREATMENT = TREATMENTS["relight-clean-editorial"]!;
const outDir = (n: string) => join(cfg.dataDir, "trials", "out", tenant, n);

async function side(buffers: Array<{ label: string; buf: Buffer }>, file: string): Promise<void> {
  const W = 480, H = 600, GAP = 16, LABEL = 44;
  const panels = await Promise.all(buffers.map(async (b, i) => {
    const img = await sharp(b.buf).resize(W, H, { fit: "contain", background: "#e9e4d9" }).jpeg({ quality: 90 }).toBuffer();
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${LABEL}"><rect width="${W}" height="${LABEL}" fill="#191714"/><text x="14" y="29" font-family="Helvetica" font-size="20" fill="#f4f1ea">${b.label.replace(/&/g, "and")}</text></svg>`);
    return { input: await sharp({ create: { width: W, height: H + LABEL, channels: 3, background: "#191714" } }).composite([{ input: svg, top: 0, left: 0 }, { input: img, top: LABEL, left: 0 }]).jpeg().toBuffer(), left: i * (W + GAP) };
  }));
  const width = buffers.length * W + (buffers.length - 1) * GAP;
  writeFileSync(file, await sharp({ create: { width, height: H + LABEL, channels: 3, background: "#f4f1ea" } }).composite(panels.map((p) => ({ input: p.input, left: p.left, top: 0 }))).png().toBuffer());
}

async function main(): Promise<void> {
  const t = await getTenant(tenant);
  if (!t) throw new Error(`no tenant ${tenant}`);
  const g = await openGraph(tenant);
  const deps = productionStudioDeps(cfg.dataDir);

  if (step === "plan") {
    const [photo] = rest;
    if (!photo || !name || !existsSync(photo)) throw new Error('usage: plan <photo> --name <n> --note "..."');
    const dir = outDir(name);
    mkdirSync(dir, { recursive: true });
    const bytes = readFileSync(photo);
    const now = Date.now();
    await ensureRoster(g, { businessId: t.businessId }, now);
    const ctx = await loadStudioContext(g, t.businessId, note);
    const got = await intake(g, { tenant, bytes, note, ownerId: ctx.owner?.id ?? null }, { store: deps.store, now, agent: TARA });
    const a = await assessPhoto(g, got.asset.id, got.normalized.buffer, assessContextFor(ctx, note, got.asset), { vision: deps.vision, model: DEFAULT_MODELS.assess, now });
    const tilt = chooseTilt(await estimateTilt(got.normalized.buffer), a.quality.tiltDeg);
    const plan = planCrop({ w: got.asset.w, h: got.asset.h }, tilt.deg, a.overlays);
    const base = await straightenedBase(got.normalized.buffer, plan, a.overlays.filter((o) => o.kind === "privacy"));
    const prompt = await buildEditPrompt(g, ctx, a, TREATMENT, now);
    writeFileSync(join(dir, "input.jpg"), bytes);
    writeFileSync(join(dir, "original.jpg"), got.normalized.buffer);
    writeFileSync(join(dir, "base.jpg"), base);
    writeFileSync(join(dir, "prompt.txt"), prompt.prompt);
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ note, original: got.asset, owner: ctx.owner, project: ctx.project, tilt, plan, assessment: a, sources: prompt.sources }, null, 2));
    console.log(JSON.stringify({ sha256: got.asset.sha256, project: ctx.project, tilt, verdict: a.verdict, assessment: a }, null, 2));
    console.log(`\nwritten to ${dir}`);
    return;
  }

  if (step === "record") {
    const [n, file, model, jobId, credits] = rest;
    if (!n || !file || !existsSync(file) || !model) throw new Error("usage: record <name> <file> <model> <jobId> <credits>");
    const planJson = JSON.parse(readFileSync(join(outDir(n), "plan.json"), "utf8")) as { original: { sha256: string } };
    const dir = recordingsDir(cfg.dataDir);
    mkdirSync(dir, { recursive: true });
    const fname = `${planJson.original.sha256.slice(0, 16)}-${TREATMENT.key}${file.endsWith(".png") ? ".png" : ".jpg"}`;
    copyFileSync(resolve(file), join(dir, fname));
    const manifest = recordingsManifest(cfg.dataDir);
    const recs = existsSync(manifest) ? (JSON.parse(readFileSync(manifest, "utf8")) as { recordings: Recording[] }).recordings : [];
    const key = recordingKey(planJson.original.sha256, TREATMENT.key);
    const entry: Recording = {
      key, file: fname, engine: "higgsfield", model, prompt: readFileSync(join(outDir(n), "prompt.txt"), "utf8"),
      ...(jobId ? { jobId } : {}), ...(credits ? { credits: Number(credits) } : {}),
      inputSha256: sha256Hex(readFileSync(join(outDir(n), "original.jpg"))), createdAt: new Date().toISOString(),
      note: "Generated once through the Higgsfield MCP tools for the content trial; replayed by RecordedEngine.",
    };
    writeFileSync(manifest, JSON.stringify({ recordings: [...recs.filter((r) => r.key !== key), entry] }, null, 2));
    console.log(`recorded ${fname} under ${key}`);
    return;
  }

  if (step === "run") {
    const [n] = rest.length ? rest : [name];
    if (!n) throw new Error("usage: run <name>");
    const dir = outDir(n);
    const bytes = readFileSync(join(dir, "input.jpg"));
    const meta = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as { note: string };
    const t0 = Date.now();
    const r = await runStudio(g, { tenant, businessId: t.businessId, bytes, note: meta.note }, deps, (e) => {
      if (e.type === "agent_status") console.log(`  ${e.agent}: ${e.text}`);
      else if (e.type !== "text") console.log(`[${e.type}]${"assetId" in e ? ` ${e.assetId}` : ""}${e.type === "review" ? ` ${e.verdict}: ${e.note}` : ""}`);
    });
    const panels: Array<{ label: string; buf: Buffer }> = [{ label: "Owner's photo", buf: readFileSync(join(dir, "original.jpg")) }];
    for (const v of r.variants) {
      writeFileSync(join(dir, `variant-${v.label}.jpg`), v.buffer);
      const f = r.fidelity.find((x) => x.assetId === v.id);
      panels.push({ label: `Variant ${v.label}${v.aiEdited ? " (AI-edited)" : " (local)"}: ${f?.badge ?? "?"}`, buf: v.buffer });
    }
    await side(panels, join(dir, "compare.png"));
    const summary = {
      original: r.original.id, tilt: r.tilt, verdict: r.assessment.verdict, coaching: r.assessment.coaching, overlays: r.assessment.overlays, textInImage: r.assessment.textInImage,
      variants: r.variants.map((v) => ({ id: v.id, label: v.label, treatment: v.treatment, engine: v.engine, recorded: v.recorded ?? false, credits: v.credits })),
      fidelity: r.fidelity.map((f) => ({ label: f.label, badge: f.badge, note: f.note, structure: f.structure, ssim: f.ssim, dhash: f.dhashDistance, vision: f.vision })),
      caption: r.caption, approvalId: r.approvalId, ms: Date.now() - t0,
    };
    writeFileSync(join(dir, "run.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    const v = deps.vision as unknown as { hits?: number; misses?: number };
    console.log(`vision cache: ${v.hits ?? 0} hits, ${v.misses ?? 0} live calls`);
    return;
  }
  throw new Error("steps: plan <photo> | record <name> <file> <model> <jobId> <credits> | run <name>");
}

try {
  await main();
} finally {
  await closeAll();
}
