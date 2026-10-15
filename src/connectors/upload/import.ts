// The owner confirmed what the columns are: write the numbers. Everything that makes this safe to run twice, or with a
// corrected file, or next to a live connector, is here:
//   - the upload is a Document (kind 'upload', id from the file's hash) and every number is an Observation with that
//     Document as its source (SOURCED_FROM), accessMode 'upload' (the ladder reads the Document's kind) and the real dates
//     the rows cover (windowStart..windowEnd); asOf is the day it was uploaded;
//   - the same file again changes nothing (same hash, same Document, answered "already added");
//   - a corrected file supersedes: a number with the same metric and window is updated (the old value stays as a Version),
//     a number the new file no longer has inside the dates it covers is retired (its MEASURES and SOURCED_FROM edges are
//     closed, not deleted), and an earlier file left with nothing current is marked replaced;
//   - uploaded numbers have conf 0.9 ("reported"), so a connector's reading (conf 1) for the same day always wins and is
//     never overwritten (the writer skips the weaker one, and it is counted as left alone);
//   - the file is parsed under hard caps, the privacy filter runs on every header and cell before anything is read
//     further, and what is stored (file name, headers in the evidence) goes through the redaction filter;
//   - one import at a time per tenant graph.
// Then the goals and the ladder are brought up to date (settleGoals, syncCapabilities).
import { createHash } from "node:crypto";
import { deriveCapabilities, findBusiness, syncCapabilities } from "../../capabilities/ladder.js";
import type { GraphHandle } from "../../graph/client.js";
import { closeEdge, upsertEdge, upsertNode, writeBatch, type NodeInput, type ObservationInput } from "../../graph/upsert.js";
import { redact } from "../../ingest/redact.js";
import { longDate, shortDate } from "../../insights/text.js";
import { localDate, regionOf } from "../../onboard/region.js";
import { goalPulse, STATUS_TEXT } from "../../insights/brief.js";
import { currentProgram, programGoals } from "../../program/program.js";
import { settleGoals } from "../../program/late.js";
import { entityId } from "../../util/ids.js";
import { buildSeries, previewTable } from "./analyse.js";
import { MAX_VALUES, UploadError, num } from "./limits.js";
import { customKey, metricByKey, type MetricDef } from "./metrics.js";
import { letterOf } from "./letters.js";
import { readTable } from "./table.js";
import type { SeriesPoint, UploadPlan } from "./types.js";

export const UPLOAD_CONF = 0.9;
export const UPLOAD_DOC_PREFIX = "document:upload-";

export interface ImportInput {
  g: GraphHandle;
  businessId: string;
  fileName: string;
  bytes: Uint8Array;
  plan: UploadPlan;
  now: number;
}

export interface GoalOutcome {
  id: string;
  name: string;
  unit: string | null;
  period: "week" | "month";
  current: number | null;
  baseline: number | null;
  target: number | null;
  status: string;               // the owner's words (STATUS_TEXT)
  sentence: string;
  newlyMeasured: boolean;       // read "We'll know after your first full week" before this file
}

export interface ImportResult {
  status: "imported" | "already_added" | "replaced_earlier";
  documentId: string;
  fileName: string;
  from: string | null;
  to: string | null;
  written: number;              // numbers stored (new or corrected)
  corrected: number;            // of those, numbers that replaced an earlier value
  retired: number;              // earlier numbers this file no longer has, inside the dates it covers
  leftAlone: number;            // days a connected account already reads, kept as they were
  leftOut: { today: number; negatives: number };
  metrics: Array<{ key: string; label: string; count: number }>;
  goals: GoalOutcome[];
  capabilities: Array<{ key: string; name: string; from: string; to: string }>;
  sentences: string[];
}

const locks = new Map<string, Promise<unknown>>();
export async function withTenantLock<T>(graph: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(graph) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(graph, run);
  try { return await run; } finally { if (locks.get(graph) === run) locks.delete(graph); }
}

const safeName = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const t = redact(base.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).text;
  return (t.length > 100 ? `${t.slice(0, 97)}...` : t) || "your file";
};

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const plural = (n: number, one: string, many = `${one}s`): string => `${num(n)} ${n === 1 ? one : many}`;
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

interface Subject { id: string; name: string }
const subjectOf = (def: MetricDef | undefined, businessId: string): Subject => (!def || def.subject === "business" ? { id: businessId, name: "" } : def.subject);

