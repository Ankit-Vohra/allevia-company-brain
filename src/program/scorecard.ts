// The Allevia 90 scorecard (product design §3.3, §8 GET /api/:t/program, §9 item 5): program day N, checkpoints, the
// first-pass curve from Approval.firstPass, learned rules, goals against their Day-0 baseline and target, capabilities
// by mode and deliverables approved. Everything is read from the graph; nothing is backfilled, so a program that
// started today shows Day 0 with whatever the business really has.
//
// With `write` (the default), it first brings the program up to date: each goal's newest complete period becomes a
// reading on the goal, a checkpoint that has come due (day 30, 60, 90) is written with the Observations that measure
// it, and on day 90 the program graduates. Public mode passes write: false and gets the same card, read only.
import type { AccessMode, CapabilityState, FirstPassPoint, GoalState, ProgramCheckpoint, ProgramGoal, ProgramScorecard } from "../../shared/contracts.js";
import { agentById } from "../../shared/roster.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode, writeBatch } from "../graph/upsert.js";
import { deriveCapabilities, findBusiness, getCapabilities } from "../capabilities/ladder.js";
import { ACCESS_MODES } from "../capabilities/modes.js";
import { learningMetrics } from "../actions/learning.js";
import { goalPulse } from "../insights/brief.js";
import { addDays, round } from "../insights/text.js";
import { localDate } from "../onboard/region.js";
import {
  CHECKPOINT_DAYS, PROGRAM_DAYS, checkpointWrite, currentProgram, measureGoals, programCheckpoints, programDay, programGoals,
  type CheckpointDay, type GoalRow,
} from "./program.js";

export interface ProgramOpts { now?: number; businessId?: string; write?: boolean }

const DAY = 86_400_000;
const isoOrNull = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : typeof v === "string" ? v : null);

