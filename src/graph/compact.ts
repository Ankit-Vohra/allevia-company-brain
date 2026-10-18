// `graph:compact` (src/cli/compact.ts): phase 2 of keeping a business brain clean (docs/product-plan-after-hackathon.md §9).
// Three steps, each a dry run unless `apply` is set. With `apply`, everything a step removes is first written to an archive
// file (JSON lines, below), and `restoreArchive` puts it back exactly: compact then restore leaves the graph as it was,
// down to the export digest (tests/graph/compact.test.ts). The CLI also takes a checked tenant:export before any of it.
//
//   rollup   daily readings (Observations) older than `readingDays` (90) fold into one reading per subject, metric and
//            ISO week (Monday to Sunday): `obs:<metric>:<subject>:week:<monday>`, rollup "week". Its `value` is the mean
//            of the days (a typical day that week, so a chart or detector that mixes it with daily points stays on the
//            same scale) and it keeps sum, min, max, first, last and samples, so a total is still exact. It MEASURES the
//            same subject and is SOURCED_FROM the same documents, so the provenance survives. A week is left alone when:
//            any of its readings is pinned (something other than a Turn's TOUCHED points at it: an answer CITED it, a
//            recommendation is EVIDENCED_BY it, a decision is BASED_ON it), or it has one reading only, or the readings
//            disagree on the unit, or the week is not wholly older than the cut-off, or the reading covers more than a
//            day (windowStart <> windowEnd). The raw readings, their Versions and every link they had go to the archive.
//   chunks   passages that no current document holds: the chunks of a superseded or retired document, and the chunks a
//            document let go of when it was re-read (their HAS_CHUNK is closed). A chunk something cites is kept, and so
//            is one that was never held at all (an ingest in progress, or a bug worth looking at, not a delete).
//   closed   facts (edges) that ended more than `closedDays` (180) ago, and Versions whose state ended that long ago.
//            The current facts, and everything that ended recently, stay: "as of" questions inside that window still work.
//
// Archive file: one JSON object per line.
//   {"kind":"header","format":"allevia-archive","version":1,"graph":…,"steps":[…],"createdAt":…,"cutoffs":{…}}
//   {"kind":"node","l":[labels],"p":{props},"f":[float keys],"v":{vectorKey:[numbers]}}       a node removed
//   {"kind":"edge","t":type,"s":<source id>,"d":<target id>,"p":{props},"f":[float keys]}       a link removed
//   {"kind":"created","id":…}                                                                  a roll-up this run made
//   {"kind":"end","nodes":n,"edges":m,"created":k,"digest":sha256 of the lines above}
// Every node in Allevia carries an `id` (the Entity.id constraint), so links are stored by their ends' ids.
//
// Writes are batched UNWIND statements with params; labels and relationship types (which Cypher cannot take as params)
// are checked as plain identifiers before they go into the text.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { MAX_PAGE, type GraphHandle } from "./client.js";
import { metricKeyOf } from "./schema.js";
import { noteGraphWrite } from "./projection.js";

const DAY = 86_400_000;
export const COMPACT = { readingDays: 90, closedDays: 180, minWeekSamples: 2 } as const;
export const ROLLUP_SRC = "allevia:rollup";
export const ARCHIVE_FORMAT = "allevia-archive";
export const ARCHIVE_VERSION = 1;
export type Step = "rollup" | "chunks" | "closed";
export const STEPS: Step[] = ["rollup", "chunks", "closed"];

const READ = { timeoutMs: 60_000 };
const BATCH = 200;
const RESULT_CAP = 10_000; // RESULTSET_SIZE: a read that comes back this full may have been cut short
// Links into a reading or a chunk that do not pin it: the reading's own Versions, a Turn that looked at it, a document holding a chunk.
const SOFT_IN = ["TOUCHED", "HAS_CHUNK"];
// A reading's own outgoing links: what the roll-up re-creates (MEASURES, SOURCED_FROM) or archives with it (HAD_VERSION).
const OWN_OUT = ["MEASURES", "SOURCED_FROM", "HAD_VERSION"];
const RETIRED = ["superseded", "archived", "retired"];
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Prop = string | number | boolean | null | Prop[];
export interface ArchNode { kind: "node"; l: string[]; p: Record<string, Prop>; f: string[]; v: Record<string, number[]> }
export interface ArchEdge { kind: "edge"; t: string; s: string; d: string; p: Record<string, Prop>; f: string[] }

