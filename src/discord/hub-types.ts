// The Discord hub (one shared server for every customer, one shared Allevia bot): the shapes everything in
// src/discord/hub-*.ts agrees on. Two small ports keep it all testable with no network:
//   HubPort   what we do TO Discord (create a role, a category, channels, an invite, post a message, give a role).
//             hub-rest.ts adapts it to Discord's REST API; tests use an in-memory fake.
//   HubStore  where the mapping lives: channel id -> business, in the `allevia_meta` graph (hub-store.ts).
// The mapping is the only thing that decides which business a Discord channel belongs to. Nothing the customer types,
// no channel or category name, ever picks a business.
import type { Outgoing } from "./bot.js";

// ---------- permissions ----------

// Discord permission bits (https://discord.com/developers/docs/topics/permissions). Only the ones we use.
export const PERM = {
  CreateInstantInvite: 1n << 0n,
  ManageChannels: 1n << 4n,
  Administrator: 1n << 3n,
  AddReactions: 1n << 6n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  ManageRoles: 1n << 28n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  SendMessagesInThreads: 1n << 38n,
} as const;
export type PermName = keyof typeof PERM;

// What the shared bot needs, and nothing more. Manage Channels and Manage Roles are how it builds each customer's
// area; Create Instant Invite is the join link; View, Send, Read History, Embed Links and the two thread permissions
// are what the existing bot already uses. Attach Files is there only because Discord lets a bot grant a permission
// in a channel only if it holds it itself, and customers may attach a screenshot in #support.
export const BOT_PERMISSIONS: PermName[] = [
  "ViewChannel", "SendMessages", "SendMessagesInThreads", "CreatePublicThreads", "ReadMessageHistory", "EmbedLinks",
  "AttachFiles", "ManageChannels", "ManageRoles", "CreateInstantInvite",
];

export const permBits = (names: readonly PermName[]): bigint => names.reduce((n, p) => n | PERM[p], 0n);
export const BOT_PERMISSION_INTEGER = permBits(BOT_PERMISSIONS).toString();

export interface Overwrite {
  id: string;                 // a role id (the @everyone role's id is the guild id) or a user id
  type: "role" | "member";
  allow: PermName[];
  deny: PermName[];
}

