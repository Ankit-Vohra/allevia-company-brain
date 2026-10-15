// The checks that stand between "an invite was used" and "this person gets a role": the role comes only from the
// business's own saved area, never from anything a person typed, and it can never be the staff or @everyone role.
import type { HubStore, InviteRecord } from "./hub-types.js";

export async function resolveInviteRole(inv: InviteRecord, store: HubStore, staffRoleId: string, guildId: string): Promise<string | null> {
  const area = await store.getArea(inv.slug);
  if (!area || area.guildId !== guildId || inv.guildId !== guildId) return null;
  const role = area.roleId;
  if (!role || role === staffRoleId || role === guildId) return null;
  // the invite must be on that business's own #your-team
  if (area.channels["your-team"] !== inv.channelId) return null;
  return role;
}
