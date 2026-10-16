// Can Allevia run on this FalkorDB server? Runs the product's own code against one graph holding the demo company
// (seedMini: an import of allevia_demo_seed) and prints a table: every agent read tool, vector and full-text search,
// impact_of at depth 1 and 4, find_paths (algo.SPpaths), PageRank and label propagation over projections, bi-temporal
// reads, the Brain page's graph-at-work route, the schema (indexes and UNIQUE/MANDATORY constraints), onboarding-style
// writes, the server-side timeouts, the query-shape plan check (GRAPH.EXPLAIN of every query this run sent), and the
// latency of typical queries. A failure is printed with the server's exact error (any URL credentials taken out).
//
//   npx tsx scripts/maint/db-compat.ts --url env:ALLEVIA_FALKORDB_CLOUD_URL --graph allevia_demo_seed [--writes] [--json out.json]
//
// Reads only, unless --writes: then it also writes into that graph (schema, a node, an edge, an observation, a closed
// edge, remember, propose_action), so --writes is refused for anything but allevia_demo_seed or an allevia_test_* graph.
// Re-import the demo afterwards (db:import … --replace) to put the copy back as it was. Projections the algorithms build
// (<graph>__cur_…) are dropped when the script ends.
import { writeFileSync } from "node:fs";
import { resolveUrl } from "../../src/cli/db-transfer.js";

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const url = resolveUrl(opt("--url") ?? "redis://127.0.0.1:6391");
const graph = opt("--graph") ?? "allevia_demo_seed";
const writes = args.includes("--writes");
const reps = Number(opt("--reps") ?? 7);
if (writes && graph !== "allevia_demo_seed" && !graph.startsWith("allevia_test_")) throw new Error("--writes only into allevia_demo_seed or an allevia_test_* graph");
process.env.ALLEVIA_FALKORDB_URL = url; // before anything reads the config: every module's default connection is this server

const { closeAll, connect, describeUrl, openGraphByName, redactUrl, setQueryObserver } = await import("../../src/graph/client.js");
const { ensureSchema, listIndexes } = await import("../../src/graph/indexes.js");
const { ALL_TOOLS } = await import("../../src/agent/tools/index.js");
const { TouchedSet } = await import("../../src/agent/tool.js");
const { upsertNode, upsertEdge, closeEdge, addObservation } = await import("../../src/graph/upsert.js");
const { moduleVersion } = await import("../../src/graph/transfer.js");
const { registerGraphWorkRoutes } = await import("../../src/server/routes/graph-work.js");
const { checkShapes, senderFile, callerFile, isProductFile } = await import("../../tests/helpers/query-shapes.js");
const { normalizeCypher } = await import("../../tests/helpers/plan-lint.js");
const { INTENTIONAL_SCANS } = await import("../../tests/helpers/intentional-scans.js");
const { fakeEmbed, SEED_NOW } = await import("../../tests/fixtures/seed-graph.js");
const { Hono } = await import("hono");

type Status = "ok" | "FAIL" | "note";
const rows: Array<{ area: string; what: string; status: Status; ms?: number; detail: string }> = [];
const clean = (s: string) => redactUrl(s, url).replace(/\s+/g, " ").slice(0, 700);
const shapes = new Map<string, string>();
setQueryObserver((q) => {
  if (shapes.has(q)) return;
  Error.stackTraceLimit = 30;
  // this script's own frames out: what is left starts at the product code that sent the query (if any did)
  const stack = (new Error().stack ?? "").split("\n").filter((l) => !l.includes("/scripts/maint/db-compat.ts")).join("\n");
  if (isProductFile(senderFile(stack))) shapes.set(q, callerFile(stack)!.replace(/^.*\/(src\/)/, "$1"));
});

async function check(area: string, what: string, fn: () => Promise<string | void>): Promise<void> {
  const t0 = performance.now();
  try {
    const detail = (await fn()) ?? "";
    rows.push({ area, what, status: detail.startsWith("NOTE") ? "note" : "ok", ms: Math.round(performance.now() - t0), detail: detail.replace(/^NOTE:? ?/, "") });
  } catch (e) {
    rows.push({ area, what, status: "FAIL", ms: Math.round(performance.now() - t0), detail: clean((e as Error).message) });
  }
}

