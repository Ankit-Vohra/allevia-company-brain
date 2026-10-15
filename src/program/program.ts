// Allevia 90 in the graph (product design §3.3, §7): the Program a business is ENROLLED_IN, its Goals (PURSUED by the
// Business, TRACKING a Metric, OWNED by the agent responsible, PART_OF the Program, SOURCED_FROM the industry
// template), the Day-0 baselines, and the day 0/30/60/90 Checkpoints. A Checkpoint holds no numbers: Observations
// MEASURE it (the goals' readings and the program's own allevia.* metrics on that day).
//
// Everything is idempotent and nothing is backfilled: the program starts the day the business enrols, a baseline is
// locked once (a later run never moves it), and a goal with no data on Day 0 says so (baseline null, baselineConf
// 'unknown') instead of carrying a guessed number.
import { agentById } from "../../shared/roster.js";
import type { GraphHandle } from "../graph/client.js";
import { observationId, writeBatch, type EdgeInput, type NodeInput, type ObservationInput } from "../graph/upsert.js";
import type { GraphWrite } from "../ingest/types.js";
import { agentNodeId } from "../agent/memory.js";
import { learningMetrics } from "../actions/learning.js";
import { entityId } from "../util/ids.js";
import { addDays, DAY_MS, dayMs, humanise } from "../insights/text.js";
import { PERIOD_DAYS, targetFor, type GoalPeriod, type GoalTemplate, type IndustryTemplate, type MetricSource } from "../onboard/templates.js";
import { readGoal, type Reading } from "./measure.js";

type Read = Pick<GraphHandle, "roQuery">;

export const PROGRAM_KIND = "allevia90";
export const PROGRAM_DAYS = 90;
export const CHECKPOINT_DAYS = [0, 30, 60, 90] as const;
export type CheckpointDay = (typeof CHECKPOINT_DAYS)[number];
export const PROGRAM_SRC = "allevia:program";

export const programId = (slug: string): string => entityId("Program", `${PROGRAM_KIND} ${slug}`);
export const checkpointId = (program: string, day: number): string => entityId("Checkpoint", `${program.replace(/^program:/, "")} day ${day}`);
export const goalId = (key: string): string => entityId("Goal", key);
export const templateDocId = (key: string): string => entityId("Document", `template ${key}`);
export const metricId = (key: string): string => entityId("Metric", key);
export const baselineObsId = (metricKey: string, goal: string): string => `obs:${metricKey}:${goal}:baseline`;

const iso = (ms: number) => new Date(ms).toISOString();

// ---------- reading what is there ----------

export interface ProgramRow {
  id: string; kind: string; status: string; startAt: number; startDate: string; endDate: string; guaranteeState: string | null; templateKey: string | null;
}

// The program the business is currently ENROLLED_IN, or null.
export async function currentProgram(g: Read, businessId: string): Promise<ProgramRow | null> {
  const [r] = await g.roQuery<{ id: string; kind: string | null; status: string | null; startAt: number | null; startDate: string | null; endDate: string | null; gs: string | null; tk: string | null }>(
    `MATCH (:Business {id:$b})-[e:ENROLLED_IN]->(p:Program) WHERE e.until IS NULL
     RETURN p.id AS id, p.kind AS kind, p.status AS status, p.startAt AS startAt, p.startDate AS startDate, p.endDate AS endDate,
            p.guaranteeState AS gs, p.templateKey AS tk LIMIT 1`, { b: businessId });
  if (!r || typeof r.startAt !== "number") return null;
  const startDate = r.startDate ?? iso(r.startAt).slice(0, 10);
  return {
    id: r.id, kind: r.kind ?? PROGRAM_KIND, status: r.status ?? "active", startAt: r.startAt, startDate,
    endDate: r.endDate ?? addDays(startDate, PROGRAM_DAYS), guaranteeState: r.gs, templateKey: r.tk,
  };
}

export interface GoalRow {
  id: string; name: string; metricKey: string; unit: string | null; period: GoalPeriod; priority: number;
  baseline: number | null; baselineConf: string | null; baselineAt: string | null; target: number | null; targetBasis: string | null;
  status: string | null; startAt: string | null; dueAt: string | null; owner: string | null; sources: MetricSource[]; lift: number | null; minTarget: number | null;
  why: string | null;
}

