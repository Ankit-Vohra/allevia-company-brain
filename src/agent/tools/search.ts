// search: the agents' front door. Full-text on Entity(name, summary) and Chunk(text), plus vector search on entity
// and chunk embeddings when an embedder is injected, fused by reciprocal rank (RRF, k=60). A chunk hit surfaces its
// parent Document with a snippet, so citations point at sources rather than passages. Bookkeeping types stay out
// unless asked for by `types`.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { ENTITY_TYPES } from "../../graph/schema.js";
import {
  Collector, InputError, NODE, SEARCH_TYPES, clamp, clip, defineTool, ftQuery, ftTerms, ro, typeOf, type NodeRow,
} from "./common.js";

const RRF_K = 60;

interface ChunkRow { c: NodeRow; text: string | null; doc: NodeRow | null; score: number }
interface EntRow { n: NodeRow; summary: string | null; score: number }
interface Hit { node: NodeRow; summary?: string; snippet?: string; chunk?: NodeRow; score: number; via: Set<string>; snippetRank: number }

// ~240 chars of `text` around the first query term.
export function snippetOf(text: string, terms: string[], n = 240): string {
  const lower = text.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  const body = text.slice(start, start + n).trim();
  return `${start > 0 ? "…" : ""}${body}${start + n < text.length ? "…" : ""}`;
}

async function safe<T>(p: Promise<T[]>, errors: string[], what: string): Promise<T[]> {
  try {
    return await p;
  } catch (e) {
    errors.push(`${what} unavailable (${(e as Error).message.slice(0, 80)})`);
    return [];
  }
}

