// `capabilities`: derive a tenant's capability ladder (product design §2.3), write it to the graph and print it.
import { parseArgs } from "node:util";
import { openGraph } from "../graph/client.js";
import { getCapabilities } from "../capabilities/ladder.js";
import { isoDate } from "../util/time.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "capabilities",
    usage: "capabilities <tenant> [--json]",
    summary: "Show what each source lets the agents do (api, delegated, upload, public, benchmark or none)",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" } } });
      const [tenant] = positionals;
      if (!tenant) { console.error("Usage: npm run cli -- capabilities <tenant> [--json]"); return 2; }
      const caps = await getCapabilities(await openGraph(tenant));
      if (values.json) { console.log(JSON.stringify(caps, null, 1)); return 0; }
      const w = Math.max(...caps.map((c) => c.name.length));
      for (const c of caps) {
        const last = c.lastOkAt !== null ? ` · last live ${isoDate(c.lastOkAt)}` : "";
        console.log(`${c.name.padEnd(w)}  ${c.accessMode.padEnd(9)} ${c.status}${last}\n${" ".repeat(w + 2)}${c.upgradeHint}`);
      }
      return 0;
    },
  },
];
