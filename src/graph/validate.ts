// Input shapes for graph writes and the checks every write runs before touching FalkorDB: known types, ids whose
// prefix matches their type, plain-identifier prop keys, primitive values, 384-d embeddings. Also the value helpers
// the writers share (FalkorDB-tolerant equality, dropping undefined).
import { EDGE_META_PROPS, NODE_META_PROPS, isEntityType, isRelType, type EntityType, type RelType } from "./schema.js";
import { VECTOR_DIM } from "./indexes.js";
import { InvalidWrite } from "./errors.js";
import { typeFromId } from "../util/ids.js";

export type Prim = string | number | boolean | null | string[] | number[];

export interface NodeInput {
  type: EntityType;
  id: string;
  name: string;
  summary?: string;
  props?: Record<string, Prim>;
  src?: string;
  asOf?: string;
  simulated?: boolean;
  embedding?: number[];
}

export interface EdgeInput {
  from: string;
  type: RelType;
  to: string;
  props?: Record<string, Prim>;
  since?: number;
  src?: string;
  asOf?: string;
  conf?: number;
  // undefined: use FUNCTIONAL_RELS; true: the source is the slot (one current <type> edge out of `from` to nodes of
  // the target's type); false: never close anything.
  functional?: boolean;
}

export interface ObservationInput {
  subject: string;
  metric: string;
  value: number;
  unit?: string;
  windowStart?: string;
  windowEnd?: string;
  asOf: string;
  src: string;
  simulated?: boolean;
  evidence?: string;      // the source's own words for the number (LLM extraction keeps its quote here)
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NODE_RESERVED = new Set<string>(NODE_META_PROPS);
const EDGE_RESERVED = new Set<string>(EDGE_META_PROPS);

export function isPrim(v: unknown): v is Prim {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => typeof x === "string") || v.every((x) => typeof x === "number" && Number.isFinite(x));
  return false;
}

export function checkProps(props: Record<string, unknown> | undefined, reserved: Set<string>, where: string): void {
  for (const [k, v] of Object.entries(props ?? {})) {
    if (!IDENT.test(k)) throw new InvalidWrite(`${where}: prop key ${JSON.stringify(k)} is not a plain identifier`);
    if (reserved.has(k)) throw new InvalidWrite(`${where}: prop ${k} is reserved (set it through the input field)`);
    if (v !== undefined && !isPrim(v)) throw new InvalidWrite(`${where}: prop ${k} must be a primitive or a list of strings/numbers`);
  }
}

export const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim() !== "" && s === s.trim();

export function validateNode(n: NodeInput): void {
  if (!isEntityType(n.type)) throw new InvalidWrite(`unknown entity type ${JSON.stringify(n.type)}`);
  if (!nonEmpty(n.id)) throw new InvalidWrite(`node id must be a non-empty trimmed string, got ${JSON.stringify(n.id)}`);
  const idType = typeFromId(n.id);
  if (idType !== n.type) {
    throw new InvalidWrite(`${n.id}: id prefix says ${idType ?? "no known type"}, not ${n.type} (build ids with entityId/observationId)`);
  }
  if (typeof n.name !== "string" || n.name.trim() === "") throw new InvalidWrite(`${n.id}: name must be a non-empty string`);
  checkProps(n.props, NODE_RESERVED, n.id);
  if (n.embedding && (n.embedding.length !== VECTOR_DIM || !n.embedding.every(Number.isFinite))) {
    throw new InvalidWrite(`${n.id}: embedding must be ${VECTOR_DIM} finite numbers, got ${n.embedding.length}`);
  }
}

export function validateEdge(e: EdgeInput): void {
  if (!isRelType(e.type)) throw new InvalidWrite(`unknown relationship type ${JSON.stringify(e.type)}`);
  if (!nonEmpty(e.from) || !nonEmpty(e.to)) throw new InvalidWrite(`edge ${e.type} needs non-empty from/to ids`);
  if (e.from === e.to) throw new InvalidWrite(`${e.from} cannot ${e.type} itself`);
  if (e.conf !== undefined && !(Number.isFinite(e.conf) && e.conf >= 0 && e.conf <= 1)) throw new InvalidWrite(`conf must be in [0,1], got ${e.conf}`);
  if (e.since !== undefined && !Number.isFinite(e.since)) throw new InvalidWrite(`since must be epoch ms, got ${e.since}`);
  checkProps(e.props, EDGE_RESERVED, `${e.from}-[:${e.type}]->${e.to}`);
}

// Values as FalkorDB returns them: doubles may come back rounded, so compare numbers with a relative tolerance.
export function sameValue(a: unknown, b: unknown): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  if (typeof x === "number" && typeof y === "number") return x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
  if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => sameValue(v, y[i]));
  return x === y;
}

export const defined = (o: Record<string, unknown>): Record<string, Prim> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Record<string, Prim>;

export const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
