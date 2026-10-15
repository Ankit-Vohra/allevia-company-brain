// HubPort over Discord's REST API (discord.js's REST client). Used by provisioning, the CLI and the API server: no
// gateway connection is needed to set an area up. Every message goes out with allowed_mentions.parse = [] so nothing
// can ping anyone. The REST client is injected, so tests drive this with a fake and no network. The bot token is only
// ever held by the REST client; nothing here logs or returns it, and errors are reduced to a short message.
import { Routes, type REST } from "discord.js";
import type { ButtonSpec, Outgoing } from "./bot.js";
import {
  PERM, statusOf, type ChannelInfo, type ChannelSpec, type HubPort, type InviteInfo, type InviteSpec, type Overwrite, type PermName, type RoleInfo,
} from "./hub-types.js";

type Json = Record<string, any>; // Discord's JSON, read field by field below

const TEXT = 0;
const CATEGORY = 4;
const ALL_PERMS = (1n << 53n) - 1n;
const APP_FLAG = { guildMembers: 1n << 14n, guildMembersLimited: 1n << 15n, messageContent: 1n << 18n, messageContentLimited: 1n << 19n };

const toBits = (names: readonly PermName[]): string => names.reduce((n, p) => n | PERM[p], 0n).toString();
const fromBits = (v: unknown): PermName[] => {
  let n = 0n;
  try { n = BigInt(String(v ?? "0")); } catch { /* not a number: no permissions */ }
  return (Object.keys(PERM) as PermName[]).filter((k) => (n & PERM[k]) === PERM[k]);
};

const overwriteJson = (o: Overwrite) => ({ id: o.id, type: o.type === "role" ? 0 : 1, allow: toBits(o.allow), deny: toBits(o.deny) });
const overwriteFrom = (j: Json): Overwrite => ({ id: String(j.id), type: j.type === 0 ? "role" : "member", allow: fromBits(j.allow), deny: fromBits(j.deny) });

const STYLE: Record<ButtonSpec["style"], number> = { secondary: 2, success: 3, danger: 4 };
function messageJson(m: Outgoing): Json {
  const body: Json = { allowed_mentions: { parse: [] } };
  if (typeof m === "string") body.content = m;
  else {
    body.content = m.content;
    body.components = m.buttons?.length
      ? [{ type: 1, components: m.buttons.slice(0, 5).map((b) => ({ type: 2, style: STYLE[b.style], label: b.label, custom_id: b.customId })) }]
      : [];
  }
  return body;
}


const inviteFrom = (j: Json, channelId: string): InviteInfo => ({
  code: String(j.code), channelId: String(j.channel?.id ?? channelId), uses: Number(j.uses ?? 0), maxUses: Number(j.max_uses ?? 0),
  expiresAt: typeof j.expires_at === "string" ? Date.parse(j.expires_at) : null,
});

export class RestHubPort implements HubPort {
  private me?: Promise<string>;
  constructor(private rest: Pick<REST, "get" | "post" | "patch" | "put" | "delete">, readonly guildId: string, private now: () => number = Date.now) {}

  async guildName(): Promise<string> {
    return String(((await this.rest.get(Routes.guild(this.guildId))) as Json).name ?? "");
  }

  botUserId(): Promise<string> {
    this.me ??= this.rest.get(Routes.user("@me")).then((u) => String((u as Json).id));
    this.me.catch(() => { this.me = undefined; });
    return this.me;
  }

  private async botRoles(): Promise<RoleInfo[]> {
    const [member, roles] = await Promise.all([
      this.rest.get(Routes.guildMember(this.guildId, await this.botUserId())) as Promise<Json>,
      this.listRoles(),
    ]);
    const mine = new Set<string>([this.guildId, ...(Array.isArray(member.roles) ? member.roles.map(String) : [])]);
    return roles.filter((r) => mine.has(r.id));
  }

  async botTopRolePosition(): Promise<number> {
    return Math.max(0, ...(await this.botRoles()).map((r) => r.position));
  }

  async botPermissions(): Promise<bigint> {
    const raw = (await this.rest.get(Routes.guildRoles(this.guildId))) as Json[];
    const mine = new Set((await this.botRoles()).map((r) => r.id));
    let bits = 0n;
    for (const r of raw) if (mine.has(String(r.id))) bits |= BigInt(String(r.permissions ?? "0"));
    return (bits & PERM.Administrator) === PERM.Administrator ? ALL_PERMS : bits;
  }

