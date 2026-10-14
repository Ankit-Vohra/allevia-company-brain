// Errors the graph layer throws on bad writes. Callers (ingestion, executors) catch these by class.
import type { EntityType, RelType } from "./schema.js";

export class InvalidWrite extends Error {
  override name = "InvalidWrite";
}

export class MissingEndpoint extends Error {
  override name = "MissingEndpoint";
  constructor(readonly ids: string[], context = "") {
    super(`missing endpoint${ids.length > 1 ? "s" : ""}: ${ids.join(", ")}${context ? ` (${context})` : ""}`);
  }
}

export class DisallowedRelationship extends Error {
  override name = "DisallowedRelationship";
  constructor(readonly from: EntityType, readonly rel: RelType, readonly to: EntityType) {
    super(`(${from})-[:${rel}]->(${to}) is not in the ontology's allowed patterns`);
  }
}
