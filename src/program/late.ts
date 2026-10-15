// Numbers that arrive after Day 0 (a spreadsheet the owner uploads, later a connector): lock the baseline of every goal
// that had none ("We'll know after your first full week") and read each goal's newest complete period, so the goal flips
// from waiting to a real reading with where the business started fixed from the data. Idempotent: a goal that already has
// a baseline is not touched, and a reading already written is not written again.
import type { GraphHandle } from "../graph/client.js";
import { writeBatch } from "../graph/upsert.js";
import { findBusiness } from "../capabilities/ladder.js";
import { localDate } from "../onboard/region.js";
import { baselinesWrite, currentProgram, measureGoals, programGoals, type BaselineResult } from "./program.js";
import type { Reading } from "./measure.js";

export interface SettleResult { locked: BaselineResult[]; readings: Reading[] }

export async function settleGoals(g: GraphHandle, o: { now?: number; businessId?: string } = {}): Promise<SettleResult> {
  const now = o.now ?? Date.now();
  const biz = await findBusiness(g, o.businessId);
  const program = biz ? await currentProgram(g, biz) : null;
  if (!biz || !program) return { locked: [], readings: [] };
  const [b] = await g.roQuery<{ tz: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.timeZone AS tz", { id: biz });
  const today = localDate(now, b?.tz ?? undefined);
  const goals = await programGoals(g, program.id);
  const said = await g.roQuery<{ id: string }>(
    `MATCH (pr:Entity:Program {id:$p}) WITH pr MATCH (gl:Goal)-[pp:PART_OF]->(pr) WHERE pp.until IS NULL AND gl.confirmedAt IS NOT NULL RETURN gl.id AS id ORDER BY gl.id`, { p: program.id });
  const { write, results } = await baselinesWrite(g, {
    goals, businessId: biz, today, relock: { program: program.id, startDate: program.startDate, keepTarget: new Set(said.map((s) => s.id)) },
  });
  if (results.length) {
    const s = await writeBatch(g, write, now);
    if (s.errors.length) throw new Error(`baselines: ${s.errors.map((e) => e.error).join("; ")}`);
  }
  const readings = await measureGoals(g, { program: program.id, businessId: biz, today, now });
  return { locked: results, readings };
}
