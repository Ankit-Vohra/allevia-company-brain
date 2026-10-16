// The hub's mapping, kept in the `allevia_meta` graph next to the tenant registry (ALLEVIA_META_GRAPH or opts.metaGraph
// points elsewhere, which is how tests stay off the real one). Node kinds, all with their own labels so nothing in a
// tenant graph or the schema is touched:
//   (:DiscordHub  {guildId, supportInboxId})                the hub-wide pieces (the staff-only #support-inbox)
//   (:DiscordArea {slug, guildId, roleId, categoryId, yourTeamId, approvalsId, todaysNoteId, supportId, ...})
//   (:DiscordChannel {channelId, guildId, slug, kind})      one per customer channel: THE channel id -> business index
//   (:DiscordInvite {code, slug, guildId, channelId, uses, status, expiresAt, ...})
//   (:DiscordPost {key, slug, kind, refId, channelId, messageId, closed})   what was already posted, so a retry is quiet
// Every query uses parameters (no Discord text is ever put into a query) and none sorts in the database.
import { openGraphByName, type GraphHandle } from "../graph/client.js";
import { ensureIndexes } from "../graph/indexes.js";
import { META_GRAPH, type TenantOpts } from "../graph/tenants.js";
import {
  CHANNEL_KINDS, type AreaPatch, type AreaRecord, type ChannelKind, type ChannelRef, type HubRecord, type HubStore,
  type InviteRecord, type InviteStatus, type PostRecord,
} from "./hub-types.js";

const CHANNEL_PROP: Record<ChannelKind, string> = {
  "your-team": "yourTeamId", studio: "studioId", approvals: "approvalsId", "todays-note": "todaysNoteId", support: "supportId",
};

type Props = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

function toArea(p: Props): AreaRecord {
  const channels: AreaRecord["channels"] = {};
  for (const k of CHANNEL_KINDS) {
    const id = str(p[CHANNEL_PROP[k]]);
    if (id) channels[k] = id;
  }
  return {
    slug: String(p.slug), guildId: String(p.guildId ?? ""), businessName: String(p.businessName ?? p.slug),
    ...(str(p.roleId) ? { roleId: str(p.roleId)! } : {}), ...(str(p.categoryId) ? { categoryId: str(p.categoryId)! } : {}),
    channels, ...(str(p.welcomeMessageId) ? { welcomeMessageId: str(p.welcomeMessageId)! } : {}),
    status: p.status === "ready" ? "ready" : "pending", attempts: num(p.attempts),
    ...(str(p.lastError) ? { lastError: str(p.lastError)! } : {}),
    ...(typeof p.nextAttemptAt === "number" ? { nextAttemptAt: p.nextAttemptAt } : {}),
    createdAt: num(p.createdAt), updatedAt: num(p.updatedAt),
  };
}

function toInvite(p: Props): InviteRecord {
  return {
    code: String(p.code), slug: String(p.slug), guildId: String(p.guildId), channelId: String(p.channelId), url: String(p.url ?? ""),
    maxUses: num(p.maxUses, 1), expiresAt: num(p.expiresAt), uses: num(p.uses), status: String(p.status ?? "open") as InviteStatus,
    createdAt: num(p.createdAt), ...(typeof p.usedAt === "number" ? { usedAt: p.usedAt } : {}),
  };
}

function toPost(p: Props): PostRecord {
  return {
    key: String(p.key), slug: String(p.slug), kind: p.kind === "note" ? "note" : "approval", refId: String(p.refId),
    channelId: String(p.channelId), messageId: String(p.messageId), closed: p.closed === true, postedAt: num(p.postedAt),
  };
}

export class GraphHubStore implements HubStore {
  private g?: Promise<GraphHandle>;
  constructor(private opts: TenantOpts = {}) {}

  private graph(): Promise<GraphHandle> {
    this.g ??= (async () => {
      const g = await openGraphByName(this.opts.metaGraph ?? process.env.ALLEVIA_META_GRAPH ?? META_GRAPH);
      await ensureIndexes(g, [
        { label: "DiscordArea", prop: "slug", type: "RANGE" },
        { label: "DiscordChannel", prop: "channelId", type: "RANGE" },
        { label: "DiscordInvite", prop: "code", type: "RANGE" },
        { label: "DiscordPost", prop: "key", type: "RANGE" },
        { label: "DiscordHub", prop: "guildId", type: "RANGE" },
      ]);
      return g;
    })();
    this.g.catch(() => { this.g = undefined; });
    return this.g;
  }

