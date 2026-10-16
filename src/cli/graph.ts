// `graph:quality <tenant>`: how clean one business's graph is (duplicates, mistyped nodes, orphans, facts with no
// source, day-one facts); read-only, safe on the live database (src/ingest/quality.ts).
// `graph:tidy <tenant>`: onboarding's tidy pass on demand (src/ingest/tidy.ts): merge near-duplicates, retype other
// businesses, retire first names, all reversible with db:unmerge. `--dry-run` says what it would do and writes nothing.
import { listGraphs, openGraph, graphName } from "../graph/client.js";
import { businessId } from "../graph/tenants.js";
import { findBusinessId } from "../actions/shared.js";
import { formatQuality, graphQuality } from "../ingest/quality.js";
import type { Command } from "./_command.js";

async function ownerOf(tenant: string): Promise<{ g: Awaited<ReturnType<typeof openGraph>>; id: string } | string> {
  if (!(await listGraphs()).includes(graphName(tenant))) return `no graph for ${tenant} (${graphName(tenant)})`;
  const g = await openGraph(tenant);
  const own = businessId(tenant);
  const [hit] = await g.roQuery<{ id: string }>("MATCH (b:Entity {id:$id}) RETURN b.id AS id", { id: own });
  const id = hit?.id ?? (await findBusinessId(g, tenant));
  return id ? { g, id } : `${tenant} has no Business node`;
}

export const commands: Command[] = [
  {
    name: "graph:quality",
    usage: "graph:quality <tenant> [--json]",
    summary: "How clean a business's graph is: duplicates, mistyped nodes, orphans, facts with no source (read-only)",
    async run(args) {
      const tenant = args.find((a) => !a.startsWith("--"));
      if (!tenant) { console.error("Usage: npm run cli -- graph:quality <tenant> [--json]"); return 2; }
      const o = await ownerOf(tenant);
      if (typeof o === "string") { console.error(o); return 1; }
      const r = await graphQuality(o.g, o.id);
      console.log(args.includes("--json") ? JSON.stringify(r, null, 1) : formatQuality(r));
      return 0;
    },
  },
];

export { ownerOf };
