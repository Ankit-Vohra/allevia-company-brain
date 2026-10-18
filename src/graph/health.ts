// How healthy each business brain is, for `db:health` (src/cli/health.ts) and the hygiene report. Read-only: every query
// is GRAPH.RO_QUERY, GRAPH.EXPLAIN, GRAPH.SLOWLOG, GRAPH.MEMORY USAGE or INFO. Nothing here writes. The practices behind
// each check, and their sources, are in docs/falkordb-best-practices.md.
//   - budgets: each business graph has a size budget (things, links, MB). Warning from 80 percent, over at 100. The
//     number is a review trigger, not a hard stop: nothing refuses a write;
//   - supernodes: a node with thousands of links makes every traversal through it slow (FalkorDB expands all of a node's
//     links when a pattern passes through it). Readings are the usual cause: each one MEASURES its subject, so a channel
//     read daily for two years has 700+ links. graph:compact's weekly roll-up is the cure;
//   - the slow log: GRAPH.SLOWLOG keeps a graph's 10 slowest queries. Each is EXPLAINed again, and a plan that scans a
//     whole label (`Node By Label Scan`, `All Node Scan`) where an index could anchor it is named;
//   - indexes: the ones ensureSchema wants (indexes.ts) that the graph lacks;
//   - persistence: the snapshot (RDB) and the append log (AOF). An append log that was never rewritten replays every
//     write since the server started on a restart, which is slow and is how the Mac's server ended up restart-looping on
//     a corrupt log (docs/notes; the recovery runbook).
import type { FalkorDB } from "falkordb";
import type { GraphHandle } from "./client.js";
import { listIndexes, wantedIndexes, type IndexSpec } from "./indexes.js";
import { parseGraphMemory, parseInfo, WARN_AT, type Level } from "./usage.js";

const READ = { timeoutMs: 60_000 };

// ---------- budgets ----------

// One business brain at the $200 plan. Measured 18 Oct 2026: the biggest live business (aamdani) holds about 4,000 things,
// 17,000 links and 12 MB, two months in. A budget of six times that leaves years of normal growth once roll-ups and the
// archive run; a brain that reaches it is reviewed (what grew, and why), never cut off.
export const BRAIN_BUDGET = { nodes: 25_000, edges: 100_000, mb: 100 } as const;
export type Budget = { nodes: number; edges: number; mb: number };

// The budget, with ALLEVIA_BRAIN_BUDGET_NODES / _EDGES / _MB overriding each part.
export function brainBudget(env: NodeJS.ProcessEnv = process.env): Budget {
  const pick = (name: string, dflt: number): number => {
    const v = env[`ALLEVIA_BRAIN_BUDGET_${name}`];
    if (v === undefined || v === "") return dflt;
    const n = Number(v);
    if (!(Number.isFinite(n) && n > 0)) throw new Error(`ALLEVIA_BRAIN_BUDGET_${name} must be a number above 0, got ${v}`);
    return n;
  };
  return { nodes: pick("NODES", BRAIN_BUDGET.nodes), edges: pick("EDGES", BRAIN_BUDGET.edges), mb: pick("MB", BRAIN_BUDGET.mb) };
}

export interface BudgetLine { what: "things" | "links" | "memory"; have: number | null; limit: number; percent: number | null; level: Level }
export type BudgetLevel = Level | "over";

export function assessBudget(have: { nodes: number; edges: number; mb: number | null }, budget: Budget = brainBudget()): Array<Omit<BudgetLine, "level"> & { level: BudgetLevel }> {
  const line = (what: BudgetLine["what"], h: number | null, limit: number) => {
    if (h === null) return { what, have: h, limit, percent: null, level: "unknown" as BudgetLevel };
    const ratio = h / limit;
    return { what, have: h, limit, percent: ratio * 100, level: (ratio >= 1 ? "over" : ratio >= WARN_AT ? "warning" : "ok") as BudgetLevel };
  };
  return [line("things", have.nodes, budget.nodes), line("links", have.edges, budget.edges), line("memory", have.mb, budget.mb)];
}

