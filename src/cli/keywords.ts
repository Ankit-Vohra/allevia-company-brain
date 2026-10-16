// `keywords`: the optional paid DataForSEO layer from the terminal. Without --yes it only prints what each call would
// cost and what is left of this month's budget; with --yes it runs them inside the budget and stores the results in
// the business's graph. When DataForSEO is not configured it says so and spends nothing.
import { parseArgs } from "node:util";
import { findBusinessId } from "../actions/shared.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { writeBatch } from "../graph/upsert.js";
import { keepPageNames } from "../checkup/pages.js";
import {
  DataForSeo, NOT_CONFIGURED, backlinksCall, competitorsCall, dfsConfig, estimateUsd, graphLedger, keywordIdeasCall, keywordsWrite, marketFor,
  rankedKeywordsCall, withinBudget, type PaidCall,
} from "../checkup/dataforseo.js";
import type { Command } from "./_command.js";

const USAGE = "keywords <tenant> [--seeds \"a,b\"] [--ranked] [--competitors] [--backlinks] [--country IN] [--yes]";

export const commands: Command[] = [
  {
    name: "keywords",
    usage: USAGE,
    summary: "Optional, paid (DataForSEO): searches to rank for, current rankings, competitors, backlinks; within a monthly budget",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { seeds: { type: "string" }, ranked: { type: "boolean" }, competitors: { type: "boolean" }, backlinks: { type: "boolean" }, country: { type: "string" }, yes: { type: "boolean" } },
      });
      const cfg = dfsConfig();
      if (!cfg.credentials) { console.log(NOT_CONFIGURED); return 0; }
      const tenant = positionals[0];
      if (!tenant || !(await listGraphs()).includes(graphName(tenant))) { console.error(`Usage: npm run cli -- ${USAGE}`); return 2; }
      const g = await openGraph(tenant);
      const bid = await findBusinessId(g, tenant);
      if (!bid) { console.error("No business in that graph."); return 2; }
      const [b] = await g.roQuery<{ domain: string | null; country: string | null; industry: string | null; city: string | null }>(
        "MATCH (b:Entity:Business {id:$id}) RETURN b.domain AS domain, b.country AS country, b.industry AS industry, b.city AS city LIMIT 1", { id: bid });
      const domain = b?.domain;
      if (!domain) { console.error("The business has no website domain on record."); return 2; }
      const market = marketFor(values.country ?? b?.country);
      const client = new DataForSeo(cfg.credentials);
      const seeds = values.seeds?.split(",").map((s) => s.trim()).filter(Boolean)
        ?? [b?.industry && b.city ? `${b.industry} ${b.city}` : b?.industry ?? domain];
      const calls: Array<PaidCall<unknown>> = [keywordIdeasCall(client, seeds, market) as PaidCall<unknown>];
      if (values.ranked) calls.push(rankedKeywordsCall(client, domain, market) as PaidCall<unknown>);
      if (values.competitors) calls.push(competitorsCall(client, domain, market) as PaidCall<unknown>);
      if (values.backlinks) calls.push(backlinksCall(client, domain) as PaidCall<unknown>);
      const ledger = graphLedger(g, bid, async (w) => { await writeBatch(g, w, Date.now()); });
      const spent = await ledger.spentThisMonth(Date.now());
      const total = calls.reduce((s, c) => s + estimateUsd(c.op, c.rows), 0);
      console.log(`Estimated cost: about $${total.toFixed(3)} (${calls.map((c) => `${c.op} $${estimateUsd(c.op, c.rows).toFixed(3)}`).join(", ")}). This month: $${spent.toFixed(3)} of $${cfg.monthlyBudgetUsd.toFixed(2)} spent.`);
      if (!values.yes) { console.log("Nothing was run. Add --yes to run it."); return 0; }
      const asOf = new Date().toISOString().slice(0, 19) + "Z";
      const out: Record<string, unknown> = {};
      for (const c of calls) {
        const r = await withinBudget(c, ledger, cfg.monthlyBudgetUsd);
        out[c.op] = r.value;
        console.log(`${c.op}: cost $${r.costUsd.toFixed(4)}; month so far $${r.spentThisMonthUsd.toFixed(3)} of $${r.budgetUsd.toFixed(2)}`);
      }
      const w = await keepPageNames(g, keywordsWrite({ asOf, host: domain, ideas: out.keyword_ideas as never, ranked: out.ranked_keywords as never }));
      const s = await writeBatch(g, w, Date.now());
      if (s.errors.length) console.error(`${s.errors.length} write(s) failed: ${s.errors[0]!.error}`);
      console.log(JSON.stringify(out, null, 2));
      return 0;
    },
  },
];
