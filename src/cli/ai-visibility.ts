// `ai-visibility`: "Does AI know you?" from the terminal. Asks Claude (the Claude Code subscription, no API key) a few
// questions a customer would ask, and says whether the business is named. With a tenant it reads the business's name,
// kind of work, city and domain from its graph (flags override), stores the run and compares with the last one.
import { parseArgs } from "node:util";
import { findBusinessId } from "../actions/shared.js";
import { loadConfig } from "../config.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { writeBatch } from "../graph/upsert.js";
import { AgentSdkRunner } from "../ingest/llm.js";
import { aiVisibilityReport, aiVisibilityWrite, checkAiVisibility, storedAiRuns, type AiBusiness } from "../checkup/ai-visibility.js";
import type { Command } from "./_command.js";

const USAGE = "ai-visibility [<tenant>] [--name <business>] [--category <what customers call it>] [--city <city>] [--domain <site>] [--audience <for whom>] [--model sonnet] [--json]";

export const commands: Command[] = [
  {
    name: "ai-visibility",
    usage: USAGE,
    summary: "Does AI know you? Ask Claude (subscription, $0) what a customer would ask and see if the business is named",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { name: { type: "string" }, category: { type: "string" }, city: { type: "string" }, domain: { type: "string" }, audience: { type: "string" },
          model: { type: "string" }, json: { type: "boolean" } },
      });
      const tenant = positionals[0];
      let facts: Partial<AiBusiness> = {};
      let g: Awaited<ReturnType<typeof openGraph>> | undefined;
      let bid: string | null = null;
      if (tenant) {
        if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}".`); return 2; }
        g = await openGraph(tenant);
        bid = await findBusinessId(g, tenant);
        if (bid) {
          const [b] = await g.roQuery<{ name: string | null; industry: string | null; city: string | null; domain: string | null }>(
            "MATCH (b:Entity:Business {id:$id}) RETURN b.name AS name, b.industry AS industry, b.city AS city, b.domain AS domain LIMIT 1", { id: bid });
          if (b) facts = { ...(b.name ? { name: b.name } : {}), ...(b.industry ? { category: b.industry } : {}), ...(b.city ? { city: b.city } : {}), ...(b.domain ? { domain: b.domain } : {}) };
        }
      }
      const biz: Partial<AiBusiness> = {
        ...facts, ...(values.name ? { name: values.name } : {}), ...(values.category ? { category: values.category } : {}),
        ...(values.city ? { city: values.city } : {}), ...(values.domain ? { domain: values.domain } : {}), ...(values.audience ? { audience: values.audience } : {}),
      };
      if (!biz.name || !biz.category) { console.error(`Need the business name and what customers call it (--name, --category).\nUsage: npm run cli -- ${USAGE}`); return 2; }
      const runner = new AgentSdkRunner({ concurrency: 1, retries: 1, timeoutMs: 120_000 });
      const run = await checkAiVisibility(biz as AiBusiness, runner, { model: values.model ?? loadConfig().model, log: (l) => console.error(l) });
      let previous: { mentionPct: number | null; asOf: string } | undefined;
      if (g && bid) {
        previous = (await storedAiRuns(g, 1))[0];
        const s = await writeBatch(g, aiVisibilityWrite(run, bid), Date.now());
        if (s.errors.length) console.error(`[ai-visibility] ${s.errors.length} write(s) failed: ${s.errors[0]!.error}`);
      }
      if (values.json) console.log(JSON.stringify(run, null, 2));
      else console.log(aiVisibilityReport(run, previous));
      return 0;
    },
  },
];