const db = await connect(url);
const g = await openGraphByName(graph);
const conn = await db.connection;
const mod = await moduleVersion(db);
const memInfo = async () => Number(/used_memory:(\d+)/.exec(await conn.info("memory"))?.[1] ?? NaN);
console.log(`server ${describeUrl(url)}  module ${mod}  graph ${graph}  writes ${writes ? "yes" : "no"}`);

// ---------- server ----------
await check("server", "settings (GRAPH.CONFIG GET)", async () => {
  const cfg = Object.fromEntries(((await db.configGet("*")) as Array<[string, unknown]>).map(([k, v]) => [k, v]));
  const keys = ["THREAD_COUNT", "TIMEOUT_DEFAULT", "TIMEOUT_MAX", "MAX_QUEUED_QUERIES", "QUERY_MEM_CAPACITY", "CACHE_SIZE", "RESULTSET_SIZE"];
  return `NOTE ${keys.map((k) => `${k}=${cfg[k]}`).join(" ")}`;
});
await check("server", "memory", async () => {
  const used = await memInfo();
  const max = Number(/maxmemory:(\d+)/.exec(await conn.info("memory"))?.[1] ?? NaN);
  let graphMb = "";
  try { const m = (await conn.sendCommand(["GRAPH.MEMORY", "USAGE", graph])) as unknown[]; const at = (k: string) => m[m.indexOf(k) + 1]; graphMb = ` · GRAPH.MEMORY USAGE ${graph}: total ${at("total_graph_sz_mb")} MB, indexes ${at("indices_sz_mb")} MB`; } catch (e) { graphMb = ` · GRAPH.MEMORY: ${clean((e as Error).message)}`; }
  return `NOTE used ${(used / 1048576).toFixed(1)} MB of ${max ? (max / 1048576).toFixed(0) : "no limit"} MB${graphMb}`;
});

// ---------- schema ----------
await check("schema", "indexes present (range, full-text, vector)", async () => {
  const have = (await listIndexes(g)).map((i) => `${i.type} ${i.label}.${i.prop}`);
  for (const want of ["RANGE Entity.id", "FULLTEXT Searchable.name", "FULLTEXT Chunk.text", "VECTOR Searchable.embedding", "VECTOR Chunk.textEmbedding", "RANGE Observation.metricKey"]) {
    if (!have.includes(want)) throw new Error(`missing ${want} (have ${have.join(", ")})`);
  }
  return `${have.length} indexes`;
});
await check("schema", "UNIQUE + MANDATORY on Entity.id operational", async () => {
  const c = await g.constraints();
  const s = c.map((x) => `${x.type} ${x.label}.${x.props.join(",")} ${x.status}`);
  if (c.filter((x) => x.status === "OPERATIONAL").length < 2) throw new Error(s.join(", ") || "none");
  return s.join(", ");
});
if (writes) {
  await check("schema", "ensureSchema (migrate + indexes + constraints) re-run", async () => {
    const r = await ensureSchema(g);
    if (r.constraints.problems.length) throw new Error(r.constraints.problems.join("; "));
    return `labelled ${r.labelled}, metricKeys ${r.metricKeys}, constraints ${JSON.stringify(r.constraints.status)}`;
  });
  await check("schema", "UNIQUE rejects a duplicate id", async () => {
    try { await g.query("CREATE (:Entity:Task {id:'decision:007-pause-daily-stories', name:'dup'})"); } catch (e) { return clean((e as Error).message); }
    throw new Error("a duplicate id was accepted");
  });
  await check("schema", "MANDATORY rejects an Entity without id", async () => {
    try { await g.query("CREATE (:Entity:Task {name:'no id'})"); } catch (e) { return clean((e as Error).message); }
    throw new Error("a node without id was accepted");
  });
}

