// Brings the recorded copy of Shiftly (src/demo/recorded/shiftly-hero.jsonl) up to date with the Sales part of the seed
// (src/sales/demo.ts), WITHOUT re-running the four live answers. tests/demo/recorded.test.ts requires the copy to hold every entity the
// plain seed builds; when only the Sales demo changed, the answers do not (they are about sign-ups), so this swaps the Sales records:
//   1. seed a throwaway graph with the plain seed (seedGrowth: the same code `seed-demo` runs) and read it back;
//   2. in the copy, drop the old Sales demo records (Lead, Deal, Meeting, Message, their Versions and Persons, the two enquiry Channels)
//      and every edge on them, and add the records the plain seed builds now (every node the copy lacks, and the Sales nodes again),
//      with the edges that touch them. A Version's id carries a hash of the node as the server listed its properties, so the new
//      records are taken from a graph the seed built, not rebuilt on an imported one;
//   3. put back what the live answers touched (a Turn TOUCHED or CITED a lead or message): the same ids exist again;
//   4. write the copy, keeping the graph name in its header, with new counts and digest.
// A change to anything else in the seed (src/demo/growth.ts) needs scripts/maint/record-demo.mjs instead: this refuses when
// something other than the Sales demo points at the Sales records.
//
//   ALLEVIA_FALKORDB_URL=redis://127.0.0.1:6391 ALLEVIA_ENV_FILE=/dev/null npx tsx scripts/maint/refresh-recorded-sales.ts
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../src/config.js";
import { GraphHandle, closeAll, connect, openGraphByName } from "../../src/graph/client.js";
import { readDump, readGraph, summarize, writeDump, type EdgeLine, type NodeLine } from "../../src/graph/transfer.js";
import { seedGrowth } from "../../src/demo/growth.js";

const FILE = fileURLToPath(new URL("../../src/demo/recorded/shiftly-hero.jsonl", import.meta.url));
const url = loadConfig().falkordbUrl;
if (!/^redis:\/\/(127\.0\.0\.1|localhost|\[::1\]):/.test(url) || /:6390\b/.test(url)) throw new Error("refusing: run this against a throwaway local FalkorDB (not the real tenants' server)");

const SALES_LABELS = ["Lead", "Deal", "Meeting", "Message"];
const SALES_OF = /^(lead|deal|meeting|message):/;
const id = (n: NodeLine): string => String(n.p.id);
const isOldSales = (n: NodeLine): boolean =>
  n.l.some((l) => SALES_LABELS.includes(l))
  || (n.l.includes("Version") && SALES_OF.test(String(n.p.of ?? "")))
  || (n.l.includes("Person") && n.p.role === "lead")
  || (n.l.includes("Channel") && n.p.kind === "enquiry" && (n.p.id === "channel:email" || n.p.id === "channel:whatsapp"));

const old = readDump(FILE);
const oldIds = new Set(old.nodes.map(id));
const dropped = new Set(old.nodes.filter(isOldSales).map(id));

const name = `allevia_refresh_${Date.now().toString(36)}`;
const g = await openGraphByName(name);
try {
  await seedGrowth(g);
  const db = await connect(url);
  const fresh = await readGraph(new GraphHandle(name, db.selectGraph(name), db), db);
  const take = (n: NodeLine): boolean => !oldIds.has(id(n)) || isOldSales(n); // a node the copy lacks, or a Sales node made again

  // nodes: the copy without the old Sales records, then the nodes the seed builds now
  const nodes: NodeLine[] = old.nodes.filter((n) => !dropped.has(id(n)));
  const kept0 = nodes.length;
  const index = new Map<string, number>(nodes.map((n) => [id(n), n.i]));
  let next = Math.max(...old.nodes.map((n) => n.i), ...fresh.nodes.map((n) => n.i)) + 1;
  for (const n of fresh.nodes.filter(take)) {
    if (index.has(id(n))) throw new Error(`${id(n)} would be in the copy twice`);
    nodes.push({ ...n, i: next });
    index.set(id(n), next++);
  }

  // edges: untouched ones stay; what the live answers touched is put back on the new ids; the Sales edges come from the seed
  const oldAt = new Map(old.nodes.map((n) => [n.i, n]));
  const edges: EdgeLine[] = [];
  let kept = 0;
  const others: string[] = [];
  for (const e of old.edges) {
    const a = oldAt.get(e.s)!, b = oldAt.get(e.d)!;
    if (!dropped.has(id(a)) && !dropped.has(id(b))) { edges.push(e); continue; }
    if ((e.t === "TOUCHED" || e.t === "CITED") && a.l.includes("Turn") && index.has(id(b))) { edges.push({ ...e, d: index.get(id(b))! }); kept++; continue; }
    const salesOwn = (n: NodeLine) => dropped.has(id(n)) || id(n) === "agent:allevia-sales-lead" || id(n) === "business:shiftly";
    if (!(salesOwn(a) && salesOwn(b))) others.push(`${id(a)} ${e.t} ${id(b)}`);
  }
  if (others.length) throw new Error(`something other than the Sales demo points at the Sales records (${others.join(", ")}): record again with scripts/maint/record-demo.mjs`);
  const takenIds = new Set(fresh.nodes.filter(take).map(id));
  const freshIdAt = new Map(fresh.nodes.map((n) => [n.i, id(n)]));
  let addedEdges = 0;
  for (const e of fresh.edges) {
    const a = freshIdAt.get(e.s)!, b = freshIdAt.get(e.d)!;
    if (!takenIds.has(a) && !takenIds.has(b)) continue;
    if (!index.has(a) || !index.has(b)) throw new Error(`${a} ${e.t} ${b}: an end is not in the copy`);
    edges.push({ ...e, s: index.get(a)!, d: index.get(b)! });
    addedEdges++;
  }
  edges.forEach((e, k) => { e.i = k; });

  const summary = summarize(nodes, edges);
  const header = {
    ...old.header, exportedAt: new Date().toISOString(),
    labels: [...new Set([...old.header.labels, ...fresh.header.labels])], relTypes: [...new Set([...old.header.relTypes, ...fresh.header.relTypes])],
    counts: { nodes: nodes.length, edges: edges.length },
  };
  await writeDump({ header, nodes, edges, end: { kind: "end", nodes: nodes.length, edges: edges.length, digest: summary.digest } }, FILE);
  console.log(`dropped ${dropped.size} nodes of the old Sales demo, added ${nodes.length - kept0} nodes and ${addedEdges} edges from the seed, put back ${kept} edges from the answers' work logs: ` +
    `${old.nodes.length} nodes and ${old.edges.length} edges became ${nodes.length} nodes and ${edges.length} edges (digest ${summary.digest.slice(0, 12)})`);
} finally {
  await g.drop();
  await closeAll();
}
