// Keeping business graphs clean (docs/product-plan-after-hackathon.md §9, phase 1).
// `graph:reference-split [--apply] [tenant…]`: moves the general know-how out of business graphs into the shared reference graph
// (src/graph/reference-split.ts). A dry run by default: it prints what it would remove and what it would keep as stubs, and
// writes nothing. With --apply it first exports each business with tenant:export to ~/allevia-db-backups/pre-split-<tenant>-<date>.export
// (checked to read back whole), then loads allevia_reference once, then splits each business. A business whose backup fails is
// left alone.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { listTenants } from "../graph/tenants.js";
import { ensureReference, referenceGraphName } from "../graph/reference.js";
import { formatSplit, splitReference, type SplitReport } from "../graph/reference-split.js";
import { exportTenant, verifyTenantExport } from "../tenant/lifecycle.js";
import { isoDate } from "../util/time.js";
import type { Command } from "./_command.js";

export const BACKUP_DIR = join(homedir(), "allevia-db-backups");

export interface SplitRun {
  tenants: Array<{ slug: string; report?: SplitReport; backup?: string; error?: string }>;
  reference?: { graph: string; loaded: boolean; nodes: number; errors: string[] };
}

// The backup file for a business: pre-split-<tenant>-<date>.export, with the time added when one of that day exists.
export function backupFile(dir: string, slug: string, now: number): string {
  const day = join(dir, `pre-split-${slug}-${isoDate(now)}.export`);
  return existsSync(day) ? join(dir, `pre-split-${slug}-${new Date(now).toISOString().replace(/[:.]/g, "-")}.export`) : day;
}

export async function runReferenceSplit(o: {
  tenants?: string[]; apply?: boolean; backupDir?: string; dataDir: string; now?: number; log?: (line: string) => void;
}): Promise<SplitRun> {
  const log = o.log ?? (() => undefined);
  const graphs = new Set(await listGraphs());
  const slugs = o.tenants?.length ? o.tenants : (await listTenants()).map((t) => t.slug);
  const run: SplitRun = { tenants: [] };
  const now = o.now ?? Date.now();
  const ready: string[] = [];
  for (const slug of slugs) {
    if (!graphs.has(graphName(slug))) { run.tenants.push({ slug, error: `no graph ${graphName(slug)}` }); continue; }
    if (!o.apply) {
      run.tenants.push({ slug, report: await splitReference(await openGraph(slug)) });
      continue;
    }
    // apply: a checked backup first, or nothing happens to this business
    const dir = o.backupDir ?? BACKUP_DIR;
    mkdirSync(dir, { recursive: true });
    const file = backupFile(dir, slug, now);
    try {
      await exportTenant(slug, file, { dataDir: o.dataDir, now });
      const check = await verifyTenantExport(file);
      if (!check.ok) throw new Error(`the backup does not read back whole: ${check.problems.join("; ")}`);
      log(`${slug}: backed up to ${file}`);
      run.tenants.push({ slug, backup: file });
      ready.push(slug);
    } catch (e) {
      run.tenants.push({ slug, error: `backup failed, left alone: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (!o.apply || !ready.length) return run;
  const ref = await ensureReference({ now });
  run.reference = { graph: ref.graph, loaded: ref.loaded, nodes: ref.nodes, errors: ref.errors };
  if (ref.errors.length) {
    for (const t of run.tenants) if (ready.includes(t.slug)) t.error = `the reference graph did not load cleanly (${ref.errors[0]}), so nothing was removed`;
    return run;
  }
  for (const t of run.tenants) {
    if (!ready.includes(t.slug)) continue;
    t.report = await splitReference(await openGraph(t.slug), { apply: true, now });
  }
  return run;
}

export const commands: Command[] = [
  {
    name: "graph:reference-split",
    usage: "graph:reference-split [--apply] [--json] [tenant…]",
    summary: "Move the shared playbooks, rules and Google update timeline out of business graphs (dry run unless --apply, which backs each business up first)",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { apply: { type: "boolean" }, json: { type: "boolean" } } });
      const r = await runReferenceSplit({
        tenants: positionals, apply: values.apply === true, dataDir: loadConfig().dataDir, log: (l) => console.log(l),
      });
      if (values.json) { console.log(JSON.stringify(r, null, 1)); return r.tenants.some((t) => t.error) ? 1 : 0; }
      console.log(values.apply ? "Splitting the general know-how out of each business:" : `Dry run (nothing is changed; add --apply to do it). Shared reference graph: ${referenceGraphName()}`);
      if (r.reference) console.log(`Reference graph ${r.reference.graph}: ${r.reference.loaded ? `loaded, ${r.reference.nodes} nodes` : "already up to date"}`);
      for (const t of r.tenants) {
        if (t.report) console.log(formatSplit(t.slug, t.report));
        if (t.backup) console.log(`  backup: ${t.backup}`);
        if (t.error) console.error(`${t.slug}: ${t.error}`);
      }
      return r.tenants.some((t) => t.error) ? 1 : 0;
    },
  },
];
