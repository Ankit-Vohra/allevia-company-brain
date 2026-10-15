// `tell`: "Tell your team" from the terminal: preview the owner's instruction as a diff, and with --apply write it.
// `agents`: the team with each desk's settings and standing instructions.
import { parseArgs } from "node:util";
import type { DirectivePreview } from "../../shared/contracts.js";
import { openGraph } from "../graph/client.js";
import { applyDirective, listAgentsWithSettings, previewDirective } from "../settings/directives.js";
import type { Command } from "./_command.js";

const OP: Record<string, string> = { change: "~", add: "+", same: "=" };

function printPreview(p: DirectivePreview): void {
  console.log(`${p.id} (${p.status}, read by ${p.parser === "rules" ? "rules" : "rules and haiku"})`);
  if (!p.diff.length) console.log("  Nothing to change.");
  for (const l of p.diff) console.log(`  ${OP[l.op] ?? "?"} ${l.label}: ${l.before !== undefined ? `${l.before} -> ` : ""}${l.after}${l.op === "same" ? " (already so)" : ""}`);
  for (const u of p.unparsed) console.log(`  ? not understood: "${u}"`);
  for (const n of p.notes) console.log(`  ! ${n}`);
}

export const commands: Command[] = [
  {
    name: "tell",
    usage: 'tell <tenant> "<instruction>" [--apply] [--no-llm] [--json]',
    summary: 'Tell your team (e.g. "No emojis on LinkedIn; switch Arjun off"): preview the change, --apply to make it',
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { apply: { type: "boolean" }, "no-llm": { type: "boolean" }, json: { type: "boolean" } },
      });
      const [tenant, ...words] = positionals;
      const text = words.join(" ").trim();
      if (!tenant || !text) { console.error('Usage: npm run cli -- tell <tenant> "<instruction>" [--apply] [--no-llm] [--json]'); return 2; }
      const g = await openGraph(tenant);
      const preview = await previewDirective(g, { text }, values["no-llm"] ? { llm: null } : {});
      const applied = values.apply ? await applyDirective(g, preview.id) : undefined;
      const out = applied ?? preview;
      if (values.json) { console.log(JSON.stringify(out, null, 1)); return 0; }
      printPreview(out);
      if (!applied) console.log(`\nApply it: npm run cli -- tell ${tenant} "${text.replace(/"/g, '\\"')}" --apply`);
      else if (applied.errors.length) { for (const e of applied.errors) console.error(`  x ${e}`); return 1; }
      return 0;
    },
  },
  {
    name: "agents",
    usage: "agents <tenant> [--json]",
    summary: "List the team: who is on, light or off, autonomy, and each desk's standing instructions",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
      const [tenant] = positionals;
      if (!tenant) { console.error("Usage: npm run cli -- agents <tenant> [--json]"); return 2; }
      const agents = await listAgentsWithSettings(await openGraph(tenant));
      if (values.json) { console.log(JSON.stringify(agents, null, 1)); return 0; }
      for (const a of agents) {
        const state = !a.enabled ? "off" : a.mode === "light" ? "light" : "on";
        console.log(`${`${a.name} (${a.title})`.padEnd(32)} ${state.padEnd(5)} L${a.autonomy}${a.statusNote ? `  ${a.statusNote}` : ""}`);
        for (const n of a.instructions) console.log(`    - ${n.text}${n.channel ? ` [${n.channel}]` : ""}  (${n.id})`);
      }
      return 0;
    },
  },
];