export async function graphCounts(g: GraphHandle): Promise<{ nodes: number; edges: number }> {
  const [n] = await g.peek<{ c: number }>("MATCH (n) RETURN count(n) AS c", {}, READ);
  const [e] = await g.peek<{ c: number }>("MATCH ()-[r]->() WHERE ID(r) >= 0 RETURN count(r) AS c", {}, READ);
  return { nodes: n?.c ?? 0, edges: e?.c ?? 0 };
}

type Db = FalkorDB;

// The graph's own memory in MB (GRAPH.MEMORY USAGE's total_graph_sz_mb, whole MB), or null when the server will not say.
export async function graphMemoryMb(db: Db, graph: string): Promise<number | null> {
  try {
    return parseGraphMemory(await (await db.connection).sendCommand(["GRAPH.MEMORY", "USAGE", graph])).total_graph_sz_mb ?? null;
  } catch {
    return null;
  }
}

// ---------- supernodes ----------

// A node is a supernode from SUPERNODE.degree links, or when it holds SUPERNODE.share of all the graph's links (the Business
// itself is expected to be the biggest hub, and is reported like any other: a business with 5,000 OWNS links is worth a look).
export const SUPERNODE = { degree: 1_000, share: 0.1, top: 5 } as const;

export interface Hub { id: string; type: string; name: string; degree: number; byType: Record<string, number> }

// The `top` best-linked nodes (every link, current and closed, both directions), with their links by type.
export async function topHubs(g: GraphHandle, top: number = SUPERNODE.top): Promise<Hub[]> {
  const rows = await g.peek<{ id: string; labels: string[]; name: string | null; deg: number }>(
    `MATCH (n:Entity) OPTIONAL MATCH (n)-[r]-() WHERE ID(r) >= 0 WITH n, count(r) AS deg
     RETURN n.id AS id, labels(n) AS labels, n.name AS name, deg ORDER BY deg DESC, id LIMIT $top`, { top }, READ);
  if (!rows.length) return [];
  const split = await g.peek<{ id: string; t: string; c: number }>(
    `UNWIND $ids AS id MATCH (n:Entity {id:id})-[r]-() WHERE ID(r) >= 0 RETURN n.id AS id, type(r) AS t, count(r) AS c`,
    { ids: rows.map((r) => r.id) }, READ);
  return rows.map((r) => ({
    id: r.id, type: r.labels.find((l) => l !== "Entity" && l !== "Searchable") ?? "Entity", name: r.name ?? r.id, degree: r.deg,
    byType: Object.fromEntries(split.filter((s) => s.id === r.id).sort((a, b) => b.c - a.c || a.t.localeCompare(b.t)).map((s) => [s.t, s.c])),
  }));
}

export const isSupernode = (h: Hub, totalEdges: number): boolean =>
  h.degree >= SUPERNODE.degree || (totalEdges >= 1_000 && h.degree >= totalEdges * SUPERNODE.share);

// ---------- the slow log ----------

export interface SlowEntry { at: number; command: string; query: string; ms: number }

// GRAPH.SLOWLOG's reply: one [unix seconds, command, query, ms, params?] per entry (the params are left out: they can hold
// a person's name or email, and the query text is what EXPLAIN needs).
export function parseSlowlog(reply: unknown): SlowEntry[] {
  if (!Array.isArray(reply)) return [];
  return reply.filter(Array.isArray).map((e: unknown[]) => ({
    at: Number(e[0]) * 1000, command: String(e[1]), query: String(e[2]), ms: Number(e[3]),
  })).filter((e) => Number.isFinite(e.ms)).sort((a, b) => b.ms - a.ms || b.at - a.at);
}

