// `insights`, `brief` and `approvals`: the action layer from the terminal, so the founder can demo it without the web
// app. `insights` runs the detectors and writes Recommendations and cards; `brief` writes today's morning brief;
// `approvals` lists the cards waiting, and `approvals <t> approve|reject <id> [--edit file]` decides one. Approving runs
// the real executor: a github_issue card opens a real issue on ALLEVIA_ACTION_REPO.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { agentById } from "../../shared/roster.js";
import { graphName, listGraphs, openGraph, type GraphHandle } from "../graph/client.js";
import { loadConfig } from "../config.js";
import { decideApproval, listApprovals, type Decision } from "../actions/approvals.js";
import type { Payload } from "../actions/shared.js";
import { writeBrief } from "../insights/brief.js";
import { runInsights } from "../insights/recommend.js";
import { refreshGoalReadings } from "../program/scorecard.js";
import { pct } from "../insights/text.js";
import type { Command } from "./_command.js";

async function tenantGraph(tenant: string | undefined): Promise<GraphHandle | null> {
  if (!tenant) return null;
  if (!(await listGraphs()).includes(graphName(tenant))) {
    console.error(`No graph for "${tenant}" (${graphName(tenant)}). Run db:check to see the tenants.`);
    return null;
  }
  return openGraph(tenant);
}

const who = (id: string | null | undefined) => (id ? agentById(id)?.name ?? id : "?");

// An edit file is a JSON object ({"title": …, "body": …}) or plain text (the new body).
export function readEdit(path: string): Partial<Payload> | string {
  const text = readFileSync(path, "utf8");
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Partial<Payload>;
  } catch {
    // not JSON: the file is the new body
  }
  return text.trim();
}

export const commands: Command[] = [
  {
    name: "insights",
    usage: "insights <tenant> [--llm] [--json]",
    summary: "Run the detectors; write Recommendations and approval cards (numbers from the graph only)",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { llm: { type: "boolean" }, json: { type: "boolean" } } });
      const g = await tenantGraph(positionals[0]);
      if (!g) { if (!positionals[0]) console.error("Usage: npm run cli -- insights <tenant> [--llm] [--json]"); return 2; }
      const tenant = positionals[0]!;
      const r = await runInsights(tenant, { graph: g, llm: !!values.llm, log: (l) => console.error(l) });
      if (values.json) { console.log(JSON.stringify(r, null, 2)); return r.errors.length ? 1 : 0; }
      const created = r.recommendations.filter((x) => x.created).length;
      const cards = r.recommendations.filter((x) => x.approvalId).length;
      console.log(`Insights for ${tenant}: ${r.candidates.length} findings (${created} new), ${cards} with a card, ${r.resolved.length} resolved${values.llm ? `, ${r.polished} polished` : ""}`);
      for (const area of ["seo", "content", "funnel", "ads", "knowledge"] as const) {
        const cs = r.candidates.filter((c) => c.area === area);
        if (!cs.length) continue;
        console.log(`\n${area.toUpperCase()}${area === "ads" ? " (simulated)" : ""}`);
        for (const c of cs) {
          const w = r.recommendations.find((x) => x.key === c.key);
          console.log(`  ${who(c.agent).padEnd(6)} ${c.title}${w?.approvalId ? `\n         card: ${w.approvalId} (${c.suggestedAction?.kind})` : ""}`);
        }
      }
      for (const e of r.errors) console.error(`detector ${e.detector} failed: ${e.error}`);
      return r.errors.length ? 1 : 0;
    },
  },
  {
    name: "brief",
    usage: "brief <tenant> [--since <ISO date>] [--llm] [--json]",
    summary: "Write today's morning brief: goal pulse, what changed, top 3, approvals, next action",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { since: { type: "string" }, llm: { type: "boolean" }, json: { type: "boolean" } } });
      const g = await tenantGraph(positionals[0]);
      if (!g) { if (!positionals[0]) console.error("Usage: npm run cli -- brief <tenant> [--since 2026-10-14]"); return 2; }
      await refreshGoalReadings(g); // Allevia 90 goals read their newest complete period first
      const b = await writeBrief(positionals[0]!, { graph: g, llm: !!values.llm, ...(values.since ? { since: values.since } : {}) });
      if (values.json) console.log(JSON.stringify(b, null, 2));
      else console.log(`${b.text}\n\n(saved as ${b.id})`);
      return 0;
    },
  },
  {
    name: "approvals",
    usage: "approvals <tenant> [approve|reject <id> [--edit <file>] [--actor <id>]] [--all]",
    summary: "List approval cards, or decide one (approve runs the executor; --edit teaches a learned rule)",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { edit: { type: "string" }, actor: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } },
      });
      const [tenant, verb, id] = positionals;
      const g = await tenantGraph(tenant);
      if (!g) { if (!tenant) console.error("Usage: npm run cli -- approvals <tenant> [approve|reject <id> [--edit file]]"); return 2; }
      if (!verb) {
        const list = await listApprovals(g, values.all ? {} : { status: "pending" });
        if (values.json) { console.log(JSON.stringify(list, null, 2)); return 0; }
        if (!list.length) { console.log(values.all ? "No approval cards." : "Nothing waiting."); return 0; }
        for (const a of list) {
          console.log(`${a.id}  ${a.status.padEnd(8)} ${a.kind.padEnd(13)} ${who(a.by).padEnd(6)} ${a.title}${a.simulated ? " (simulated)" : ""}`);
        }
        return 0;
      }
      if ((verb !== "approve" && verb !== "reject") || !id) {
        console.error("Usage: npm run cli -- approvals <tenant> approve|reject <approval id> [--edit file] [--actor person:…]");
        return 2;
      }
      const r = await decideApproval(g, {
        approvalId: id, decision: verb as Decision, ...(values.edit ? { editedPayload: readEdit(values.edit) } : {}), ...(values.actor ? { actor: values.actor } : {}),
      }, {
        // Same safety default as the API and Discord: GitHub issues and Discord posts are dry runs unless ALLEVIA_ACTIONS_LIVE=1.
        tenant: tenant!, executors: { dryRun: !loadConfig().actionsLive },
        onLearned: (e) => console.log(`Learned: ${e.text} (${e.ruleId})`),
      });
      if (values.json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      if (r.alreadyDecided) console.log(`Already decided: ${r.approval.status}. Nothing done.`);
      else console.log(`${r.approval.id}: ${r.approval.status}${r.approval.firstPass ? " (first pass)" : ""}`);
      if (r.action) console.log(`Action ${r.action.id}: ${r.action.status}. ${r.action.result}`);
      if (r.metrics && !r.alreadyDecided) {
        const m = r.metrics;
        console.log(`First-pass rate (30 days): ${m.firstPassRate === null ? "n/a" : `${pct(m.firstPassRate, 0)} (${m.firstPass30d}/${m.decided30d})`} · learned rules: ${m.learnedRules} · approved: ${m.deliverablesApproved}`);
      }
      return r.approval.status === "failed" ? 1 : 0;
    },
  },
];