const parseSources = (v: unknown): MetricSource[] => {
  try {
    const x = typeof v === "string" ? JSON.parse(v) as unknown : [];
    return Array.isArray(x) ? x.filter((s): s is MetricSource => !!s && typeof s.metric === "string" && typeof s.subject === "string" && (s.agg === "window" || s.agg === "daily_sum")) : [];
  } catch {
    return [];
  }
};
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The program's goals, primary first.
export async function programGoals(g: Read, program: string): Promise<GoalRow[]> {
  const rows = await g.roQuery<{ p: Record<string, unknown>; owner: string | null }>(
    `MATCH (gl:Goal)-[pp:PART_OF]->(:Program {id:$p}) WHERE pp.until IS NULL AND NOT coalesce(gl.status, '') IN ['retired', 'superseded']
     OPTIONAL MATCH (a:Agent)-[o:OWNS]->(gl) WHERE o.until IS NULL
     WITH gl, collect(a.rosterId)[0] AS owner
     RETURN properties(gl) AS p, owner ORDER BY coalesce(gl.priority, 99), gl.id`, { p: program });
  return rows.map(({ p, owner }) => ({
    id: String(p.id), name: String(p.name), metricKey: String(p.metricKey ?? ""), unit: typeof p.unit === "string" ? p.unit : null,
    period: p.period === "week" ? "week" : "month", priority: numOrNull(p.priority) ?? 99,
    baseline: numOrNull(p.baseline), baselineConf: typeof p.baselineConf === "string" ? p.baselineConf : null,
    baselineAt: typeof p.baselineAt === "string" ? p.baselineAt : null, target: numOrNull(p.target),
    targetBasis: typeof p.targetBasis === "string" ? p.targetBasis : null, status: typeof p.status === "string" ? p.status : null,
    startAt: typeof p.startAt === "string" ? p.startAt : null, dueAt: typeof p.dueAt === "string" ? p.dueAt : null,
    owner: owner ?? null, sources: parseSources(p.measure), lift: numOrNull(p.lift), minTarget: numOrNull(p.minTarget),
    why: typeof p.why === "string" ? p.why : null,
  }));
}

// ---------- the program and its goals ----------

export interface EnrolInput {
  slug: string;
  businessId: string;
  businessName: string;
  template: IndustryTemplate;
  now: number;
  startDate: string;        // the owner's local date on Day 0
  timeZone?: string;
}

// The Program (Day 0 = today) and ENROLLED_IN, unless the business is already in one; the template Document; the
// goals with their Metric, owner and edges. A goal already in the graph keeps its baseline, target and status.
export async function programAndGoalsWrite(g: GraphHandle, i: EnrolInput): Promise<{ write: GraphWrite; program: string; created: boolean; goals: string[]; startDate: string }> {
  const existing = await currentProgram(g, i.businessId);
  const program = existing?.id ?? programId(i.slug);
  const startDate = existing?.startDate ?? i.startDate;
  const due = addDays(startDate, PROGRAM_DAYS);
  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];
  if (!existing) {
    nodes.push({
      type: "Program", id: program, name: `Allevia 90: ${i.businessName}`,
      summary: `${i.businessName}'s 90-day improvement program, from ${startDate} to ${due}.`,
      props: {
        kind: PROGRAM_KIND, status: "active", guaranteeState: "open", startAt: i.now, startDate, endAt: i.now + PROGRAM_DAYS * DAY_MS, endDate: due,
        days: PROGRAM_DAYS, templateKey: i.template.key, ...(i.timeZone ? { timeZone: i.timeZone } : {}),
      },
    });
    edges.push({ from: i.businessId, type: "ENROLLED_IN", to: program });
  }
  const doc = templateDocId(i.template.key);
  nodes.push({
    type: "Document", id: doc, name: `Industry template: ${i.template.name}`,
    summary: `Allevia's starting goals for a ${i.template.name.toLowerCase()}: ${i.template.goals.map((t) => t.name).join(", ")}.`,
    props: { kind: "template", templateKey: i.template.key, goals: i.template.goals.map((t) => t.key) },
  });
  const have = new Set((await g.roQuery<{ id: string }>("MATCH (gl:Goal) RETURN gl.id AS id")).map((r) => r.id));
  const ids: string[] = [];
  for (const t of i.template.goals) {
    const id = goalId(t.key);
    ids.push(id);
    nodes.push({ type: "Metric", id: metricId(t.metricKey), name: humanise(t.metricKey), props: { key: t.metricKey, unit: t.unit } });
    if (!have.has(id)) nodes.push(goalNode(id, t, startDate, due, doc));
    const owner = agentNodeId(t.owner);
    edges.push(
      { from: i.businessId, type: "PURSUES", to: id },
      { from: id, type: "TRACKS", to: metricId(t.metricKey) },
      { from: id, type: "PART_OF", to: program },
      { from: id, type: "SOURCED_FROM", to: doc },
      { from: owner, type: "OWNS", to: id },
    );
  }
  return { write: { nodes, edges, observations: [] }, program, created: !existing, goals: ids, startDate };
}

