// Temporal writes (spec §5.4). Nothing here ever deletes: the graph remembers what was true and when.
// - Nodes MERGE on `id`. Re-asserting identical content is a no-op. When a TRACKED_PROPS value changes, the old
//   state is copied into a `Version` node first: (n)-[:HAD_VERSION]->(:Entity:Version {props: JSON, since, until}).
//   `stateSince` on the node marks when its current tracked state began (the next Version's `since`). Version times
//   are source dates (asOf) wherever the source has one, record time otherwise. An older source never overwrites the
//   current state; it only adds what the node lacks, and its view becomes a backdated Version.
// - Edges carry valid time (since/until) and record time (recordedAt/retiredAt). A current edge has `until` null.
//   Re-asserting a known fact (same since, the current edge, or a closed edge covering the since) refreshes its
//   provenance in place, so replays add nothing; an older source never replaces a newer one at equal conf and never
//   reopens a fact that ended after its date. Functional relationships (schema FUNCTIONAL_RELS) hold at most one
//   holder at any moment, whatever order the facts arrive in (see edges.ts).
// - Numbers are Observation nodes with a deterministic id, linked MEASURES -> subject and SOURCED_FROM -> document.
// Concurrency: each node create, node update (+ its Version) and edge write (+ its functional hand-over) is one
// atomic statement; see upsertNode/upsertEdge. addObservation is three idempotent statements (node, MEASURES,
// SOURCED_FROM), not one, and writeBatch is item by item.
// A read plus one write per item: plenty for hackathon-sized ingests; UNWIND batching can come later behind writeBatch.
// The code lives in validate.ts, nodes.ts, edges.ts, observations.ts and batch.ts; this module is the stable import
// path for all of it.
export { DisallowedRelationship, InvalidWrite, MissingEndpoint } from "./errors.js";
export type { Prim, NodeInput, EdgeInput, ObservationInput } from "./validate.js";
export { upsertNode, type NodeResult } from "./nodes.js";
export { upsertEdge, closeEdge } from "./edges.js";
export { addObservation, observationId } from "./observations.js";
export { writeBatch, type BatchOpts, type WriteStats } from "./batch.js";
export { gateNode, gateWrite, RefusedWrite, type GateOpts } from "./gate.js";