// Plan checks that keep a silent guess out: every number column the file has is answered, nothing is unnamed, no two
// columns share a metric (they would be added together without anyone saying so).
function checkPlan(t: ReturnType<typeof readTable>, plan: UploadPlan, asked: number[]): void {
  if (plan.cadence === null) throw new UploadError("Tell us whether each row is a day, a week or a month, then send it again.", "needs_answer");
  const seen = new Map<string, number>();
  for (const c of plan.columns) {
    if (!Number.isInteger(c.index) || c.index < 0 || c.index >= t.headers.length || c.index === plan.dateColumn) throw new UploadError("That plan doesn't match the file. Start again from the file.", "bad_plan");
    if (c.metric === null) throw new UploadError(`Tell us what column ${letterOf(c.index)} (“${t.headers[c.index] || "no title"}”) is, or leave it out.`, "needs_answer");
    if (c.metric === "other" && !(c.label ?? "").trim()) throw new UploadError(`Give column ${letterOf(c.index)} a name, or leave it out.`, "needs_answer");
    if (c.metric === "skip") continue;
    if (c.metric !== "other" && !metricByKey(c.metric)) throw new UploadError(`We don't know what “${c.metric}” is. Pick one from the list for column ${letterOf(c.index)}.`, "bad_plan");
    const key = c.metric === "other" ? customKey(c.label!) : c.metric;
    if (seen.has(key)) throw new UploadError(`Columns ${letterOf(seen.get(key)!)} and ${letterOf(c.index)} are both “${metricByKey(key)?.label ?? c.label}”. Pick a different one for one of them, or leave it out.`, "bad_plan");
    seen.set(key, c.index);
  }
  for (const i of asked) {
    if (!plan.columns.some((c) => c.index === i)) throw new UploadError(`Tell us what column ${letterOf(i)} (“${t.headers[i] || "no title"}”) is, or leave it out.`, "needs_answer");
  }
  if (![...seen].length) throw new UploadError("Every column was left out, so there is nothing to keep. Pick what at least one column is.", "needs_answer");
}

export interface BizFacts { timeZone?: string; currency?: string; countryCode?: string }
export async function businessFacts(g: GraphHandle, id: string): Promise<BizFacts> {
  const [b] = await g.roQuery<{ tz: string | null; cur: string | null; cc: string | null; country: string | null }>(
    "MATCH (b:Entity:Business {id:$id}) RETURN b.timeZone AS tz, b.currency AS cur, b.countryCode AS cc, b.country AS country", { id });
  const cc = b?.cc ?? regionOf(b?.country)?.countryCode;
  return { ...(b?.tz ? { timeZone: b.tz } : {}), ...(b?.cur ? { currency: b.cur } : {}), ...(cc ? { countryCode: cc } : {}) };
}

export async function importNumbers(i: ImportInput): Promise<ImportResult> {
  return withTenantLock(i.g.name, () => run(i));
}