function goalNode(id: string, t: GoalTemplate, startDate: string, dueAt: string, doc: string): NodeInput {
  return {
    type: "Goal", id, name: t.name, summary: t.why, src: doc,
    props: {
      metricKey: t.metricKey, unit: t.unit, period: t.period, periodDays: PERIOD_DAYS[t.period], priority: t.priority,
      startAt: startDate, dueAt, templateKey: t.key, lift: t.lift, minTarget: t.minTarget, why: t.why, measure: JSON.stringify(t.sources),
      owner: t.owner,
    },
  };
}

// The agent that owns each goal must exist before OWNS can point at it.
export function goalOwners(t: IndustryTemplate): string[] {
  return [...new Set(t.goals.map((x) => x.owner))].filter((id) => !!agentById(id));
}

// ---------- Day-0 baselines ----------

export interface BaselineResult { goal: string; name: string; baseline: number | null; conf: "measured" | "reported" | "unknown"; target: number; targetBasis: "baseline" | "template"; reading?: Reading }

const readingObservation = (goal: string, metricKey: string, unit: string | null, r: Reading): ObservationInput => ({
  subject: goal, metric: metricKey, value: r.value, ...(unit ? { unit } : {}), windowStart: r.windowStart, windowEnd: r.windowEnd,
  asOf: r.asOf, src: r.src || PROGRAM_SRC, evidence: r.evidence, ...(r.conf !== null ? { conf: r.conf } : {}),
});

