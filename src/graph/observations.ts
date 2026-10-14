// Numbers are Observation nodes with a deterministic id (obs:<metric>:<subject>:<windowEnd|asOf>), linked
// MEASURES -> subject and SOURCED_FROM -> document. Never overwritten silently: a corrected value keeps a Version.
// Strength: `conf` (missing = 1, measured) ranks sources. A weaker observation (lower conf than the stored one) is
// ignored, so a number reported in a note never replaces a connector's measurement. Equal or stronger updates the
// value and keeps the earlier reading as a Version; `conf` and `evidence` always describe the stored value.
import type { GraphHandle } from "./client.js";
import { InvalidWrite, MissingEndpoint } from "./errors.js";
import { upsertNode, type NodeResult } from "./nodes.js";
import { upsertEdge } from "./edges.js";
import { defined, nonEmpty, type ObservationInput } from "./validate.js";

export function observationId(o: Pick<ObservationInput, "metric" | "subject" | "windowEnd" | "asOf">): string {
  return `obs:${o.metric}:${o.subject}:${o.windowEnd ?? o.asOf}`;
}

export async function writeObservation(g: GraphHandle, o: ObservationInput, now: number): Promise<NodeResult & { id: string; skippedWeaker: boolean }> {
  for (const k of ["subject", "metric", "asOf", "src"] as const) {
    if (!nonEmpty(o[k])) throw new InvalidWrite(`observation ${k} must be a non-empty string`);
  }
  if (!Number.isFinite(o.value)) throw new InvalidWrite(`observation value must be a finite number, got ${o.value}`);
  if (o.conf !== undefined && !(Number.isFinite(o.conf) && o.conf >= 0 && o.conf <= 1)) throw new InvalidWrite(`observation conf must be in [0,1], got ${o.conf}`);
  const id = observationId(o);
  const subj = await g.query<{ name: string | null }>("MATCH (s:Entity {id:$id}) RETURN s.name AS name LIMIT 1", { id: o.subject });
  if (!subj.length) throw new MissingEndpoint([o.subject], `subject of ${id}`);
  const stored = await g.query<{ conf: number | null }>("MATCH (o:Entity {id:$id}) RETURN o.conf AS conf LIMIT 1", { id });
  if (stored.length && (o.conf ?? 1) < (stored[0]!.conf ?? 1)) {
    return { id, created: false, versioned: false, updated: false, skippedWeaker: true };
  }
  const res = await upsertNode(g, {
    type: "Observation", id,
    name: `${o.metric} of ${subj[0]!.name ?? o.subject} (${o.windowEnd ?? o.asOf})`,
    props: defined({
      metric: o.metric, value: o.value, unit: o.unit, windowStart: o.windowStart, windowEnd: o.windowEnd, subject: o.subject,
      evidence: o.evidence ?? null, conf: o.conf ?? null,
    }),
    src: o.src, asOf: o.asOf, simulated: o.simulated,
  }, now);
  await upsertEdge(g, { from: id, type: "MEASURES", to: o.subject, src: o.src, asOf: o.asOf, conf: o.conf }, now);
  // The source document may be ingested later; the `src` prop already records it, the edge follows when it exists.
  const doc = await g.query<{ c: number }>("MATCH (d:Entity:Document {id:$id}) RETURN count(d) AS c", { id: o.src });
  if ((doc[0]?.c ?? 0) > 0) await upsertEdge(g, { from: id, type: "SOURCED_FROM", to: o.src, asOf: o.asOf, conf: o.conf }, now);
  return { id, ...res, skippedWeaker: false };
}

// Returns the observation id: obs:<metric>:<subject>:<windowEnd|asOf>. Re-adding it with a different value updates
// the value and keeps the earlier reading as a Version (a number corrected by a later source), unless the new one is
// weaker (lower conf) or older (earlier asOf, stored as a backdated Version instead).
export async function addObservation(g: GraphHandle, o: ObservationInput, now: number = Date.now()): Promise<string> {
  return (await writeObservation(g, o, now)).id;
}