const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

function capped(rows: unknown[], what: string): void {
  if (rows.length >= RESULT_CAP) throw new Error(`${what} came back with ${rows.length} rows, the server's cap: refusing to act on a list that may be cut short`);
}

// ---------- reading what will be archived ----------

interface NodeRow { id: string; l: string[]; p: Record<string, unknown>; f: string[]; v: string[] }
interface EdgeRow { i: number; t: string; s: string | null; d: string | null; ok?: boolean; p: Record<string, unknown>; f: string[] }

const typed = (e: string): string =>
  `[k IN keys(${e}) WHERE typeOf(${e}[k]) = 'Float'] AS f, [k IN keys(${e}) WHERE typeOf(${e}[k]) = 'Vectorf32'] AS v`;

// The nodes with these ids, and every link that touches them (each once), as archive lines.
export async function collect(g: GraphHandle, ids: string[]): Promise<{ nodes: ArchNode[]; edges: ArchEdge[] }> {
  const nodes: ArchNode[] = [];
  const edges = new Map<number, ArchEdge>();
  for (const part of chunks(ids, BATCH)) {
    const rows = await g.roQuery<NodeRow>(
      `UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, labels(n) AS l, properties(n) AS p, ${typed("n")}`, { ids: part }, READ);
    for (const r of rows) {
      const v: Record<string, number[]> = {};
      const p: Record<string, Prop> = {};
      for (const [k, x] of Object.entries(r.p)) {
        if (r.v.includes(k)) v[k] = (x as number[]).map(Number);
        else p[k] = x as Prop;
      }
      nodes.push({ kind: "node", l: r.l, p, f: r.f.filter((k) => !r.v.includes(k)), v });
    }
    for (const dir of ["out", "in"] as const) {
      const pattern = dir === "out" ? "(n:Entity {id:id})-[r]->(x)" : "(x)-[r]->(n:Entity {id:id})";
      const ends = dir === "out" ? "n.id AS s, x.id AS d" : "x.id AS s, n.id AS d";
      // a link to a node outside Entity could not be put back by id, and DETACH DELETE would take it: refuse
      const er = await g.roQuery<EdgeRow>(
        `UNWIND $ids AS id MATCH ${pattern} WHERE ID(r) >= 0 RETURN id(r) AS i, type(r) AS t, ${ends}, 'Entity' IN labels(x) AS ok, properties(r) AS p, ${typed("r").split(", ")[0]}`,
        { ids: part }, READ);
      capped(er, "the links of the nodes to archive");
      for (const e of er) {
        if (e.s === null || e.d === null || e.ok === false) throw new Error(`a ${e.t} link touches a node outside Entity or without an id: it cannot be archived by id`);
        edges.set(e.i, { kind: "edge", t: e.t, s: e.s, d: e.d, p: e.p as Record<string, Prop>, f: e.f });
      }
    }
  }
  return { nodes, edges: [...edges.values()] };
}

// ---------- rollup ----------

interface ReadingRow {
  id: string; metric: string; subject: string; unit: string | null; value: number; asOf: string; src: string | null;
  conf: number | null; simulated: boolean | null; pins: number;
}

export interface WeekGroup {
  rollupId: string; metric: string; subject: string; unit: string | null; weekStart: string; weekEnd: string;
  readings: ReadingRow[]; existing: "none" | "same" | "other";
}

export interface RollupPlan {
  cutoff: string;                                   // readings dated before this day are old
  oldReadings: number;
  weeks: WeekGroup[];                               // the weeks that fold
  kept: { pinned: number; single: number; mixedUnits: number; partialWeek: number; rolledBefore: number };
}

// The Monday of the ISO week holding `day` (YYYY-MM-DD…), as YYYY-MM-DD.
export function weekStart(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`not a date: ${day}`);
  const back = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  return new Date(d.getTime() - back * DAY).toISOString().slice(0, 10);
}
const plusDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const rollupId = (metric: string, subject: string, monday: string): string => `obs:${metric}:${subject}:week:${monday}`;

