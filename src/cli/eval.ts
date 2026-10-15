// `eval`: run a tenant's eval set (evals/<set>.yaml) through the agent company and write docs/evals/<date>-<tenant>.md
// (evals/runner.ts). `showcase`: mark a stored turn for public replay (spec §11.3), unmark it, or list the marked ones.
import { parseArgs } from "node:util";
import { listShowcase, setShowcase } from "../agent/memory.js";
import { openGraph } from "../graph/client.js";
import { formatIst } from "../util/time.js";
import type { Command } from "./_command.js";
import { interruptible } from "./_interrupt.js";

export const commands: Command[] = [
  {
    name: "eval",
    usage: "eval <tenant> [--limit N] [--only id,id] [--tags a,b] [--fake] [--model haiku] [--verbose]",
    summary: "Run the tenant's eval questions, score every turn and write docs/evals/<date>-<tenant>.md",
    async run(args) {
      const { evalMain } = await import("../../evals/runner.js");
      const verbose = args.includes("--verbose");
      const log = verbose ? (await import("./_worklog.js")).workLog() : undefined;
      const stop = interruptible();
      try {
        return await evalMain(args, { signal: stop.signal, ...(log ? { onEvent: (_it, e) => log(e) } : {}) });
      } finally {
        stop.dispose();
      }
    },
  },
  {
    name: "showcase",
    usage: "showcase <tenant> [<turnId>] [--off]",
    summary: "Mark a turn for public replay (or --off to unmark); with no turn id, list the showcase turns",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { off: { type: "boolean" } } });
      const [tenant, turnId] = positionals;
      if (!tenant) { console.error("Usage: npm run cli -- showcase <tenant> [<turnId>] [--off]"); return 2; }
      const g = await openGraph(tenant);
      if (turnId) {
        const t = await setShowcase(g, turnId, values.off !== true);
        console.log(`${t.showcase ? "Showcase" : "No longer a showcase"}: ${t.id}  ${t.question}`);
      }
      const all = await listShowcase(g);
      if (!all.length) { console.log("No showcase turns."); return 0; }
      console.log(`Showcase turns in ${tenant} (${all.length}):`);
      for (const t of all) console.log(`  ${t.id}  ${t.at ? formatIst(t.at) : "?"}  ${t.question}`);
      return 0;
    },
  },
];