  async getHub(guildId: string): Promise<HubRecord | null> {
    const g = await this.graph();
    const [r] = await g.roQuery<{ p: Props }>("MATCH (h:DiscordHub {guildId:$guildId}) RETURN properties(h) AS p", { guildId });
    return r ? {
      guildId, ...(str(r.p.staffCategoryId) ? { staffCategoryId: str(r.p.staffCategoryId)! } : {}),
      ...(str(r.p.supportInboxId) ? { supportInboxId: str(r.p.supportInboxId)! } : {}), updatedAt: num(r.p.updatedAt),
    } : null;
  }

  async saveHub(rec: HubRecord): Promise<void> {
    const g = await this.graph();
    await g.query("MERGE (h:DiscordHub {guildId:$guildId}) SET h.supportInboxId = $inbox, h.staffCategoryId = $cat, h.updatedAt = $now",
      { guildId: rec.guildId, inbox: rec.supportInboxId ?? null, cat: rec.staffCategoryId ?? null, now: rec.updatedAt });
  }

  async getArea(slug: string): Promise<AreaRecord | null> {
    const g = await this.graph();
    const [r] = await g.roQuery<{ p: Props }>("MATCH (a:DiscordArea {slug:$slug}) RETURN properties(a) AS p", { slug });
    return r ? toArea(r.p) : null;
  }