export async function planRollup(g: GraphHandle, now: number, readingDays: number = COMPACT.readingDays): Promise<RollupPlan> {
  const cutoff = new Date(now - readingDays * DAY).toISOString().slice(0, 10);
  const rows: ReadingRow[] = [];
  // Paged on the internal id, not on o.id: on FalkorDB 6.0.2 a pattern with both labels, Entity:Observation, filtered on
  // Entity.id and on an indexed Observation property (asOf, subject, metric, metricKey) returns no rows at all
  // (docs/notes/falkordb-two-label-index-scan.md; tests/graph/two-label-index.test.ts).
  for (let after = -1; ;) {
    const page = await g.roQuery<ReadingRow & { i: number }>(
      `MATCH (o:Observation) WHERE id(o) > $after AND o.asOf < $cutoff AND o.rollup IS NULL
         AND (o.windowStart IS NULL OR o.windowStart = o.windowEnd)
       OPTIONAL MATCH (o)<-[pin]-() WHERE NOT type(pin) IN $softIn
       WITH o, count(pin) AS pinsIn
       OPTIONAL MATCH (o)-[out]->() WHERE NOT type(out) IN $ownOut
       WITH o, pinsIn, count(out) AS pinsOut
       RETURN id(o) AS i, o.id AS id, o.metric AS metric, o.subject AS subject, o.unit AS unit, o.value AS value, o.asOf AS asOf, o.src AS src,
              o.conf AS conf, o.simulated AS simulated, pinsIn + pinsOut AS pins ORDER BY i LIMIT $limit`,
      { after, cutoff, softIn: SOFT_IN, ownOut: OWN_OUT, limit: MAX_PAGE }, READ);
    rows.push(...page);
    if (page.length < MAX_PAGE) break;
    after = page[page.length - 1]!.i;
  }
  const plan: RollupPlan = { cutoff, oldReadings: rows.length, weeks: [], kept: { pinned: 0, single: 0, mixedUnits: 0, partialWeek: 0, rolledBefore: 0 } };
  const groups = new Map<string, ReadingRow[]>();
  for (const r of rows) {
    if (typeof r.value !== "number" || !r.metric || !r.subject || !r.asOf) { plan.kept.single++; continue; }
    const key = `${r.subject}\u0000${r.metric}\u0000${weekStart(r.asOf)}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const candidates: WeekGroup[] = [];
  for (const [key, readings] of [...groups].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [subject, metric, monday] = key.split("\u0000") as [string, string, string];
    const sunday = plusDays(monday, 6);
    const n = readings.length;
    if (sunday >= cutoff) { plan.kept.partialWeek += n; continue; }
    if (readings.some((r) => r.pins > 0)) { plan.kept.pinned += n; continue; }
    if (n < COMPACT.minWeekSamples) { plan.kept.single += n; continue; }
    if (new Set(readings.map((r) => r.unit ?? "")).size > 1) { plan.kept.mixedUnits += n; continue; }
    readings.sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : a.id < b.id ? -1 : 1));
    candidates.push({ rollupId: rollupId(metric, subject, monday), metric, subject, unit: readings[0]!.unit, weekStart: monday, weekEnd: sunday, readings, existing: "none" });
  }
  // A roll-up of that week may already exist: a run that stopped between writing it and removing the raw readings (it
  // lists them in rolledFrom, so finishing is safe), or readings that arrived late for a week rolled up before (kept).
  for (const part of chunks(candidates, BATCH)) {
    const have = await g.roQuery<{ id: string; from: string[] | null }>(
      "UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, n.rolledFrom AS from", { ids: part.map((c) => c.rollupId) }, READ);
    const byId = new Map(have.map((h) => [h.id, h.from ?? []]));
    for (const c of part) {
      const from = byId.get(c.rollupId);
      if (from === undefined) continue;
      c.existing = c.readings.every((r) => from.includes(r.id)) ? "same" : "other";
    }
  }
  for (const c of candidates) {
    if (c.existing === "other") plan.kept.rolledBefore += c.readings.length;
    else plan.weeks.push(c);
  }
  return plan;
}

interface RollupRow {
  id: string; metric: string; metricKey: string; subject: string; unit: string | null; name: string;
  value: number; sum: number; min: number; max: number; first: number; last: number; samples: number;
  windowStart: string; windowEnd: string; asOf: string; conf: number | null; simulated: boolean | null;
  rolledFrom: string[]; srcs: string[]; since: number;
}

function rollupRow(w: WeekGroup, subjectName: string): RollupRow {
  const vals = w.readings.map((r) => r.value);
  const sum = vals.reduce((s, x) => s + x, 0);
  const confs = w.readings.map((r) => r.conf).filter((c): c is number => typeof c === "number");
  return {
    id: w.rollupId, metric: w.metric, metricKey: metricKeyOf(w.metric), subject: w.subject, unit: w.unit,
    name: `${w.metric} of ${subjectName} (week of ${w.weekStart})`,
    value: sum / vals.length, sum, min: Math.min(...vals), max: Math.max(...vals), first: vals[0]!, last: vals[vals.length - 1]!,
    samples: vals.length, windowStart: w.weekStart, windowEnd: w.weekEnd, asOf: w.weekEnd,
    conf: confs.length ? Math.min(...confs) : null,
    simulated: w.readings.every((r) => r.simulated === true) ? true : null,
    rolledFrom: w.readings.map((r) => r.id),
    srcs: [...new Set(w.readings.map((r) => r.src).filter((s): s is string => !!s))].sort(),
    since: Date.parse(`${w.weekEnd}T00:00:00Z`),
  };
}

async function writeRollups(g: GraphHandle, weeks: WeekGroup[], now: number): Promise<string[]> {
  const fresh = weeks.filter((w) => w.existing === "none");
  const created: string[] = [];
  for (const part of chunks(fresh, BATCH)) {
    const names = await g.roQuery<{ id: string; name: string | null }>(
      "UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id, n.name AS name", { ids: [...new Set(part.map((w) => w.subject))] }, READ);
    const nameOf = new Map(names.map((x) => [x.id, x.name ?? x.id]));
    const rows = part.map((w) => rollupRow(w, nameOf.get(w.subject) ?? w.subject));
    // value, sum, min, max, first, last are Floats whatever the readings were (a mean of integers is not an integer)
    await g.query(
      `UNWIND $rows AS r MATCH (s:Entity {id: r.subject})
       CREATE (o:Entity:Observation {id: r.id})
       SET o.name = r.name, o.metric = r.metric, o.metricKey = r.metricKey, o.subject = r.subject, o.unit = r.unit,
           o.value = toFloat(r.value), o.sum = toFloat(r.sum), o.min = toFloat(r.min), o.max = toFloat(r.max),
           o.first = toFloat(r.first), o.last = toFloat(r.last), o.samples = r.samples, o.rollup = 'week', o.rolledFrom = r.rolledFrom,
           o.windowStart = r.windowStart, o.windowEnd = r.windowEnd, o.asOf = r.asOf, o.conf = r.conf, o.simulated = r.simulated,
           o.src = $src, o.createdAt = $now, o.updatedAt = $now, o.stateSince = $now, o.rev = 1
       CREATE (o)-[m:MEASURES {src: $src, asOf: r.asOf, since: r.since, recordedAt: $now}]->(s)
       RETURN count(m) AS c`,
      { rows, src: ROLLUP_SRC, now });
    // provenance: the documents the daily readings came from
    await g.query(
      `UNWIND $rows AS r UNWIND r.srcs AS src MATCH (o:Entity {id: r.id}), (d:Entity:Document {id: src})
       CREATE (o)-[e:SOURCED_FROM {src: $src, asOf: r.asOf, since: r.since, recordedAt: $now}]->(d) RETURN count(e) AS c`,
      { rows: rows.map((r) => ({ id: r.id, asOf: r.asOf, since: r.since, srcs: r.srcs })), src: ROLLUP_SRC, now });
    created.push(...rows.map((r) => r.id));
  }
  return created;
}

// ---------- chunks ----------

export interface ChunkPlan { total: number; prune: string[]; kept: { cited: number; neverHeld: number } }

export async function planChunks(g: GraphHandle): Promise<ChunkPlan> {
  const retired = new Set<string>();
  for (let after = ""; ;) {
    const page = await g.roQuery<{ id: string }>(
      `MATCH (d:Entity:Document) WHERE d.id > $after OPTIONAL MATCH (:Document)-[sp:SUPERSEDES]->(d) WHERE ID(sp) >= 0
       WITH d, count(sp) AS successors WHERE successors > 0 OR toLower(coalesce(d.status, '')) IN $retired
       RETURN d.id AS id ORDER BY id LIMIT $limit`, { after, retired: RETIRED, limit: MAX_PAGE }, READ);
    for (const r of page) retired.add(r.id);
    if (page.length < MAX_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  const plan: ChunkPlan = { total: 0, prune: [], kept: { cited: 0, neverHeld: 0 } };
  for (let after = ""; ;) {
    const page = await g.roQuery<{ id: string; docs: string[]; ever: number; pins: number }>(
      `MATCH (c:Entity:Chunk) WHERE c.id > $after
       OPTIONAL MATCH (d:Document)-[h:HAS_CHUNK]->(c) WHERE ID(h) >= 0
       WITH c, collect(CASE WHEN h.until IS NULL THEN d.id END) AS docs, count(h) AS ever
       OPTIONAL MATCH (c)<-[pin]-() WHERE NOT type(pin) IN $softIn
       WITH c, docs, ever, count(pin) AS pins
       RETURN c.id AS id, docs, ever, pins ORDER BY id LIMIT $limit`, { after, softIn: SOFT_IN, limit: MAX_PAGE }, READ);
    for (const c of page) {
      plan.total++;
      const unheld = c.docs.every((d) => retired.has(d)); // no holder, or only superseded / retired ones
      if (!unheld) continue;
      if (c.ever === 0) { plan.kept.neverHeld++; continue; }
      if (c.pins > 0) { plan.kept.cited++; continue; }
      plan.prune.push(c.id);
    }
    if (page.length < MAX_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  return plan;
}

// ---------- closed facts and old versions ----------

export interface ClosedPlan { before: number; edges: ArchEdge[]; versions: string[] }

export async function planClosed(g: GraphHandle, now: number, closedDays: number = COMPACT.closedDays): Promise<ClosedPlan> {
  const before = now - closedDays * DAY;
  const edges: ArchEdge[] = [];
  for (let after = -1; ;) {
    const page = await g.roQuery<EdgeRow>(
      `MATCH (a:Entity)-[r]->(b:Entity) WHERE ID(r) > $after AND r.until IS NOT NULL AND r.until < $before AND type(r) <> 'HAD_VERSION'
       RETURN id(r) AS i, type(r) AS t, a.id AS s, b.id AS d, properties(r) AS p, ${typed("r").split(", ")[0]} ORDER BY i LIMIT $limit`,
      { after, before, limit: MAX_PAGE }, READ);
    for (const e of page) {
      if (e.s === null || e.d === null) continue; // not addressable by id: left where it is
      edges.push({ kind: "edge", t: e.t, s: e.s, d: e.d, p: e.p as Record<string, Prop>, f: e.f });
    }
    if (page.length < MAX_PAGE) break;
    after = page[page.length - 1]!.i;
  }
  const versions: string[] = [];
  for (let after = ""; ;) {
    const page = await g.roQuery<{ id: string }>(
      "MATCH (v:Entity:Version) WHERE v.id > $after AND v.until IS NOT NULL AND v.until < $before RETURN v.id AS id ORDER BY id LIMIT $limit",
      { after, before, limit: MAX_PAGE }, READ);
    versions.push(...page.map((r) => r.id));
    if (page.length < MAX_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  return { before, edges, versions };
}

// ---------- the run ----------

export interface CompactOpts {
  steps?: Step[]; apply?: boolean; now?: number; readingDays?: number; closedDays?: number;
  archiveFile?: string;                      // required with apply
}

export interface CompactReport {
  graph: string; applied: boolean; archive: string | null;
  rollup?: { plan: RollupPlan; foldedReadings: number; created: number; versions: number };
  chunks?: { plan: ChunkPlan };
  closed?: { edges: number; versions: number; byType: Record<string, number>; before: number };
  removed: { nodes: number; edges: number };
}

const edgeKey = (e: ArchEdge): string => JSON.stringify([e.t, e.s, e.d, e.p]);

export async function compactGraph(g: GraphHandle, o: CompactOpts = {}): Promise<CompactReport> {
  const steps = o.steps ?? STEPS;
  const now = o.now ?? Date.now();
  if (o.apply && !o.archiveFile) throw new Error("apply needs an archive file: nothing is removed without a copy");
  if (o.archiveFile && existsSync(o.archiveFile)) throw new Error(`${o.archiveFile} already exists: an archive is never overwritten`);
  const report: CompactReport = { graph: g.name, applied: !!o.apply, archive: o.apply ? o.archiveFile! : null, removed: { nodes: 0, edges: 0 } };

  const removeNodes = new Set<string>();
  const removeEdges: ArchEdge[] = [];
  let weeks: WeekGroup[] = [];
  if (steps.includes("rollup")) {
    const plan = await planRollup(g, now, o.readingDays);
    weeks = plan.weeks;
    const readingIds = weeks.flatMap((w) => w.readings.map((r) => r.id));
    const versions: string[] = [];
    for (const part of chunks(readingIds, BATCH)) {
      versions.push(...(await g.roQuery<{ id: string }>(
        "UNWIND $ids AS id MATCH (o:Entity {id:id})-[h:HAD_VERSION]->(v:Entity:Version) WHERE ID(h) >= 0 RETURN DISTINCT v.id AS id", { ids: part }, READ)).map((r) => r.id));
    }
    for (const id of [...readingIds, ...versions]) removeNodes.add(id);
    report.rollup = { plan, foldedReadings: readingIds.length, created: weeks.filter((w) => w.existing === "none").length, versions: versions.length };
  }
  if (steps.includes("chunks")) {
    const plan = await planChunks(g);
    for (const id of plan.prune) removeNodes.add(id);
    report.chunks = { plan };
  }
  let closedVersions: string[] = [];
  if (steps.includes("closed")) {
    const plan = await planClosed(g, now, o.closedDays);
    closedVersions = plan.versions.filter((v) => !removeNodes.has(v));
    for (const id of closedVersions) removeNodes.add(id);
    const byType: Record<string, number> = {};
    for (const e of plan.edges) {
      if (removeNodes.has(e.s) || removeNodes.has(e.d)) continue; // goes with its node
      removeEdges.push(e);
      byType[e.t] = (byType[e.t] ?? 0) + 1;
    }
    report.closed = { edges: removeEdges.length, versions: closedVersions.length, byType, before: plan.before };
  }

  const archived = await collect(g, [...removeNodes]);
  const seen = new Set(archived.edges.map(edgeKey));
  const allEdges = [...archived.edges, ...removeEdges.filter((e) => !seen.has(edgeKey(e)))];
  report.removed = { nodes: archived.nodes.length, edges: allEdges.length };
  if (!o.apply) return report;

  // 1. the archive, before anything changes
  const created = weeks.filter((w) => w.existing === "none").map((w) => w.rollupId);
  writeArchive(o.archiveFile!, {
    graph: g.name, steps, createdAt: new Date(now).toISOString(),
    cutoffs: { readingsBefore: report.rollup?.plan.cutoff ?? null, closedBefore: report.closed?.before ?? null },
  }, archived.nodes, allEdges, created);
  // 2. the roll-ups (a week whose roll-up a stopped run already wrote is not written twice)
  if (weeks.length) await writeRollups(g, weeks, now);
  // 3. the removals: links on their own first (anchored by both ends, type and their own times), then nodes
  for (const [t, es] of groupBy(removeEdges, (e) => e.t)) {
    if (!IDENT.test(t)) throw new Error(`relationship type ${JSON.stringify(t)} is not a plain identifier`);
    for (const part of chunks(es, BATCH)) {
      await g.query(
        `UNWIND $rows AS row MATCH (a:Entity {id: row.s})-[r:${t}]->(b:Entity {id: row.d})
         WHERE r.until = row.until AND coalesce(r.since, -1) = row.since DELETE r`,
        { rows: part.map((e) => ({ s: e.s, d: e.d, until: e.p.until as number, since: (e.p.since as number | undefined) ?? -1 })) });
    }
  }
  for (const part of chunks([...removeNodes], BATCH)) {
    await g.query("UNWIND $ids AS id MATCH (n:Entity {id:id}) DETACH DELETE n", { ids: part });
  }
  await noteGraphWrite(g.name);
  return report;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

// ---------- the archive file ----------

export interface ArchiveHeader {
  kind: "header"; format: string; version: number; graph: string; steps: Step[]; createdAt: string;
  cutoffs: { readingsBefore: string | null; closedBefore: number | null };
}
export interface Archive { header: ArchiveHeader; nodes: ArchNode[]; edges: ArchEdge[]; created: string[] }

export function writeArchive(file: string, h: Omit<ArchiveHeader, "kind" | "format" | "version">, nodes: ArchNode[], edges: ArchEdge[], created: string[]): void {
  const lines = [
    JSON.stringify({ kind: "header", format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, ...h }),
    ...nodes.map((n) => JSON.stringify(n)), ...edges.map((e) => JSON.stringify(e)),
    ...created.map((id) => JSON.stringify({ kind: "created", id })),
  ];
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  lines.push(JSON.stringify({ kind: "end", nodes: nodes.length, edges: edges.length, created: created.length, digest }));
  writeFileSync(file, `${lines.join("\n")}\n`, { flag: "wx" });
}

export function readArchive(file: string): Archive {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const header = JSON.parse(lines[0] ?? "{}") as ArchiveHeader;
  if (header.format !== ARCHIVE_FORMAT || header.version !== ARCHIVE_VERSION) throw new Error(`${file} is not an ${ARCHIVE_FORMAT} v${ARCHIVE_VERSION} file`);
  const end = JSON.parse(lines[lines.length - 1] ?? "{}") as { kind: string; nodes: number; edges: number; created: number; digest: string };
  if (end.kind !== "end") throw new Error(`${file} is cut short (no end line)`);
  const body = lines.slice(0, -1);
  if (createHash("sha256").update(body.join("\n")).digest("hex") !== end.digest) throw new Error(`${file} does not match its digest`);
  const a: Archive = { header, nodes: [], edges: [], created: [] };
  for (const l of body.slice(1)) {
    const x = JSON.parse(l) as ArchNode | ArchEdge | { kind: "created"; id: string };
    if (x.kind === "node") a.nodes.push(x);
    else if (x.kind === "edge") a.edges.push(x);
    else if (x.kind === "created") a.created.push(x.id);
  }
  if (a.nodes.length !== end.nodes || a.edges.length !== end.edges || a.created.length !== end.created) throw new Error(`${file}: counts do not match its end line`);
  return a;
}

// ---------- restore ----------

export interface RestoreReport { graph: string; applied: boolean; nodes: number; nodesThere: number; edges: number; edgesSkipped: number; rollupsRemoved: number }

const check = (what: string, xs: string[]): void => {
  for (const x of xs) if (!IDENT.test(x)) throw new Error(`${what} ${JSON.stringify(x)} is not a plain identifier`);
};

// Puts back what an archive removed and takes out the roll-ups it made. A dry run unless `apply`. A node whose id is in the
// graph again is left as it is (counted in nodesThere); a link whose end is gone is skipped and counted. A restored archive
// gets a `<file>.restored` marker, and an archive with one is refused: links would otherwise come back twice.
export async function restoreArchive(g: GraphHandle, file: string, o: { apply?: boolean } = {}): Promise<RestoreReport> {
  const a = readArchive(file);
  if (a.header.graph !== g.name && !o.apply) { /* restoring into a copy is allowed: the header names the source */ }
  if (existsSync(`${file}.restored`)) throw new Error(`${file} was restored already (${file}.restored)`);
  const ids = a.nodes.map((n) => String(n.p.id));
  const there = new Set<string>();
  for (const part of chunks(ids, BATCH)) {
    for (const r of await g.peek<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids: part })) there.add(r.id);
  }
  const report: RestoreReport = { graph: g.name, applied: !!o.apply, nodes: 0, nodesThere: there.size, edges: 0, edgesSkipped: 0, rollupsRemoved: 0 };
  const toCreate = a.nodes.filter((n) => !there.has(String(n.p.id)));
  report.nodes = toCreate.length;
  if (!o.apply) {
    report.edges = a.edges.length;
    report.rollupsRemoved = a.created.length;
    return report;
  }
  // nodes, one statement per (labels, float keys, vector keys)
  for (const [, ns] of groupBy(toCreate, (n) => JSON.stringify([n.l, [...n.f].sort(), Object.keys(n.v).sort()]))) {
    const n0 = ns[0]!;
    const labels = n0.l.filter((l) => l !== "Entity");
    check("label", labels);
    check("property", [...n0.f, ...Object.keys(n0.v)]);
    const sets = [
      ...n0.f.map((k) => `n.${k} = toFloat(r.p.${k})`),
      ...Object.keys(n0.v).map((k) => `n.${k} = vecf32(r.v.${k})`),
    ];
    for (const part of chunks(ns, BATCH)) {
      await g.query(
        `UNWIND $rows AS r CREATE (n:Entity${labels.map((l) => `:${l}`).join("")} {id: r.id}) SET n += r.p${sets.length ? `, ${sets.join(", ")}` : ""}`,
        { rows: part.map((n) => ({ id: n.p.id, p: n.p, v: n.v })) });
    }
  }
  // links
  for (const [, es] of groupBy(a.edges, (e) => JSON.stringify([e.t, [...e.f].sort()]))) {
    const e0 = es[0]!;
    check("relationship type", [e0.t]);
    check("property", e0.f);
    const floats = e0.f.map((k) => `, e.${k} = toFloat(r.p.${k})`).join("");
    for (const part of chunks(es, BATCH)) {
      const [made] = await g.query<{ c: number }>(
        `UNWIND $rows AS r MATCH (a:Entity {id: r.s}), (b:Entity {id: r.d}) CREATE (a)-[e:${e0.t}]->(b) SET e += r.p${floats} RETURN count(e) AS c`,
        { rows: part.map((e) => ({ s: e.s, d: e.d, p: e.p })) });
      report.edges += made?.c ?? 0;
      report.edgesSkipped += part.length - (made?.c ?? 0);
    }
  }
  // the roll-ups this archive's run made
  for (const part of chunks(a.created, BATCH)) {
    const [r] = await g.query<{ c: number }>(
      "UNWIND $ids AS id MATCH (n:Entity {id:id}) WHERE n.rollup IS NOT NULL WITH n, n.id AS gone DETACH DELETE n RETURN count(gone) AS c", { ids: part });
    report.rollupsRemoved += r?.c ?? 0;
  }
  writeFileSync(`${file}.restored`, `${new Date().toISOString()} ${g.name}\n`, { flag: "wx" });
  await noteGraphWrite(g.name);
  return report;
}

// ---------- the report ----------

const n = (x: number): string => x.toLocaleString("en-US");

export function formatCompact(slug: string, r: CompactReport): string {
  const out = [`${slug} (${r.graph}): ${r.applied ? `applied, archive ${r.archive}` : "a dry run, nothing is changed (--apply to do it)"}`];
  if (r.rollup) {
    const p = r.rollup.plan;
    out.push(`  readings: ${n(p.oldReadings)} dated before ${p.cutoff}; ${n(r.rollup.foldedReadings)} fold into ${n(p.weeks.length)} weekly readings` +
      ` (${n(r.rollup.versions)} of their versions go too)`);
    const k = p.kept;
    out.push(`    kept as they are: ${n(k.pinned)} in weeks something cites, ${n(k.single)} alone in their week, ${n(k.partialWeek)} in a week that is not wholly old,` +
      ` ${n(k.mixedUnits)} with mixed units, ${n(k.rolledBefore)} that arrived after their week was rolled up`);
  }
  if (r.chunks) {
    const p = r.chunks.plan;
    out.push(`  passages: ${n(p.total)}; ${n(p.prune.length)} no current document holds go to the archive (kept: ${n(p.kept.cited)} cited, ${n(p.kept.neverHeld)} never held by a document)`);
  }
  if (r.closed) {
    const types = Object.entries(r.closed.byType).sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([t, c]) => `${t} ${n(c)}`).join(", ");
    out.push(`  closed facts that ended before ${new Date(r.closed.before).toISOString().slice(0, 10)}: ${n(r.closed.edges)}${types ? ` (${types})` : ""}; old versions: ${n(r.closed.versions)}`);
  }
  out.push(`  in all: ${n(r.removed.nodes)} things and ${n(r.removed.edges)} links ${r.applied ? "moved" : "would move"} to the archive` +
    `${r.rollup ? `, ${n(r.rollup.created)} weekly readings ${r.applied ? "added" : "would be added"}` : ""}`);
  return out.join("\n");
}
