// `action-target` and `numbers`: the operator's side of two customer paths.
//   action-target <tenant> [app | repo <owner/name> [--operator]]   show or set where an approved fix lands for a business.
//     By default fixes become tasks inside the app. `repo` opts the business in to GitHub issues on its own repo. Only here,
//     with --operator, can a business be pointed at the repo Allevia runs on (ALLEVIA_ACTION_REPO): that is how Allevia's own
//     workspace keeps its own tracker. A web request can never do that.
//   numbers <tenant> <file.csv|file.xlsx> [--yes]   preview what we find in a spreadsheet of a business's numbers, and with
//     --yes add it as the guess stands (it refuses while a column still needs an answer). The same two functions the web
//     app and (later) Discord call.
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { getActionTarget, setActionTarget, APP_TARGET_LABEL } from "../actions/target.js";
import { describePreview, describeResult } from "../connectors/upload/text.js";
import { MAX_FILE_BYTES } from "../connectors/upload/limits.js";
import { graphName, listGraphs, openGraph } from "../graph/client.js";
import { getTenant } from "../graph/tenants.js";
import { importUpload, previewUpload } from "../server/routes/numbers.js";
import type { Command } from "./_command.js";

async function openKnown(tenant: string | undefined) {
  if (!tenant) return null;
  if (!(await listGraphs()).includes(graphName(tenant))) { console.error(`No graph for "${tenant}" (${graphName(tenant)}). Onboard it first.`); return null; }
  const g = await openGraph(tenant);
  const reg = await getTenant(tenant);
  return { g, businessId: reg?.businessId ?? `business:${tenant.replace(/_/g, "-")}` };
}

export const commands: Command[] = [
  {
    name: "action-target",
    usage: "action-target <tenant> [app | repo <owner/name> [--operator]]",
    summary: "Show or set where an approved fix lands for a business: tasks in the app (default) or its own GitHub repo",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { operator: { type: "boolean" } } });
      const [tenant, what, repo] = positionals;
      const ctx = await openKnown(tenant);
      if (!ctx) return 2;
      if (what === "app") await setActionTarget(ctx.g, { target: "app" }, { tenant: tenant!, businessId: ctx.businessId });
      else if (what === "repo") {
        if (!repo) { console.error("Usage: npm run cli -- action-target <tenant> repo <owner/name> [--operator]"); return 2; }
        await setActionTarget(ctx.g, { target: "github", repo }, { tenant: tenant!, businessId: ctx.businessId, operator: values.operator === true });
      } else if (what) { console.error("Say `app` or `repo <owner/name>`."); return 2; }
      const t = await getActionTarget(ctx.g, tenant, { businessId: ctx.businessId });
      console.log(t.kind === "github" ? `${tenant}: GitHub issues on ${t.repo}` : `${tenant}: ${APP_TARGET_LABEL}${t.reason ? ` (${t.reason})` : ""}`);
    },
  },
  {
    name: "numbers",
    usage: "numbers <tenant> <file.csv|file.xlsx> [--yes]",
    summary: "Preview a spreadsheet of a business's numbers (visits, orders, enquiries...) and, with --yes, add it",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { yes: { type: "boolean" } } });
      const [tenant, path] = positionals;
      if (!tenant || !path) { console.error("Usage: npm run cli -- numbers <tenant> <file.csv|file.xlsx> [--yes]"); return 2; }
      const ctx = await openKnown(tenant);
      if (!ctx) return 2;
      if (statSync(path).size > MAX_FILE_BYTES) { console.error("That file is too big: send one under 20 MB."); return 2; }
      const file = { fileName: basename(path), bytes: readFileSync(path) };
      const p = await previewUpload(ctx.g, ctx.businessId, file);
      console.log(describePreview(p));
      if (!values.yes) return 0;
      if (p.questions.length) { console.error("\nNot added: some answers are still missing. Use the web app to pick them."); return 1; }
      console.log(`\n${describeResult(await importUpload(ctx.g, ctx.businessId, file, p.plan, Date.now()))}`);
    },
  },
];
