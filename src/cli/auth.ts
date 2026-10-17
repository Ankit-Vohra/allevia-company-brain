// `auth:issue`, `auth:list`, `auth:revoke`, `auth:demo`: who may open which business when ALLEVIA_AUTH=1 (src/auth/tokens.ts,
// docs/tenant-isolation.md). An owner link is shown once when it is issued; only its hash is stored, so it cannot be listed
// again, only revoked and replaced.
// `auth:users`, `auth:reset-link`, `auth:invite`, `auth:disable`: the operator's side of accounts (src/auth/accounts.ts). There
// is no email sender yet, so a reset link or an invite is printed here once and sent to the person by hand.
import { parseArgs } from "node:util";
import { createInvite, createResetCode, isMemberRole, listUsers, setDisabled } from "../auth/accounts.js";
import { seatsFor } from "../auth/seats.js";
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
  {
    name: "auth:users",
    usage: "auth:users [tenant]",
    summary: "List accounts (email, name, joined, businesses and roles, switched off); never a password or a hash",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      const slug = positionals[0];
      const users = (await listUsers()).filter((u) => !slug || u.businesses.some((b) => b.slug === slug));
      if (!users.length) { console.log(slug ? `No accounts in ${slug}.` : "No accounts yet."); return 0; }
      for (const u of users) {
        const biz = u.businesses.map((b) => `${b.slug} (${b.role})`).join(", ") || "no business yet";
        console.log(`${u.id}  ${u.email.padEnd(32)} ${u.disabledAt ? "OFF  " : "     "}joined ${when(u.createdAt)}  "${u.name}"  ${biz}`);
      }
      console.log(`${users.length} account${users.length === 1 ? "" : "s"}.`);
      return 0;
    },
  },
  {
    name: "auth:reset-link",
    usage: "auth:reset-link <email>",
    summary: "Print a single-use link (24 hours) for an account to choose a new password; send it by hand",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      if (positionals.length !== 1) { console.error("Usage: npm run cli -- auth:reset-link <email>"); return 2; }
      const r = await createResetCode(positionals[0]);
      if (!r) { console.error(`No account for "${positionals[0]}".`); return 1; }
      console.log(`Reset link for ${r.user.email} (works once, until ${when(r.expiresAt)} UTC; an earlier unused one stops working):`);
      console.log(`  ${loadConfig().webBaseUrl}/reset/${r.code}`);
      console.log("Send it to them privately. It is shown once. Choosing a new password signs them out everywhere.");
      return 0;
    },
  },
  {
    name: "auth:invite",
    usage: "auth:invite <tenant> [--role owner|member] [--days 7]",
    summary: "Print a single-use invite link into a business (for an owner account on a business set up before sign-in, say)",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { role: { type: "string" }, days: { type: "string" } } });
      const [slug] = positionals;
      const role = values.role ?? "member";
      if (!slug || positionals.length > 1 || !isMemberRole(role)) { console.error("Usage: npm run cli -- auth:invite <tenant> [--role owner|member] [--days 7]"); return 2; }
      const days = values.days === undefined ? 7 : Number(values.days);
      if (!(Number.isFinite(days) && days > 0 && days <= 30)) { console.error(`--days must be 1 to 30, got "${values.days}"`); return 2; }
      if (!(await getTenant(slug))) { console.error(`No such business "${slug}" in the registry.`); return 1; }
      const seats = await seatsFor(slug);
      const r = await createInvite(slug, { role, seats, createdBy: "operator", days });
      if ("full" in r) { console.error(`Every seat in ${slug} is taken (${seats}, counting open invites).`); return 1; }
      console.log(`Invite into ${slug} as ${role} (works once, until ${when(r.expiresAt)} UTC):`);
      console.log(`  ${loadConfig().webBaseUrl}/invite/${r.code}`);
      console.log("Send it privately. It is shown once. It works only when the server runs with ALLEVIA_AUTH=1.");
      return 0;
    },
  },
  {
    name: "auth:disable",
    usage: "auth:disable <email> [--off]",
    summary: "Switch an account off (signed out everywhere at once, cannot sign in), or --off to switch it back on",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { off: { type: "boolean" } } });
      if (positionals.length !== 1) { console.error("Usage: npm run cli -- auth:disable <email> [--off]"); return 2; }
      const u = await setDisabled(positionals[0], !values.off);
      if (!u) { console.error(`No account for "${positionals[0]}".`); return 1; }
      console.log(values.off ? `${u.email} can sign in again.` : `${u.email} is switched off and signed out everywhere.`);
      return 0;
    },
  },
];
