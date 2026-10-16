// `sales`: the Sales department's records from the command line (src/sales).
//   sales import <tenant> <file.csv|file.xlsx>   add the people in a spreadsheet of enquiries as leads (the fallback when Gmail or WhatsApp is not connected)
//   sales pipeline <tenant>                      how many leads are in each stage, what is waiting, what is stuck
// Nothing here contacts anyone.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { importLeadsSheet } from "../sales/sheet.js";
import { pipeline, stalledDeals, unanswered } from "../sales/graph.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "sales",
    usage: "sales import <tenant> <file> | sales pipeline <tenant>",
    summary: "Sales records: add leads from a spreadsheet, or see the pipeline",
    async run(args) {
      const [what, tenant, file] = args;
      if (!what || !tenant || (what === "import" && !file)) { console.error("Usage: sales import <tenant> <file> | sales pipeline <tenant>"); return 1; }
      if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}" (${graphName(tenant)}).`); return 1; }
      const g = await openGraph(tenant);
      if (what === "import") {
        const r = await importLeadsSheet(g, readFileSync(file!), basename(file!), { now: Date.now(), tenant });
        console.log(`${r.added} added, ${r.alreadyThere} already there, ${r.skipped} skipped (no name, email or phone, or no message).`);
        return 0;
      }
      if (what === "pipeline") {
        const now = Date.now();
        const p = await pipeline(g);
        console.log(`Leads by stage: ${Object.entries(p.byStage).map(([k, v]) => `${k} ${v}`).join(", ")}. Open deals: ${p.open} (${p.openValue}). Won: ${p.wonValue}.`);
        console.log(`Waiting for a reply: ${(await unanswered(g, now)).length}. Quiet for two weeks: ${(await stalledDeals(g, now)).length}.`);
        return 0;
      }
      console.error(`Unknown sales command "${what}".`);
      return 1;
    },
  },
];
