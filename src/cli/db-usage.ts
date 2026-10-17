// `db:usage`: how full the database is (src/graph/usage.ts). FalkorDB Cloud's free plan is 100 MB and refuses writes when full, so this
// prints the memory used and the limit, each graph's own share, and warns from 80 percent. Read-only; works on Cloud 4.22 (INFO memory,
// GRAPH.MEMORY USAGE). A server is named by a URL or `env:NAME`, as in db:export, and is never printed.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { connect, describeUrl, redactUrl } from "../graph/client.js";
import { CRITICAL_AT, WARN_AT, assess, readGraphUsage, readMemory } from "../graph/usage.js";
import type { Command } from "./_command.js";
import { resolveUrl } from "./db-transfer.js";

const fmt = (mb: number): string => `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
const SHOWN = 12;

export const commands: Command[] = [
  {
    name: "db:usage",
    usage: "db:usage [--on <url|env:NAME>] [--limit-mb <n>] [--all]",
    summary: "How full the database is: memory used against its limit, each graph's share; warns from 80% (exit 3 at 80% or more)",
    async run(args) {
      let values: { on?: string; "limit-mb"?: string; all?: boolean };
      try {
        values = parseArgs({ args, allowPositionals: false, options: { on: { type: "string" }, "limit-mb": { type: "string" }, all: { type: "boolean" } } }).values;
      } catch (e) {
        console.error(`${(e as Error).message.split("\n")[0]}\nUsage: npm run cli -- db:usage [--on <url|env:NAME>] [--limit-mb <n>] [--all]`);
        return 2;
      }
      let flagMb: number | undefined;
      if (values["limit-mb"] !== undefined) {
        flagMb = Number(values["limit-mb"]);
        if (!(Number.isFinite(flagMb) && flagMb > 0)) { console.error(`--limit-mb must be a number of MB above 0, got "${values["limit-mb"]}"`); return 2; }
      }
      const cfg = loadConfig();
      const url = resolveUrl(values.on ?? cfg.falkordbUrl);
      try {
        const db = await connect(url);
        const info = await readMemory(db);
        const a = assess(info, { ...(flagMb !== undefined ? { flagMb } : {}), ...(cfg.dbLimitMb !== undefined ? { envMb: cfg.dbLimitMb } : {}) });
        const graphs = await readGraphUsage(db);

        const head = a.limitMb === null
          ? `${describeUrl(url)}: ${fmt(info.usedMb)} used; the server reports no limit (set ALLEVIA_DB_LIMIT_MB, or pass --limit-mb, to see how full it is)`
          : `${describeUrl(url)}: ${fmt(info.usedMb)} used of ${fmt(a.limitMb)} (${a.percent!.toFixed(0)}%), ${fmt(a.roomMb!)} free${a.limitFrom === "server" ? "" : ` (limit from ${a.limitFrom === "flag" ? "--limit-mb" : "ALLEVIA_DB_LIMIT_MB"})`}`;
        console.log(head);
        console.log(`  peak ${info.peakMb === null ? "unknown" : fmt(info.peakMb)}${info.policy ? `, when full: ${info.policy === "noeviction" ? "writes fail (noeviction)" : info.policy}` : ""}`);

        const real = graphs.filter((g) => !g.projection);
        const projections = graphs.filter((g) => g.projection);
        const own = graphs.reduce((s, g) => s + (g.mb ?? 0), 0);
        console.log(`  graphs: ${real.length}, using ${fmt(own)} of their own (the rest is Redis, indexes and cached projections)`);
        for (const g of (values.all ? graphs : graphs.slice(0, SHOWN))) console.log(`    ${g.graph.padEnd(34)} ${g.mb === null ? "n/a" : fmt(g.mb)}${g.projection ? "  (cached projection)" : ""}`);
        if (!values.all && graphs.length > SHOWN) console.log(`    … and ${graphs.length - SHOWN} more (--all lists every graph)`);
        if (projections.length) console.log(`  ${projections.length} cached projection${projections.length === 1 ? "" : "s"}: ${fmt(projections.reduce((s, g) => s + (g.mb ?? 0), 0))}; they go with their graph and are rebuilt when needed`);

        const tests = graphs.filter((g) => g.graph.startsWith("allevia_test_"));
        if (a.level === "warning" || a.level === "critical") {
          console.error(`${a.level === "critical" ? "CRITICAL" : "WARNING"}: the database is ${a.percent!.toFixed(0)}% full (${fmt(info.usedMb)} of ${fmt(a.limitMb!)}); ` +
            `${a.level === "critical" ? "writes are about to fail" : `warning from ${WARN_AT * 100}%, critical from ${CRITICAL_AT * 100}%`}, and a full plan refuses every write.`);
          if (tests.length) console.error(`  ${tests.length} test graph${tests.length === 1 ? "" : "s"} (allevia_test_…) ${tests.length === 1 ? "is" : "are"} using ${fmt(tests.reduce((s, g) => s + (g.mb ?? 0), 0))}: drop ${tests.length === 1 ? "it" : "them"} first.`);
          console.error("  Then: erase a business that is not needed (tenant:erase), or move to a bigger plan.");
          return 3;
        }
        return 0;
      } catch (e) {
        console.error(`db:usage: ${redactUrl((e as Error).message, url)}`);
        return 1;
      }
    },
  },
];
