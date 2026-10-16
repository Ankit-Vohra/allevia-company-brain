// Fakes for the Discord hub: a whole fake guild behind HubPort (roles, channels with permission overwrites, messages,
// invites, members' roles) and an in-memory HubStore. No network, no FalkorDB. The hub tests run provisioning against
// this store and against the real allevia_meta store on a throwaway graph, with the same fake guild.
import type { Outgoing } from "../../src/discord/bot.js";
import {
  PERM, type AreaPatch, type AreaRecord, type ChannelInfo, type ChannelKind, type ChannelRef, type ChannelSpec, type HubPort, type HubRecord,
  type HubStore, type InviteInfo, type InviteRecord, type InviteSpec, type Overwrite, type PermName, type PostRecord, type RoleInfo,
} from "../../src/discord/hub-types.js";

let seq = 0;
export const snowflake = (): string => String(700000000000000000n + BigInt(++seq));
const copy = <T>(x: T): T => structuredClone(x);

export interface SentMessage { id: string; channelId: string; content: string; buttons: string[]; edits: string[]; files: string[] }

export class FakeHub implements HubPort {
  readonly guildId = snowflake();
  readonly botId = snowflake();
  roles = new Map<string, RoleInfo>();
  channels = new Map<string, ChannelInfo>();
  messages = new Map<string, SentMessage>();
  invites = new Map<string, InviteInfo & { revoked?: boolean }>();
  memberRoles = new Map<string, Set<string>>();
  calls: string[] = [];
  /** Make an operation fail: return a message to throw, or undefined to let it through. */
  fail: (op: string, arg?: string) => string | undefined = () => undefined;
  clock = () => Date.now();
  botPerms = Object.values(PERM).reduce((a, b) => a | b, 0n);
  appIntents = { serverMembers: true, messageContent: true };
  botPosition = 50;
  inGuild = true;
  tokenValid = true;

  constructor() {
    this.roles.set(this.guildId, { id: this.guildId, name: "@everyone", position: 0 });
  }

  addRole(name: string, position = 1): RoleInfo {
    const r = { id: snowflake(), name, position };
    this.roles.set(r.id, r);
    return r;
  }

  private op(name: string, arg?: string): void {
    this.calls.push(arg ? `${name}:${arg}` : name);
    const f = this.fail(name, arg);
    if (f) throw new Error(f);
    if (!this.tokenValid) throw Object.assign(new Error("401: Unauthorized"), { status: 401 });
  }
  private guildOnly(name: string, arg?: string): void {
    this.op(name, arg);
    if (!this.inGuild) throw Object.assign(new Error("Missing Access"), { status: 403 });
  }