async function run({ g, businessId, fileName, bytes, plan, now }: ImportInput): Promise<ImportResult> {
  const table = readTable(bytes, fileName);
  const facts = await businessFacts(g, businessId);
  const today = localDate(now, facts.timeZone);
  // the privacy filter and the plan checks both run on the table the file actually holds, not on what the client says
  const asked = previewTable(table, { fileName, fileHash: "", ...(facts.countryCode ? { country: facts.countryCode } : {}) }).columns.map((c) => c.index);
  checkPlan(table, plan, asked);
  const series = buildSeries(table, plan, facts.countryCode);

  const hash = sha(bytes);
  const documentId = `${UPLOAD_DOC_PREFIX}${hash.slice(0, 12)}`;
  const name = safeName(fileName);
  const [have] = await g.roQuery<{ status: string | null }>("MATCH (d:Entity:Document {id:$id}) RETURN d.status AS status LIMIT 1", { id: documentId });
  if (have) {
    const replaced = have.status === "replaced";
    const result = await settle(g, businessId, now, new Map());
    return {
      status: replaced ? "replaced_earlier" : "already_added", documentId, fileName: name, from: series.from, to: series.to, written: 0, corrected: 0, retired: 0, leftAlone: 0,
      leftOut: { today: 0, negatives: series.negatives }, metrics: [], goals: result.goals, capabilities: result.capabilities,
      sentences: [replaced
        ? `You sent this file before, and a newer file has replaced its numbers since. We left the newer numbers as they are. If you want these back, change one number in the file and send it again.`
        : `You already added this file, so nothing changed.`],
    };
  }

  // only days that are over count: a number for today is not final
  const kept: SeriesPoint[] = series.points.filter((p) => p.windowEnd < today);
  const leftToday = series.points.length - kept.length;
  if (!kept.length) {
    throw new UploadError("Every row in this file is for today or later, and a day only counts once it is over. Add earlier rows, or send it again tomorrow.", "future_only");
  }
  if (kept.length > MAX_VALUES) {
    throw new UploadError(`That is more numbers than we take in one go (${num(MAX_VALUES)}). Send fewer columns, or just the last year or so.`, "too_many_values");
  }

  const currency = facts.currency ?? "";
  const defs = new Map<string, MetricDef | undefined>(kept.map((p) => [p.metric, metricByKey(p.metric)]));
  const subjects = new Map<string, Subject>();
  for (const [key, def] of defs) subjects.set(key, subjectOf(def, businessId));
  const unitOf = (key: string): string | undefined => {
    const u = defs.get(key)?.unit;
    return u === "currency" ? (currency || "money") : u;
  };

  // channels the numbers are about, created only when the graph has none (an existing channel is never renamed)
  const channelIds = [...new Set([...subjects.values()].filter((s) => s.id !== businessId).map((s) => s.id))];
  const haveChannels = new Set((channelIds.length ? await g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (c:Entity:Channel {id:id}) RETURN c.id AS id", { ids: channelIds }) : []).map((r) => r.id));
  const nodes: NodeInput[] = [];
  for (const s of new Map([...subjects.values()].map((x) => [x.id, x])).values()) {
    if (s.id !== businessId && !haveChannels.has(s.id)) nodes.push({ type: "Channel", id: s.id, name: s.name });
  }

  const metricsUsed = [...new Set(kept.map((p) => p.metric))];
  const labels = new Map(kept.map((p) => [p.metric, p.label]));
  nodes.push({
    type: "Document", id: documentId, name: `Numbers you uploaded: ${name}`.slice(0, 160),
    summary: `Numbers from ${name}: ${list(metricsUsed.map((k) => labels.get(k)!.toLowerCase()))}, ${shortDate(series.from!)} to ${longDate(series.to!)}.`.slice(0, 400),
    props: {
      kind: "upload", filename: name, rows: series.rowCount, firstDate: series.from!, lastDate: series.to!, uploadedAt: now, hash, status: "active",
      metrics: metricsUsed, ...(table.sheet ? { sheet: redact(table.sheet).text.slice(0, 60) } : {}),
    },
    asOf: today,
  });

  const observations: ObservationInput[] = kept.map((p) => {
    const unit = unitOf(p.metric);
    return {
      subject: subjects.get(p.metric)!.id, metric: p.metric, value: p.value, ...(unit ? { unit } : {}), windowStart: p.windowStart, windowEnd: p.windowEnd,
      asOf: today, src: documentId, conf: UPLOAD_CONF,
      evidence: redact(`From your file “${name}”, column “${p.header}”.`).text.slice(0, 300),
    };
  });
  const idOf = (o: ObservationInput) => `obs:${o.metric}:${o.subject}:${o.windowEnd}`;
  const newIds = new Set(observations.map(idOf));

  // what this file replaces: earlier uploads' numbers (same metric and subject) inside the dates this file covers, and the
  // numbers it re-sources (same id, another file)
  const before = await capabilityModes(g, businessId, now);
  const retire: Array<{ id: string; subject: string; src: string }> = [];
  const resourced = new Map<string, string>(); // id -> the earlier file
  const groups = new Map<string, { metric: string; subject: string; from: string; to: string }>();
  for (const o of observations) {
    const k = `${o.metric}|${o.subject}`;
    const gr = groups.get(k);
    if (!gr) groups.set(k, { metric: o.metric, subject: o.subject, from: o.windowStart!, to: o.windowEnd! });
    else { if (o.windowStart! < gr.from) gr.from = o.windowStart!; if (o.windowEnd! > gr.to) gr.to = o.windowEnd!; }
  }
  for (const gr of groups.values()) {
    const rows = await g.roQuery<{ id: string; src: string | null }>(
      `MATCH (o:Observation)-[m:MEASURES]->(s:Entity {id:$subject})
       WHERE o.metric = $metric AND m.until IS NULL AND o.src STARTS WITH $prefix AND o.src <> $doc AND o.windowStart >= $from AND o.windowEnd <= $to
       RETURN o.id AS id, o.src AS src ORDER BY o.id LIMIT 25000`,
      { subject: gr.subject, metric: gr.metric, prefix: UPLOAD_DOC_PREFIX, doc: documentId, from: gr.from, to: gr.to });
    for (const r of rows) {
      if (!r.src) continue;
      if (newIds.has(r.id)) resourced.set(r.id, r.src);
      else retire.push({ id: r.id, subject: gr.subject, src: r.src });
    }
  }
  // a number this file writes that exists from another source: from a connector (conf 1) it stays, as measured
  const existing = new Map<string, { src: string | null; conf: number | null; value: number | null }>();
  for (const part of chunks([...newIds], 1000)) {
    const rows = await g.roQuery<{ id: string; src: string | null; conf: number | null; value: number | null }>(
      "UNWIND $ids AS id MATCH (o:Entity:Observation {id:id}) RETURN o.id AS id, o.src AS src, o.conf AS conf, o.value AS value", { ids: part });
    for (const r of rows) existing.set(r.id, { src: r.src, conf: r.conf, value: r.value });
  }
  const leftAlone = observations.filter((o) => { const e = existing.get(idOf(o)); return e && (e.conf ?? 1) > UPLOAD_CONF; }).length;
  const corrected = observations.filter((o) => { const e = existing.get(idOf(o)); return e && (e.conf ?? 1) <= UPLOAD_CONF && e.value !== null && Math.abs(e.value - o.value) > 1e-9; }).length;

  const stats = await writeBatch(g, { nodes, observations }, now);
  if (stats.errors.length) throw new Error(`upload: ${stats.errors[0]!.error}`);

  // the earlier file's links to a number this file now owns, and the numbers it dropped, are closed (never deleted)
  for (const [id, src] of resourced) {
    await closeEdge(g, id, "SOURCED_FROM", src, now, "replaced by a corrected upload");
  }
  for (const r of retire) {
    await closeEdge(g, r.id, "MEASURES", r.subject, now, "left out of a corrected upload");
    await closeEdge(g, r.id, "SOURCED_FROM", r.src, now, "left out of a corrected upload");
  }
  // a number retired by an earlier file and given again now is current again
  const bySubject = new Map(observations.map((o) => [idOf(o), o.subject]));
  for (const part of chunks([...newIds], 1000)) {
    const rows = await g.roQuery<{ id: string; open: number }>(
      `UNWIND $ids AS id MATCH (o:Entity:Observation {id:id}) OPTIONAL MATCH (o)-[m:MEASURES]->(:Entity) WHERE m.until IS NULL
       RETURN o.id AS id, count(m) AS open`, { ids: part });
    for (const r of rows) {
      const e = existing.get(r.id);
      if (r.open > 0 || !bySubject.has(r.id) || (e && (e.conf ?? 1) > UPLOAD_CONF)) continue;
      await upsertEdge(g, { from: r.id, type: "MEASURES", to: bySubject.get(r.id)!, src: documentId, asOf: today, since: now, conf: UPLOAD_CONF }, now);
    }
  }
  // earlier files with nothing current left
  const touched = [...new Set([...resourced.values(), ...retire.map((r) => r.src)])];
  for (const src of touched) {
    // numbers about the business, not the goal readings and baselines that were worked out from the file (those keep it as their source)
    const [c] = await g.roQuery<{ c: number }>(
      `MATCH (d:Entity:Document {id:$id}) WITH d
       MATCH (o:Observation)-[s:SOURCED_FROM]->(d) WHERE s.until IS NULL AND coalesce(o.baseline, false) = false WITH o
       MATCH (o)-[m:MEASURES]->(t:Entity) WHERE m.until IS NULL AND NOT t:Goal RETURN count(m) AS c`, { id: src });
    if ((c?.c ?? 0) === 0) {
      const [d] = await g.roQuery<{ name: string }>("MATCH (d:Entity:Document {id:$id}) RETURN d.name AS name", { id: src });
      if (d) await upsertNode(g, { type: "Document", id: src, name: d.name, props: { status: "replaced", replacedBy: documentId, replacedAt: now } }, now);
    }
  }

  const after = await settle(g, businessId, now, before);
  const metrics = metricsUsed.map((key) => ({ key, label: labels.get(key)!, count: kept.filter((p) => p.metric === key).length }));
  const written = observations.length - leftAlone;
  const periods = new Set(kept.map((p) => p.windowEnd)).size;
  const sentences: string[] = [
    `Added ${list(metrics.map((m) => m.label.toLowerCase()))} for ${plural(periods, periodWord(plan))}, ${shortDate(series.from!)} to ${longDate(series.to!)}.`,
  ];
  if (corrected) sentences.push(`${plural(corrected, "number")} replaced an earlier value, and the earlier value is kept in the history.`);
  if (retire.length) sentences.push(`${plural(retire.length, "earlier number")} from a previous file ${retire.length === 1 ? "is" : "are"} no longer in this one, so we stopped using ${retire.length === 1 ? "it" : "them"}.`);
  if (leftAlone) sentences.push(`${plural(leftAlone, "day")} ${leftAlone === 1 ? "is" : "are"} already read straight from a connected account, so we kept those as they were.`);
  if (leftToday) sentences.push(`${plural(leftToday, "number")} for today or later ${leftToday === 1 ? "was" : "were"} left out: a day only counts once it is over.`);
  if (series.negatives) sentences.push(`${plural(series.negatives, "number")} below zero ${series.negatives === 1 ? "was" : "were"} left out.`);
  for (const c of after.capabilities) sentences.push(`${c.name}: now ${MODE_WORDS[c.to] ?? c.to}.`);
  for (const gl of after.goals.filter((x) => x.newlyMeasured)) sentences.push(gl.sentence);
  return {
    status: "imported", documentId, fileName: name, from: series.from, to: series.to, written, corrected, retired: retire.length, leftAlone,
    leftOut: { today: leftToday, negatives: series.negatives }, metrics, goals: after.goals, capabilities: after.capabilities, sentences,
  };
}

const periodWord = (p: UploadPlan): string => (p.cadence === "day" ? "day" : p.cadence === "week" ? "week" : p.cadence === "month" ? "month" : "period");
const MODE_WORDS: Record<string, string> = { upload: "read from your uploads", api: "live", delegated: "live, through your access", public: "public data only", benchmark: "benchmarks only", none: "not connected" };

async function capabilityModes(g: GraphHandle, businessId: string, now: number): Promise<Map<string, { name: string; mode: string }>> {
  return new Map((await deriveCapabilities(g, { now, businessId })).map((c) => [c.key, { name: c.name, mode: c.accessMode }]));
}

// Goals and the ladder after the numbers landed: baselines locked for goals that had none, readings written, capabilities
// synced; what changed, in the owner's words.
async function settle(g: GraphHandle, businessId: string, now: number, before: Map<string, { name: string; mode: string }>): Promise<{ goals: GoalOutcome[]; capabilities: ImportResult["capabilities"] }> {
  const biz = (await findBusiness(g, businessId)) ?? businessId;
  const program = await currentProgram(g, biz);
  const waiting = new Set<string>();
  if (program) for (const gl of await programGoals(g, program.id)) if (gl.baselineConf === "unknown" || gl.baselineConf === null) waiting.add(gl.id);
  await settleGoals(g, { now, businessId: biz });
  const { capabilities } = await syncCapabilities(g, { now, businessId: biz });
  const moves = before.size
    ? capabilities.filter((c) => before.get(c.key) && before.get(c.key)!.mode !== c.accessMode && c.accessMode === "upload").map((c) => ({ key: c.key, name: c.name, from: before.get(c.key)!.mode, to: c.accessMode }))
    : [];
  const goals: GoalOutcome[] = [];
  if (program) {
    const rows = await programGoals(g, program.id);
    const pulse = await goalPulse(g, now, biz);
    for (const gl of rows) {
      const p = pulse.find((x) => x.id === gl.id);
      const current = p?.current ?? null;
      const baseline = p?.baseline ?? gl.baseline;
      const per = gl.period === "week" ? "a week" : "a month";
      const unit = gl.unit ? ` ${gl.unit}` : "";
      goals.push({
        id: gl.id, name: gl.name, unit: gl.unit, period: gl.period, current, baseline, target: p?.target ?? gl.target, status: STATUS_TEXT[p?.status ?? "no_data"],
        newlyMeasured: waiting.has(gl.id) && current !== null,
        sentence: current === null ? `${gl.name}: ${STATUS_TEXT.no_data}.` : `${gl.name}: ${current.toLocaleString("en-US")}${unit} ${per}${baseline !== null ? `, you started at ${baseline.toLocaleString("en-US")}` : ""}.`,
      });
    }
  }
  return { goals, capabilities: moves };
}