  async intents(): Promise<{ serverMembers: boolean; messageContent: boolean }> {
    const flags = BigInt(Number(((await this.rest.get(Routes.currentApplication())) as Json).flags ?? 0));
    return {
      serverMembers: (flags & (APP_FLAG.guildMembers | APP_FLAG.guildMembersLimited)) !== 0n,
      messageContent: (flags & (APP_FLAG.messageContent | APP_FLAG.messageContentLimited)) !== 0n,
    };
  }

  async listRoles(): Promise<RoleInfo[]> {
    return ((await this.rest.get(Routes.guildRoles(this.guildId))) as Json[]).map((r) => ({ id: String(r.id), name: String(r.name), position: Number(r.position ?? 0) }));
  }

  async createRole(name: string): Promise<RoleInfo> {
    // no permissions, not shown separately, not mentionable: the role only unlocks the customer's own area
    const r = (await this.rest.post(Routes.guildRoles(this.guildId), { body: { name, permissions: "0", hoist: false, mentionable: false } })) as Json;
    return { id: String(r.id), name: String(r.name), position: Number(r.position ?? 0) };
  }

  private channelFrom(j: Json): ChannelInfo {
    return {
      id: String(j.id), name: String(j.name ?? ""), kind: j.type === CATEGORY ? "category" : j.type === TEXT ? "text" : "other",
      parentId: j.parent_id ? String(j.parent_id) : null, position: Number(j.position ?? 0), topic: typeof j.topic === "string" ? j.topic : null,
      overwrites: Array.isArray(j.permission_overwrites) ? j.permission_overwrites.map(overwriteFrom) : [],
    };
  }

  async listChannels(): Promise<ChannelInfo[]> {
    return ((await this.rest.get(Routes.guildChannels(this.guildId))) as Json[]).map((j) => this.channelFrom(j));
  }

  async createChannel(spec: ChannelSpec): Promise<ChannelInfo> {
    const body: Json = {
      name: spec.name, type: spec.kind === "category" ? CATEGORY : TEXT, permission_overwrites: spec.overwrites.map(overwriteJson),
      ...(spec.parentId ? { parent_id: spec.parentId } : {}), ...(spec.topic ? { topic: spec.topic } : {}),
      ...(spec.position !== undefined ? { position: spec.position } : {}),
    };
    return this.channelFrom((await this.rest.post(Routes.guildChannels(this.guildId), { body })) as Json);
  }

  async editChannel(id: string, patch: { name?: string; topic?: string; parentId?: string; position?: number; overwrites?: Overwrite[] }): Promise<void> {
    const body: Json = {
      ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
      ...(patch.parentId !== undefined ? { parent_id: patch.parentId } : {}),
      ...(patch.position !== undefined ? { position: patch.position } : {}),
      ...(patch.overwrites ? { permission_overwrites: patch.overwrites.map(overwriteJson) } : {}),
    };
    await this.rest.patch(Routes.channel(id), { body });
  }

  async sendMessage(channelId: string, m: Outgoing): Promise<{ id: string }> {
    return { id: String(((await this.rest.post(Routes.channelMessages(channelId), { body: messageJson(m) })) as Json).id) };
  }

  async editMessage(channelId: string, messageId: string, m: Outgoing): Promise<void> {
    await this.rest.patch(Routes.channelMessage(channelId, messageId), { body: messageJson(m) });
  }

  async messageExists(channelId: string, messageId: string): Promise<boolean> {
    try {
      await this.rest.get(Routes.channelMessage(channelId, messageId));
      return true;
    } catch (e) {
      if (statusOf(e) === 404) return false;
      throw e;
    }
  }

  async createInvite(channelId: string, spec: InviteSpec): Promise<InviteInfo> {
    const j = (await this.rest.post(Routes.channelInvites(channelId), {
      body: { max_age: spec.maxAgeSeconds, max_uses: spec.maxUses, unique: true, temporary: false },
    })) as Json;
    const made = inviteFrom(j, channelId);
    return { ...made, maxUses: spec.maxUses, expiresAt: made.expiresAt ?? this.now() + spec.maxAgeSeconds * 1000 };
  }

  async listInvites(channelId: string): Promise<InviteInfo[] | null> {
    try {
      return ((await this.rest.get(Routes.channelInvites(channelId))) as Json[]).map((j) => inviteFrom(j, channelId));
    } catch (e) {
      const s = statusOf(e);
      if (s === 403 || s === 404) return null;
      throw e;
    }
  }

  async deleteInvite(code: string): Promise<void> {
    try {
      await this.rest.delete(Routes.invite(code));
    } catch (e) {
      if (statusOf(e) !== 404) throw e;
    }
  }

  async addMemberRole(userId: string, roleId: string): Promise<void> {
    await this.rest.put(Routes.guildMemberRole(this.guildId, userId, roleId));
  }
}
