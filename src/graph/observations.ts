// Numbers are Observation nodes with a deterministic id (obs:<metric>:<subject>:<windowEnd|asOf>), linked
// MEASURES -> subject and SOURCED_FROM -> document. Never overwritten silently: a corrected value keeps a Version.
// Strength: `conf` (missing = 1, measured) ranks sources. A weaker observation (lower conf than the stored one) is
// ignored, so a number reported in a note never replaces a connector's measurement. Equal or stronger updates the
// value and keeps the earlier reading as a Version; `conf` and `evidence` always describe the stored value.
import type { GraphHandle } from "./client.js";
import { InvalidWrite, MissingEndpoint } from "./errors.js";
import { upsertNode, type NodeResult } from "./nodes.js";
import { upsertEdge } from "./edges.js";
import { metricKeyOf } from "./schema.js";
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
  // One read for everything the write needs to know (it used to be three, and each edge write then read its ends again):
  // the subject (must exist; its name goes into the observation's), what is stored under this id (a weaker reading does
  // not replace it), and whether the source document exists yet.
  const [pre] = await g.peek<{ name: string | null; labels: string[]; stored: boolean; conf: number | null; doc: boolean }>(
    `MATCH (s:Entity {id:$subject})
     OPTIONAL MATCH (x:Entity {id:$id})
     OPTIONAL MATCH (d:Entity:Document {id:$src})
     RETURN s.name AS name, labels(s) AS labels, x IS NOT NULL AS stored, x.conf AS conf, d IS NOT NULL AS doc LIMIT 1`,
    { subject: o.subject, id, src: o.src });
  if (!pre) throw new MissingEndpoint([o.subject], `subject of ${id}`);
  if (pre.stored && (o.conf ?? 1) < (pre.conf ?? 1)) {
    return { id, created: false, versioned: false, updated: false, skippedWeaker: true };
  }
  const res = await upsertNode(g, {
    type: "Observation", id,
    name: `${o.metric} of ${pre.name ?? o.subject} (${o.windowEnd ?? o.asOf})`,
    props: defined({
      metric: o.metric, metricKey: metricKeyOf(o.metric), value: o.value, unit: o.unit, windowStart: o.windowStart, windowEnd: o.windowEnd,
      subject: o.subject, evidence: o.evidence ?? null, conf: o.conf ?? null,
    }),
    src: o.src, asOf: o.asOf, simulated: o.simulated,
  }, now);
  // Both ends are known (just read, just written), so upsertEdge need not read them again.
  const ends = new Map<string, string[]>([[id, ["Entity", "Observation"]], [o.subject, pre.labels]]);
  await upsertEdge(g, { from: id, type: "MEASURES", to: o.subject, src: o.src, asOf: o.asOf, conf: o.conf }, now, ends);
  // The source document may be ingested later; the `src` prop already records it, the edge follows when it exists.
  if (pre.doc) {
    await upsertEdge(g, { from: id, type: "SOURCED_FROM", to: o.src, asOf: o.asOf, conf: o.conf }, now, new Map([...ends, [o.src, ["Entity", "Document"]]]));
  }
  return { id, ...res, skippedWeaker: false };
}

// Returns the observation id: obs:<metric>:<subject>:<windowEnd|asOf>. Re-adding it with a different value updates
// the value and keeps the earlier reading as a Version (a number corrected by a later source), unless the new one is
// weaker (lower conf) or older (earlier asOf, stored as a backdated Version instead).
export async function addObservation(g: GraphHandle, o: ObservationInput, now: number = Date.now()): Promise<string> {
  return (await writeObservation(g, o, now)).id;
}