  async guildName() { this.guildOnly("guildName"); return "Allevia Hub"; }
  async botUserId() { return this.botId; }
  async botTopRolePosition() { this.guildOnly("botTopRolePosition"); return this.botPosition; }
  async botPermissions() { this.guildOnly("botPermissions"); return this.botPerms; }
  async intents() { this.op("intents"); return this.appIntents; }
  async listRoles() { this.guildOnly("listRoles"); return copy([...this.roles.values()]); }
  /** Like Discord today: a new role lands at the bottom (place 1), whatever is already there, so it can tie with the bot's. */
  async createRole(name: string) { this.guildOnly("createRole", name); return copy(this.addRole(name)); }
  /**
   * Discord's hierarchy rule for a bot: it may move only a role that sits strictly below its own highest role, and only to
   * a place strictly below it (a tie counts as level, so both are refused with 403). Making room is simplified: every other
   * role at or above the new place moves up one, the bot's own role with them. Answers with every role, like Discord.
   */
  async setRolePosition(roleId: string, position: number) {
    this.guildOnly("setRolePosition", roleId);
    const r = this.roles.get(roleId);
    if (!r || roleId === this.guildId) throw Object.assign(new Error("Unknown Role"), { status: 404 });
    if (r.position >= this.botPosition || position >= this.botPosition) throw Object.assign(new Error("Missing Permissions"), { status: 403 });
    for (const o of this.roles.values()) if (o.id !== roleId && o.position >= position) o.position += 1;
    this.botPosition += 1;
    r.position = position;
    return copy([...this.roles.values()]);
  }
  async listChannels() { this.guildOnly("listChannels"); return copy([...this.channels.values()]); }
  async createChannel(spec: ChannelSpec) {
    this.guildOnly("createChannel", spec.name);
    const siblings = this.siblings(spec.kind, spec.parentId ?? null);
    const c: ChannelInfo = { id: snowflake(), name: spec.name, kind: spec.kind, parentId: spec.parentId ?? null, position: siblings.length, topic: spec.topic ?? null, overwrites: copy(spec.overwrites) };
    this.channels.set(c.id, c);
    if (spec.position !== undefined) this.move(c, spec.position);
    return copy(this.channels.get(c.id)!);
  }
  /** Channels that are ordered against each other: the same kind under the same parent. */
  private siblings(kind: string, parentId: string | null): ChannelInfo[] {
    return [...this.channels.values()].filter((c) => c.kind === kind && c.parentId === parentId).sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  }
  /** Discord's rule: putting a channel at a position shifts its siblings, and positions are renumbered 0..n-1. */
  private move(c: ChannelInfo, position: number): void {
    const rest = this.siblings(c.kind, c.parentId).filter((x) => x.id !== c.id);
    rest.splice(Math.max(0, Math.min(position, rest.length)), 0, c);
    rest.forEach((x, i) => { x.position = i; });
  }
  async editChannel(id: string, patch: { name?: string; topic?: string; parentId?: string; position?: number; overwrites?: Overwrite[] }) {
    this.guildOnly("editChannel", id);
    const c = this.channels.get(id);
    if (!c) throw Object.assign(new Error("Unknown Channel"), { status: 404 });
    if (patch.name !== undefined) c.name = patch.name;
    if (patch.topic !== undefined) c.topic = patch.topic;
    if (patch.parentId !== undefined) { c.parentId = patch.parentId; c.position = this.siblings(c.kind, c.parentId).length; }
    if (patch.position !== undefined) this.move(c, patch.position);
    if (patch.overwrites) c.overwrites = copy(patch.overwrites);
  }
  async sendMessage(channelId: string, m: Outgoing) {
    this.guildOnly("sendMessage", channelId);
    const msg: SentMessage = { id: snowflake(), channelId, content: typeof m === "string" ? m : m.content, buttons: typeof m === "string" ? [] : (m.buttons ?? []).map((b) => b.customId), edits: [], files: typeof m === "string" ? [] : (m.files ?? []).map((f) => f.name) };
    this.messages.set(msg.id, msg);
    return { id: msg.id };
  }
  async editMessage(channelId: string, messageId: string, m: Outgoing) {
    this.guildOnly("editMessage", messageId);
    const msg = this.messages.get(messageId);
    if (!msg) throw Object.assign(new Error("Unknown Message"), { status: 404 });
    msg.edits.push(typeof m === "string" ? m : m.content);
    msg.content = typeof m === "string" ? m : m.content;
    msg.buttons = typeof m === "string" ? [] : (m.buttons ?? []).map((b) => b.customId);
  }
  async messageExists(_channelId: string, messageId: string) { this.guildOnly("messageExists"); return this.messages.has(messageId); }

  async createInvite(channelId: string, spec: InviteSpec) {
    this.guildOnly("createInvite", channelId);
    const inv: InviteInfo = { code: `inv${snowflake().slice(-8)}`, channelId, uses: 0, maxUses: spec.maxUses, expiresAt: this.clock() + spec.maxAgeSeconds * 1000 };
    this.invites.set(inv.code, inv);
    return copy(inv);
  }
  async listInvites(channelId: string) {
    this.guildOnly("listInvites", channelId);
    if (!this.channels.has(channelId)) return null;
    return copy([...this.invites.values()].filter((i) => i.channelId === channelId));
  }
  async deleteInvite(code: string) { this.guildOnly("deleteInvite", code); this.invites.delete(code); }
  async addMemberRole(userId: string, roleId: string) {
    this.guildOnly("addMemberRole", roleId);
    if (!this.roles.has(roleId)) throw Object.assign(new Error("Unknown Role"), { status: 404 });
    (this.memberRoles.get(userId) ?? this.memberRoles.set(userId, new Set()).get(userId)!).add(roleId);
  }

  // ----- test helpers -----

  /** Someone joins using this invite: its use count goes up, and a spent single-use invite disappears. */
  join(code: string): void {
    const inv = this.invites.get(code);
    if (!inv) throw new Error(`no invite ${code}`);
    inv.uses++;
    if (inv.maxUses > 0 && inv.uses >= inv.maxUses) this.invites.delete(code);
  }
  byName(name: string): ChannelInfo | undefined { return [...this.channels.values()].find((c) => c.name === name); }
  channelsIn(categoryId: string): ChannelInfo[] { return [...this.channels.values()].filter((c) => c.parentId === categoryId); }
  count(op: string): number { return this.calls.filter((c) => c === op || c.startsWith(`${op}:`)).length; }
  /** Who can see a channel, by the permission rules Discord applies to overwrites (role allow/deny over @everyone). */
  canView(channelId: string, member: { roles: string[]; userId?: string }): boolean {
    const c = this.channels.get(channelId);
    if (!c) return false;
    const eff = (cat: ChannelInfo | undefined): boolean => {
      const list = cat?.overwrites ?? [];
      let allow = true; // @everyone can see by default in a fresh server
      const ev = list.find((o) => o.id === this.guildId);
      if (ev?.deny.includes("ViewChannel")) allow = false;
      if (ev?.allow.includes("ViewChannel")) allow = true;
      const mine = list.filter((o) => o.type === "role" && member.roles.includes(o.id));
      if (mine.some((o) => o.deny.includes("ViewChannel"))) allow = false;
      if (mine.some((o) => o.allow.includes("ViewChannel"))) allow = true;
      const mem = list.find((o) => o.type === "member" && o.id === member.userId);
      if (mem?.deny.includes("ViewChannel")) allow = false;
      if (mem?.allow.includes("ViewChannel")) allow = true;
      return allow;
    };
    return eff(c);
  }
  can(channelId: string, member: { roles: string[] }, perm: PermName): boolean {
    const c = this.channels.get(channelId);
    if (!c) return false;
    let allow = perm === "SendMessages" || perm === "ReadMessageHistory" || perm === "ViewChannel"; // @everyone defaults
    const ev = c.overwrites.find((o) => o.id === this.guildId);
    if (ev?.deny.includes(perm)) allow = false;
    if (ev?.allow.includes(perm)) allow = true;
    const mine = c.overwrites.filter((o) => o.type === "role" && member.roles.includes(o.id));
    if (mine.some((o) => o.deny.includes(perm))) allow = false;
    if (mine.some((o) => o.allow.includes(perm))) allow = true;
    return allow;
  }
}

