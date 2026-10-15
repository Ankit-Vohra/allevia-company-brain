// Prints a saved `ask --json` run as a founder would read it: the plan, each desk's finding, each review verdict, the
// answer, and the automatic checks. Usage: npx tsx scripts/trials/show-run.ts <run.jsonl> [--full]
import { readFileSync } from "node:fs";

const [file] = process.argv.slice(2);
if (!file) throw new Error("usage: show-run.ts <run.jsonl>");
const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown> & { type: string });
for (const e of events) {
  switch (e.type) {
    case "plan": console.log(`PLAN: ${JSON.stringify(e.steps)}\n  why: ${e.rationale}`); break;
    case "finding": console.log(`\nFINDING by ${e.agent}:\n${e.text}\n  cites: ${JSON.stringify(e.citations)}`); break;
    case "review": console.log(`\nREVIEW by ${e.agent} on ${e.findingId}: ${e.verdict}: ${e.note}`); break;
    case "revision": console.log(`\nREVISION ${JSON.stringify(e).slice(0, 600)}`); break;
    case "proposal": console.log(`\nPROPOSAL ${JSON.stringify(e)}`); break;
    case "final": console.log(`\nFINAL ANSWER (${e.ms} ms, agents ${JSON.stringify(e.agents)}):\n${e.answer}\nCHECKS ${JSON.stringify(e.checks)}`); break;
    case "error": console.log(`ERROR ${e.message}`); break;
    default: break;
  }
}
console.log(`\nevent types: ${[...new Set(events.map((e) => e.type))].join(", ")}`);
