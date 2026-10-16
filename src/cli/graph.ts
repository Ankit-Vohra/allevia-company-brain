// `graph:quality <tenant>`: how clean one business's graph is (duplicates, mistyped nodes, orphans, facts with no
// source, day-one facts); read-only, safe on the live database (src/ingest/quality.ts).
// `graph:tidy <tenant>`: onboarding's tidy pass on demand (src/ingest/tidy.ts): merge near-duplicates, retype other
// businesses, retire first names, all reversible with db:unmerge. `--dry-run` says what it would do and writes nothing.
// `graph:story <tenant>`: how the business's brain grew, nodes and edges per day or week by kind (src/graph/story.ts);
// read-only, the numbers behind the website's "it keeps growing".
import { listGraphs, openGraph, graphName } from "../graph/client.js";
import { businessId } from "../graph/tenants.js";
import { findBusinessId } from "../actions/shared.js";
import { formatQuality, graphQuality } from "../ingest/quality.js";
import { tidyGraph } from "../ingest/tidy.js";
import { formatStory, graphStory, type StoryAxis, type StoryBucket } from "../graph/story.js";
import { embedPassages } from "../ingest/embed.js";
import { AgentSdkRunner } from "../ingest/llm.js";
import { makeAsk } from "../ingest/sources/website/ask.js";
import { loadConfig } from "../config.js";
import { tenantCacheDir } from "../util/cache.js";
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
  {
    name: "graph:story",
    usage: "graph:story <tenant> [--by recorded|happened] [--bucket day|week] [--json]",
    summary: "How a business's brain grew: nodes and edges per week by kind, from the graph itself (read-only)",
    async run(args) {
      const tenant = args.find((a) => !a.startsWith("--") && !["recorded", "happened", "source", "day", "week"].includes(a));
      if (!tenant) { console.error("Usage: npm run cli -- graph:story <tenant> [--by recorded|happened] [--bucket day|week] [--json]"); return 2; }
      const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
      const by = flag("by") ?? "recorded";
      const bucket = flag("bucket") ?? "auto";
      if (!["recorded", "happened", "source"].includes(by)) { console.error('--by is "recorded" (when the team learned it) or "happened" (the date of the source)'); return 2; }
      if (!["auto", "day", "week"].includes(bucket)) { console.error('--bucket is "day" or "week"'); return 2; }
      if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`no graph for ${tenant} (${graphName(tenant)})`); return 1; }
      const g = await openGraph(tenant);
      const s = await graphStory(g, { axis: (by === "recorded" ? "recorded" : "source") as StoryAxis, bucket: bucket as StoryBucket | "auto", tenant });
      console.log(args.includes("--json") ? JSON.stringify(s, null, 1) : formatStory(s));
      return 0;
    },
  },
  {
    name: "graph:tidy",
    usage: "graph:tidy <tenant> [--dry-run] [--no-model]",
    summary: "Merge near-duplicates, retype other businesses, retire first names (undo one with db:unmerge)",
    async run(args) {
      const tenant = args.find((a) => !a.startsWith("--"));
      if (!tenant) { console.error("Usage: npm run cli -- graph:tidy <tenant> [--dry-run] [--no-model]"); return 2; }
      const o = await ownerOf(tenant);
      if (typeof o === "string") { console.error(o); return 1; }
      const [biz] = await o.g.roQuery<{ name: string | null; domain: string | null }>("MATCH (b:Entity {id:$id}) RETURN b.name AS name, b.domain AS domain", { id: o.id });
      const cfg = loadConfig();
      const ask = args.includes("--no-model") ? undefined
        : makeAsk(new AgentSdkRunner({ concurrency: 1 }), { model: cfg.extractModel, cacheDir: tenantCacheDir(cfg.dataDir, "onboard", tenant) });
      const r = await tidyGraph(o.g, {
        owner: { id: o.id, name: biz?.name ?? tenant, ...(biz?.domain ? { domain: biz.domain } : {}) },
        ...(ask ? { ask } : {}), embed: embedPassages, dryRun: args.includes("--dry-run"), log: (l) => console.error(l),
      });
      console.log(`${args.includes("--dry-run") ? "Would do" : "Done"}:`);
      for (const x of r.examples) console.log(`  - ${x}`);
      if (r.unclear.length) console.log(`  Left as they are (unclear): ${r.unclear.join(", ")}`);
      if (r.skipped.length) for (const s of r.skipped) console.log(`  Left alone: ${s.ids.join(", ")} (${s.why})`);
      return r.errors.length ? 1 : 0;
    },
  },
];

export { ownerOf };
