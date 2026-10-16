// `seed-demo`: builds the synthetic hero-use-case business (src/demo/growth.ts) as its own graph and registers it, so the
// public repo and the judges can run "Why did sign-ups drop this week, and what should we do?" with no private data.
// Dropped and rebuilt each time; refuses any name that is not demo_* or *_seed, so a real business can never be reseeded.
//
// `--recorded` loads the same business WITH four recorded live runs on it (src/demo/recorded/shiftly-hero.jsonl, a
// db:export file, marked as showcase turns), so the public read-only mode has answers to replay and the Approvals page has
// the cards those runs drafted. A live run starts from the plain seed, which is why that stays the default: a graph that
// already holds the answer would remember it.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { ensureTenant } from "../graph/tenants.js";
import { importDump, readDump } from "../graph/transfer.js";
import { GROWTH_TENANT, seedGrowth } from "../demo/growth.js";
import { realVectors } from "../demo/vectors.js";
import type { Command } from "./_command.js";

export const RECORDED_HERO_FILE = fileURLToPath(new URL("../demo/recorded/shiftly-hero.jsonl", import.meta.url));

export const commands: Command[] = [
  {
    name: "seed-demo",
    usage: "seed-demo [tenant] [--recorded] [--no-register]",
    summary: "Build the synthetic hero-use-case business (default demo_growth: sign-ups dropped after a release) and register it; --recorded adds the recorded answers that public mode replays",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "no-register": { type: "boolean" }, recorded: { type: "boolean" } } });
      const tenant = positionals[0] ?? GROWTH_TENANT;
      if (!/^demo_|_seed$/.test(tenant)) throw new Error(`refusing to reseed "${tenant}": only throwaway tenants (demo_* or *_seed)`);
      if (values.recorded === true) {
        const dump = readDump(RECORDED_HERO_FILE);
        const r = await importDump(dump, loadConfig().falkordbUrl, { graph: graphName(tenant), replace: true });
        if (!r.verify.ok) throw new Error(`the recorded copy did not verify: ${[...r.verify.problems, ...r.schema.problems].join("; ")}`);
        const turns = dump.nodes.filter((n) => n.l.includes("Turn") && n.p.showcase === true).length;
        console.log(`Loaded ${graphName(tenant)} from the recorded copy: ${r.nodes} nodes, ${r.edges} edges, ${turns} recorded answers to replay (no model, no network).`);
      } else {
        const g = await openGraph(tenant);
        if ((await listGraphs()).includes(graphName(tenant))) await g.drop();
        const n = await seedGrowth(await openGraph(tenant));
        const vectors = await realVectors(await openGraph(tenant));
        console.log(`Seeded ${graphName(tenant)}: ${n.nodes} nodes, ${n.edges} edges, ${n.observations} readings; ${vectors ? `${vectors} real e5 vectors` : "stand-in vectors (no local model)"}.`);
      }
      if (values["no-register"] !== true) {
        await ensureTenant({ slug: tenant, name: "Shiftly (synthetic demo)", domain: "demo.example", industry: "shift-jobs app (synthetic demo data)", city: "Pune" });
        console.log(values.recorded === true
          ? `Registered "${tenant}". Start the app (npm run cli -- serve --public) and open Chat: the four recorded answers replay with their work logs and paths.`
          : `Registered "${tenant}". Ask it: npm run cli -- ask ${tenant} "Why did sign-ups drop this week, and what should we do?"`);
      }
      return 0;
    },
  },
];
