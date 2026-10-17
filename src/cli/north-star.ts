// `north-star <tenant>` shows a business's main goal (its north star) as the team reads it; `north-star:backfill [tenant ...]`
// writes it for businesses set up before it existed (src/northstar/backfill.ts). Safe to run again: the same goal writes nothing,
// and one the owner set is kept unless --force.
import { parseArgs } from "node:util";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { BACKFILL, backfillNorthStar } from "../northstar/backfill.js";
import { loadNorthStar, loadPlanGoals, northStarBlock } from "../northstar/northstar.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "north-star",
    usage: "north-star <tenant> [--json]",
    summary: "Show a business's main goal (north star) and growth-plan goals, as every agent reads them",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
      const tenant = positionals[0];
      if (!tenant) { console.error("Usage: npm run cli -- north-star <tenant>"); return 2; }
      if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}".`); return 2; }
      const g = await openGraph(tenant);
      const [ns, goals] = await Promise.all([loadNorthStar(g), loadPlanGoals(g)]);
      if (values.json) console.log(JSON.stringify({ northStar: ns, goals }, null, 2));
      else console.log(northStarBlock(ns, goals));
      return 0;
    },
  },
  {
    name: "north-star:backfill",
    usage: "north-star:backfill [tenant ...] [--force] [--dry-run]",
    summary: `Write the main goal for businesses set up before it existed (default: ${Object.keys(BACKFILL).join(", ")})`,
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { force: { type: "boolean" }, "dry-run": { type: "boolean" } } });
      const graphs = new Set(await listGraphs());
      const tenants = positionals.length ? positionals : Object.keys(BACKFILL);
      let failed = 0;
      for (const t of tenants) {
        if (!graphs.has(graphName(t))) { console.log(`${t}: no graph here, skipped`); continue; }
        const r = await backfillNorthStar(await openGraph(t), t, { now: Date.now(), ...(values.force ? { force: true } : {}), ...(values["dry-run"] ? { dryRun: true } : {}) });
        const ns = r.northStar;
        const what = { written: "written", same: "already set, nothing written", "kept-owner": "kept the one the owner set (use --force to replace)", "dry-run": "dry run, nothing written" }[r.status];
        console.log(`${t}: ${what}\n  Outcome: ${ns.outcome}\n  For: ${ns.audiences.join("; ") || "(no audience on record)"}\n  Offer: ${ns.offer || "(none on record)"}\n  CTA: ${ns.cta.text}${ns.cta.url ? ` (${ns.cta.url})` : ""}${ns.altCta ? `; or ${ns.altCta.text}${ns.altCta.url ? ` (${ns.altCta.url})` : ""}` : ""}`);
        for (const e of r.errors) { console.error(`  error: ${e}`); failed++; }
      }
      return failed ? 1 : 0;
    },
  },
];