// ---------- the agents' tools ----------
const byName = new Map(ALL_TOOLS.map((t) => [t.name, t]));
const ctx = (over: Record<string, unknown> = {}) => ({
  graph: g, tenant: graph.replace(/^allevia_/, ""), turnId: "compat-1", agentId: "chief-of-staff", asker: "person:founder",
  touched: new TouchedSet(), now: SEED_NOW, embedQuery: async (t: string) => fakeEmbed(t), readOnly: !writes, ...over,
});
const { z } = await import("zod");
const CALLS: Array<[string, Record<string, unknown>]> = [
  ["search", { query: "instagram stories reels" }], ["get_entity", { id: "decision:007-pause-daily-stories" }],
  ["get_entity", { id: "system:ig-connector", asOf: "2026-09-15" }], ["neighbors", { id: "channel:instagram", depth: 2 }],
  ["find_paths", { from: "person:founder", to: "system:ig-connector" }], ["trace_decision", { query: "pause daily stories" }],
  ["who_owns", { id: "system:ig-connector" }], ["who_knows", { id: "channel:instagram" }],
  ["impact_of", { id: "system:ig-connector", depth: 1 }], ["impact_of", { id: "system:ig-connector", depth: 4 }],
  ["important", {}], ["topics", {}], ["metric_trend", { metric: "followers", subject: "channel:instagram" }], ["metric_trend", { metric: "signups" }],
  ["content_performance", {}], ["seo_report", {}], ["ad_report", {}], ["playbook", { topic: "hooks" }],
  ["history", { id: "task:fix-ig-token" }], ["history", { id: "system:ig-connector", asOf: "2026-09-01" }],
  ["recall", { ids: ["decision:007-pause-daily-stories"] }], ["recall", { query: "stories" }],
  ["cypher", { query: "MATCH (t:Task)<-[r:OWNS]-(o) RETURN t, r, o" }],
  ["get_brand_asset", {}], ["show_path", { ids: ["decision:007-pause-daily-stories", "channel:instagram", "system:ig-connector"] }],
];
for (const [name, a] of CALLS) {
  await check("tool", `${name} ${JSON.stringify(a)}`.slice(0, 90), async () => {
    const t = byName.get(name)!;
    const r = await t.run(z.object(t.input).parse(a) as never, ctx() as never);
    const d = r.data as Record<string, unknown>;
    if (d?.error) throw new Error(`tool error: ${String(d.error)}`);
    return `${r.nodes.length} nodes, ${r.edges.length} edges${r.note ? ` · ${r.note.slice(0, 80)}` : ""}`;
  });
}
await check("search", "vector index query (db.idx.vector.queryNodes)", async () => {
  const r = await g.roQuery<{ id: string }>("CALL db.idx.vector.queryNodes('Searchable', 'embedding', 5, vecf32($v)) YIELD node RETURN node.id AS id", { v: fakeEmbed("instagram stories") });
  if (!r.length) throw new Error("no hits");
  return r.map((x) => x.id).slice(0, 3).join(", ");
});
await check("search", "full-text query (db.idx.fulltext.queryNodes)", async () => {
  const r = await g.roQuery<{ id: string }>("CALL db.idx.fulltext.queryNodes('Searchable', 'instagram') YIELD node RETURN node.id AS id");
  if (!r.length) throw new Error("no hits");
  return `${r.length} hits`;
});
await check("route", "GET /api/:t/graph/at-work", async () => {
  const app = new Hono();
  registerGraphWorkRoutes(app as never, {
    tenantOf: async () => ({ reg: { slug: graph.replace(/^allevia_/, "") }, g }), refuseInPublicMode: () => undefined, publicMode: false,
    now: () => SEED_NOW, log: (l: string) => console.error(clean(l)),
  } as never);
  const res = await app.request(`/api/x/graph/at-work`);
  const d = (await res.json()) as { errors: string[]; focus: { id: string; deep: { total: number } } | null; important: unknown[]; groups: unknown[] };
  if (res.status !== 200 || d.errors.length) throw new Error(`status ${res.status} errors ${JSON.stringify(d.errors)}`);
  return `focus ${d.focus?.id} (deep ${d.focus?.deep.total}), ${d.important.length} important, ${d.groups.length} groups`;
});

