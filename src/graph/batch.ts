// writeBatch: one ingestion unit (a document's extraction, a snapshot) written item by item, errors collected.
import type { GraphHandle } from "./client.js";
import { upsertNode } from "./nodes.js";
import { upsertEdge } from "./edges.js";
import { writeObservation } from "./observations.js";
import { gateWrite, type GateOpts, type Resolution } from "./gate.js";
import type { EdgeInput, NodeInput, ObservationInput } from "./validate.js";

export interface WriteStats {
  nodesCreated: number;
  nodesUpdated: number;
  versions: number;
  edgesCreated: number;
  edgesClosed: number;
  observations: number;
  skippedWeaker: number;  // observations ignored because a stronger (higher conf) one with the same id is stored
  errors: Array<{ kind: "node" | "edge" | "observation"; item: NodeInput | EdgeInput | ObservationInput; error: string }>;
  resolved?: Resolution[]; // with a gate: new nodes that were the same as one already there (nothing created; their edges point at it)
}

export interface BatchOpts {
  // The write gate (src/graph/gate.ts): every new node has a known label, a source and a date (the write's own when it names
  // none), and a new person, business or product that is already there is linked to instead of created. A refused node is an
  // error of the batch ("RefusedWrite: <why>"), and so is each edge or number that needed it.
  gate?: GateOpts;
}

// Nodes first, then observations (they only need their subject node), then edges, so an edge can point at an
// observation from the same batch (an extracted Decision BASED_ON a number). A bad item is recorded in `errors` and the
// batch carries on. Observation MEASURES/SOURCED_FROM edges are not counted in edgesCreated.
export async function writeBatch(
  g: GraphHandle,
  input: { nodes?: NodeInput[]; edges?: EdgeInput[]; observations?: ObservationInput[] },
  now: number = Date.now(),
  opts: BatchOpts = {},
): Promise<WriteStats> {
  const s: WriteStats = { nodesCreated: 0, nodesUpdated: 0, versions: 0, edgesCreated: 0, edgesClosed: 0, observations: 0, skippedWeaker: 0, errors: [] };
  let w = input;
  if (opts.gate) {
    const gated = await gateWrite(g, input, opts.gate);
    w = gated.write;
    for (const r of gated.refused) {
      const item = (input.nodes ?? []).find((n) => n.id === r.id)!;
      s.errors.push({ kind: "node", item, error: `RefusedWrite: ${r.reason}` });
    }
    const gone = new Set(gated.refused.map((r) => r.id));
    for (const e of input.edges ?? []) if (gone.has(e.from) || gone.has(e.to)) s.errors.push({ kind: "edge", item: e, error: `RefusedWrite: ${gone.has(e.from) ? e.from : e.to} was refused` });
    for (const o of input.observations ?? []) if (gone.has(o.subject)) s.errors.push({ kind: "observation", item: o, error: `RefusedWrite: ${o.subject} was refused` });
    if (gated.resolved.length) s.resolved = gated.resolved;
  }
  const msg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  for (const n of w.nodes ?? []) {
    try {
      const r = await upsertNode(g, n, now);
      if (r.created) s.nodesCreated++;
      else if (r.updated) s.nodesUpdated++;
      if (r.versioned) s.versions++;
    } catch (e) {
      s.errors.push({ kind: "node", item: n, error: msg(e) });
    }
  }
  for (const o of w.observations ?? []) {
    try {
      const r = await writeObservation(g, o, now);
      if (r.skippedWeaker) {
        s.skippedWeaker++;
        continue;
      }
      s.observations++;
      if (r.versioned) s.versions++;
    } catch (e) {
      s.errors.push({ kind: "observation", item: o, error: msg(e) });
    }
  }
  for (const e of w.edges ?? []) {
    try {
      const r = await upsertEdge(g, e, now);
      if (r.created) s.edgesCreated++;
      s.edgesClosed += r.closed;
    } catch (err) {
      s.errors.push({ kind: "edge", item: e, error: msg(err) });
    }
  }
  return s;
}