// null when the business is not enrolled.
export async function getProgram(g: GraphHandle, opts: ProgramOpts = {}): Promise<ProgramScorecard | null> {
  const now = opts.now ?? Date.now();
  const write = opts.write !== false;
  const biz = await findBusiness(g, opts.businessId);
  if (!biz) return null;
  const program = await currentProgram(g, biz);
  if (!program) return null;
  const [b] = await g.roQuery<{ tz: string | null; tk: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.timeZone AS tz, b.templateKey AS tk", { id: biz });
  const timeZone = b?.tz ?? undefined;
  const today = localDate(now, timeZone);
  const day = Math.max(0, programDay(program.startDate, today));

  let goals = await programGoals(g, program.id);
  let status = program.status;
  if (write) {
    await measureGoals(g, { program: program.id, businessId: biz, today, now });
    for (const d of CHECKPOINT_DAYS) {
      if (d === 0 || day < d) continue;
      const w = await checkpointWrite(g, { program: program.id, day: d, date: addDays(program.startDate, d), now, goals });
      if (w.nodes.length) {
        const s = await writeBatch(g, w, now);
        if (s.errors.length) throw new Error(`checkpoint day ${d}: ${s.errors[0]!.error}`);
      }
    }
    if (day >= PROGRAM_DAYS && status === "active") {
      await upsertNode(g, { type: "Program", id: program.id, name: (await programName(g, program.id)) ?? program.id, props: { status: "graduated", graduatedAt: now } }, now);
      status = "graduated";
    }
    goals = await programGoals(g, program.id);
  }

  const [checkpoints, pulse, kpi, series, rules, caps, deliverables] = await Promise.all([
    checkpointList(g, program.id, program.startDate, day),
    goalPulse(g, now, biz),
    learningMetrics(g, now),
    firstPassSeries(g, program.startAt, program.startDate, today),
    learnedRules(g, program.startAt),
    write ? getCapabilities(g, { now, businessId: biz }) : deriveCapabilities(g, { now, businessId: biz }),
    deliverablesSince(g, program.startAt),
  ]);

  return {
    id: program.id, kind: program.kind, status, day, daysLeft: Math.max(0, PROGRAM_DAYS - day), startDate: program.startDate,
    endDate: program.endDate, today, ...(timeZone ? { timeZone } : {}), ...(b?.tk || program.templateKey ? { templateKey: (b?.tk ?? program.templateKey)! } : {}),
    checkpoints,
    firstPass: { rate: kpi.firstPassRate, decided30d: kpi.decided30d, firstPass30d: kpi.firstPass30d, series },
    learnedRules: rules,
    goals: goals.map((gl) => programGoal(gl, pulse.find((p) => p.id === gl.id))),
    capabilities: capabilitySummary(caps),
    deliverables,
  };
}

// Each goal's newest complete period as a reading on the goal, so the morning brief's goal pulse is current. Nothing
// when the business is not enrolled.
export async function refreshGoalReadings(g: GraphHandle, o: { now?: number; businessId?: string } = {}): Promise<number> {
  const now = o.now ?? Date.now();
  const biz = await findBusiness(g, o.businessId);
  const program = biz ? await currentProgram(g, biz) : null;
  if (!biz || !program) return 0;
  const [b] = await g.roQuery<{ tz: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.timeZone AS tz", { id: biz });
  return (await measureGoals(g, { program: program.id, businessId: biz, today: localDate(now, b?.tz ?? undefined), now })).length;
}

async function programName(g: GraphHandle, id: string): Promise<string | undefined> {
  return (await g.roQuery<{ n: string }>("MATCH (p:Entity:Program {id:$id}) RETURN p.name AS n", { id }))[0]?.n;
}

function programGoal(gl: GoalRow, p: Awaited<ReturnType<typeof goalPulse>>[number] | undefined): ProgramGoal {
  const owner = gl.owner ? agentById(gl.owner) : undefined;
  const conf = gl.baselineConf === "measured" || gl.baselineConf === "reported" ? gl.baselineConf : "unknown";
  return {
    id: gl.id, name: gl.name, metricKey: gl.metricKey, unit: gl.unit, period: gl.period,
    owner: owner ? { id: owner.id, name: owner.name } : null,
    baseline: gl.baseline, baselineConf: conf, baselineAt: gl.baselineAt, target: gl.target,
    targetBasis: gl.targetBasis === "baseline" || gl.targetBasis === "template" ? gl.targetBasis : null,
    current: p?.current ?? null, currentAt: p?.currentAt ?? null, progress: p?.progress ?? null,
    status: (p?.status ?? "no_data") as GoalState, dueAt: gl.dueAt,
  };
}

async function checkpointList(g: GraphHandle, program: string, startDate: string, day: number): Promise<ProgramCheckpoint[]> {
  const rows = await programCheckpoints(g, program);
  return CHECKPOINT_DAYS.map((d: CheckpointDay): ProgramCheckpoint => {
    const r = rows.find((x) => x.day === d);
    const dueDate = addDays(startDate, d);
    if (r) {
      return { day: d, dueDate, status: "done", id: r.id, ...(isoOrNull(r.at) ? { at: isoOrNull(r.at)! } : {}), ...(r.summary ? { summary: r.summary } : {}) };
    }
    return { day: d, dueDate, status: day >= d ? "due" : "upcoming" };
  });
}

// The first-pass rate over the 30 days up to each day from the start to today, from the decided Approvals.
export async function firstPassSeries(g: Pick<GraphHandle, "roQuery">, startAt: number, startDate: string, today: string): Promise<FirstPassPoint[]> {
  const rows = await g.roQuery<{ at: number; fp: boolean }>(
    "MATCH (a:Approval) WHERE a.decidedAt >= $from AND a.firstPass IS NOT NULL RETURN a.decidedAt AS at, a.firstPass AS fp ORDER BY at, a.id LIMIT 5000",
    { from: startAt - 30 * DAY });
  const out: FirstPassPoint[] = [];
  for (let d = startDate, i = 0; d <= today && i <= PROGRAM_DAYS; d = addDays(d, 1), i++) {
    const end = Date.parse(`${addDays(d, 1)}T00:00:00Z`);
    const inWindow = rows.filter((r) => r.at < end && r.at >= end - 30 * DAY && r.at >= startAt);
    const fp = inWindow.filter((r) => r.fp === true).length;
    out.push({ date: d, decided: inWindow.length, firstPass: fp, rate: inWindow.length ? round(fp / inWindow.length, 3) : null });
  }
  return out;
}

async function learnedRules(g: Pick<GraphHandle, "roQuery">, startAt: number): Promise<ProgramScorecard["learnedRules"]> {
  const rows = await g.roQuery<{ id: string; text: string | null; status: string | null; at: number | null }>(
    "MATCH (r:Rule) WHERE r.kind = 'learned' RETURN r.id AS id, coalesce(r.text, r.name) AS text, r.status AS status, coalesce(r.learnedAt, r.createdAt) AS at ORDER BY at DESC, id LIMIT 1000");
  const active = rows.filter((r) => (r.status ?? "active") === "active");
  return {
    active: active.length,
    learnedSinceStart: rows.filter((r) => (r.at ?? 0) >= startAt).length,
    retired: rows.filter((r) => r.status === "retired").length,
    recent: active.slice(0, 5).map((r) => ({ id: r.id, text: r.text ?? r.id, learnedAt: isoOrNull(r.at) })),
  };
}

async function deliverablesSince(g: Pick<GraphHandle, "roQuery">, startAt: number): Promise<ProgramScorecard["deliverables"]> {
  const rows = await g.roQuery<{ decision: string | null; status: string | null; at: number | null; fp: boolean | null }>(
    "MATCH (a:Approval) RETURN a.decision AS decision, a.status AS status, a.decidedAt AS at, a.firstPass AS fp LIMIT 10000");
  const since = rows.filter((r) => (r.at ?? 0) >= startAt);
  const approved = (r: (typeof rows)[number]) => r.decision === "approve" || (!r.decision && ["approved", "edited", "executed"].includes(r.status ?? ""));
  return {
    approved: rows.filter(approved).length,
    approvedSinceStart: since.filter(approved).length,
    editedSinceStart: since.filter((r) => approved(r) && (r.fp === false || r.status === "edited")).length,
    rejectedSinceStart: since.filter((r) => r.decision === "reject" || r.status === "rejected").length,
    pending: rows.filter((r) => (r.status ?? "pending") === "pending").length,
  };
}

function capabilitySummary(caps: CapabilityState[]): ProgramScorecard["capabilities"] {
  const byMode = Object.fromEntries(ACCESS_MODES.map((m) => [m, 0])) as Record<AccessMode, number>;
  for (const c of caps) byMode[c.accessMode]++;
  return { byMode, items: caps.map(({ key, name, accessMode, status }) => ({ key, name, accessMode, status })) };
}