async function run(args: { query: string; types?: string[]; limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  const terms = ftTerms(args.query);
  const types = args.types?.length ? args.types : SEARCH_TYPES;
  const entityTypes = types.filter((t) => t !== "Chunk");
  const wantChunks = !args.types?.length || types.includes("Document") || types.includes("Chunk");
  const k = Math.min(50, limit * 3);
  const errors: string[] = [];

  const entCols = `${NODE("node")} AS n, node.summary AS summary, score`;
  const chunkCols = `${NODE("node")} AS c, node.text AS text, ${NODE("d")} AS doc, score`;
  const typeFilter = "WITH node, score WHERE any(l IN labels(node) WHERE l IN $types) AND NOT node:Chunk";
  const q = terms.length ? ftQuery(terms) : null;
  let vec: number[] | null = null;
  if (ctx.embedQuery) {
    try {
      vec = await ctx.embedQuery(args.query);
    } catch (e) {
      errors.push(`vector search skipped (${(e as Error).message.slice(0, 80)})`);
    }
  }
  if (!terms.length && !vec) throw new InputError("The query has no searchable words. Use nouns, e.g. 'instagram reels signups'.");

  const [ftE, ftC, vE, vC] = await Promise.all([
    q && entityTypes.length ? safe(ro<EntRow>(ctx, `CALL db.idx.fulltext.queryNodes('Entity', $q) YIELD node, score ${typeFilter}
      RETURN ${entCols} ORDER BY score DESC, node.id LIMIT $k`, { q, types: entityTypes, k }), errors, "full-text") : [],
    q && wantChunks ? safe(ro<ChunkRow>(ctx, `CALL db.idx.fulltext.queryNodes('Chunk', $q) YIELD node, score
      OPTIONAL MATCH (d:Document)-[:HAS_CHUNK]->(node) RETURN ${chunkCols} ORDER BY score DESC, node.id LIMIT $k`, { q, k }), errors, "chunk full-text") : [],
    // The `node.id` tiebreak is load-bearing: FalkorDB 6.0.2 panics (and restarts) sorting on score alone when two
    // scores tie and map columns are projected ("comparison function does not correctly implement a total order").
    vec && entityTypes.length ? safe(ro<EntRow>(ctx, `CALL db.idx.vector.queryNodes('Entity', 'embedding', $k, vecf32($v)) YIELD node, score ${typeFilter}
      RETURN ${entCols} ORDER BY score ASC, node.id`, { v: vec, types: entityTypes, k: limit * 2 }), errors, "vector") : [],
    vec && wantChunks ? safe(ro<ChunkRow>(ctx, `CALL db.idx.vector.queryNodes('Chunk', 'textEmbedding', $k, vecf32($v)) YIELD node, score
      OPTIONAL MATCH (d:Document)-[:HAS_CHUNK]->(node) RETURN ${chunkCols} ORDER BY score ASC, node.id`, { v: vec, k: limit * 2 }), errors, "chunk vector") : [],
  ]);

  // Reciprocal rank fusion. Within one list a key counts once, at its best rank.
  const hits = new Map<string, Hit>();
  const add = (key: string, node: NodeRow, rank: number, via: string, extra: Partial<Hit> = {}) => {
    const h = hits.get(key) ?? { node, score: 0, via: new Set<string>(), snippetRank: Infinity };
    h.score += 1 / (RRF_K + rank);
    h.via.add(via);
    if (extra.summary && !h.summary) h.summary = extra.summary;
    if (extra.snippet && rank < h.snippetRank) Object.assign(h, { snippet: extra.snippet, chunk: extra.chunk, snippetRank: rank });
    hits.set(key, h);
  };
  const fuseEntities = (rows: EntRow[], via: string) => {
    const seen = new Set<string>();
    rows.forEach((r) => {
      if (seen.has(r.n.id)) return;
      seen.add(r.n.id);
      add(r.n.id, r.n, seen.size, via, { summary: clip(r.summary, 200) });
    });
  };
  const fuseChunks = (rows: ChunkRow[], via: string) => {
    const seen = new Set<string>();
    rows.forEach((r) => {
      const parent = r.doc?.id ? r.doc : r.c;
      if (seen.has(parent.id)) return;
      seen.add(parent.id);
      add(parent.id, parent, seen.size, via, { snippet: r.text ? snippetOf(r.text, terms) : undefined, chunk: r.c });
    });
  };
  fuseEntities(ftE, "text");
  fuseChunks(ftC, "chunk-text");
  fuseEntities(vE, "vector");
  fuseChunks(vC, "chunk-vector");

  const top = [...hits.values()].sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id)).slice(0, limit);
  const col = new Collector();
  const out = top.map((h) => {
    col.node(h.node);
    if (h.chunk && h.chunk.id !== h.node.id) {
      col.node(h.chunk);
      col.edge({ from: h.node.id, type: "HAS_CHUNK", to: h.chunk.id, since: null, until: null });
    }
    return {
      id: h.node.id, type: typeOf(h.node), name: h.node.name ?? h.node.id,
      ...(h.summary ? { summary: h.summary } : {}),
      ...(h.snippet ? { snippet: h.snippet, chunk: h.chunk?.id } : {}),
      score: Math.round(h.score * 10_000) / 10_000, via: [...h.via],
    };
  });
  const notes = [...(out.length ? [] : ["No matches. Try other words, fewer type filters, or get_entity with a known id."]), ...errors];
  return col.result(ctx, { query: args.query, hits: out }, notes.join(" ") || undefined);
}

export const search = defineTool({
  name: "search",
  description:
    "Find entities and documents by meaning or words; start here when you lack an id. Returns ranked hits {id, type, name, summary or snippet from the source document} from full-text and vector search. Turns, versions and observations only when named in types. For 'why did we…' questions use trace_decision. Example: {\"query\":\"instagram token refresh\",\"types\":[\"System\",\"Task\",\"Document\"],\"limit\":5}",
  input: {
    query: z.string().min(1).describe("What to look for, in plain words"),
    types: z.array(z.enum(ENTITY_TYPES)).optional().describe("Only these node types"),
    limit: z.number().int().optional().describe("Max hits, default 10, max 25"),
  },
  run,
});
