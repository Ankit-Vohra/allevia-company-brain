// `db:check`: is FalkorDB reachable, which graphs exist, which tenants are registered (with node/edge counts).
// `db:unmerge`: undo one of the librarian's merges (src/ingest/merge.ts).
import { loadConfig } from "../config.js";
import { listGraphs, openGraph, openGraphByName } from "../graph/client.js";
import { unmerge } from "../ingest/merge.js";
import { listTenants } from "../graph/tenants.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "db:check",
    usage: "db:check",
    summary: "Ping FalkorDB, list graphs and registered tenants",
    async run() {
      const url = loadConfig().falkordbUrl;
      const t0 = Date.now();
      let graphs: string[];
      try {
        graphs = await listGraphs();
      } catch (e) {
        console.error(`FalkorDB at ${url}: unreachable (${e instanceof Error ? e.message : String(e)})`);
        return 1;
      }
      console.log(`FalkorDB at ${url}: ok (${Date.now() - t0} ms)`);
      const shown = graphs.filter((g) => !g.startsWith("allevia_test_")).sort();
      const tests = graphs.length - shown.length;
      console.log(`Graphs (${graphs.length}): ${shown.join(", ") || "none"}${tests ? ` + ${tests} test graph(s)` : ""}`);
      const tenants = await listTenants();
      if (!tenants.length) { console.log("Tenants: none registered"); return 0; }
      console.log("Tenants:");
      for (const t of tenants) {
        let size = "graph missing";
        if (graphs.includes(t.graph)) {
          const g = await openGraphByName(t.graph);
          const [n] = await g.roQuery<{ c: number }>("MATCH (n) RETURN count(n) AS c");
          const [r] = await g.roQuery<{ c: number }>("MATCH ()-[r]->() RETURN count(r) AS c");
          size = `${n?.c ?? 0} nodes, ${r?.c ?? 0} edges`;
        }
        console.log(`  ${t.slug.padEnd(16)} ${t.name} · ${t.graph} · ontology v${t.ontologyVersion} · ${size}`);
      }
      return 0;
    },
  },
  {
    name: "db:unmerge",
    usage: "db:unmerge <tenant> <id>",
    summary: "Undo the librarian's merge of a duplicate node (it stays apart from then on)",
    async run(args) {
      const [tenant, id] = args;
      if (!tenant || !id) { console.error("Usage: npm run cli -- db:unmerge <tenant> <id>"); return 2; }
      const into = await unmerge(await openGraph(tenant), id);
      console.log(into ? `${id} is its own node again (it had been merged into ${into}); the librarian will leave the pair apart.` : `${id} was not merged into anything.`);
      return into ? 0 : 1;
    },
  },
];
