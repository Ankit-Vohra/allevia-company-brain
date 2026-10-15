// Who joined with which invite. A member joining the hub does not say which link they used, so we compare what the
// hub's channels list now with what we saved when we made each link: a link whose use count went up, or a single-use
// link that has vanished (Discord deletes it on its last use) before it expired, was just used. Exactly one such link
// means we know the business, so the join gets that business's role. Anything else (no link used, or two used at once
// so we cannot tell whose is whose) gives NO role: a person with no role sees nothing, and staff are told.
import { resolveInviteRole } from "./hub-guards.js";
import type { HubPort, HubStore, InviteRecord } from "./hub-types.js";

export type Attribution =
  | { kind: "matched"; slug: string; roleId: string; code: string }
  | { kind: "none" }
  | { kind: "ambiguous"; slugs: string[] };

export interface JoinDeps { hub: HubPort; store: HubStore; staffRoleId: string; now?: () => number; log?: (line: string) => void }

const PARALLEL = 5;

export async function attributeJoin(d: JoinDeps): Promise<Attribution> {
  const now = (d.now ?? Date.now)();
  const open = await d.store.openInvites(d.hub.guildId);
  const live: InviteRecord[] = [];
  for (const i of open) {
    if (i.expiresAt <= now) await d.store.saveInvite({ ...i, status: "expired" });
    else live.push(i);
  }
  const channels = [...new Set(live.map((i) => i.channelId))];
  const lists = new Map<string, Awaited<ReturnType<HubPort["listInvites"]>>>();
  for (let n = 0; n < channels.length; n += PARALLEL) {
    await Promise.all(channels.slice(n, n + PARALLEL).map(async (c) => { lists.set(c, await d.hub.listInvites(c).catch(() => null)); }));
  }
  const used: InviteRecord[] = [];
  for (const i of live) {
    const list = lists.get(i.channelId);
    if (list === null || list === undefined) continue; // could not look: not evidence of anything
    const seen = list.find((x) => x.code === i.code);
    if (seen ? seen.uses > i.uses : i.uses === 0) used.push({ ...i, uses: seen ? seen.uses : i.maxUses });
  }
  for (const i of used) await d.store.saveInvite({ ...i, status: "used", usedAt: now });
  if (used.length === 0) return { kind: "none" };
  if (used.length > 1) return { kind: "ambiguous", slugs: used.map((i) => i.slug) };
  const inv = used[0]!;
  const role = await resolveInviteRole(inv, d.store, d.staffRoleId, d.hub.guildId);
  if (!role) return { kind: "none" };
  return { kind: "matched", slug: inv.slug, roleId: role, code: inv.code };
}