export async function readSlowlog(db: Db, graph: string): Promise<SlowEntry[]> {
  try {
    return parseSlowlog(await (await db.connection).sendCommand(["GRAPH.SLOWLOG", graph]));
  } catch {
    return [];
  }
}

const SCANS = /\b(All Node Scan|Node By Label Scan)\b[^\n]*/;
// The operators of a plan that read a whole label (or every node). A label scan is fine where the query means to read every
// node of a kind (a count, the map, a health check); in a lookup it is a missing index or a missing Entity label.
export function planScans(plan: string[]): string[] {
  return plan.map((l) => SCANS.exec(l)?.[0]?.trim()).filter((x): x is string => !!x);
}

export interface SlowQuery extends SlowEntry { scans: string[] | null }

// The slow log, each query EXPLAINed (null where it cannot be: an index command, or a query this server will not plan).
export async function slowQueries(db: Db, g: GraphHandle): Promise<SlowQuery[]> {
  const out: SlowQuery[] = [];
  for (const e of await readSlowlog(db, g.name)) {
    let scans: string[] | null = null;
    if (/\b(MATCH|MERGE)\b/i.test(e.query)) {
      try {
        scans = planScans(await g.explain(e.query));
      } catch { /* not plannable on its own */ }
    }
    out.push({ ...e, scans });
  }
  return out;
}

// ---------- indexes ----------

export async function missingIndexes(g: GraphHandle, wanted: IndexSpec[] = wantedIndexes()): Promise<IndexSpec[]> {
  const have = new Set((await listIndexes(g)).map((i) => `${i.label}|${i.prop}|${i.type}`));
  return wanted.filter((w) => !have.has(`${w.label}|${w.prop}|${w.type}`));
}

// ---------- persistence ----------

export interface Persistence {
  aof: boolean;
  aofMb: number | null;
  aofBaseMb: number | null;
  aofRewrites: number | null;
  rdbOk: boolean;
  lastSave: number | null;        // ms
  unsaved: number | null;         // writes since the last snapshot
  warnings: string[];
}

const MB = 1_048_576;

// INFO persistence, read against what keeps a restart fast and a crash cheap. `now` is for the snapshot's age.
export function persistence(infoText: string, now: number = Date.now()): Persistence {
  const i = parseInfo(infoText);
  const num = (k: string): number | null => (i[k] === undefined || !Number.isFinite(Number(i[k])) ? null : Number(i[k]));
  const aof = i.aof_enabled === "1";
  const aofBytes = num("aof_current_size");
  const baseBytes = num("aof_base_size");
  const lastSave = num("rdb_last_save_time");
  const p: Persistence = {
    aof, aofMb: aofBytes === null ? null : aofBytes / MB, aofBaseMb: baseBytes === null ? null : baseBytes / MB,
    aofRewrites: num("aof_rewrites"), rdbOk: (i.rdb_last_bgsave_status ?? "ok") === "ok",
    lastSave: lastSave === null ? null : lastSave * 1000, unsaved: num("rdb_changes_since_last_save"), warnings: [],
  };
  if (!aof) p.warnings.push("no append log: a crash loses every write since the last snapshot");
  if (!p.rdbOk) p.warnings.push("the last snapshot failed (rdb_last_bgsave_status): check the disk and the server log");
  if (aof && aofBytes !== null && baseBytes !== null && aofBytes > 16 * MB && aofBytes > 4 * Math.max(baseBytes, 1)) {
    p.warnings.push(`the append log is ${(aofBytes / MB).toFixed(0)} MB on a ${(baseBytes / 1024).toFixed(0)} KB base: a restart replays every ` +
      "write since it began. BGREWRITEAOF folds it into a snapshot (one command, read-safe, run it off-peak)");
  }
  if (p.lastSave !== null && now - p.lastSave > 24 * 3_600_000) p.warnings.push("no snapshot in over a day");
  return p;
}

export async function readPersistence(db: Db, now?: number): Promise<Persistence> {
  return persistence(String(await (await db.connection).info("persistence")), now);
}