  async listAreas(): Promise<AreaRecord[]> {
    const g = await this.graph();
    const rows = await g.roQuery<{ p: Props }>("MATCH (a:DiscordArea) RETURN properties(a) AS p");
    return rows.map((r) => toArea(r.p)).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  async saveArea(slug: string, base: { guildId: string; businessName: string }, patch: AreaPatch, now: number): Promise<AreaRecord> {
    const g = await this.graph();
    const props: Record<string, unknown> = { guildId: base.guildId, businessName: base.businessName };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "channels" || v === undefined) continue;
      props[k] = v; // null clears the property (SET a += {k: null})
    }
    for (const [kind, id] of Object.entries(patch.channels ?? {})) props[CHANNEL_PROP[kind as ChannelKind]] = id;
    await g.query(
      "MERGE (a:DiscordArea {slug:$slug}) ON CREATE SET a.createdAt = $now, a.status = 'pending', a.attempts = 0 SET a += $props, a.updatedAt = $now",
      { slug, now, props });
    return (await this.getArea(slug))!;
  }

  async setChannels(slug: string, guildId: string, channels: Partial<Record<ChannelKind, string>>): Promise<void> {
    const g = await this.graph();
    const rows = Object.entries(channels).map(([kind, channelId]) => ({ kind, channelId: channelId! }));
    // a channel id that already belongs to another business is never taken over
    const taken = await g.roQuery<{ slug: string }>(
      "UNWIND $ids AS id MATCH (c:DiscordChannel {channelId:id}) WHERE c.slug <> $slug RETURN DISTINCT c.slug AS slug", { ids: rows.map((r) => r.channelId), slug });
    if (taken.length) throw new Error(`a Discord channel is already mapped to another business (${taken[0]!.slug}); refusing to map it to ${slug}`);
    await g.query("MATCH (c:DiscordChannel {slug:$slug}) WHERE NOT c.channelId IN $ids DETACH DELETE c", { slug, ids: rows.map((r) => r.channelId) });
    if (rows.length) {
      await g.query("UNWIND $rows AS r MERGE (c:DiscordChannel {channelId: r.channelId}) SET c.guildId = $guildId, c.slug = $slug, c.kind = r.kind",
        { rows, guildId, slug });
    }
  }

  async channel(guildId: string, channelId: string): Promise<ChannelRef | null> {
    if (!/^\d{1,25}$/.test(channelId)) return null; // a Discord snowflake, nothing else
    const g = await this.graph();
    const [r] = await g.roQuery<{ slug: string; kind: string }>(
      "MATCH (c:DiscordChannel {channelId:$channelId, guildId:$guildId}) RETURN c.slug AS slug, c.kind AS kind", { channelId, guildId });
    if (!r || !(CHANNEL_KINDS as readonly string[]).includes(r.kind)) return null;
    return { slug: r.slug, kind: r.kind as ChannelKind, guildId, channelId };
  }

  async claim(slug: string, now: number, ttlMs: number): Promise<string | null> {
    const g = await this.graph();
    const token = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const rows = await g.query<{ mine: boolean }>(
      `MERGE (a:DiscordArea {slug:$slug}) ON CREATE SET a.createdAt = $now, a.updatedAt = $now, a.status = 'pending', a.attempts = 0
       WITH a WHERE coalesce(a.lockUntil, 0) < $now
       SET a.lockUntil = $until, a.lockToken = $token
       RETURN a.lockToken = $token AS mine`, { slug, now, until: now + ttlMs, token });
    return rows[0]?.mine ? token : null;
  }

  async release(slug: string, token: string): Promise<void> {
    const g = await this.graph();
    await g.query("MATCH (a:DiscordArea {slug:$slug}) WHERE a.lockToken = $token SET a.lockUntil = 0, a.lockToken = null", { slug, token });
  }

  async claimSync(slug: string, now: number, ttlMs: number): Promise<string | null> {
    const g = await this.graph();
    const token = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const rows = await g.query<{ mine: boolean }>(
      `MATCH (a:DiscordArea {slug:$slug}) WHERE coalesce(a.syncUntil, 0) < $now
       SET a.syncUntil = $until, a.syncToken = $token
       RETURN a.syncToken = $token AS mine`, { slug, now, until: now + ttlMs, token });
    return rows[0]?.mine ? token : null;
  }

  async releaseSync(slug: string, token: string): Promise<void> {
    const g = await this.graph();
    await g.query("MATCH (a:DiscordArea {slug:$slug}) WHERE a.syncToken = $token SET a.syncUntil = 0, a.syncToken = null", { slug, token });
  }

  async saveInvite(rec: InviteRecord): Promise<void> {
    const g = await this.graph();
    const { usedAt, ...rest } = rec;
    await g.query("MERGE (i:DiscordInvite {code:$code}) SET i += $props, i.usedAt = $usedAt", { code: rec.code, props: rest, usedAt: usedAt ?? null });
  }

  async invites(slug: string): Promise<InviteRecord[]> {
    const g = await this.graph();
    const rows = await g.roQuery<{ p: Props }>("MATCH (i:DiscordInvite {slug:$slug}) RETURN properties(i) AS p", { slug });
    return rows.map((r) => toInvite(r.p)).sort((a, b) => a.createdAt - b.createdAt || (a.code < b.code ? -1 : 1));
  }

  async openInvites(guildId: string): Promise<InviteRecord[]> {
    const g = await this.graph();
    const rows = await g.roQuery<{ p: Props }>("MATCH (i:DiscordInvite {guildId:$guildId, status:'open'}) RETURN properties(i) AS p", { guildId });
    return rows.map((r) => toInvite(r.p)).sort((a, b) => a.createdAt - b.createdAt || (a.code < b.code ? -1 : 1));
  }

  async getPost(key: string): Promise<PostRecord | null> {
    const g = await this.graph();
    const [r] = await g.roQuery<{ p: Props }>("MATCH (p:DiscordPost {key:$key}) RETURN properties(p) AS p", { key });
    return r ? toPost(r.p) : null;
  }

  async savePost(rec: PostRecord): Promise<void> {
    const g = await this.graph();
    await g.query("MERGE (p:DiscordPost {key:$key}) SET p += $props", { key: rec.key, props: rec });
  }

  async openApprovalPosts(slug: string): Promise<PostRecord[]> {
    const g = await this.graph();
    const rows = await g.roQuery<{ p: Props }>("MATCH (p:DiscordPost {slug:$slug, kind:'approval', closed:false}) RETURN properties(p) AS p", { slug });
    return rows.map((r) => toPost(r.p));
  }
}
