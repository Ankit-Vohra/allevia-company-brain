// `ingest`: run the ingestion pipeline for a tenant, printing progress and the report summary.
// `privacy-scan`: scan every string in a tenant's graph for what the redaction engine would remove; must report 0.
// Neither prints a matched value: the scan shows node ids, property names and masked samples only.
import { parseArgs } from "node:util";
import { openGraph } from "../graph/client.js";
import { scanGraph } from "../ingest/privacy.js";
import { runIngest, type PipelineReport } from "../ingest/pipeline.js";
import { SOURCE_NAMES, isSourceName, tenantConfig, type SourceName } from "../tenant-config.js";
import type { Command } from "./_command.js";

export interface IngestArgs { tenant: string; sources?: SourceName[]; limitDocs?: number; model?: string; dryRun: boolean }

export function parseIngestArgs(args: string[]): IngestArgs {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { sources: { type: "string" }, "limit-docs": { type: "string" }, model: { type: "string" }, "dry-run": { type: "boolean" } },
  });
  const [tenant] = positionals;
  if (!tenant || positionals.length > 1) throw new Error("expected exactly one tenant");
  const out: IngestArgs = { tenant, dryRun: values["dry-run"] === true };
  if (values.sources !== undefined) {
    const list = values.sources.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = list.filter((s) => !isSourceName(s));
    if (bad.length || !list.length) throw new Error(`unknown source(s) ${bad.join(", ") || "(none)"}; choose from ${SOURCE_NAMES.join(", ")}`);
    out.sources = [...new Set(list)] as SourceName[];
  }
  if (values["limit-docs"] !== undefined) {
    const n = Number(values["limit-docs"]);
    if (!Number.isInteger(n) || n < 0) throw new Error(`--limit-docs must be a whole number, got ${values["limit-docs"]}`);
    out.limitDocs = n;
  }
  if (values.model) out.model = values.model;
  return out;
}

const fmt = (o: Record<string, number>, max = 40) =>
  Object.entries(o).slice(0, max).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

export function formatReport(r: PipelineReport, reportPath: string): string {
  const x = r.extraction;
  const lines = [
    "",
    `Ingest ${r.tenant}${r.dryRun ? " (dry run: nothing written, no model calls)" : ""} · ${(r.durationMs / 1000).toFixed(1)} s · model ${r.model}${r.vaultHead ? ` · vault ${r.vaultHead.slice(0, 12)}` : ""}`,
    "Sources:",
    ...r.sources.map((s) => `  ${s.source.padEnd(10)} ${s.nodes} nodes, ${s.edges} edges, ${s.observations} observations, ${s.docs} docs, ${s.skipped} skipped`),
    `Extraction: ${x.candidates} candidates · ${x.docs} extracted (${x.cached} cached) · ${x.skipped} over the limit · ${x.failed} failed · ${x.entities} entities, ${x.relations} relations, ${x.observations} numbers, ${x.dropped} dropped, ${x.olderReadings} older readings kept out`,
  ];
  if (!r.dryRun) {
    lines.push(
      `Writes: +${r.stats.nodesCreated} nodes (${r.stats.nodesUpdated} updated, ${r.stats.versions} versions), +${r.stats.edgesCreated} edges (${r.stats.edgesClosed} closed), ${r.stats.observations} observations, ${r.stats.errors} errors`,
      `Embeddings: ${r.embeddings.entities} entities, ${r.embeddings.chunks} chunks`,
    );
    if (r.librarian) {
      const m = r.librarian.merge;
      lines.push(`Merges: ${m.merged} duplicate(s) in ${m.groups} group(s) · ${m.edgesMoved} edges moved · ${m.credentialLinks} new credential link(s)` +
        `${m.skipped.length ? ` · ${m.skipped.length} left alone` : ""}${m.errors.length ? ` · ${m.errors.length} errors` : ""}`);
      lines.push(`Librarian: KNOWS_ABOUT ${r.librarian.knowsAbout.edges} (${r.librarian.knowsAbout.created} new, ${r.librarian.knowsAbout.closed} closed) · ${r.librarian.community.communities} communities · ${r.librarian.orphans.count} orphans (${fmt(r.librarian.orphans.byType)})`);
    }
    lines.push(
      `Graph nodes: ${fmt(r.graph.nodes)}`,
      `Graph edges (current): ${fmt(r.graph.edges)}`,
      `Redactions: ${fmt(r.redactions)}`,
      `Privacy scan: ${r.privacyScanHits} hits`,
    );
  } else {
    lines.push(`Would extract: ${x.order.length} documents (first: ${x.order.slice(0, 5).join(", ") || "none"})`);
  }
  if (r.writeErrors.length) lines.push(`Write errors (first 5): ${r.writeErrors.slice(0, 5).map((e) => `${e.ref}: ${e.error}`).join(" | ")}`);
  if (x.failures.length) lines.push(`Extraction failures: ${x.failures.slice(0, 5).map((f) => `${f.id}: ${f.error}`).join(" | ")}`);
  if (reportPath) lines.push(`Report: ${reportPath}`);
  return lines.join("\n");
}

export const commands: Command[] = [
  {
    name: "ingest",
    usage: "ingest <tenant> [--sources brain,ops,playbooks,simads,github] [--limit-docs N] [--model haiku] [--dry-run]",
    summary: "Ingest a tenant's sources into its graph (LLM extraction on the subscription)",
    async run(args) {
      let a: IngestArgs;
      try {
        a = parseIngestArgs(args);
        tenantConfig(a.tenant);
      } catch (e) {
        console.error(`ingest: ${(e as Error).message}\nUsage: npm run cli -- ${commands[0]!.usage}`);
        return 2;
      }
      const { report, reportPath } = await runIngest(a.tenant, {
        ...(a.sources ? { sources: a.sources } : {}), ...(a.limitDocs !== undefined ? { limitDocs: a.limitDocs } : {}),
        ...(a.model ? { model: a.model } : {}), dryRun: a.dryRun, log: (line) => console.log(line),
      });
      console.log(formatReport(report, reportPath));
      return report.stats.errors || report.extraction.failed ? 1 : 0;
    },
  },
  {
    name: "privacy-scan",
    usage: "privacy-scan <tenant>",
    summary: "Scan every string in a tenant's graph for secrets and personal data (must be 0)",
    async run(args) {
      const [tenant] = args;
      if (!tenant) { console.error("Usage: npm run cli -- privacy-scan <tenant>"); return 2; }
      const g = await openGraph(tenant);
      const t0 = Date.now();
      const hits = await scanGraph(g);
      const [n] = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
      const [r] = await g.roQuery<{ c: number }>("MATCH ()-[r]->() RETURN count(r) AS c");
      console.log(`privacy-scan ${tenant}: ${hits.length} hit(s) in ${n?.c ?? 0} nodes and ${r?.c ?? 0} edges (${Date.now() - t0} ms)`);
      for (const h of hits.slice(0, 50)) console.log(`  ${h.kind.padEnd(14)} ${h.id} .${h.prop}  ${h.sample}`);
      if (hits.length > 50) console.log(`  … and ${hits.length - 50} more`);
      return hits.length ? 1 : 0;
    },
  },
];
