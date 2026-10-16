// `db:check`: is FalkorDB reachable, does it run with the settings the code assumes, which graphs exist, which tenants are
// registered (with node/edge counts). `db:migrate`: bring tenant graphs up to the current schema.
// `db:unmerge`: undo one of the librarian's merges (src/ingest/merge.ts), or what onboarding's tidy pass did to a node
// (src/ingest/tidy.ts: a merge, a retyped business, a retired first name).
import { loadConfig } from "../config.js";
import { connect, describeUrl, listGraphs, openGraph, openGraphByName, redactUrl } from "../graph/client.js";
import { ensureSchema } from "../graph/indexes.js";
import { configDrift, readServerConfig } from "../graph/server-config.js";
import { redisKeys, sweepTelemetry } from "../graph/telemetry.js";
import { undoTidy } from "../ingest/tidy.js";
import { listTenants } from "../graph/tenants.js";
import type { Command } from "./_command.js";

export const commands: Command[] = [
  {
    name: "db:check",
    usage: "db:check",
    summary: "Ping FalkorDB, list graphs and registered tenants",
    async run() {
      const url = loadConfig().falkordbUrl;
      const where = describeUrl(url);
      const t0 = Date.now();
      let graphs: string[];
      try {
        graphs = await listGraphs();
      } catch (e) {
        console.error(`FalkorDB at ${where}: unreachable (${redactUrl(e instanceof Error ? e.message : String(e), url)})`);
        return 1;
      }
      console.log(`FalkorDB at ${where}: ok (${Date.now() - t0} ms)`);
      const drift = configDrift(await readServerConfig(await connect()));
      console.log(drift.length
        ? `Server settings differ from docker-compose.yml: ${drift.map((d) => `${d.name} ${d.have ?? "unset"} (want ${d.want})`).join(", ")}${where.includes("<remote>") ? " (a managed server: its provider sets these; see docs/falkordb-cloud.md)" : ". Restart it with: docker compose up -d falkordb"}`
        : "Server settings: as docker-compose.yml");
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
    name: "db:telemetry",
    usage: "db:telemetry [--dry-run]",
    summary: "Remove FalkorDB's own telemetry{<graph>} streams from the server (the server does this every 10 minutes; --dry-run only lists them)",
    async run(args) {
      const url = loadConfig().falkordbUrl;
      const dryRun = args.includes("--dry-run");
      try {
        const r = await sweepTelemetry(await redisKeys(), { dryRun });
        if (r.refused) { console.log(`FalkorDB at ${describeUrl(url)} does not allow the plain Redis commands this needs (SCAN, TYPE, UNLINK), so its telemetry streams cannot be removed from here. Nothing to do.`); return 0; }
        console.log(r.removed.length
          ? `${dryRun ? "Found" : "Removed"} ${r.removed.length} telemetry stream${r.removed.length === 1 ? "" : "s"} on ${describeUrl(url)}: ${r.removed.join(", ")}`
          : `No telemetry streams on ${describeUrl(url)}.`);
        return 0;
      } catch (e) {
        console.error(`FalkorDB at ${describeUrl(url)}: ${redactUrl(e instanceof Error ? e.message : String(e), url)}`);
        return 1;
      }
    },
  },
  {
    name: "db:unmerge",
    usage: "db:unmerge <tenant> <id>",
    summary: "Undo a merge, a retype or a retirement of one node (the librarian's or onboarding's); it stays as it is from then on",
    async run(args) {
      const [tenant, id] = args;
      if (!tenant || !id) { console.error("Usage: npm run cli -- db:unmerge <tenant> <id>"); return 2; }
      const done = await undoTidy(await openGraph(tenant), id);
      console.log(done ?? `${id} was not merged, retyped or retired.`);
      return done ? 0 : 1;
    },
  },
  {
    name: "db:migrate",
    usage: "db:migrate [tenant…]",
    summary: "Bring tenant graphs up to the current schema (indexes, Searchable label, metricKey, Entity.id constraints)",
    async run(args) {
      const tenants = await listTenants();
      const want = args.filter((a) => !a.startsWith("-"));
      const chosen = want.length ? tenants.filter((t) => want.includes(t.slug)) : tenants;
      const unknown = want.filter((w) => !tenants.some((t) => t.slug === w));
      if (unknown.length) { console.error(`No such tenant: ${unknown.join(", ")}`); return 1; }
      if (!chosen.length) { console.log("No tenants registered."); return 0; }
      let failed = 0;
      for (const t of chosen) {
        const t0 = Date.now();
        const r = await ensureSchema(await openGraphByName(t.graph));
        const c = r.constraints;
        console.log(`${t.slug.padEnd(16)} ${t.graph}: ${r.labelled} labelled Searchable, ${r.metricKeys} metricKeys, ${c.merged} duplicate nodes merged, ` +
          `constraints ${Object.entries(c.status).map(([k, v]) => `${k} ${v}`).join(", ") || "none"} (${Date.now() - t0} ms)`);
        for (const p of c.problems) { console.log(`  needs a person: ${p}`); failed++; }
      }
      // the registry's own relationships (Tenant -HAS_AREA-> Area, -ISSUED-> Invite, -HAS_TOKEN-> AuthToken, Channel -POSTED-> Post): only those missing are added
      if (!want.length) {
        const { linkRegistry } = await import("../graph/tenants.js");
        const l = await linkRegistry();
        console.log(`registry: linked ${l.areas} areas, ${l.channels} channels, ${l.invites} invites, ${l.posts} posts, ${l.tokens} tokens`);
      }
      return failed ? 1 : 0;
    },
  },
];
