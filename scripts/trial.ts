// Trial one business through the real onboarding flow and report what a new owner would get on day one:
//   npm run trial -- --name "Prufrock Coffee" --slug trial_prufrock --url https://prufrockcoffee.com --country "United Kingdom" [--out file.json]
// It sends what the web form sends (name, URL, country, and that country's currency, locale and time zone; no industry
// or vertical), runs onboard() on the subscription (AgentSdkRunner; this script counts every model call), then reads
// back: the time, model calls, pages, graph counts per label, every name per label (to judge duplicates and junk),
// the Allevia 90 goals as the owner sees them, "what your team can see", and the first Today's note (no model).
// Use a throwaway slug (trial_<name>); delete the graph afterwards with `npm run trial -- --delete trial_<name>`.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { closeAll, graphName, openGraph } from "../src/graph/client.js";
import { AgentSdkRunner, type LlmRunner, type StructuredInput } from "../src/ingest/llm.js";
import { writeBrief } from "../src/insights/brief.js";
import { onboard } from "../src/onboard/onboard.js";
import { REGIONS, regionOf } from "../src/onboard/region.js";
import { getProgram } from "../src/program/scorecard.js";

const { values: a } = parseArgs({
  options: {
    name: { type: "string" }, slug: { type: "string" }, url: { type: "string" }, country: { type: "string" }, out: { type: "string" },
    delete: { type: "string" }, "max-pages": { type: "string" }, model: { type: "string" },
  },
});

if (a.delete) {
  if (!a.delete.startsWith("trial_")) throw new Error("only trial_* graphs are deleted by this script");
  const g = await openGraph(a.delete);
  await g.drop();
  console.log(`deleted ${graphName(a.delete)}`);
  await closeAll();
  process.exit(0);
}
if (!a.name || !a.slug || !a.url) {
  console.error('usage: npm run trial -- --name "Business" --slug trial_name --url https://example.com [--country "United Kingdom"] [--out file.json]');
  process.exit(2);
}
if (!a.slug.startsWith("trial_")) throw new Error("trial slugs start with trial_ so they are easy to find and delete");

// Counts every model call by what it was for, and how long the model spent.
const calls: Record<string, number> = {};
let modelMs = 0;
const base = new AgentSdkRunner({ concurrency: 3 });
const runner: LlmRunner = {
  async structured(i: StructuredInput) {
    const label = /profile/i.test(i.system.slice(0, 80)) ? "profile" : /brand/i.test(i.system.slice(0, 120)) ? "brand" : "extract";
    calls[label] = (calls[label] ?? 0) + 1;
    const t = Date.now();
    try {
      return await base.structured(i);
    } finally {
      modelMs += Date.now() - t;
    }
  },
};

const region = regionOf(a.country ?? "United Kingdom") ?? REGIONS.GB!;
const t0 = Date.now();
const stageAt: Record<string, number> = {};
const errors: string[] = [];
const pageEvents: Array<{ url: string; title: string }> = [];
const res = await onboard(
  { name: a.name, slug: a.slug, url: a.url, country: region.country, currency: region.currency, locale: region.locale, timeZone: region.timeZone },
  (e) => {
    const at = (Date.now() - t0) / 1000;
    if (e.type === "stage") { stageAt[e.stage] = at; console.log(`${at.toFixed(1)}s [${e.stage}] ${e.text}`); }
    else if (e.type === "page") pageEvents.push({ url: e.url, title: e.title });
    else if (e.type === "error") { errors.push(e.message); console.log(`${at.toFixed(1)}s ERROR ${e.message}`); }
  },
  { runner, ...(a.model ? { model: a.model } : {}), ...(a["max-pages"] ? { crawlOptions: { maxPages: Number(a["max-pages"]) } } : {}), log: (l) => { if (!l.startsWith("[crawl]")) console.error(l); } },
);
const seconds = (Date.now() - t0) / 1000;

const g = await openGraph(a.slug);
const names: Record<string, string[]> = {};
const rows = await g.roQuery<{ labels: string[]; name: string | null; id: string }>(
  "MATCH (n:Entity) WHERE NOT n:Chunk AND NOT n:Version AND NOT n:Observation AND NOT n:Page AND NOT n:Document RETURN labels(n) AS labels, n.name AS name, n.id AS id ORDER BY id");
for (const r of rows) {
  const label = r.labels.find((l) => l !== "Entity") ?? "?";
  (names[label] ??= []).push(r.name ?? r.id);
}
const program = await getProgram(g);
const brief = await writeBrief(a.slug, { graph: g, llm: false });
const [biz] = await g.roQuery<Record<string, unknown>>("MATCH (b:Business) RETURN properties(b) AS p LIMIT 1").then((r) => r.map((x) => (x as { p: Record<string, unknown> }).p));

const out = {
  slug: a.slug, url: a.url, ok: res.ok, seconds: Math.round(seconds), modelMs: Math.round(modelMs), modelCalls: calls,
  modelCallTotal: Object.values(calls).reduce((x, y) => x + y, 0), stageAt, pages: res.pages, pageEvents: pageEvents.map((p) => p.url),
  seoScore: res.seoScore, errors, counts: res.counts, region: res.region, templateKey: res.templateKey, report: res.reportPath,
  business: biz, names,
  goals: program?.goals.map((x) => ({ name: x.name, unit: x.unit, period: x.period, baseline: x.baseline, target: x.target, current: x.current, status: x.status })),
  capabilities: program?.capabilities,
  note: brief.text,
};
const file = a.out ?? `/tmp/${a.slug}.json`;
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`written ${file}: ${Math.round(seconds)}s, ${out.modelCallTotal} model calls, ${res.pages} pages, ${errors.length} errors`);
await closeAll();
process.exit(0);
