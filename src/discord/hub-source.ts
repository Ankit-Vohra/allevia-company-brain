// What the hub posts for one business, read from that business's own graph (and its own folder for pictures): its pending
// cards, the newest note, today's stand-up drafts, where approved fixes go, and what goes on each card besides its text.
import { getActionTarget } from "../actions/target.js";
import { usesFoundersAccounts } from "../actions/executors.js";
import type { GraphHandle } from "../graph/client.js";
import { approval as readApproval, approvals as readApprovals, latestBrief } from "../server/reads.js";
import type { ApprovalDto } from "../server/types.js";
import { readStandup } from "../proactive/note.js";
import type { AssetStore } from "../studio/store.js";
import { isoDate } from "../util/time.js";
import { approvalExtras } from "./approval-extras.js";
import type { TenantSource } from "./hub-provision.js";

export const tenantSource = (g: GraphHandle, slug?: string, o: { store?: AssetStore; webBase?: string } = {}): TenantSource => ({
  pendingApprovals: async () => (await readApprovals(g)).filter((a) => a.status === "pending"),
  approval: (id) => readApproval(g, id),
  latestBrief: async () => {
    const b = await latestBrief(g);
    return b ? { id: b.id, title: b.title, ...(b.asOf ? { asOf: b.asOf } : {}), text: b.text } : null;
  },
  ...(slug ? {
    actionTarget: () => getActionTarget(g, slug, { founders: usesFoundersAccounts(slug) }),
    extras: (a: ApprovalDto, why?: string) => approvalExtras(a, { graph: g, tenant: slug, ...(o.store ? { store: o.store } : {}), ...(o.webBase ? { webBase: o.webBase } : {}) }, why),
  } : {}),
  standupCards: async () => {
    const s = await readStandup(g, isoDate(Date.now()));
    const out: Array<{ approval: ApprovalDto; why: string }> = [];
    for (const i of s?.items ?? []) {
      if (i.status !== "drafted" || !i.approvalId) continue;
      const a = await readApproval(g, i.approvalId);
      if (a) out.push({ approval: a, why: i.why });
    }
    return out;
  },
});
