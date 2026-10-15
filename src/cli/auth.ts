// `auth:issue`, `auth:list`, `auth:revoke`, `auth:demo`: who may open which business when ALLEVIA_AUTH=1 (src/auth/tokens.ts,
// docs/tenant-isolation.md). An owner link is shown once when it is issued; only its hash is stored, so it cannot be listed
// again, only revoked and replaced.
import { parseArgs } from "node:util";
import { OPERATOR_SCOPE, issueToken, listTokens, revokeToken } from "../auth/tokens.js";
import { loadConfig } from "../config.js";
import { getTenant, setDemo } from "../graph/tenants.js";
import type { Command } from "./_command.js";

const when = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString().slice(0, 16).replace("T", " "));

export const commands: Command[] = [
  {
    name: "auth:issue",
    usage: "auth:issue <tenant> [--label \"Priya's laptop\"] [--days 90] | auth:issue --operator [--label ops]",
    summary: "Issue an owner link for one business (or an operator link); shown once, stored only as a hash",
    async run(args) {
      const { values, positionals } = parseArgs({
        args, allowPositionals: true,
        options: { label: { type: "string" }, days: { type: "string" }, operator: { type: "boolean" } },
      });
      const scope = values.operator ? OPERATOR_SCOPE : positionals[0];
      if (!scope || (values.operator && positionals.length) || positionals.length > 1) {
        console.error('Usage: npm run cli -- auth:issue <tenant> [--label "name"] [--days 90]   (or --operator)');
        return 2;
      }
      let expiresAt: number | undefined;
      if (values.days !== undefined) {
        const days = Number(values.days);
        if (!(Number.isFinite(days) && days > 0 && days <= 3650)) { console.error(`--days must be a number of days, got "${values.days}"`); return 2; }
        expiresAt = Date.now() + days * 86_400_000;
      }
      const t = await issueToken(scope, { ...(values.label ? { label: values.label } : {}), ...(expiresAt ? { expiresAt } : {}) });
      const base = loadConfig().webBaseUrl;
      console.log(`${t.scope === OPERATOR_SCOPE ? "Operator link" : `Owner link for ${t.scope}`} (${t.tokenId}${t.label ? `, "${t.label}"` : ""}, expires ${when(t.expiresAt ?? null)}):`);
      console.log(`  ${base}/#key=${t.token}`);
      console.log("Send it to the owner privately. It is shown once and cannot be looked up again; `auth:revoke` kills it, and issuing another replaces it.");
      console.log("It works only when the server runs with ALLEVIA_AUTH=1.");
      return 0;
    },
  },
  {
    name: "auth:list",
    usage: "auth:list [tenant]",
    summary: "List issued links (id, business, label, dates, revoked); never the link itself",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      const rows = await listTokens(positionals[0] ? { scope: positionals[0] } : {});
      if (!rows.length) { console.log("No links issued."); return 0; }
      for (const r of rows) {
        console.log(`${r.tokenId}  ${r.scope.padEnd(18)} ${r.revoked ? "revoked " : "live    "} issued ${when(r.createdAt)}  expires ${when(r.expiresAt)}${r.revoked ? `  revoked ${when(r.revokedAt)}` : ""}${r.label ? `  "${r.label}"` : ""}`);
      }
      return 0;
    },
  },
  {
    name: "auth:revoke",
    usage: "auth:revoke <tokenId> | auth:revoke --tenant <slug> (every live link of that business, or --operator)",
    summary: "Revoke one link, or all of a business's links; takes effect on the next request",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { tenant: { type: "string" }, operator: { type: "boolean" } } });
      const scope = values.operator ? OPERATOR_SCOPE : values.tenant;
      const id = positionals[0];
      if ((!id && !scope) || (id && scope) || positionals.length > 1) { console.error("Usage: npm run cli -- auth:revoke <tokenId>   or   auth:revoke --tenant <slug>"); return 2; }
      const n = await revokeToken(id ? { tokenId: id } : { scope: scope! });
      console.log(n ? `Revoked ${n} link${n === 1 ? "" : "s"}.` : "Nothing to revoke (no such live link).");
      return n ? 0 : 1;
    },
  },
  {
    name: "auth:demo",
    usage: "auth:demo <tenant> [--off]",
    summary: "Mark a business as a public demo (read-only without a link when ALLEVIA_AUTH=1), or --off",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { off: { type: "boolean" } } });
      const [slug] = positionals;
      if (!slug || positionals.length > 1) { console.error("Usage: npm run cli -- auth:demo <tenant> [--off]"); return 2; }
      if (!(await setDemo(slug, !values.off))) { console.error(`No such business "${slug}" in the registry.`); return 1; }
      const t = await getTenant(slug);
      console.log(`${slug} is ${t?.demo ? "a public demo: anyone can read it, nobody can change it without its link" : "private again: it needs its owner link"} (when ALLEVIA_AUTH=1).`);
      return 0;
    },
  },
];
