// `connect`: the operator's side of the Google connectors (Search Console).
//   connect status [<tenant>]        what the server still needs from the founder, and how a business's connection stands
//   connect pull <tenant> | --all    read Search Console now for one business, or every business that connected it (this is the
//                                    daily pull: a cron entry or a scheduled task can run it; the server also does it on its own)
//   connect url <tenant>             print the Google address a business would be sent to, to check the OAuth setup by hand
// Setup steps for the founder are in docs/connectors-setup.md. Nothing here prints a token or a secret.
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { pullDue } from "../connectors/google/schedule.js";
import { authorizationUrl, connectionStatus, pullSearchConsole } from "../connectors/google/searchconsole.js";
import { NotConfiguredError } from "../connectors/google/settings.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { getTenant, listTenants } from "../graph/tenants.js";
import { productionGoogle } from "../server/main.js";
import type { Command } from "./_command.js";

async function open(tenant: string | undefined) {
  if (!tenant) return null;
  if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}" (${graphName(tenant)}). Onboard it first.`); return null; }
  return { g: await openGraph(tenant), businessId: (await getTenant(tenant))?.businessId };
}

export const commands: Command[] = [
  {
    name: "connect",
    usage: "connect status [<tenant>] | pull <tenant> | pull --all | url <tenant>",
    summary: "Search Console: what is set up, read it now (or for every connected business), or print the Google address to test",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: "boolean" } } });
      const [what, tenant] = positionals;
      const w = productionGoogle();
      if (what === "status") {
        const s = w.deps.settings;
        console.log(s.configured ? "Google sign-in is set up on this server." : `Not set up yet. Still needed: ${s.missing.map((m) => `${m.setting} (${m.words})`).join("; ")}. See docs/connectors-setup.md.`);
        console.log(`Redirect address to register in Google Cloud: ${loadConfig().google.redirectUri}`);
        if (tenant) {
          const t = await open(tenant);
          if (!t) return 2;
          const st = await connectionStatus(w.deps, t.g, tenant, t.businessId);
          console.log(`${tenant}: ${st.state}. ${st.message}`);
        }
        return 0;
      }
      if (what === "url") {
        if (!tenant) { console.error("Usage: npm run cli -- connect url <tenant>"); return 2; }
        try {
          console.log(authorizationUrl(w.deps, tenant));
        } catch (e) {
          if (e instanceof NotConfiguredError) { console.error(`Not set up yet. Still needed: ${e.missing.map((m) => m.setting).join(", ")}. See docs/connectors-setup.md.`); return 1; }
          throw e;
        }
        return 0;
      }
      if (what === "pull") {
        if (values.all) {
          const out = await pullDue({ google: w.deps, tenants: () => listTenants(), openGraph: (s) => openGraph(s), minHours: 0 });
          for (const o of out) console.log("result" in o ? `${o.tenant}: ${o.result.status}. ${o.result.message}` : `${o.tenant}: skipped (${o.skipped})`);
          if (!out.length) console.log("No business has connected Search Console (or the server has no Google credentials).");
          return 0;
        }
        const t = await open(tenant);
        if (!t) { console.error("Usage: npm run cli -- connect pull <tenant> | --all"); return 2; }
        const r = await pullSearchConsole(w.deps, t.g, tenant!, t.businessId ? { businessId: t.businessId } : {});
        console.log(`${tenant}: ${r.status}. ${r.message}${r.written !== undefined ? ` (${r.written} numbers written)` : ""}`);
        return r.status === "ok" ? 0 : 1;
      }
      console.error("Usage: npm run cli -- connect status [<tenant>] | pull <tenant> | pull --all | url <tenant>");
      return 2;
    },
  },
];
