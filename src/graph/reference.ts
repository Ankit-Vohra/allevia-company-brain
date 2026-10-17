// The shared reference graph `allevia_reference`: one read-only copy of the general know-how every business uses (the
// playbooks, their Rules, the Google update timeline, the ad platforms' policies; what is in it: src/ingest/sources/reference.ts).
//
// - Written only by ensureReference (onboarding, ingest and `graph:reference-split` call it), idempotently, and only when the
//   vendored data changed (a hash on a ReferenceMeta node). Nothing else writes it; agents read it with roQuery.
// - A business graph keeps business facts, plus a stub (same id, `refStub: true`) of each reference node something of the
//   business points at. referenceFilter() is how a read tells a reference node (or a stub) from a business one, in a business
//   graph that has not been split yet as well as one that has.
// - ALLEVIA_REFERENCE_GRAPH points it elsewhere (tests use a throwaway one per file). "reference" is a reserved tenant slug, so
//   no business can be named allevia_reference.
import { openGraphByName, type GraphHandle, type QueryOpts } from "./client.js";
import { ensureIndexes } from "./indexes.js";
import { writeBatch } from "./batch.js";
import type { NodeInput } from "./validate.js";
import { VENDOR_DOC_PREFIX, referenceHash, referenceIds, referenceWrite, refStubNode } from "../ingest/sources/reference.js";

export const REFERENCE_GRAPH = "allevia_reference";
export const referenceGraphName = (): string => process.env.ALLEVIA_REFERENCE_GRAPH ?? REFERENCE_GRAPH;

let opened = false;
export async function openReference(): Promise<GraphHandle> {
  opened = true;
  return openGraphByName(referenceGraphName());
}
// Whether this process opened the reference graph (the test setup drops its throwaway one only then).
export const referenceOpened = (): boolean => opened;

const absent = (e: unknown): boolean => /empty key|no such|not exist/i.test(String((e as Error)?.message));

// A read on the reference graph; [] while it has not been loaded yet (a server before its first onboarding or split).
export async function readReference<T = Record<string, unknown>>(cypher: string, params?: Record<string, unknown>, opts?: QueryOpts & { graph?: GraphHandle }): Promise<T[]> {
  const g = opts?.graph ?? await openReference();
  try {
    return await g.roQuery<T>(cypher, params, opts);
  } catch (e) {
    if (absent(e)) return [];
    throw e;
  }
}

// ---------- telling reference nodes apart ----------

// A Cypher condition, true for a reference node (or its stub) bound to `a`. Needs the params of referenceParams(). By id
// (the current reference write), by stub flag, and by source (a Rule or Event mapped from a vendored file, also from an older
// version of a pack), so a business graph that still holds the copy shows only its business facts.
export const referenceFilter = (a: string): string =>
  `(${a}.id IN $refIds OR coalesce(${a}.refStub, false) = true OR ${a}.id STARTS WITH $refDocPrefix OR coalesce(${a}.src, '') STARTS WITH $refDocPrefix)`;
export const referenceParams = (): { refIds: string[]; refDocPrefix: string } => ({ refIds: [...referenceIds()], refDocPrefix: VENDOR_DOC_PREFIX });

// ---------- loading ----------

export interface ReferenceLoad { graph: string; loaded: boolean; hash: string; nodes: number; edges: number; errors: string[] }

let loadedHash: string | undefined; // per process: the hash this process already saw in the reference graph

// Loads the reference graph when it is missing or older than the vendored data. Idempotent (every write MERGEs on ids), so
// two onboardings starting at once only repeat each other's work.
export async function ensureReference(opts: { force?: boolean; graph?: GraphHandle; now?: number } = {}): Promise<ReferenceLoad> {
  const g = opts.graph ?? await openReference();
  const hash = referenceHash();
  const w = referenceWrite();
  const base = { graph: g.name, hash, nodes: w.nodes.length, edges: w.edges.length };
  if (!opts.force && loadedHash === hash && !opts.graph) return { ...base, loaded: false, errors: [] };
  if (!opts.force) {
    const [m] = await g.peek<{ h: string | null }>("MATCH (m:ReferenceMeta {key:'version'}) RETURN m.hash AS h");
    if (m?.h === hash) {
      if (!opts.graph) loadedHash = hash;
      return { ...base, loaded: false, errors: [] };
    }
  }
  await ensureIndexes(g);
  const s = await writeBatch(g, w, opts.now ?? Date.now());
  const errors = s.errors.map((e) => `${e.kind} ${"id" in e.item ? e.item.id : ""}: ${e.error}`);
  if (!errors.length) {
    await g.query("MERGE (m:ReferenceMeta {key:'version'}) SET m.hash = $hash, m.loadedAt = $now, m.nodes = $nodes, m.edges = $edges",
      { hash, now: opts.now ?? Date.now(), nodes: w.nodes.length, edges: w.edges.length });
    if (!opts.graph) loadedHash = hash;
  }
  return { ...base, loaded: true, errors };
}

// ---------- stubs ----------

// Stubs in a business graph for the reference ids among `ids` it does not hold yet (an answer that cited a rule, a card based
// on one), so the business's edge to it has an endpoint and the citation still resolves. Returns the ids now present.
export async function ensureReferenceStubs(g: GraphHandle, ids: Iterable<string>, now: number = Date.now()): Promise<string[]> {
  const want = [...new Set(ids)].filter((id) => referenceIds().has(id));
  if (!want.length) return [];
  const have = new Set((await g.peek<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids: want })).map((r) => r.id));
  const stubs = want.filter((id) => !have.has(id)).map((id) => refStubNode(id)).filter((n): n is NodeInput => !!n);
  if (!stubs.length) return want.filter((id) => have.has(id));
  const s = await writeBatch(g, { nodes: stubs }, now);
  const failed = new Set(s.errors.map((e) => (e.item as NodeInput).id));
  return want.filter((id) => have.has(id) || (stubs.some((n) => n.id === id) && !failed.has(id)));
}
