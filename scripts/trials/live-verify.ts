// One live check of the generative Studio (founder's brief, 2026-10-15): the real HiggsfieldEngine on the founder's CLI login,
// the real Claude vision on the subscription, a throwaway graph (dropped by the `drop` step), a temp data dir with its own
// credit ledger, and a hard budget (ALLEVIA_STUDIO_DAILY_CREDIT_CAP, set by the caller). Nothing here is committed; the photo
// must show no real person. Every generation is quoted first by the engine and refused above the caps.
//
//   run <photo>                       the whole pipeline: Option A (free) and Option B (AI edit), Fact Checker's checks, the caption
//   request "<words>"                 a free-form request on that card ("make it festive")
//   ad "<message>"                    "make this into an ad saying <message>"
//   clip                              the priced offer for a 5 second clip (add --yes to make it)
//   drop                              drops the throwaway graph
//
// Usage: ALLEVIA_STUDIO_DAILY_CREDIT_CAP=16 npx tsx scripts/trials/live-verify.ts <step> [args] --dir <workdir>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeAll, openGraphByName } from "../../src/graph/client.js";
import { ClipService } from "../../src/studio/clip.js";
import { CreditLedger, creditCaps } from "../../src/studio/credits.js";
import { execCli, HiggsfieldEngine } from "../../src/studio/higgsfield.js";
import { generateVariant } from "../../src/studio/generate.js";
import { runStudio } from "../../src/studio/pipeline.js";
import { AssetStore } from "../../src/studio/store.js";
import { studioEngine } from "../../src/studio/wiring.js";
import { CachedVision, ClaudeVision } from "../../src/studio/vision.js";
import { studioCard } from "../../src/studio/approve.js";
import { BIZ, seedBrand } from "../../tests/studio/fixtures.js";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const yes = args.includes("--yes") && !!args.splice(args.indexOf("--yes"), 1);
const dir = flag("dir");
const [step, arg] = args;
if (!dir || !step) throw new Error("usage: live-verify.ts <run|request|ad|clip|drop> [arg] --dir <workdir>");
mkdirSync(dir, { recursive: true });
const GRAPH = "allevia_live_verify";
const TENANT = "live_verify";
const stateFile = join(dir, "state.json");
const state = (): { approvalId: string } => JSON.parse(readFileSync(stateFile, "utf8"));
const log = (l: string) => console.error(l);

async function main(): Promise<void> {
  const g = await openGraphByName(GRAPH);
  try {
    if (step === "drop") { await g.drop(); console.log("graph dropped"); return; }
    const store = new AssetStore(dir);
    const vision = new CachedVision(new ClaudeVision(), join(dir, "cache"));
    const engine = studioEngine(dir, { live: true, log });
    const now = Date.now();
    const out = (name: string, buf: Buffer) => { writeFileSync(join(dir, name), buf); console.log(`wrote ${join(dir, name)}`); };

    if (step === "run") {
      if (!arg || !existsSync(arg)) throw new Error("give a photo path");
      await seedBrand(g);
      const r = await runStudio(g, { tenant: TENANT, businessId: BIZ, bytes: readFileSync(arg), note: "the pool house, for Instagram" }, { store, vision, engine, now: () => Date.now() },
        (e) => { if (e.type === "agent_status") console.log(`[${e.agent}] ${e.text}`); });
      writeFileSync(stateFile, JSON.stringify({ approvalId: r.approvalId }));
      out("original.jpg", store.get(TENANT, r.original.storageKey)!);
      for (const v of r.variants) {
        out(`option-${v.label}.jpg`, v.buffer);
        const f = r.fidelity.find((x) => x.assetId === v.id)!;
        console.log(`Option ${v.label} (${v.aiEdited ? `AI${v.credits !== undefined ? `, ${v.credits} credits` : ""}` : "local"}): ${f.badge}: ${f.note}`);
      }
      console.log("Miss Influencer:", r.assessment.verdict, "|", r.assessment.subject);
      console.log("notices:", JSON.stringify(r.notices));
      const c = await studioCard(g, r.approvalId);
      console.log("recommended:", c?.payload.studio.variants.find((v) => v.id === c.payload.studio.recommended)?.label ?? "none");
    } else if (step === "request" || step === "ad") {
      if (!arg) throw new Error("give the words");
      const request = step === "ad" ? { kind: "ad" as const, words: `make this into an ad saying ${arg}`, headline: arg } : { kind: "request" as const, words: arg };
      const r = await generateVariant(g, { tenant: TENANT, businessId: BIZ, approvalId: state().approvalId, request }, { store, vision, engine, now: Date.now(), status: (t) => console.log(`[status] ${t}`) });
      if (!r.ok) { console.log("not made:", r.message); return; }
      out(`option-${r.variant.label}.jpg`, r.variant.buffer);
      console.log(`Option ${r.variant.label} (AI, ${r.variant.credits} credits): ${r.fidelity.badge}: ${r.fidelity.note}`);
      console.log("canRetry:", r.canRetry, "retryQuote:", r.retryQuote ?? "-");
    } else if (step === "retry") {
      const r = await generateVariant(g, { tenant: TENANT, businessId: BIZ, approvalId: state().approvalId, request: { kind: "retry" } }, { store, vision, engine, now: Date.now(), status: (t) => console.log(`[status] ${t}`) });
      if (!r.ok) { console.log("not made:", r.message); return; }
      out(`option-${r.variant.label}.jpg`, r.variant.buffer);
      console.log(`Option ${r.variant.label} (AI, ${r.variant.credits} credits): ${r.fidelity.badge}: ${r.fidelity.note}`);
    } else if (step === "clip") {
      const hf = new HiggsfieldEngine({ cli: execCli(), ledger: new CreditLedger(dir), caps: creditCaps(), log });
      const clip = new ClipService({ g, store, engine: hf });
      const ids = { tenant: TENANT, businessId: BIZ, approvalId: state().approvalId };
      const o = await clip.offer(ids);
      console.log(o.message);
      if (yes && o.ok) {
        const m = await clip.make(ids);
        console.log(m.message);
        if (m.ok) out("clip.mp4", m.video);
      }
    } else throw new Error(`unknown step ${step}`);
    console.log(`ledger today: ${new CreditLedger(dir).spentOn()} credits of ${creditCaps().daily}`);
  } finally {
    await closeAll();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