// Stable form, so two overwrite lists compare equal whatever order they were written in.
export function normalizeOverwrites(list: Overwrite[]): Overwrite[] {
  return list
    .map((o) => ({ id: o.id, type: o.type, allow: [...new Set(o.allow)].sort(), deny: [...new Set(o.deny)].sort() }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export const sameOverwrites = (a: Overwrite[], b: Overwrite[]): boolean =>
  JSON.stringify(normalizeOverwrites(a)) === JSON.stringify(normalizeOverwrites(b));

// The HTTP status of a failed Discord REST call, when it has one.
export const statusOf = (e: unknown): number | undefined => (e && typeof e === "object" && "status" in e && typeof (e as { status: unknown }).status === "number" ? (e as { status: number }).status : undefined);

// ---------- the Discord port ----------

export interface RoleInfo { id: string; name: string; position: number }
export interface ChannelInfo {
  id: string;
  name: string;
  kind: "category" | "text" | "other";
  parentId: string | null;
  position: number;           // the order among its siblings (a company's channels, or the server's categories)
  topic: string | null;
  overwrites: Overwrite[];
}
export interface ChannelSpec { name: string; kind: "category" | "text"; parentId?: string; topic?: string; position?: number; overwrites: Overwrite[] }
export interface InviteInfo { code: string; channelId: string; uses: number; maxUses: number; expiresAt: number | null }
export interface InviteSpec { maxUses: number; maxAgeSeconds: number }

export interface HubPort {
  readonly guildId: string;
  guildName(): Promise<string>;
  botUserId(): Promise<string>;
  botTopRolePosition(): Promise<number>;
  // Read-only checks for `discord-hub status`: what the bot may do in this guild (all of its roles combined, Administrator
  // counts as everything), and whether the Developer Portal has the privileged intents switched on for the application.
  botPermissions(): Promise<bigint>;
  intents(): Promise<{ serverMembers: boolean; messageContent: boolean }>;
  listRoles(): Promise<RoleInfo[]>;
  createRole(name: string): Promise<RoleInfo>;
  listChannels(): Promise<ChannelInfo[]>;
  createChannel(spec: ChannelSpec): Promise<ChannelInfo>;
  editChannel(id: string, patch: { name?: string; topic?: string; parentId?: string; position?: number; overwrites?: Overwrite[] }): Promise<void>;
  sendMessage(channelId: string, m: Outgoing): Promise<{ id: string }>;
  editMessage(channelId: string, messageId: string, m: Outgoing): Promise<void>;
  messageExists(channelId: string, messageId: string): Promise<boolean>;
  createInvite(channelId: string, spec: InviteSpec): Promise<InviteInfo>;
  // null: Discord would not let us read this channel's invites (the channel is gone, or the bot lost its permission).
  listInvites(channelId: string): Promise<InviteInfo[] | null>;
  deleteInvite(code: string): Promise<void>;
  addMemberRole(userId: string, roleId: string): Promise<void>;
}

// ---------- the mapping (allevia_meta) ----------

// In the order a company always sees them.
export const CHANNEL_KINDS = ["your-team", "studio", "approvals", "todays-note", "support"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface AreaRecord {
  slug: string;
  guildId: string;
  businessName: string;
  roleId?: string;
  categoryId?: string;
  channels: Partial<Record<ChannelKind, string>>;
  welcomeMessageId?: string;
  status: "pending" | "ready";
  attempts: number;           // failed provisioning runs since the last success
  lastError?: string;
  nextAttemptAt?: number;     // when the retry loop tries again (absent: not queued)
  createdAt: number;
  updatedAt: number;
}

export type AreaPatch = Partial<Omit<AreaRecord, "slug" | "channels" | "createdAt" | "updatedAt" | "lastError" | "nextAttemptAt" | "roleId" | "categoryId" | "welcomeMessageId">> & {
  channels?: Partial<Record<ChannelKind, string>>;
  // null clears a field
  lastError?: string | null; nextAttemptAt?: number | null; roleId?: string | null; categoryId?: string | null; welcomeMessageId?: string | null;
};

export type InviteStatus = "open" | "used" | "expired" | "revoked" | "gone";
export interface InviteRecord {
  code: string;
  slug: string;
  guildId: string;
  channelId: string;          // the invite lives on the customer's #your-team
  url: string;
  maxUses: number;
  expiresAt: number;
  uses: number;               // the use count at the last look: a join is "this went up" or "this vanished"
  status: InviteStatus;
  createdAt: number;
  usedAt?: number;
}

export interface PostRecord {
  key: string;                // <slug>|approval|<id> or <slug>|note|<id>
  slug: string;
  kind: "approval" | "note";
  refId: string;
  channelId: string;
  messageId: string;
  closed: boolean;            // an approval whose card no longer shows buttons
  postedAt: number;
}

export interface HubRecord { guildId: string; staffCategoryId?: string; supportInboxId?: string; updatedAt: number }

export interface ChannelRef { slug: string; kind: ChannelKind; guildId: string; channelId: string }

export interface HubStore {
  getHub(guildId: string): Promise<HubRecord | null>;
  saveHub(rec: HubRecord): Promise<void>;
  getArea(slug: string): Promise<AreaRecord | null>;
  listAreas(): Promise<AreaRecord[]>;
  // Merges `patch` into the area (creating it); `base` fills the fields a new area needs.
  saveArea(slug: string, base: { guildId: string; businessName: string }, patch: AreaPatch, now: number): Promise<AreaRecord>;
  // Replaces the channel index of one business: exactly these channel ids map to it afterwards.
  setChannels(slug: string, guildId: string, channels: Partial<Record<ChannelKind, string>>): Promise<void>;
  // THE lookup: a Discord channel id (in this guild) to the business and which of its channels it is. Never a name.
  channel(guildId: string, channelId: string): Promise<ChannelRef | null>;
  // One writer per business at a time, across processes. Returns a token, or null when someone else holds it.
  claim(slug: string, now: number, ttlMs: number): Promise<string | null>;
  release(slug: string, token: string): Promise<void>;
  saveInvite(rec: InviteRecord): Promise<void>;
  invites(slug: string): Promise<InviteRecord[]>;
  openInvites(guildId: string): Promise<InviteRecord[]>;
  getPost(key: string): Promise<PostRecord | null>;
  savePost(rec: PostRecord): Promise<void>;
  openApprovalPosts(slug: string): Promise<PostRecord[]>;
}

// ---------- names ----------

export const roleNameFor = (slug: string): string => `customer-${slug}`;
export const INBOX_NAME = "support-inbox";
export const STAFF_CATEGORY_NAME = "Allevia Staff";
export const INVITE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// A business name as a Discord category name: no control characters or line breaks, at most 100 characters.
export function categoryNameFor(businessName: string): string {
  const clean = businessName.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return (clean || "Your business").slice(0, 100);
}
