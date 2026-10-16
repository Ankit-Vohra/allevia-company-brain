// `seed-demo`: builds the synthetic hero-use-case business (src/demo/growth.ts) as its own graph and registers it, so the
// public repo and the judges can run "Why did sign-ups drop this week, and what should we do?" with no private data.
// Dropped and rebuilt each time; refuses any name that is not demo_* or *_seed, so a real business can never be reseeded.
import { parseArgs } from "node:util";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { ensureTenant } from "../graph/tenants.js";
import { GROWTH_TENANT, seedGrowth } from "../demo/growth.js";
import { realVectors } from "../demo/vectors.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "seed-demo",
    usage: "seed-demo [tenant] [--no-register]",
    summary: "Build the synthetic hero-use-case business (default demo_growth: sign-ups dropped after a release) and register it",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { "no-register": { type: "boolean" } } });
      const tenant = positionals[0] ?? GROWTH_TENANT;
      if (!/^demo_|_seed$/.test(tenant)) throw new Error(`refusing to reseed "${tenant}": only throwaway tenants (demo_* or *_seed)`);
      const g = await openGraph(tenant);
      if ((await listGraphs()).includes(graphName(tenant))) await g.drop();
      const n = await seedGrowth(await openGraph(tenant));
      const vectors = await realVectors(await openGraph(tenant));
      console.log(`Seeded ${graphName(tenant)}: ${n.nodes} nodes, ${n.edges} edges, ${n.observations} readings; ${vectors ? `${vectors} real e5 vectors` : "stand-in vectors (no local model)"}.`);
      if (values["no-register"] !== true) {
        await ensureTenant({ slug: tenant, name: "Shiftly (synthetic demo)", domain: "demo.example", industry: "shift-jobs app (synthetic demo data)", city: "Pune" });
        console.log(`Registered "${tenant}". Ask it: npm run cli -- ask ${tenant} "Why did sign-ups drop this week, and what should we do?"`);
      }
      return 0;
    },
  },
];
