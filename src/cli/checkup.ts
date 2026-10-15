// `checkup`: the free website check-up from the terminal. Crawls the site politely, runs Lighthouse locally, judges
// the first screen a phone visitor sees, and prints the top five fixes in owner words (--all adds "Show how").
// With --tenant it stores the run in that business's graph and says what changed since the last one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { ownerReport } from "../checkup/report.js";
import { runCheckup, saveCheckup } from "../checkup/run.js";
import type { BusinessKind } from "../checkup/conversion.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "checkup",
    usage: "checkup <url> [--tenant <slug>] [--name <business>] [--kind local|online] [--pages 25] [--all] [--json <file>] [--shots <dir>]",
    summary: "Free website check-up: top 5 fixes ranked by likely enquiries (Lighthouse + crawl + first-screen checks)",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { tenant: { type: "string" }, name: { type: "string" }, kind: { type: "string" }, pages: { type: "string" }, all: { type: "boolean" },
          json: { type: "string" }, shots: { type: "string" }, quiet: { type: "boolean" } },
      });
      const url = positionals[0];
      if (!url) { console.error("Usage: npm run cli -- checkup <url> [--tenant <slug>] [--name <business>] [--all]"); return 2; }
      const kind = values.kind === "local" || values.kind === "online" ? (values.kind as BusinessKind) : undefined;
      if (values.tenant && !(await listGraphs()).includes(graphName(values.tenant))) {
        console.error(`No graph for "${values.tenant}". Run db:check to see the tenants.`);
        return 2;
      }
      const log = values.quiet ? () => {} : (l: string) => console.error(l);
      const r = await runCheckup(/^https?:\/\//i.test(url) ? url : `https://${url}`, {
        ...(values.name ? { businessName: values.name } : {}), ...(kind ? { kind } : {}), ...(values.pages ? { maxPages: Number(values.pages) } : {}),
      }, { log, ...(values.shots ? { crawlOptions: { screenshotDir: values.shots } } : {}) });
      let progress: string[] = [];
      if (values.tenant) {
        const g = await openGraph(values.tenant);
        const saved = await saveCheckup(g, r);
        progress = saved.progress.lines;
        console.error(`[checkup] stored as ${saved.docId}${saved.closed ? `; ${saved.closed} fixed item(s) closed` : ""}`);
      }
      const host = new URL(r.origin).hostname;
      console.log(ownerReport(r.verdict, { progress, notes: r.notes, showHow: !!values.all, host, asOf: r.asOf }));
      if (values.json) {
        mkdirSync(dirname(values.json), { recursive: true });
        const { crawl, ...rest } = r;
        writeFileSync(values.json, JSON.stringify({ ...rest, crawl: { pages: crawl.pages.length, skipped: crawl.skipped.length, robots: crawl.robots, sitemapUrls: crawl.sitemapUrls, screenshots: crawl.screenshots } }, null, 2));
      }
      return 0;
    },
  },
];
