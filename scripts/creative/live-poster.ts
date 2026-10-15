// The live check: one sentence from the owner, through the real company (planner, Chief, tools) on the Claude subscription,
// over a PRIVATE COPY of a business's graph, with the real Higgsfield engine under a hard credit cap. Nothing touches the
// real tenant: the graph is copied (GRAPH.COPY) and dropped afterwards, files go to a scratch data dir, nothing is posted.
//   npx tsx scripts/creative/live-poster.ts --tenant avs_atelier --site https://www.avsatelier.in/ --out docs/creative-live \
//     --cap 10 --ask "I want a poster for Insta with my logo" [--ask "..."]
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import type { AgentEvent } from "../../shared/contracts.js";
import { ask } from "../../src/agent/ask.js";
import { createAskDeps } from "../../src/agent/wiring.js";
import { fetchWebsiteBrandFiles } from "../../src/brand/website.js";
import { ClaudeResearch } from "../../src/creative/research.js";
import { loadAssetFile } from "../../src/creative/files.js";
import { closeAll, openGraphByName } from "../../src/graph/client.js";
import { businessId } from "../../src/graph/tenants.js";
import { guardedFetch } from "../../src/ingest/sources/website/fetch.js";
import type { PageData } from "../../src/ingest/sources/website/page.js";
import { AssetStore } from "../../src/studio/store.js";
import { CachedVision, ClaudeVision } from "../../src/studio/vision.js";
import { HiggsfieldTextEngine } from "./hf-text-engine.js";

const { values: a } = parseArgs({ options: {
  tenant: { type: "string" }, site: { type: "string" }, out: { type: "string" }, cap: { type: "string" }, ask: { type: "string", multiple: true }, data: { type: "string" }, model: { type: "string" }, quality: { type: "string" },
} });
if (!a.tenant || !a.site || !a.out || !a.ask?.length) throw new Error("usage: --tenant slug --site url --out dir --ask sentence [--ask ...] [--cap 10]");
const tenant = a.tenant;
const copy = `allevia_${tenant}_livecheck`;
const out = resolve(a.out);
const dataDir = resolve(a.data ?? ".scratch/live-data");
mkdirSync(out, { recursive: true });
const redis = (...args: string[]) => execFileSync("redis-cli", ["-p", "6390", ...args], { encoding: "utf8" }).trim();

redis("GRAPH.DELETE", copy);
console.log("copy:", redis("GRAPH.COPY", `allevia_${tenant}`, copy));
const g = await openGraphByName(copy);
const store = new AssetStore(dataDir);
const vision = new CachedVision(new ClaudeVision(), join(dataDir, "cache", "vision"));
const engine = new HiggsfieldTextEngine({ cap: Number(a.cap ?? 10), ...(a.model ? { model: a.model } : {}), ...(a.quality ? { quality: a.quality } : {}) });
const now = Date.now();
const biz = businessId(tenant);

// 1. the brand library from the website, as onboarding now does it (the logo file and the brand's fonts)
const html = (await guardedFetch(a.site, { maxBytes: 2_000_000 })).body.toString("utf8");
const abs = (u: string) => new URL(u.replace(/&amp;/g, "&"), a.site).toString();
const og = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i.exec(html)?.[1];
const icons = [...html.matchAll(/<link([^>]+rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*)>/gi)].map((m) => ({
  href: abs(/href="([^"]+)"/.exec(m[1]!)?.[1] ?? ""), sizes: /sizes="([^"]+)"/.exec(m[1]!)?.[1], rel: /rel="([^"]+)"/.exec(m[1]!)?.[1] ?? "icon",
})).filter((x) => x.href);
const home = { og: og ? { "og:image": abs(og) } : {}, iconLinks: icons, favicon: icons[0]?.href } as unknown as PageData;
const fonts = (await g.roQuery<{ v: string; r: string | null }>("MATCH (a:BrandAsset) WHERE a.kind = 'font' RETURN a.value AS v, a.role AS r ORDER BY a.id"))
  .map((f) => ({ family: f.v, role: (f.r === "heading" || f.r === "body" ? f.r : "other") as "heading" | "body" | "other", share: 0.5 }));
const [doc] = await g.roQuery<{ id: string }>("MATCH (d:Document) WHERE d.id CONTAINS $h RETURN d.id AS id ORDER BY d.id LIMIT 1", { h: new URL(a.site).hostname.replace(/^www\./, "") });
const brand = await fetchWebsiteBrandFiles(g, home, { logo: og ? { value: abs(og), source: "og:image", format: "img" } : null, fonts },
  { tenant, businessId: biz, docId: doc?.id ?? "", store, now, vision, log: (l) => console.log(l) });
console.log("brand files:", JSON.stringify(brand, null, 1));

// 2. each sentence through the real company
const deps = await createAskDeps({ tenant }, {
  graph: g, embedQuery: null,
  creative: { store, vision, engine, maxCreditsPerRequest: 6, research: new ClaudeResearch(), fonts: { fetchMissing: true } },
});
const report: Array<Record<string, unknown>> = [];
for (const [i, question] of a.ask.entries()) {
  const t0 = Date.now();
  const events: AgentEvent[] = [];
  const res = await ask({ tenant, question, channel: "web" }, deps, (e) => {
    events.push(e);
    if (e.type === "agent_status" || e.type === "tool_call") console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${e.type === "tool_call" ? `tool ${e.name} ${JSON.stringify(e.args).slice(0, 300)}` : `${e.agent}: ${e.text}`}`);
  });
  const secs = (Date.now() - t0) / 1000;
  const made = events.filter((e): e is Extract<AgentEvent, { type: "deliverable" }> => e.type === "deliverable");
  const files: string[] = [];
  for (const d of made) for (const o of d.options) {
    const f = await loadAssetFile(g, store, tenant, o.assetId);
    if (!f) continue;
    const name = `${i + 1}-${d.kind}-${o.label.toLowerCase()}${o.assetId === d.recommended ? "-pick" : ""}.jpg`;
    writeFileSync(join(out, name), await sharp(f.data).jpeg({ quality: 86 }).toBuffer());
    files.push(name);
  }
  report.push({ question, seconds: Math.round(secs), ok: res.ok, answer: res.answer, plan: events.find((e) => e.type === "plan"), made: made.map((d) => ({ kind: d.kind, title: d.title, notes: d.notes, options: d.options.map((o) => ({ label: o.label, badge: o.badge, note: o.note, layout: o.layout, aiEdited: o.aiEdited })) })), files, checks: res.checks, questions: events.filter((e) => e.type === "quick_replies") });
  console.log(`\n=== ${question}\n${secs.toFixed(1)} s, ok ${res.ok}\n${res.answer}\nfiles: ${files.join(", ")}`);
}
writeFileSync(join(out, "run.json"), JSON.stringify({ at: new Date(now).toISOString(), tenant, brand, report, spend: engine.log, creditsSpent: engine.spent }, null, 1));
console.log("credits spent:", engine.spent, JSON.stringify(engine.log.map((l) => ({ job: l.jobId, credits: l.credits, model: l.model }))));
redis("GRAPH.DELETE", copy);
await closeAll();
