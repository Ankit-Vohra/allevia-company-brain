// Errors the graph layer throws on bad writes. Callers (ingestion, executors) catch these by class.
import type { EntityType, RelType } from "./schema.js";

export class InvalidWrite extends Error {
  override name = "InvalidWrite";
}

// A query refused before it reached the server because its text has a shape that crashes FalkorDB 6.0.2 (an ORDER BY
// that can tie, or one that sorts a NaN): see safety.ts. Nothing was sent.
export class UnsafeQuery extends Error {
  override name = "UnsafeQuery";
}

export class MissingEndpoint extends Error {
  override name = "MissingEndpoint";
  constructor(readonly ids: string[], context = "") {
    super(`missing endpoint${ids.length > 1 ? "s" : ""}: ${ids.join(", ")}${context ? ` (${context})` : ""}`);
  }
}

// A projection did not hold exactly what its source holds (a truncated read, or a source that kept changing while it
// was read). Algorithms never run on a partial projection.
export class ProjectionMismatch extends Error {
  override name = "ProjectionMismatch";
}

export class DisallowedRelationship extends Error {
  override name = "DisallowedRelationship";
  constructor(readonly from: EntityType, readonly rel: RelType, readonly to: EntityType) {
    super(`(${from})-[:${rel}]->(${to}) is not in the ontology's allowed patterns`);
  }
}