// ---------- writes (onboarding-style) ----------
if (writes) {
  const now = Date.now();
  await check("write", "upsertNode (new Task with embedding)", async () => {
    const r = await upsertNode(g, { type: "Task", id: "task:compat-check", name: "Compat check", summary: "written by db-compat", embedding: fakeEmbed("compat"), src: "doc:compat" }, now);
    return JSON.stringify(r);
  });
  await check("write", "upsertNode again with a change (versioned)", async () => JSON.stringify(await upsertNode(g, { type: "Task", id: "task:compat-check", name: "Compat check", summary: "changed", props: { status: "doing" } }, now + 1)));
  await check("write", "upsertEdge (Person OWNS Task)", async () => JSON.stringify(await upsertEdge(g, { from: "person:founder", type: "OWNS", to: "task:compat-check" }, now + 2)));
  await check("write", "addObservation", async () => addObservation(g, { subject: "channel:instagram", metric: "followers", value: 1234.0, asOf: "2026-10-16", src: "doc:compat" } as never, now + 3));
  await check("write", "closeEdge (bi-temporal close)", async () => String(await closeEdge(g, "person:founder", "OWNS", "task:compat-check", now + 4, "compat")));
  await check("write", "remember tool", async () => {
    const t = byName.get("remember")!;
    const r = await t.run(z.object(t.input).parse({ text: "Compat check memory", kind: "fact", about: ["channel:instagram"] }) as never, ctx({ readOnly: false }) as never);
    if ((r.data as Record<string, unknown>).error) throw new Error(String((r.data as Record<string, unknown>).error));
    return `${r.nodes.length} nodes`;
  });
  await check("write", "propose_action tool", async () => {
    const t = byName.get("propose_action")!;
    const r = await t.run(z.object(t.input).parse({ title: "Compat check action", why: "checking writes", kind: "github_issue", payload: { body: "x" }, evidence: ["system:ig-connector"] }) as never, ctx({ readOnly: false }) as never);
    if ((r.data as Record<string, unknown>).error) throw new Error(String((r.data as Record<string, unknown>).error));
    return `${r.nodes.length} nodes`;
  });
  await check("write", "history sees the closed edge (bi-temporal read after write)", async () => {
    const r = await g.roQuery<{ until: number | null }>("MATCH (:Entity {id:'person:founder'})-[r:OWNS]->(:Entity {id:'task:compat-check'}) RETURN r.until AS until");
    if (!r.length || r[0]!.until == null) throw new Error(`edge not closed: ${JSON.stringify(r)}`);
    return `until set`;
  });
}

// ---------- timeouts ----------
// About 0.6 s on 6.0.2 locally with the demo graph (6 M paths; about 20x that on the free cloud tier): long enough to see a cut-off, short enough if there is none.
const HEAVY = "MATCH (a:Entity)-[*1..4]-(b:Entity) RETURN count(*) AS c";
await check("timeout", "per-query TIMEOUT on a heavy read (300 ms)", async () => {
  const t0 = performance.now();
  try {
    const r = await g.roQuery<{ c: number }>(HEAVY, {}, { timeoutMs: 300 });
    return `NOTE not cut off: finished in ${Math.round(performance.now() - t0)} ms with ${r[0]?.c} rows counted`;
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (/timed out/i.test((e as Error).message)) return `cut off after ${ms} ms: ${clean((e as Error).message)}`;
    throw e;
  }
});
await check("timeout", "TIMEOUT on a write (300 ms; 6.0.2 ignores it)", async () => {
  const t0 = performance.now();
  try {
    await g.query("MATCH (a:Entity)-[*1..4]-(b:Entity) WITH count(*) AS c WHERE c < 0 CREATE (:Entity:Task {id:'never-created'})", {}, { timeoutMs: 300 });
    return `NOTE not cut off: finished in ${Math.round(performance.now() - t0)} ms`;
  } catch (e) {
    return `cut off after ${Math.round(performance.now() - t0)} ms: ${clean((e as Error).message)}`;
  }
});

