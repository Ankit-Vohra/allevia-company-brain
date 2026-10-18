// Keeping business graphs clean, phase 2 (docs/product-plan-after-hackathon.md §9; src/graph/compact.ts).
// `graph:compact <tenant>`: weekly roll-ups of old readings, passages no current document holds, and facts that ended
// long ago. A dry run by default: it prints what it would fold and move, and writes nothing. With --apply it first writes a
// checked tenant:export backup to ~/allevia-db-backups/pre-compact-<tenant>-<date>.export, then the archive of exactly
// what it removes to ~/allevia-db-backups/archive/, then changes the graph. A business whose backup fails is left alone.
// `graph:compact-undo <archive>`: puts an archive back (a dry run unless --apply).
// `--graph <name>` acts on any graph by name instead (a scratch copy: its backup is a db:export of that graph), and
// `--on <url|env:NAME>` picks the server (default: the configured one).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { GraphHandle, connect, describeUrl, graphName, redactUrl } from "../graph/client.js";
import { STEPS, compactGraph, formatCompact, readArchive, restoreArchive, type Step } from "../graph/compact.js";
import { readGraph, writeDump, readDump, summarize } from "../graph/transfer.js";
import { exportTenant, verifyTenantExport } from "../tenant/lifecycle.js";
import { BACKUP_DIR } from "./hygiene.js";
import { resolveUrl } from "./db-transfer.js";
import type { Command } from "./_command.js";

const stamp = (now: number): string => new Date(now).toISOString().replace(/[:.]/g, "-");

async function handle(url: string, name: string): Promise<GraphHandle | null> {
  const db = await connect(url);
  if (!(await db.list()).includes(name)) return null;
  return new GraphHandle(name, db.selectGraph(name), db);
}

function steps(v: string | undefined): Step[] {
  if (!v) return STEPS;
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of out) if (!STEPS.includes(s as Step)) throw new Error(`unknown step "${s}" (steps: ${STEPS.join(", ")})`);
  return out as Step[];
}

const days = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!(Number.isInteger(n) && n >= 7)) throw new Error(`--${name} must be a whole number of days, 7 or more`);
  return n;
};

export const commands: Command[] = [
  {
    name: "graph:compact",
    usage: "graph:compact <tenant> [--apply] [--steps rollup,chunks,closed] [--reading-days 90] [--closed-days 180] [--backup-dir <dir>] [--graph <name>] [--on <url|env:NAME>] [--json]",
    summary: "Fold old daily readings into weekly ones, and move unheld passages and long-closed facts to an archive (dry run unless --apply, which backs up first)",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: {
          apply: { type: "boolean" }, json: { type: "boolean" }, steps: { type: "string" }, graph: { type: "string" }, on: { type: "string" },
          "reading-days": { type: "string" }, "closed-days": { type: "string" }, "archive-dir": { type: "string" }, "backup-dir": { type: "string" },
        },
      });
      const [slug] = positionals;
      if ((!slug && !values.graph) || positionals.length > 1) {
        console.error("Usage: npm run cli -- graph:compact <tenant> [--apply] [--steps rollup,chunks,closed] [--graph <name>] [--on <url|env:NAME>]");
        return 2;
      }
      const url = resolveUrl(values.on ?? loadConfig().falkordbUrl);
      const name = values.graph ?? graphName(slug!);
      const label = slug ?? name;
      try {
        const g = await handle(url, name);
        if (!g) { console.error(`no graph ${name} on ${describeUrl(url)}`); return 1; }
        const now = Date.now();
        let archiveFile: string | undefined;
        if (values.apply) {
          const backups = values["backup-dir"] ?? BACKUP_DIR;
          mkdirSync(backups, { recursive: true });
          // a checked backup first, or nothing happens
          if (values.graph) {
            const file = join(backups, `pre-compact-${name}-${stamp(now)}.export`);
            const dump = await readGraph(g, await connect(url));
            await writeDump(dump, file);
            const back = readDump(file);
            if (summarize(back.nodes, back.edges).digest !== dump.end.digest) throw new Error(`the backup ${file} does not read back whole`);
            console.log(`${label}: backed up to ${file}`);
          } else {
            const file = join(backups, `pre-compact-${slug!}-${stamp(now)}.export`);
            await exportTenant(slug!, file, { dataDir: loadConfig().dataDir, now });
            const check = await verifyTenantExport(file);
            if (!check.ok) throw new Error(`the backup does not read back whole: ${check.problems.join("; ")}`);
            console.log(`${label}: backed up to ${file}`);
          }
          const dir = values["archive-dir"] ?? join(backups, "archive");
          mkdirSync(dir, { recursive: true });
          archiveFile = join(dir, `${name}-${stamp(now)}.archive.jsonl`);
        }
        const r = await compactGraph(g, {
          steps: steps(values.steps), apply: values.apply === true, now, archiveFile,
          readingDays: days(values["reading-days"], "reading-days"), closedDays: days(values["closed-days"], "closed-days"),
        });
        console.log(values.json ? JSON.stringify({ ...r, rollup: r.rollup && { ...r.rollup, plan: { ...r.rollup.plan, weeks: r.rollup.plan.weeks.length } } }, null, 1) : formatCompact(label, r));
        if (archiveFile) console.log(`  undo: npm run cli -- graph:compact-undo ${archiveFile} --apply${values.graph ? ` --graph ${name}` : ""}`);
        return 0;
      } catch (e) {
        console.error(`graph:compact: ${redactUrl((e as Error).message, url)}`);
        return 1;
      }
    },
  },
  {
    name: "graph:compact-undo",
    usage: "graph:compact-undo <archive> [--apply] [--graph <name>] [--on <url|env:NAME>]",
    summary: "Put back what a graph:compact archive removed and take out its weekly roll-ups (dry run unless --apply)",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true, options: { apply: { type: "boolean" }, graph: { type: "string" }, on: { type: "string" } },
      });
      const [file] = positionals;
      if (!file || positionals.length > 1) { console.error("Usage: npm run cli -- graph:compact-undo <archive> [--apply] [--graph <name>]"); return 2; }
      const url = resolveUrl(values.on ?? loadConfig().falkordbUrl);
      try {
        const a = readArchive(file);
        const name = values.graph ?? a.header.graph;
        const g = await handle(url, name);
        if (!g) { console.error(`no graph ${name} on ${describeUrl(url)}`); return 1; }
        const r = await restoreArchive(g, file, { apply: values.apply === true });
        console.log(`${name}: ${r.applied ? "restored" : "a dry run (--apply to do it)"}: ${r.nodes} things ${r.applied ? "put back" : "to put back"} ` +
          `(${r.nodesThere} already there), ${r.edges} links${r.edgesSkipped ? ` (${r.edgesSkipped} skipped: an end is gone)` : ""}, ` +
          `${r.rollupsRemoved} weekly roll-ups ${r.applied ? "removed" : "to remove"}`);
        return 0;
      } catch (e) {
        console.error(`graph:compact-undo: ${redactUrl((e as Error).message, url)}`);
        return 1;
      }
    },
  },
];
