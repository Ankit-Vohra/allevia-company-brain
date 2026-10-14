// Ingestion contract. Every source turns its input into a GraphWrite; the pipeline applies it with writeBatch. Sources
// never talk to FalkorDB themselves (except the extraction step reading existing ids for entity resolution), so each
// source is a pure, fixture-testable mapper.
import type { EdgeInput, NodeInput, ObservationInput } from "../graph/upsert.js";

export interface GraphWrite {
  nodes: NodeInput[];
  edges: EdgeInput[];
  observations: ObservationInput[];
}

export const emptyWrite = (): GraphWrite => ({ nodes: [], edges: [], observations: [] });

export function mergeWrites(...ws: GraphWrite[]): GraphWrite {
  return { nodes: ws.flatMap((w) => w.nodes), edges: ws.flatMap((w) => w.edges), observations: ws.flatMap((w) => w.observations) };
}

// A document as read from a source, after the privacy filter. `id` is the Document entity id; `text` is redacted.
export interface RawDoc {
  id: string;
  kind: "note" | "decision" | "report" | "agent" | "pending" | "registry" | "issue" | "webpage" | "snapshot" | "playbook" | "readme";
  title: string;
  path?: string;          // vault-relative path or URL
  url?: string;
  text: string;
  asOf?: string;          // ISO date of the source (commit date, report date, fetch date)
  hash: string;           // sha256 of the redacted text
  meta?: Record<string, string | number | boolean>;
}

export interface SourceResult {
  source: string;               // "brain", "registry", "github", "ops", "website", "instagram", "playbooks", "simads"
  docs: RawDoc[];               // documents whose text should go to LLM extraction (may be empty)
  write: GraphWrite;            // deterministic nodes/edges/observations
  skipped: Array<{ ref: string; reason: string }>;
  redactions: Record<string, number>;
}

export interface IngestReport {
  tenant: string;
  startedAt: string;
  finishedAt: string;
  sources: Array<{ source: string; docs: number; nodes: number; edges: number; observations: number; skipped: number }>;
  stats: { nodesCreated: number; nodesUpdated: number; versions: number; edgesCreated: number; edgesClosed: number; observations: number; errors: number };
  extraction: { docs: number; cached: number; entities: number; relations: number; dropped: number };
  redactions: Record<string, number>;
  privacyScanHits: number;
  vaultHead?: string;
}
