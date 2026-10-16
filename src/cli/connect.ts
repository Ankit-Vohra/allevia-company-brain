// `connect`: the operator's side of the connections (src/connections, docs/connections-setup.md).
//   connect status [<tenant>]        what the server still needs from the founder, and how each connection stands for a business
//   connect toolkits                 asks Composio whether every toolkit Allevia lists exists (finds a wrong slug in a minute)
//   connect publish-check            asks Composio's own tool lists whether the actions and arguments posting uses still exist (read only:
//                                    nothing is posted, nothing is connected)
//   connect pull <tenant> | --all    read the connected numbers now (the server also does it daily on its own)
//   connect rotate-keys              seal every stored connection with the current ALLEVIA_CONNECTOR_KEY (after setting the old one
//                                    in ALLEVIA_CONNECTOR_KEY_PREVIOUS); then the old key can be removed
//   connect revoke <tenant>          disconnect everything a business has and forget what is stored for it
//   connect audit <tenant>           the newest calls made through a business's connections
// Nothing here prints a token or a secret.
import { parseArgs } from "node:util";
import { TOOLKIT_CATALOG } from "../../shared/connection-map.js";
import { loadConfig } from "../config.js";
import { realComposioClient } from "../connections/composio.js";
import { productionConnections } from "../connections/production.js";
import { PLATFORM_IDS, PLATFORMS, slugsOf, verifyPublishTools } from "../publish/platforms.js";
import { graphName, listGraphs } from "../graph/client.js";
import { listTenants } from "../graph/tenants.js";
import type { Command } from "./_command.js";

async function known(tenant: string | undefined): Promise<boolean> {
  if (!tenant) return false;
  if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}" (${graphName(tenant)}). Onboard it first.`); return false; }
  return true;
}

const USAGE = "connect status [<tenant>] | toolkits | publish-check | pull <tenant> | pull --all | rotate-keys | revoke <tenant> | audit <tenant>";

export const commands: Command[] = [
  {
    name: "connect",
    usage: USAGE,
    summary: "Connections: what is set up, check Composio's toolkits, read now, rotate the key, revoke a business, show the audit log",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: "boolean" } } });
      const [what, tenant] = positionals;
      const cfg = loadConfig();
      const svc = productionConnections();
      if (what === "status") {
        const need = new Map<string, string>();
        for (const c of svc.connectors) for (const m of c.availability().missing) need.set(m.setting, m.words);
        console.log(need.size ? `Still needed on this server: ${[...need].map(([s, w]) => `${s} (${w})`).join("; ")}. See docs/connections-setup.md.` : "Every connection can be offered on this server.");
        console.log(`Google products run ${cfg.connections.googleVia ?? (cfg.connections.composioApiKey ? "through Composio" : "on Allevia's own Google app")}. Redirect address for our own Google app: ${cfg.google.redirectUri}`);
        if (tenant) {
          if (!(await known(tenant))) return 2;
          for (const v of await svc.list(tenant)) if (v.available) console.log(`${v.name.padEnd(24)} ${v.state.padEnd(16)} ${v.message}`);
        }
        return 0;
      }
      if (what === "toolkits") {
        const key = cfg.connections.composioApiKey;
        if (!key) { console.error("COMPOSIO_API_KEY is not set."); return 1; }
        const c = realComposioClient(key);
        let bad = 0;
        for (const e of TOOLKIT_CATALOG) {
          const t = await c.toolkit(e.toolkit).catch(() => null);
          console.log(`${t ? "ok     " : "MISSING"} ${e.toolkit.padEnd(22)} ${e.name}`);
          if (!t) bad++;
        }
        return bad ? 1 : 0;
      }
      if (what === "publish-check") {
        const key = cfg.connections.composioApiKey;
        if (!key) { console.error("COMPOSIO_API_KEY is not set."); return 1; }
        const c = realComposioClient(key);
        let bad = 0;
        for (const spec of PLATFORM_IDS.map((id) => PLATFORMS[id])) {
          const listed = await c.tools(spec.toolkit).catch(() => null);
          if (!listed) { console.log(`COULD NOT READ ${spec.name}'s tool list`); bad++; continue; }
          const r = verifyPublishTools(spec, listed);
          console.log(`${r.ok ? "ok     " : "PROBLEM"} ${spec.name}: ${slugsOf(spec).length} actions${r.ok ? "" : ` (missing: ${r.missing.join(", ") || "none"}; unknown arguments: ${r.badArgs.map((b) => `${b.slug} ${b.arg}`).join(", ") || "none"})`}`);
          if (!r.ok) bad++;
        }
        return bad ? 1 : 0;
      }
      if (what === "pull") {
        const tenants = values.all ? (await listTenants()).map((t) => ({ slug: t.slug })) : tenant && (await known(tenant)) ? [{ slug: tenant }] : null;
        if (!tenants) { console.error("Usage: npm run cli -- connect pull <tenant> | --all"); return 2; }
        const out = await svc.pullDue(tenants, { force: true });
        for (const o of out) console.log("skipped" in o ? `${o.tenant}/${o.connector}: skipped (${o.skipped})` : `${o.tenant}/${o.connector}: ${o.ok ? "ok" : "problem"}. ${o.message}`);
        if (!out.length) console.log("No business has connected anything that is read daily.");
        return 0;
      }
      if (what === "rotate-keys") {
        const r = await svc.rotateKeys();
        console.log(`Sealed ${r.rotated} stored connection${r.rotated === 1 ? "" : "s"} with the current key.${r.unreadable.length ? ` Could not open: ${r.unreadable.join(", ")} (they need connecting again).` : ""}`);
        return r.unreadable.length ? 1 : 0;
      }
      if (what === "revoke") {
        if (!(await known(tenant))) { console.error("Usage: npm run cli -- connect revoke <tenant>"); return 2; }
        const r = await svc.revokeAll(tenant!);
        console.log(`${tenant}: disconnected ${r.disconnected.length ? r.disconnected.join(", ") : "nothing"} and forgot what was stored.`);
        return 0;
      }
      if (what === "audit") {
        if (!tenant) { console.error("Usage: npm run cli -- connect audit <tenant>"); return 2; }
        for (const e of await svc.audit.recent(tenant, { limit: 30 })) console.log(`${new Date(e.at).toISOString()} ${e.connector} ${e.op} ${e.ok ? "ok" : "FAILED"}${e.actor ? ` (${e.actor})` : ""}${e.detail ? ` ${e.detail}` : ""}`);
        return 0;
      }
      console.error(`Usage: npm run cli -- ${USAGE}`);
      return 2;
    },
  },
];
