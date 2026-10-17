// `seed-sample <tenant> --profile coffee`: the private layer a public demo business cannot show, as SAMPLE NUMBERS, linked into its
// real public graph (src/demo/sample/coffee.ts): eight weeks of orders by channel, city and product; the checkout release, the UPI
// error and the wasted ad spend behind "Why did online orders drop this week?"; a sample inbox and calendar; then the product's own
// steps: enrol, insights, the stand-up and Today's note (src/demo/sample/setup.ts). Everything it writes is marked sample.
//
// Only for the listed demo businesses (bluetokai) and throwaway ones (demo_*, *_seed): a real customer's graph is never seeded.
// Run it after `onboard`, on the same day you want the demo to read "this week" (it is dated from now; --now pins it).
import { parseArgs } from "node:util";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { realVectors } from "../demo/vectors.js";
import { isSampleTenant } from "../demo/sample/connections.js";
import { PROFILES, seedable, setupSample, type Profile } from "../demo/sample/setup.js";
import type { Command } from "./_command.js";

const fmt = (n: number) => n.toLocaleString("en-IN");

export const commands: Command[] = [
  {
    name: "seed-sample",
    usage: "seed-sample <tenant> --profile coffee [--name <text>] [--industry <text>] [--now <ISO time>] [--weeks 8] [--no-standup] [--no-llm] [--json]",
    summary: "Add sample private numbers (orders, checkout, ads, inbox) to a public demo business, linked into its real graph, then enrol, insights and the stand-up",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: {
          profile: { type: "string" }, name: { type: "string" }, industry: { type: "string" }, now: { type: "string" }, weeks: { type: "string" },
          "no-standup": { type: "boolean" }, "no-llm": { type: "boolean" }, json: { type: "boolean" },
        },
      });
      const tenant = positionals[0];
      const profile = values.profile ?? "";
      if (!tenant || !(PROFILES as readonly string[]).includes(profile)) {
        console.error(`Usage: npm run cli -- seed-sample <tenant> --profile ${PROFILES.join("|")} [--now 2026-10-17T06:00:00Z] [--no-standup] [--no-llm]`);
        return 2;
      }
      if (!seedable(tenant, isSampleTenant)) {
        console.error(`Refusing to add sample numbers to "${tenant}": only the demo businesses (bluetokai) and throwaway ones (demo_*, *_seed) are seeded, never a real customer.`);
        return 2;
      }
      if (!(await listGraphs()).includes(graphName(tenant))) {
        console.error(`No graph for "${tenant}" (${graphName(tenant)}). Onboard it first: npm run cli -- onboard <url> --slug ${tenant}`);
        return 2;
      }
      const now = values.now ? Date.parse(values.now) : Date.now();
      if (!Number.isFinite(now)) { console.error(`--now must be a time like 2026-10-17T06:00:00Z, got "${values.now}"`); return 2; }
      const weeks = values.weeks ? Number.parseInt(values.weeks, 10) : undefined;
      const g = await openGraph(tenant);
      const r = await setupSample(g, {
        tenant, profile: profile as Profile, now, ...(weeks ? { weeks } : {}),
        ...(values.name ? { name: values.name } : {}), ...(values.industry ? { industry: values.industry } : {}),
        standup: values["no-standup"] !== true, ...(values["no-llm"] ? { runner: null } : {}),
        log: (l) => console.error(l),
      });
      const vectors = await realVectors(g, { ids: r.seed.sample });
      if (values.json) { console.log(JSON.stringify({ ...r, seed: { ...r.seed, sample: r.seed.sample.length }, vectors }, null, 2)); return 0; }
      const t = r.seed.timeline;
      console.log(`Sample layer for ${tenant}: ${fmt(r.seed.nodes)} nodes, ${fmt(r.seed.edges)} edges, ${fmt(r.seed.observations)} readings, all marked sample; ${vectors ? `${vectors} real e5 vectors` : "stand-in vectors (no local model)"}.`);
      console.log(`  weeks ${t.firstDay} to ${t.lastDay}; the checkout release on ${t.releaseDay}; Instagram reach dipped from ${t.reachDipDay} (the red herring)`);
      console.log(`  online orders ${t.releaseDay} to ${t.lastDay}: ${fmt(r.seed.hero.after)} against ${fmt(r.seed.hero.before)} the same days a week earlier (down ${r.seed.hero.dropPct}%)`);
      console.log(`  products: ${r.seed.products.map((p) => `${p.name}${p.crawled ? "" : " [sample]"}`).join("; ")}`);
      console.log(`  goals: ${r.enrolled ? "enrolled now; " : ""}${r.goals.locked} starting points locked, ${r.goals.readings} readings`);
      console.log(`  insights: ${r.insights.findings} findings, ${r.insights.cards} cards`);
      if (r.standup) console.log(`  stand-up (${r.standup.by}): ${r.standup.drafted.length ? r.standup.drafted.join("; ") : "nothing drafted"}`);
      for (const f of r.filled) console.log(`  drafted for the demo: ${f.kind} "${f.title}" (${f.status})`);
      console.log(`\nWaiting for the owner's OK (${r.waiting.length}):`);
      for (const w of r.waiting) console.log(`  ${w.kind}: ${w.title}${w.sample ? " [sample numbers]" : ""}`);
      console.log(`\nAsk it: npm run cli -- ask ${tenant} "Why did online orders drop this week?"`);
      return 0;
    },
  },
];
