// Billing in test mode, for the operator (src/billing/provider.ts): while no payment provider is connected, an owner's
// "Switch to Growth", "Buy 100 credits", "Pause" or "Cancel" is recorded (ALLEVIA_BILLING=test-request, the default) and
// waits here. Approving one applies it: the plan changes and this month's credits are topped up, or the pack's credits are
// added.
//   billing:requests [--all] [--tenant <slug>]   what is waiting (or every request)
//   billing:approve <id>                         apply one
//   billing:decline <id>                         say no to one (nothing changes)
//   billing:show <tenant>                        a business's plan and this month's credits
//   billing:set <tenant> <plan> [--yearly]       put a business on a plan by hand (no request needed)
import { parseArgs } from "node:util";
import { leftWords } from "../../shared/credits.js";
import { PLAN_BY_ID } from "../../shared/plans.js";
import { approveRequest, declineRequest, requestWords } from "../billing/provider.js";
import { getSubscription, isPlanId, listRequests, putSubscription, renewalAfter, type BillingRequest } from "../billing/subscription.js";
import { credits } from "../credits/index.js";
import { getTenant } from "../graph/tenants.js";
import type { Command } from "./_command.js";

const when = (ms: number | undefined): string => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "-");
const day = (ms: number | undefined): string => (ms ? new Date(ms).toISOString().slice(0, 10) : "-");

async function planLine(slug: string): Promise<string> {
  const s = await getSubscription(slug);
  if (!s) return "no subscription record yet (a business set up before 17 October is on Growth; a newer one starts the trial on first use)";
  const plan = s.status === "paused" ? "Pause" : s.plan ? PLAN_BY_ID[s.plan].name : "no plan chosen";
  const parts = [`${plan}${s.status === "active" ? ` (${s.cycle})` : ""}`, s.status];
  if (s.status === "trial" && s.trialEndsAt) parts.push(`trial ends ${day(s.trialEndsAt)}`);
  if (s.renewsAt && s.status === "active") parts.push(`renews ${day(s.renewsAt)}`);
  return parts.join(", ");
}

async function creditsLine(slug: string): Promise<string> {
  const b = await credits().balance(slug);
  const extra = [
    b.rollover ? `${b.rollover} rolled over` : "", b.packs ? `${b.packs} bought or added` : "", b.trial ? `${b.trial} trial` : "", b.owed ? `${b.owed} owed from last month` : "",
  ].filter(Boolean);
  return `${leftWords(b.left)} this month (${b.month}): ${b.allowance} from the plan${extra.length ? `, ${extra.join(", ")}` : ""}; ${b.used} used. Resets ${b.resetsAt.slice(0, 10)}.`;
}

function requestLine(r: BillingRequest): string {
  return `  ${r.requestId.padEnd(16)} ${r.slug.padEnd(22)} ${requestWords(r).padEnd(30)} ${r.status.padEnd(8)} asked ${when(r.at)}${r.by ? ` by ${r.by}` : ""}${r.decidedAt ? `, ${r.status} ${when(r.decidedAt)}` : ""}`;
}

