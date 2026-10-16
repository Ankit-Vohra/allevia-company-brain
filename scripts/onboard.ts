// Onboard one business from its website: npm run onboard -- --name "Kestrel & Oak" --slug kestrel_oak --url https://…
//   [--instagram handle] [--industry "architecture studio"] [--model haiku] [--max-pages 40] [--understand-pages 12]
// Streams the onboarding events as lines, writes into the local FalkorDB (ALLEVIA_FALKORDB_URL, default
// redis://127.0.0.1:6390) through ensureTenant, and leaves screenshots, caches and the run report under data/.
// Claude runs only through the Agent SDK on the subscription (AgentSdkRunner fails closed on an API key).
import { parseArgs } from "node:util";
import { closeAll } from "../src/graph/client.js";
import { AgentSdkRunner } from "../src/ingest/llm.js";
import { loadConfig } from "../src/config.js";
import { onboard } from "../src/onboard/onboard.js";
import { productionStudioDeps } from "../src/studio/wiring.js";
import { productionPublicData } from "../src/publicdata/service.js";

const { values: a } = parseArgs({
  options: {
    name: { type: "string" }, slug: { type: "string" }, url: { type: "string" }, instagram: { type: "string" }, industry: { type: "string" },
    model: { type: "string" }, "max-pages": { type: "string" }, "understand-pages": { type: "string" }, verbose: { type: "boolean" },
  },
});
if (!a.name || !a.slug || !a.url) {
  console.error('usage: npm run onboard -- --name "Business" --slug business_slug --url https://example.com [--instagram handle] [--industry text] [--model haiku] [--max-pages 40]');
  process.exit(2);
}
const int = (s: string | undefined) => (s === undefined ? undefined : Number.parseInt(s, 10));

const studio = productionStudioDeps(loadConfig().dataDir);
const t0 = Date.now();
const res = await onboard(
  { name: a.name, slug: a.slug, url: a.url, ...(a.instagram ? { instagram: a.instagram } : {}), ...(a.industry ? { industry: a.industry } : {}) },
  (e) => {
    const at = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
    if (e.type === "stage") console.log(`${at} [${e.stage}] ${e.text}`);
    else if (e.type === "page") console.log(`${at}   page ${e.url} "${e.title}"`);
    else if (e.type === "nodes") { if (a.verbose) console.log(`${at}   +${e.nodes.length} nodes, +${e.edges.length} edges`); }
    else if (e.type === "error") console.log(`${at} ERROR ${e.message}`);
    else if (e.type === "done") console.log(`${at} done ${e.tenant} ${JSON.stringify(e.counts)}`);
  },
  {
    runner: new AgentSdkRunner({ concurrency: 3 }),
    brand: { store: studio.store, vision: studio.vision, googleFonts: true },
    publicData: productionPublicData(loadConfig()),
    ...(a.model ? { model: a.model } : {}),
    crawlOptions: { ...(int(a["max-pages"]) ? { maxPages: int(a["max-pages"]) } : {}) },
    ...(int(a["understand-pages"]) ? { maxUnderstandPages: int(a["understand-pages"]) } : {}),
    log: (line) => { if (a.verbose || !line.startsWith("[crawl]")) console.error(line); },
  },
);
console.log(JSON.stringify({ ok: res.ok, pages: res.pages, seoScore: res.seoScore, stats: res.stats, errors: res.errors, report: res.reportPath }, null, 1));
await closeAll();
process.exit(res.ok ? 0 : 1);
