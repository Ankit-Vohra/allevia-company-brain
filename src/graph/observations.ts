// Numbers are Observation nodes with a deterministic id (obs:<metric>:<subject>:<windowEnd|asOf>), linked
// MEASURES -> subject and SOURCED_FROM -> document. Never overwritten silently: a corrected value keeps a Version.
import type { GraphHandle } from "./client.js";
import { InvalidWrite, MissingEndpoint } from "./errors.js";
import { upsertNode, type NodeResult } from "./nodes.js";
import { upsertEdge } from "./edges.js";
import { defined, nonEmpty, type ObservationInput } from "./validate.js";

export function observationId(o: Pick<ObservationInput, "metric" | "subject" | "windowEnd" | "asOf">): string {
  return `obs:${o.metric}:${o.subject}:${o.windowEnd ?? o.asOf}`;
}

export async function writeObservation(g: GraphHandle, o: ObservationInput, now: number): Promise<NodeResult & { id: string }> {
  for (const k of ["subject", "metric", "asOf", "src"] as const) {
    if (!nonEmpty(o[k])) throw new InvalidWrite(`observation ${k} must be a non-empty string`);
  }
  if (!Number.isFinite(o.value)) throw new InvalidWrite(`observation value must be a finite number, got ${o.value}`);
  const id = observationId(o);
  const subj = await g.query<{ name: string | null }>("MATCH (s:Entity {id:$id}) RETURN s.name AS name LIMIT 1", { id: o.subject });
  if (!subj.length) throw new MissingEndpoint([o.subject], `subject of ${id}`);
  const res = await upsertNode(g, {
    type: "Observation", id,
    name: `${o.metric} of ${subj[0]!.name ?? o.subject} (${o.windowEnd ?? o.asOf})`,
    props: defined({
      metric: o.metric, value: o.value, unit: o.unit, windowStart: o.windowStart, windowEnd: o.windowEnd, subject: o.subject,
      evidence: o.evidence,
    }),
    src: o.src, asOf: o.asOf, simulated: o.simulated,
  }, now);
  await upsertEdge(g, { from: id, type: "MEASURES", to: o.subject, src: o.src, asOf: o.asOf }, now);
  // The source document may be ingested later; the `src` prop already records it, the edge follows when it exists.
  const doc = await g.query<{ c: number }>("MATCH (d:Entity:Document {id:$id}) RETURN count(d) AS c", { id: o.src });
  if ((doc[0]?.c ?? 0) > 0) await upsertEdge(g, { from: id, type: "SOURCED_FROM", to: o.src, asOf: o.asOf }, now);
  return { id, ...res };
}

// Returns the observation id: obs:<metric>:<subject>:<windowEnd|asOf>. Re-adding it with a different value updates
// the value and keeps the earlier reading as a Version (a number corrected by a later source).
export async function addObservation(g: GraphHandle, o: ObservationInput, now: number = Date.now()): Promise<string> {
  return (await writeObservation(g, o, now)).id;
}
