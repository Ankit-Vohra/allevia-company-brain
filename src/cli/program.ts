// `enroll` and `program`: Allevia 90 from the terminal. `enroll <tenant>` runs onboarding's program stages on a business
// already in the graph (no crawl, no model): profile (country defaults, industry template), goals, Day-0 baselines from
// the Observations already there, the Day-0 checkpoint, and the capability ladder. `program <tenant>` prints the
// scorecard GET /api/:t/program serves.
import { parseArgs } from "node:util";
import type { OnboardEvent } from "../../shared/contracts.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { getTenant } from "../graph/tenants.js";
import { TENANT_CONFIGS } from "../tenant-config.js";
import { onboard } from "../onboard/onboard.js";
import { baselineLine } from "../onboard/enroll.js";
import { getProgram } from "../program/scorecard.js";
import { fmt, pct } from "../insights/text.js";
import type { Command } from "./_command.js";

async function known(tenant: string | undefined): Promise<boolean> {
  if (!tenant) return false;
  if ((await listGraphs()).includes(graphName(tenant))) return true;
  console.error(`No graph for "${tenant}" (${graphName(tenant)}). Ingest or onboard it first.`);
  return false;
}

const num = (v: number | null, unit?: string | null) => (v === null ? "unknown" : unit === "ratio" ? pct(v, 0) : fmt(v));

export const commands: Command[] = [
  {
    name: "enroll",
    usage: "enroll <tenant> [--country <name>] [--industry <text>] [--json]",
    summary: "Enrol a business already in the graph in Allevia 90: country defaults, goals, Day-0 baselines from its data, capabilities",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { country: { type: "string" }, industry: { type: "string" }, json: { type: "boolean" } },
      });
      const slug = positionals[0];
      if (!slug) { console.error("Usage: npm run cli -- enroll <tenant> [--country UK] [--industry \"architecture studio\"]"); return 2; }
      if (!(await known(slug))) return 2;
      const cfg = Object.hasOwn(TENANT_CONFIGS, slug) ? TENANT_CONFIGS[slug] : undefined;
      const reg = await getTenant(slug);
      const name = cfg?.name ?? reg?.name;
      if (!name) { console.error(`"${slug}" is not in the tenant registry or src/tenant-config.ts.`); return 2; }
      const industry = values.industry ?? cfg?.industry ?? reg?.industry;
      const country = values.country ?? cfg?.country;
      const domain = cfg?.domain ?? reg?.domain;
      const events: OnboardEvent[] = [];
      const r = await onboard({
        name, slug, website: false, ...(industry ? { industry } : {}), ...(country ? { country } : {}), ...(domain ? { domain } : {}),
      }, (e) => {
        events.push(e);
        if (values.json) return;
        if (e.type === "stage") console.log(`[${e.stage}] ${e.text}`);
        else if (e.type === "error") console.error(`error: ${e.message}`);
      }, {});
      if (values.json) { console.log(JSON.stringify(r, null, 2)); return r.errors.length ? 1 : 0; }
      const reg2 = r.region;
      console.log(`\n${name}: ${reg2?.country ?? "country unknown"}${reg2?.currency ? `, ${reg2.currency}` : ""}${reg2?.locale ? `, ${reg2.locale}` : ""}${reg2?.timeZone ? `, ${reg2.timeZone}` : ""}; template ${r.templateKey ?? "?"}`);
      if (r.program) console.log(`${r.program.program}: ${r.program.created ? "started" : "already running since"} ${r.program.startDate}`);
      for (const b of r.goals ?? []) console.log(`  ${baselineLine(b)}`);
      if (r.goals && !r.goals.length) console.log("  (goals already locked on an earlier run; `program` shows them)");
      if (r.capabilities) console.log(`Capabilities: ${r.capabilities.map((c) => `${c.name} ${c.accessMode}`).join("; ")}`);
      return r.errors.length ? 1 : 0;
    },
  },
  {
    name: "program",
    usage: "program <tenant> [--json] [--read-only]",
    summary: "The Allevia 90 scorecard: day N, checkpoints, first-pass curve, learned rules, goals against Day 0, capabilities",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: "boolean" }, "read-only": { type: "boolean" } } });
      const slug = positionals[0];
      if (!slug) { console.error("Usage: npm run cli -- program <tenant> [--json]"); return 2; }
      if (!(await known(slug))) return 2;
      const p = await getProgram(await openGraph(slug), { write: !values["read-only"] });
      if (!p) { console.log(`${slug} is not enrolled in Allevia 90. Run: npm run cli -- enroll ${slug}`); return 1; }
      if (values.json) { console.log(JSON.stringify(p, null, 2)); return 0; }
      console.log(`Allevia 90, day ${p.day} of 90 (${p.startDate} to ${p.endDate}), ${p.status}`);
      console.log(`Checkpoints: ${p.checkpoints.map((c) => `D${c.day} ${c.status}${c.status === "upcoming" ? ` ${c.dueDate}` : ""}`).join(" · ")}`);
      console.log(`First pass (30 days): ${p.firstPass.rate === null ? "no drafts decided yet" : `${pct(p.firstPass.rate, 0)} (${p.firstPass.firstPass30d}/${p.firstPass.decided30d})`}`);
      console.log(`Learned rules: ${p.learnedRules.active} active, ${p.learnedRules.learnedSinceStart} since the start, ${p.learnedRules.retired} retired`);
      console.log(`Deliverables approved: ${p.deliverables.approvedSinceStart} since the start (${p.deliverables.approved} in all); ${p.deliverables.pending} waiting`);
      console.log("Goals:");
      for (const gl of p.goals) {
        console.log(`  ${gl.name} (${gl.period}, ${gl.owner?.name ?? "no owner"}): baseline ${num(gl.baseline)}${gl.baselineConf === "unknown" ? " (no data on Day 0)" : ""}; now ${num(gl.current)}; target ${num(gl.target)}${gl.targetBasis === "template" ? " (template)" : ""} by ${gl.dueAt}; ${gl.status}`);
      }
      console.log(`Capabilities: ${Object.entries(p.capabilities.byMode).filter(([, n]) => n).map(([m, n]) => `${n} ${m}`).join(", ")}`);
      return 0;
    },
  },
];