// Locks each goal's Day-0 baseline from the Observations already in the graph: an Observation{baseline:true} on the
// goal (SOURCED_FROM where the numbers came from), the goal's first reading, and baseline/target on the Goal. A goal
// with no reading gets baseline null and baselineConf 'unknown', and the template's target. A goal already locked is
// left as it is.
export async function baselinesWrite(g: GraphHandle, o: { goals: GoalRow[]; businessId: string; today: string }): Promise<{ write: GraphWrite; results: BaselineResult[] }> {
  const w: GraphWrite = { nodes: [], edges: [], observations: [] };
  const results: BaselineResult[] = [];
  const docs = new Set<string>();
  for (const gl of o.goals) {
    if (gl.baselineConf) continue; // locked on an earlier run
    const r = await readGoal(g, gl.sources, { businessId: o.businessId, period: gl.period, today: o.today });
    const baseline = r ? r.value : null;
    const conf: BaselineResult["conf"] = !r ? "unknown" : r.conf !== null && r.conf < 1 ? "reported" : "measured";
    const { target, basis } = targetFor({ lift: gl.lift ?? 0.5, minTarget: gl.minTarget ?? 0 }, baseline);
    w.nodes.push({
      type: "Goal", id: gl.id, name: gl.name,
      props: {
        baseline, baselineConf: conf, baselineAt: r ? r.windowEnd : null, target, targetBasis: basis,
        status: r ? "on_track" : "no_data", ...(r ? { baselineEvidence: r.evidence } : {}),
      },
    });
    if (r) {
      const bid = baselineObsId(gl.metricKey, gl.id);
      w.nodes.push({
        type: "Observation", id: bid, name: `${gl.name}: Day-0 baseline (${r.windowEnd})`, src: r.src || PROGRAM_SRC, asOf: r.asOf,
        props: {
          metric: gl.metricKey, value: r.value, ...(gl.unit ? { unit: gl.unit } : {}), baseline: true, subject: gl.id,
          windowStart: r.windowStart, windowEnd: r.windowEnd, evidence: r.evidence, conf: r.conf, readings: r.obsIds,
        },
      });
      w.edges.push({ from: bid, type: "MEASURES", to: gl.id, src: r.src || PROGRAM_SRC, asOf: r.asOf });
      if (r.src) { docs.add(r.src); w.edges.push({ from: bid, type: "SOURCED_FROM", to: r.src, asOf: r.asOf }); }
      w.observations.push(readingObservation(gl.id, gl.metricKey, gl.unit, r));
    }
    results.push({ goal: gl.id, name: gl.name, baseline, conf, target, targetBasis: basis, ...(r ? { reading: r } : {}) });
  }
  // A source document that is not in the graph: the edge would fail; the observation's src prop still names it.
  if (docs.size) {
    const present = new Set((await g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (d:Document {id:id}) RETURN d.id AS id", { ids: [...docs] })).map((r) => r.id));
    w.edges = w.edges.filter((e) => e.type !== "SOURCED_FROM" || present.has(e.to));
  }
  return { write: w, results };
}

// ---------- goal readings after Day 0 ----------

// Each goal's newest complete period, as an Observation on the goal (id by window end, so a period is written once).
// Run before the scorecard and the brief so the goal pulse reads current numbers.
export async function measureGoals(g: GraphHandle, o: { program: string; businessId: string; today: string; now: number }): Promise<Reading[]> {
  const goals = await programGoals(g, o.program);
  const obs: ObservationInput[] = [];
  const out: Reading[] = [];
  for (const gl of goals) {
    const r = await readGoal(g, gl.sources, { businessId: o.businessId, period: gl.period, today: o.today });
    if (!r) continue;
    const input = readingObservation(gl.id, gl.metricKey, gl.unit, r);
    const [have] = await g.roQuery<{ v: number | null }>("MATCH (x:Observation {id:$id}) RETURN x.value AS v", { id: observationId(input) });
    if (have && have.v === r.value) continue;
    obs.push(input);
    out.push(r);
  }
  if (obs.length) {
    const s = await writeBatch(g, { observations: obs }, o.now);
    if (s.errors.length) throw new Error(`goal readings: ${s.errors.map((e) => e.error).join("; ")}`);
  }
  return out;
}

// ---------- checkpoints ----------

export interface CheckpointRow { id: string; day: number; at: number | null; date: string | null; summary: string | null }

export async function programCheckpoints(g: Read, program: string): Promise<CheckpointRow[]> {
  return g.roQuery<CheckpointRow>(
    `MATCH (c:Checkpoint)-[pp:PART_OF]->(:Program {id:$p}) WHERE pp.until IS NULL
     RETURN c.id AS id, c.day AS day, c.at AS at, c.date AS date, c.summary AS summary ORDER BY c.day`, { p: program });
}

const CHECKPOINT_TEXT: Record<CheckpointDay, string> = {
  0: "Day 0 of Allevia 90: goals set and baselines locked from the data on hand.",
  30: "Day 30 of Allevia 90: report one, goals against their Day-0 baselines.",
  60: "Day 60 of Allevia 90: the halfway review.",
  90: "Day 90 of Allevia 90: graduation, every goal before and after.",
};

// The checkpoint for `day`, PART_OF the program, MEASURED by the program's own numbers that day (first-pass rate when
// any draft was decided, learned rules, deliverables approved) and by each goal's newest reading (its baseline on
// Day 0). Written once.
export async function checkpointWrite(g: GraphHandle, o: { program: string; day: CheckpointDay; date: string; now: number; goals: GoalRow[] }): Promise<GraphWrite> {
  const id = checkpointId(o.program, o.day);
  const w: GraphWrite = { nodes: [], edges: [], observations: [] };
  if ((await g.roQuery<{ id: string }>("MATCH (c:Checkpoint {id:$id}) RETURN c.id AS id", { id })).length) return w;
  w.nodes.push({ type: "Checkpoint", id, name: `Allevia 90, day ${o.day}`, summary: CHECKPOINT_TEXT[o.day], asOf: o.date, props: { day: o.day, at: o.now, date: o.date } });
  w.edges.push({ from: id, type: "PART_OF", to: o.program });
  const m = await learningMetrics(g, o.now);
  const base = { subject: id, asOf: o.date, windowEnd: o.date, src: PROGRAM_SRC };
  if (m.firstPassRate !== null) w.observations.push({ ...base, metric: "allevia.first_pass_rate", value: m.firstPassRate, unit: "ratio", windowStart: addDays(o.date, -29) });
  w.observations.push({ ...base, metric: "allevia.learned_rules", value: m.learnedRules, unit: "count" });
  w.observations.push({ ...base, metric: "allevia.deliverables_approved", value: m.deliverablesApproved, unit: "count" });
  for (const gl of o.goals) {
    const [r] = o.day === 0
      ? await g.roQuery<{ id: string }>("MATCH (x:Observation {id:$id}) RETURN x.id AS id", { id: baselineObsId(gl.metricKey, gl.id) })
      : await g.roQuery<{ id: string }>(
        `MATCH (x:Observation)-[m:MEASURES]->(:Goal {id:$g}) WHERE m.until IS NULL AND coalesce(x.baseline, false) = false AND x.windowEnd <= $d
         RETURN x.id AS id ORDER BY x.windowEnd DESC LIMIT 1`, { g: gl.id, d: o.date });
    if (r) w.edges.push({ from: r.id, type: "MEASURES", to: id });
  }
  return w;
}

// The program day on a local date: 0 on the start date.
export const programDay = (startDate: string, today: string): number => Math.round((dayMs(today) - dayMs(startDate)) / DAY_MS);
