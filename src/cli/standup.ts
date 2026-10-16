// `standup <tenant>`: run the daily team stand-up now (the server runs it each morning on its own). Meera reviews what
// changed, picks at most three things, the team drafts them and they wait for the owner's OK; then today's note is written,
// leading with them. Nothing is posted or sent. --no-llm: the rule order picks (the words are still drafted on the
// subscription); --no-paid: no paid picture today; --json: the whole stand-up.
import { parseArgs } from "node:util";
import { agentById } from "../../shared/roster.js";
import { findBusinessId } from "../actions/shared.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "standup",
    usage: "standup <tenant> [--no-llm] [--no-paid] [--json]",
    summary: "Run today's team stand-up now: what the team noticed, drafted for your OK, then today's note",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "no-llm": { type: "boolean" }, "no-paid": { type: "boolean" }, json: { type: "boolean" } } });
      const tenant = positionals[0];
      if (!tenant) { console.error("Usage: npm run cli -- standup <tenant> [--no-llm] [--no-paid] [--json]"); return 2; }
      if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}" (${graphName(tenant)}). Run db:check to see the tenants.`); return 2; }
      const g = await openGraph(tenant);
      const businessId = await findBusinessId(g, tenant);
      if (!businessId) { console.error(`"${tenant}" has no business in its graph yet.`); return 2; }
      const { runDaily } = await import("../proactive/wiring.js");
      const { standup, brief } = await runDaily(tenant, g, businessId, {
        force: true, ...(values["no-llm"] ? { runner: null } : {}), ...(values["no-paid"] ? { paid: false } : {}), log: (l) => console.error(l),
      });
      if (values.json) { console.log(JSON.stringify({ standup, brief: { id: brief.id, text: brief.text } }, null, 2)); return 0; }
      console.log(`Stand-up for ${tenant} (${standup.localDate}), picked by ${standup.by === "meera" ? "Meera" : "the rule order"}: ${standup.considered} opportunities looked at, ${standup.skipped.length} set aside.`);
      for (const i of standup.items) {
        console.log(`\n${i.status === "drafted" ? "Drafted" : "Could not draft"}: ${i.title} (${agentById(i.agent)?.name ?? i.agent})`);
        console.log(`  why: ${i.why}`);
        console.log(`  brief: ${i.purpose}`);
        if (i.approvalId) console.log(`  waiting for OK: ${i.approvalId}${i.paid ? " (used the day's paid picture)" : ""}`);
        for (const n of i.notes) console.log(`  note: ${n}`);
      }
      for (const s of standup.skipped.slice(0, 8)) console.log(`  set aside: ${s.title} (${s.why})`);
      console.log(`\n${brief.text}\n\n(saved as ${standup.id} and ${brief.id})`);
      return 0;
    },
  },
];