export const commands: Command[] = [
  {
    name: "billing:requests",
    usage: "billing:requests [--all] [--tenant <slug>]",
    summary: "List the plan changes and credit packs owners asked for (test mode), waiting for billing:approve",
    async run(args) {
      const { values } = parseArgs({ args, options: { all: { type: "boolean" }, tenant: { type: "string" } } });
      const rows = await listRequests({ ...(values.tenant ? { slug: values.tenant } : {}), ...(values.all ? {} : { status: "pending" as const }), limit: 500 });
      if (!rows.length) {
        console.log(values.all ? "No billing requests yet." : "Nothing waiting. (Use --all to see the ones already decided.)");
        return 0;
      }
      console.log(`${rows.length} ${values.all ? "billing request" : "billing request waiting"}${rows.length === 1 ? "" : "s"}${values.all ? "" : " for your OK"}:`);
      for (const r of rows) console.log(requestLine(r));
      if (rows.some((r) => r.status === "pending")) {
        console.log("");
        console.log("Approve one:  npm run cli -- billing:approve <id>");
        console.log("Decline one:  npm run cli -- billing:decline <id>");
      }
      return 0;
    },
  },
  {
    name: "billing:approve",
    usage: "billing:approve <id>",
    summary: "Apply a waiting billing request (test mode): the plan changes, or the pack's credits are added",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      const id = positionals[0];
      if (!id || positionals.length > 1) { console.error("Usage: npm run cli -- billing:approve <id>   (billing:requests lists them)"); return 2; }
      const r = await approveRequest(id, { credits: credits(), by: "operator" });
      if (!r.ok) { console.error(r.why ?? `Could not approve ${id}.`); return 1; }
      const req = r.request!;
      const t = await getTenant(req.slug).catch(() => null);
      console.log(`Approved ${id} for ${t?.name ?? req.slug} (${req.slug}): ${requestWords(req)}.`);
      console.log(`  Plan:    ${await planLine(req.slug)}`);
      console.log(`  Credits: ${await creditsLine(req.slug)}`);
      console.log("The owner sees it the next time the page loads.");
      return 0;
    },
  },
  {
    name: "billing:decline",
    usage: "billing:decline <id>",
    summary: "Decline a waiting billing request (nothing changes for the business)",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      const id = positionals[0];
      if (!id || positionals.length > 1) { console.error("Usage: npm run cli -- billing:decline <id>"); return 2; }
      if (!(await declineRequest(id, { credits: credits(), by: "operator" }))) { console.error(`${id} is not waiting (no such request, or already decided).`); return 1; }
      console.log(`Declined ${id}. Nothing changed for the business.`);
      return 0;
    },
  },
  {
    name: "billing:show",
    usage: "billing:show <tenant>",
    summary: "A business's plan, this month's credits, and its billing requests",
    async run(args) {
      const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
      const slug = positionals[0];
      if (!slug || positionals.length > 1) { console.error("Usage: npm run cli -- billing:show <tenant>"); return 2; }
      const t = await getTenant(slug);
      if (!t) { console.error(`No such business "${slug}" in the registry.`); return 1; }
      console.log(`${t.name} (${slug})${t.demo ? ", a public demo" : ""}`);
      console.log(`  Plan:    ${await planLine(slug)}`);
      console.log(`  Credits: ${await creditsLine(slug)}`);
      const reqs = await listRequests({ slug, limit: 20 });
      if (reqs.length) { console.log("  Requests:"); for (const r of reqs) console.log(`  ${requestLine(r)}`); }
      return 0;
    },
  },
  {
    name: "billing:set",
    usage: "billing:set <tenant> <starter|growth|pro|scale|pause> [--yearly]",
    summary: "Put a business on a plan by hand (test mode); this month's credits go up to the plan's",
    async run(args) {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { yearly: { type: "boolean" } } });
      const [slug, plan] = positionals;
      if (!slug || !isPlanId(plan) || positionals.length > 2) { console.error("Usage: npm run cli -- billing:set <tenant> <starter|growth|pro|scale|pause> [--yearly]"); return 2; }
      if (!(await getTenant(slug))) { console.error(`No such business "${slug}" in the registry.`); return 1; }
      const now = Date.now();
      const cycle = plan !== "pause" && values.yearly ? "yearly" : "monthly";
      await putSubscription({ slug, plan, cycle, status: plan === "pause" ? "paused" : "active", startedAt: now, renewsAt: renewalAfter(now, cycle), provider: "test", providerRef: "operator", updatedAt: now });
      await credits().topUpPlan(slug, `set-${now}`);
      console.log(`${slug} is on ${PLAN_BY_ID[plan].name} now.`);
      console.log(`  Plan:    ${await planLine(slug)}`);
      console.log(`  Credits: ${await creditsLine(slug)}`);
      return 0;
    },
  },
];