export class MemoryHubStore implements HubStore {
  hubs = new Map<string, HubRecord>();
  areas = new Map<string, AreaRecord>();
  chans = new Map<string, ChannelRef>();
  locks = new Map<string, { token: string; until: number }>();
  invs = new Map<string, InviteRecord>();
  posts = new Map<string, PostRecord>();

  async getHub(g: string) { return copy(this.hubs.get(g) ?? null); }
  async saveHub(r: HubRecord) { this.hubs.set(r.guildId, copy(r)); }
  async getArea(slug: string) { return copy(this.areas.get(slug) ?? null); }
  async listAreas() { return copy([...this.areas.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1))); }
  async saveArea(slug: string, base: { guildId: string; businessName: string }, patch: AreaPatch, now: number) {
    const cur = this.areas.get(slug) ?? { slug, guildId: base.guildId, businessName: base.businessName, channels: {}, status: "pending" as const, attempts: 0, createdAt: now, updatedAt: now };
    const next: Record<string, unknown> = { ...cur, guildId: base.guildId, businessName: base.businessName, updatedAt: now };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "channels" || v === undefined) continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    next.channels = { ...cur.channels, ...(patch.channels ?? {}) };
    this.areas.set(slug, next as unknown as AreaRecord);
    return copy(next as unknown as AreaRecord);
  }
  async setChannels(slug: string, guildId: string, channels: Partial<Record<ChannelKind, string>>) {
    for (const [id, ref] of this.chans) if (ref.slug === slug && !Object.values(channels).includes(id)) this.chans.delete(id);
    for (const [kind, id] of Object.entries(channels)) {
      const have = this.chans.get(id!);
      if (have && have.slug !== slug) throw new Error(`a Discord channel is already mapped to another business (${have.slug}); refusing to map it to ${slug}`);
      this.chans.set(id!, { slug, kind: kind as ChannelKind, guildId, channelId: id! });
    }
  }
  async channel(guildId: string, channelId: string) {
    const r = this.chans.get(channelId);
    return r && r.guildId === guildId ? copy(r) : null;
  }
  async claim(slug: string, now: number, ttl: number) {
    const l = this.locks.get(slug);
    if (l && l.until > now) return null;
    const token = `t${Math.random().toString(36).slice(2)}`;
    this.locks.set(slug, { token, until: now + ttl });
    if (!this.areas.has(slug)) this.areas.set(slug, { slug, guildId: "", businessName: slug, channels: {}, status: "pending", attempts: 0, createdAt: now, updatedAt: now });
    return token;
  }
  async release(slug: string, token: string) { if (this.locks.get(slug)?.token === token) this.locks.delete(slug); }
  syncLocks = new Map<string, { token: string; until: number }>();
  async claimSync(slug: string, now: number, ttl: number) {
    const l = this.syncLocks.get(slug);
    if (l && l.until > now) return null;
    const token = `s${Math.random().toString(36).slice(2)}`;
    this.syncLocks.set(slug, { token, until: now + ttl });
    return token;
  }
  async releaseSync(slug: string, token: string) { if (this.syncLocks.get(slug)?.token === token) this.syncLocks.delete(slug); }
  async saveInvite(r: InviteRecord) { this.invs.set(r.code, copy(r)); }
  async invites(slug: string) { return copy([...this.invs.values()].filter((i) => i.slug === slug).sort((a, b) => a.createdAt - b.createdAt || (a.code < b.code ? -1 : 1))); }
  async openInvites(g: string) { return copy([...this.invs.values()].filter((i) => i.guildId === g && i.status === "open")); }
  async getPost(key: string) { return copy(this.posts.get(key) ?? null); }
  async savePost(r: PostRecord) { this.posts.set(r.key, copy(r)); }
  async openApprovalPosts(slug: string) { return copy([...this.posts.values()].filter((p) => p.slug === slug && p.kind === "approval" && !p.closed)); }
}