// ---------- the plan check ----------
await check("plans", "query-shape check (EXPLAIN every query this run sent)", async () => {
  const list = [...shapes].map(([q, file]) => ({ q: normalizeCypher(q), file }));
  // 4.x will not plan a query whose $params are unbound ("Missing parameters"), and plans `{id: null}` as a scan: bind each
  // to a stand-in of the kind its name suggests (a list for plurals and rows, a number for limits and times, else a string)
  const stand = (p: string) => (/s$|^rows$|^batch$/.test(p) ? "['x']" : /^(limit|cap|chain|n|k|depth|skip|asOf|since|until|now|at|after|from)$/.test(p) ? "1" : "'x'");
  const bound = (q: string) => {
    const ps = [...new Set([...q.matchAll(/\$([A-Za-z_]\w*)/g)].map((m) => m[1]!))];
    return ps.length ? `CYPHER ${ps.map((p) => `${p}=${stand(p)}`).join(" ")} ${q}` : q;
  };
  const r = await checkShapes((q) => g.explain(bound(q)), list, INTENTIONAL_SCANS);
  if (r.violations.length) throw new Error(`${r.violations.length} shapes scan despite an id anchor: ${r.violations.map((v) => `${v.q.slice(0, 120)} [${v.scans.join(", ")}]`).join(" | ")}`);
  if (r.unplannable > 0.1 * list.length) throw new Error(`${r.unplannable} of ${list.length} would not plan`);
  return `${r.checked} shapes planned, ${r.unplannable} not plannable (procedures/DDL), 0 violations`;
});

// ---------- latency ----------
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const LAT: Array<[string, () => Promise<unknown>]> = [
  ["ping", () => conn.ping()],
  ["get node by id", () => g.roQuery("MATCH (n:Entity {id:$id}) RETURN n.name AS name", { id: "system:ig-connector" })],
  ["count nodes", () => g.roQuery("MATCH (n) RETURN count(n) AS c")],
  ["search tool", () => byName.get("search")!.run({ query: "instagram stories reels" } as never, ctx() as never)],
  ["impact_of depth 4", () => byName.get("impact_of")!.run({ id: "system:ig-connector", depth: 4 } as never, ctx() as never)],
  ["metric_trend", () => byName.get("metric_trend")!.run({ metric: "followers", subject: "channel:instagram" } as never, ctx() as never)],
  ["important (PageRank, cached projection)", () => byName.get("important")!.run({} as never, ctx() as never)],
  ["find_paths", () => byName.get("find_paths")!.run({ from: "person:founder", to: "system:ig-connector" } as never, ctx() as never)],
];
const latency: Record<string, number> = {};
for (const [name, fn] of LAT) {
  await fn().catch(() => undefined); // warm (plan cache, projection)
  const xs: number[] = [];
  for (let i = 0; i < reps; i++) { const t0 = performance.now(); await fn(); xs.push(performance.now() - t0); }
  latency[name] = Math.round(median(xs) * 10) / 10;
}
await check("server", "memory after the run", async () => `NOTE used ${((await memInfo()) / 1048576).toFixed(1)} MB`);

// ---------- report ----------
for (const r of rows) console.log(`${r.status.padEnd(4)} ${r.area.padEnd(8)} ${r.what.padEnd(70)} ${String(r.ms ?? "").padStart(6)} ms  ${r.detail}`);
console.log("\nlatency (median of", reps, "ms):");
for (const [k, v] of Object.entries(latency)) console.log(`  ${k.padEnd(42)} ${v}`);
const failed = rows.filter((r) => r.status === "FAIL").length;
console.log(`\n${failed ? `${failed} FAILED` : "all passed"} (${rows.length} checks)`);
if (opt("--json")) writeFileSync(opt("--json")!, JSON.stringify({ module: mod, graph, rows, latency }, null, 2));
setQueryObserver(undefined);
await closeAll();
const left = (await (await connect(url)).list()).filter((n) => n.startsWith(`${graph}__`));
if (left.length) console.log(`projections left behind: ${left.join(", ")}`);
await closeAll();
process.exit(failed ? 1 : 0);
