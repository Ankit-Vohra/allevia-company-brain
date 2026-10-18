// `db:health [tenant…]`: one read-only look at the database and every business brain on it (src/graph/health.ts):
//   server  memory against its limit, the snapshot and the append log, settings that differ from server-config.ts;
//   per graph  things and links, its own memory, its size budget (business graphs), the best-linked nodes (a supernode is
//              flagged), indexes the schema wants that it lacks, and its slow log with each query's plan checked for scans.
// Nothing here writes. Exit code 1 when a business is over budget or the server reports a persistence problem.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { GraphHandle, connect, describeUrl, graphName, redactUrl } from "../graph/client.js";
import {
  assessBudget, brainBudget, graphCounts, graphMemoryMb, isSupernode, missingIndexes, readPersistence, slowQueries, topHubs,
  type Hub, type Persistence, type SlowQuery,
} from "../graph/health.js";
import { configDrift, readServerConfig, type ConfigDrift } from "../graph/server-config.js";
import { META_GRAPH } from "../graph/tenants.js";
import { referenceGraphName } from "../graph/reference.js";
import { assess, readMemory, type Assessment, type MemoryInfo } from "../graph/usage.js";
import type { IndexSpec } from "../graph/indexes.js";
import { resolveUrl } from "./db-transfer.js";
import type { Command } from "./_command.js";

export interface GraphHealth {
  graph: string; business: boolean; nodes: number; edges: number; mb: number | null;
  budget: ReturnType<typeof assessBudget> | null;
  hubs: Array<Hub & { supernode: boolean }>;
  missingIndexes: IndexSpec[];
  slow: SlowQuery[];
}
export interface Health {
  server: string; memory: MemoryInfo; limit: Assessment; persistence: Persistence; drift: ConfigDrift[]; graphs: GraphHealth[];
}

export async function readHealth(url: string, only: string[] = []): Promise<Health> {
  const db = await connect(url);
  const names = (await db.list()).filter((n) => !n.includes("__") && n.startsWith("allevia_") && !n.startsWith("allevia_test_"));
  const wanted = only.length ? only.map((t) => (t.startsWith("allevia_") ? t : graphName(t))) : names.sort();
  const memory = await readMemory(db);
  const envMb = Number(process.env.ALLEVIA_DB_LIMIT_MB);
  const health: Health = {
    server: describeUrl(url), memory, limit: assess(memory, Number.isFinite(envMb) && envMb > 0 ? { envMb } : {}),
    persistence: await readPersistence(db), drift: configDrift(await readServerConfig(db)), graphs: [],
  };
  const budget = brainBudget();
  for (const name of wanted) {
    if (!names.includes(name)) throw new Error(`no graph ${name} on ${describeUrl(url)}`);
    const g = new GraphHandle(name, db.selectGraph(name), db);
    const business = name !== META_GRAPH && name !== referenceGraphName();
    const counts = await graphCounts(g);
    const mb = await graphMemoryMb(db, name);
    const hubs = business ? (await topHubs(g)).map((h) => ({ ...h, supernode: isSupernode(h, counts.edges) })) : [];
    health.graphs.push({
      graph: name, business, ...counts, mb,
      budget: business ? assessBudget({ ...counts, mb }, budget) : null,
      hubs, missingIndexes: business ? await missingIndexes(g) : [], slow: await slowQueries(db, g),
    });
  }
  return health;
}

const n = (x: number): string => x.toLocaleString("en-US");
const pct = (x: number | null): string => (x === null ? "?" : `${x.toFixed(0)}%`);
const oneLine = (q: string, max = 110): string => { const s = q.replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export function formatHealth(h: Health): string {
  const out: string[] = [];
  const m = h.memory;
  out.push(`${h.server}: ${m.usedMb.toFixed(1)} MB used (peak ${m.peakMb?.toFixed(1) ?? "?"} MB), limit ${h.limit.limitMb === null ? "none set" : `${h.limit.limitMb} MB (${pct(h.limit.percent)}, ${h.limit.level})`}, eviction ${m.policy ?? "?"}`);
  const p = h.persistence;
  out.push(`  persistence: append log ${p.aof ? `on, ${p.aofMb?.toFixed(1) ?? "?"} MB (base ${p.aofBaseMb === null ? "?" : `${(p.aofBaseMb * 1024).toFixed(0)} KB`}, rewritten ${p.aofRewrites ?? "?"} times since start)` : "OFF"}; ` +
    `last snapshot ${p.lastSave === null ? "never" : new Date(p.lastSave).toISOString().slice(0, 16).replace("T", " ")} UTC ${p.rdbOk ? "ok" : "FAILED"}, ${p.unsaved ?? "?"} writes since`);
  for (const w of p.warnings) out.push(`  ! ${w}`);
  for (const d of h.drift) out.push(`  ! setting ${d.name} is ${d.have ?? "unset"}, the code expects ${d.want} (db:check)`);
  for (const g of h.graphs) {
    out.push("", `${g.graph}: ${n(g.nodes)} things, ${n(g.edges)} links, ${g.mb === null ? "?" : g.mb} MB`);
    if (g.budget) {
      out.push(`  budget: ${g.budget.map((b) => `${b.what} ${pct(b.percent)} of ${n(b.limit)}${b.what === "memory" ? " MB" : ""}${b.level === "ok" ? "" : ` (${b.level.toUpperCase()})`}`).join(", ")}`);
    }
    if (g.hubs.length) {
      out.push(`  best-linked: ${g.hubs.map((x) => `${x.id} ${n(x.degree)}${x.supernode ? " (SUPERNODE)" : ""}`).join(", ")}`);
      for (const x of g.hubs.filter((y) => y.supernode)) {
        out.push(`    ${x.id}: ${Object.entries(x.byType).slice(0, 6).map(([t, c]) => `${t} ${n(c)}`).join(", ")}`);
      }
    }
    if (g.missingIndexes.length) out.push(`  ! missing indexes: ${g.missingIndexes.map((i) => `${i.type} ${i.label}.${i.prop}`).join(", ")} (db:migrate adds them)`);
    if (g.slow.length) {
      out.push(`  slow log (${g.slow.length}, slowest first):`);
      for (const q of g.slow.slice(0, 5)) {
        const plan = q.scans === null ? "" : q.scans.length ? `  scans: ${[...new Set(q.scans)].join("; ")}` : "  plan: indexed";
        out.push(`    ${q.ms.toFixed(0)} ms ${new Date(q.at).toISOString().slice(0, 16).replace("T", " ")} ${oneLine(q.query)}${plan}`);
      }
    }
  }
  return out.join("\n");
}

export const commands: Command[] = [
  {
    name: "db:health",
    usage: "db:health [tenant…] [--on <url|env:NAME>] [--json]",
    summary: "Memory, persistence, and per business: size against its budget, supernodes, missing indexes and the slow log with plans (read-only)",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { on: { type: "string" }, json: { type: "boolean" } } });
      const url = resolveUrl(values.on ?? loadConfig().falkordbUrl);
      try {
        const h = await readHealth(url, positionals);
        console.log(values.json ? JSON.stringify(h, null, 1) : formatHealth(h));
        const bad = h.graphs.some((g) => g.budget?.some((b) => b.level === "over")) || !h.persistence.rdbOk || !h.persistence.aof;
        return bad ? 1 : 0;
      } catch (e) {
        console.error(`db:health: ${redactUrl((e as Error).message, url)}`);
        return 1;
      }
    },
  },
];
