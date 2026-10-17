// Brings the shipped demo recording up to the team's role names (shared/legacy-names.ts): every Agent node takes its
// roster name and summary, and every string the team wrote (answers, work logs, findings, reviews) says "Data Detective"
// where it said "Kabir". The business's own people keep their names. The end line's digest is recomputed, so readDump
// accepts the file. Idempotent: a second run changes nothing.
//   npx tsx scripts/maint/rename-recorded.ts [file]   (default: the hero recording)
import { RECORDED_HERO_FILE } from "../../src/cli/demo.js";
import { readDump, summarize, writeDump, type Prop } from "../../src/graph/transfer.js";
import { currentNames } from "../../shared/legacy-names.js";
import { agentById } from "../../shared/roster.js";

const file = process.argv[2] ?? RECORDED_HERO_FILE;
const dump = readDump(file);
// What the team wrote. Sales records (leads, deals, meetings, messages, the approvals and actions on them) are about
// customers, one of whom is called Arjun, so they are left alone, and so are the sales desk's own recommendations.
const TEAM_WRITTEN = ["Finding", "Recommendation", "Turn", "Session", "Document", "Agent"];

const renamed = (v: Prop): Prop => (typeof v === "string" ? currentNames(v) : Array.isArray(v) ? v.map(renamed) : v);
let changed = 0;
for (const n of dump.nodes) {
  const id = String(n.p.id ?? "");
  const staff = id.startsWith("agent:allevia-") ? agentById(id.slice("agent:allevia-".length)) : undefined;
  if (!staff && (!n.l.some((l) => TEAM_WRITTEN.includes(l)) || n.p.by === "sales-lead")) continue;
  const before = JSON.stringify(n.p);
  for (const [k, v] of Object.entries(n.p)) if (k !== "id" && !k.endsWith("mbedding")) n.p[k] = renamed(v);
  if (staff) n.p.name = staff.name;
  if (JSON.stringify(n.p) !== before) changed++;
}
for (const e of dump.edges) for (const [k, v] of Object.entries(e.p)) e.p[k] = renamed(v);
const s = summarize(dump.nodes, dump.edges);
dump.end = { kind: "end", nodes: s.nodes, edges: s.edges, digest: s.digest };
await writeDump(dump, file);
readDump(file); // the file reads back and its digest holds
console.log(`${file}: ${changed} nodes renamed`);
