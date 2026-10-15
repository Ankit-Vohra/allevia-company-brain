// Crawl one site and print every crawler log line with a clock, to see where a slow or stuck crawl spends its time:
//   npx tsx scripts/crawl-probe.ts https://example.com [maxPages]
// Nothing is written anywhere: no graph, no model.
import { crawlSite } from "../src/ingest/sources/website/index.js";

const [url, max] = process.argv.slice(2);
if (!url) {
  console.error("usage: npx tsx scripts/crawl-probe.ts https://example.com [maxPages]");
  process.exit(2);
}
const t0 = Date.now();
const r = await crawlSite(url, { maxPages: max ? Number(max) : 40, log: (l) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${l}`) });
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${r.pages.length} pages, ${r.requests} requests, ${r.skipped.length} skipped`);
process.exit(0);
