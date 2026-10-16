// `db:export` and `db:import`: copy one graph between FalkorDB servers as a logical, versioned JSON-lines file
// (src/graph/transfer.ts), for a move to a server whose version cannot load the other's dumps (docs/falkordb-cloud.md).
//
// A server is named by a URL or by `env:NAME`, which reads NAME from the environment or the env file (so a URL with a
// password never has to be typed on a command line, and is never printed: output names a server by describeUrl).
import { existsSync, readFileSync } from "node:fs";
import { expandHome, loadConfig, parseEnvFile } from "../config.js";
import { GraphHandle, connect, describeUrl, graphName, redactUrl } from "../graph/client.js";
import { META_GRAPH } from "../graph/tenants.js";
import { importDump, readDump, readGraph, writeDump } from "../graph/transfer.js";
import type { Command } from "./_command.js";

export function resolveUrl(spec: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!spec.startsWith("env:")) return spec;
  const name = spec.slice(4);
  const file = expandHome(env.ALLEVIA_ENV_FILE || "~/.config/allevia/allevia.env");
  const v = env[name] || (existsSync(file) ? parseEnvFile(readFileSync(file, "utf8"))[name] : undefined);
  if (!v) throw new Error(`${name} is not set (in the environment or the env file)`);
  return v;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
}

const positional = (args: string[], valued: string[]) =>
  args.filter((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1] ?? ""));

// "meta" is the registry; a name that already is a graph name (allevia_…) is taken as it is; anything else is a tenant.
export function sourceGraph(what: string): string {
  if (what === "meta") return META_GRAPH;
  if (/^allevia_[a-z0-9_]+$/.test(what)) return what;
  return graphName(what);
}

export const commands: Command[] = [
  {
    name: "db:export",
    usage: "db:export <tenant|meta> <file> [--from <url|env:NAME>]",
    summary: "Write one graph to a versioned JSON-lines file (every node, edge, vector, index and constraint)",
    async run(args) {
      const [what, file] = positional(args, ["--from"]);
      if (!what || !file) { console.error("Usage: npm run cli -- db:export <tenant|meta> <file> [--from <url|env:NAME>]"); return 2; }
      const url = resolveUrl(flag(args, "--from") ?? loadConfig().falkordbUrl);
      const name = sourceGraph(what);
      try {
        const db = await connect(url);
        if (!(await db.list()).includes(name)) { console.error(`${name} does not exist on ${describeUrl(url)}`); return 1; }
        const t0 = Date.now();
        const dump = await readGraph(new GraphHandle(name, db.selectGraph(name), db), db);
        await writeDump(dump, file);
        console.log(`${name} from ${describeUrl(url)} (module ${dump.header.source.moduleVersion ?? "?"}): ${dump.nodes.length} nodes, ` +
          `${dump.edges.length} edges, ${dump.header.indexes.length} indexes, ${dump.header.constraints.length} constraints -> ${file} ` +
          `(digest ${dump.end.digest.slice(0, 12)}, ${Date.now() - t0} ms)`);
        return 0;
      } catch (e) {
        console.error(`db:export: ${redactUrl((e as Error).message, url)}`);
        return 1;
      }
    },
  },
  {
    name: "db:import",
    usage: "db:import <file> --to <url|env:NAME> [--graph <name>] [--replace] [--max-memory-mb <n>]",
    summary: "Load a db:export file into a server, rebuild its indexes and constraints, and verify the copy",
    async run(args) {
      const [file] = positional(args, ["--to", "--graph", "--max-memory-mb"]);
      const to = flag(args, "--to");
      if (!file || !to) { console.error("Usage: npm run cli -- db:import <file> --to <url|env:NAME> [--graph <name>] [--replace] [--max-memory-mb <n>]"); return 2; }
      const url = resolveUrl(to);
      try {
        const dump = readDump(file);
        const r = await importDump(dump, url, {
          graph: flag(args, "--graph"), replace: args.includes("--replace"), log: (m) => console.log(`  ${m}`),
          ...(flag(args, "--max-memory-mb") ? { maxMemoryMb: Number(flag(args, "--max-memory-mb")) } : {}),
        });
        const v = r.verify;
        console.log(`${r.graph} on ${describeUrl(url)}: ${r.nodes} nodes, ${r.edges} edges, ${r.schema.indexes} indexes, ` +
          `constraints ${Object.entries(r.schema.constraints).map(([k, s]) => `${k} ${s}`).join(", ") || "none"} (${r.ms} ms)`);
        console.log(`verify: ${v.ok ? "ok" : "FAILED"}: digest ${v.summary.digest === dump.end.digest ? "equal" : "differs"}, ` +
          `id checksum ${v.summary.idChecksum.slice(0, 12)}, ${Object.keys(v.summary.labelSets).length} label sets and ` +
          `${Object.keys(v.summary.relTypes).length} relationship types counted, ${v.spotChecked} nodes spot-checked`);
        for (const p of [...r.schema.problems, ...v.problems]) console.log(`  problem: ${p}`);
        return v.ok && !r.schema.problems.length ? 0 : 1;
      } catch (e) {
        console.error(`db:import: ${redactUrl((e as Error).message, url)}`);
        return 1;
      }
    },
  },
];
