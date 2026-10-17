// `tenant:export`, `tenant:import` and `tenant:erase`: take one business's data out of Allevia, bring it into another server, or
// remove it (src/tenant/lifecycle.ts, docs/tenant-isolation.md). All three run on the operator's machine against the database in ALLEVIA_FALKORDB_URL and the data folder in ALLEVIA_DATA_DIR; no URL, no
// token and no secret is printed.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { Refused, eraseTenant, exportTenant, importTenant, verifyTenantExport } from "../tenant/lifecycle.js";
import type { Command } from "./_command.js";

const n = (x: number): string => x.toLocaleString("en-US");
const mb = (bytes: number): string => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

export const commands: Command[] = [
  {
    name: "tenant:export",
    usage: "tenant:export <tenant> <file>",
    summary: "Write everything that is one business's (registry rows, the whole graph, its files) to one file, and check it reads back",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      const [slug, file] = positionals;
      if (!slug || !file || positionals.length > 2) { console.error("Usage: npm run cli -- tenant:export <tenant> <file>"); return 2; }
      const cfg = loadConfig();
      try {
        const r = await exportTenant(slug, file, { dataDir: cfg.dataDir });
        const check = await verifyTenantExport(file);
        if (!check.ok) { console.error(`The export was written but does not read back whole: ${check.problems.join("; ")}`); return 1; }
        console.log(`${slug} -> ${file}`);
        console.log(`  graph: ${r.graph ? `${n(r.graph.nodes)} nodes, ${n(r.graph.edges)} edges (digest ${r.graph.digest.slice(0, 12)})` : "none"}`);
        console.log(`  registry: ${r.registry.tenants} business, ${r.registry.ownerLinks} owner links (no secrets), ${r.registry.discordChannels} Discord channels, ${r.registry.discordInvites} invites`);
        console.log(`  files: ${r.files} (${mb(r.bytes)})`);
        if (r.sealedLeftOut.length) console.log(`  not exported: the sealed connection tokens (${r.sealedLeftOut.join(", ")}); they only open on this server`);
        console.log("  the file reads back whole. It holds the customer's data: hand it over, keep it private, delete it when it is no longer needed.");
        return 0;
      } catch (e) {
        if (e instanceof Refused) { console.error(e.message); return 1; }
        throw e;
      }
    },
  },
  {
    name: "tenant:import",
    usage: "tenant:import <file> [--as <tenant>] [--replace]",
    summary: "Read one business's export into this server (registry rows, the whole graph, its files), check it, and count it all again",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { as: { type: "string" }, replace: { type: "boolean" } } });
      const [file] = positionals;
      if (!file || positionals.length > 1) { console.error("Usage: npm run cli -- tenant:import <file> [--as <tenant>] [--replace]"); return 2; }
      const cfg = loadConfig();
      try {
        const r = await importTenant(file, {
          dataDir: cfg.dataDir, ...(values.as ? { as: values.as } : {}), ...(values.replace ? { replace: true } : {}),
          log: (l) => console.log(`  ${l}`),
        });
        console.log(`${file} -> ${r.slug}${r.slug !== r.from ? ` (exported as ${r.from})` : ""}${r.replaced ? ", replacing what was here" : ""}`);
        console.log(`  graph: ${r.graph ? `${n(r.graph.nodes)} nodes, ${n(r.graph.edges)} edges, read back against the file` : "none in the file"}`);
        console.log(`  registry: ${r.registry.tenants} business, ${r.registry.discordAreas} Discord area, ${r.registry.discordChannels} channels, ${r.registry.discordPosts} post records`);
        console.log(`  files: ${r.files} (${mb(r.bytes)})`);
        if (r.problems.length) { console.error(`It does NOT all match: ${r.problems.join("; ")}`); return 1; }
        console.log("  counted again: the graph, the registry entry and every file match the file.");
        console.log("Still for a person to do:");
        console.log(`  - owner links are not carried${r.registry.ownerLinksLeftOut ? ` (${r.registry.ownerLinksLeftOut} in the file)` : ""}: issue new ones with auth:issue ${r.slug}`);
        if (r.registry.discordLeftOut) console.log(`  - ${r.registry.discordLeftOut} Discord rows were left out (join codes are never exported${r.slug !== r.from ? ", and a new id has no Discord area yet" : ""})`);
        console.log(`  - connections: copy <data>/connectors/${r.from}/ from the old server and run this one with the same ALLEVIA_CONNECTOR_KEY and COMPOSIO_API_KEY${r.slug !== r.from ? " (tokens sealed for the old id do not open under the new one: connect again)" : ""}`);
        return 0;
      } catch (e) {
        if (e instanceof Refused) { console.error(e.message); return 1; }
        throw e;
      }
    },
  },
  {
    name: "tenant:erase",
    usage: "tenant:erase <tenant> --confirm <tenant> [--force] [--export-to <file>]",
    summary: "Export one business, then delete its graph, registry rows, files, Discord mapping and sealed connection tokens",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { confirm: { type: "string" }, force: { type: "boolean" }, "export-to": { type: "string" } } });
      const [slug] = positionals;
      if (!slug || positionals.length > 1) { console.error("Usage: npm run cli -- tenant:erase <tenant> --confirm <tenant> [--force] [--export-to <file>]"); return 2; }
      if (values.confirm !== slug) {
        console.error(`This deletes all of ${slug}'s data. Say you mean it by repeating the business id: --confirm ${slug}`);
        return 2;
      }
      const cfg = loadConfig();
      try {
        const r = await eraseTenant(slug, {
          dataDir: cfg.dataDir, confirm: values.confirm, ...(values.force ? { force: true } : {}), ...(values["export-to"] ? { exportTo: values["export-to"] } : {}),
          log: (l) => console.log(`  ${l}`),
        });
        console.log(`Erased ${r.slug}.`);
        console.log(`  graph: ${r.graph ? `${r.graph.name}: ${n(r.graph.nodes)} nodes and ${n(r.graph.edges)} edges dropped` : "there was none"}`);
        console.log(`  registry: ${r.registry.tenants} business, ${r.registry.ownerLinks} owner links, Discord mapping (${r.registry.discordAreas} area, ${r.registry.discordChannels} channels, ${r.registry.discordInvites} invites, ${r.registry.discordPosts} post records)`);
        console.log(`  folders: ${r.folders.length ? r.folders.join(", ") : "none"}`);
        if (r.sealedConnections.length) console.log(`  sealed connection tokens deleted: ${r.sealedConnections.join(", ")}`);
        console.log(`  export kept at ${r.exportFile} (${r.export.files} files, ${mb(r.export.bytes)}): hand it to the customer, then delete it.`);
        console.log("Still for a person to do:");
        console.log("  - the Discord channels are still on Discord (only Allevia's mapping of them is gone): remove them there");
        if (r.sealedConnections.length) console.log(`  - revoke ${r.sealedConnections.join(", ")} at the provider (the tokens here are gone, the grants at the provider are not)`);
        console.log("  - the Studio credit ledger and the public-data spend ledger keep their counts (billing records, no content)");
        if (r.leftovers.length) { console.error(`NOT everything went: ${r.leftovers.join("; ")}`); return 1; }
        return 0;
      } catch (e) {
        if (e instanceof Refused) { console.error(e.message); return 1; }
        throw e;
      }
    },
  },
];
