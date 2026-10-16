// What the hub leaves in a business's own graph (graph audit G13), so the business's records know it has a Discord space, which card
// became which message, and who the people on its team are. The registry (allevia_meta, hub-store.ts) says which channel belongs to which
// business; this is the other half: the business's own graph says what happened in it.
//   Channel{id:'channel:discord', platform:'discord'} -PART_OF-> Business      when the business's area becomes ready
//   Approval -PUBLISHED_ON {messageId, postedAt, discordChannelId, surface}-> channel:discord     when a card is posted
//   Person{discordUserId} -MEMBER_OF-> Business                                when someone joins with the business's link
// Nothing here reads or stores a token. A person is named by their Discord user id only: the join gives us nothing else, and a
// Discord display name is never copied (it can be a real name the person did not give to this business).
import type { GraphHandle } from "../graph/client.js";
import { businessId } from "../graph/tenants.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { isoDate } from "../util/time.js";

export const DISCORD_CHANNEL = "channel:discord";

const iso = (ms: number): string => new Date(ms).toISOString();

async function exists(g: Pick<GraphHandle, "roQuery">, label: "Business" | "Channel" | "Approval" | "Person", id: string): Promise<boolean> {
  return (await g.roQuery<{ id: string }>(`MATCH (n:Entity:${label} {id:$id}) RETURN n.id AS id`, { id })).length > 0;
}

/** The business's Discord space as a Channel of its own graph, PART_OF the business. False when the business has no node yet. */
export async function ensureDiscordChannel(g: GraphHandle, slug: string, now: number): Promise<boolean> {
  const biz = businessId(slug);
  if (!(await exists(g, "Business", biz))) return false;
  await upsertNode(g, { type: "Channel", id: DISCORD_CHANNEL, name: "Discord", props: { platform: "discord" }, src: biz, asOf: iso(now) }, now);
  await upsertEdge(g, { from: DISCORD_CHANNEL, type: "PART_OF", to: biz, since: now, src: biz, asOf: iso(now) }, now);
  return true;
}

export interface PostedCard { channelId: string; messageId: string; postedAt: number; surface: "approvals" | "todays-note" }

/** An approval card went out as a Discord message: the Approval is PUBLISHED_ON the Discord channel, with the message and when. */
export async function notePosted(g: GraphHandle, slug: string, approvalId: string, p: PostedCard): Promise<void> {
  if (!(await exists(g, "Approval", approvalId))) return;
  if (!(await ensureDiscordChannel(g, slug, p.postedAt))) return;
  await upsertEdge(g, {
    from: approvalId, type: "PUBLISHED_ON", to: DISCORD_CHANNEL, since: p.postedAt, src: approvalId, asOf: isoDate(p.postedAt),
    props: { messageId: p.messageId, postedAt: p.postedAt, discordChannelId: p.channelId, surface: p.surface },
  }, p.postedAt);
}

/** The Person a Discord user is in a business's graph. The id is the Discord user id and nothing else. */
export const discordPersonId = (userId: string): string => `person:discord-${userId}`;

/**
 * Someone joined with the business's link and got its role: they are a Person in the business's graph, MEMBER_OF the business, with
 * their Discord user id kept as \`discordUserId\` so an approval they press can be attributed to them. Named by the last four digits of
 * the id (the join gives us no name, and none is looked up).
 */
export async function recordMember(g: GraphHandle, slug: string, m: { userId: string; joinedAt: number }): Promise<string | null> {
  if (!/^\d{1,25}$/.test(m.userId)) return null; // a Discord snowflake, nothing else
  const biz = businessId(slug);
  if (!(await exists(g, "Business", biz))) return null;
  const id = discordPersonId(m.userId);
  const asOf = iso(m.joinedAt);
  await upsertNode(g, { type: "Person", id, name: `Team member on Discord (${m.userId.slice(-4)})`, props: { discordUserId: m.userId, role: "team", joinedVia: "discord" }, src: biz, asOf }, m.joinedAt);
  await upsertEdge(g, { from: id, type: "MEMBER_OF", to: biz, since: m.joinedAt, src: biz, asOf }, m.joinedAt);
  return id;
}

/** The Person who pressed a button, when they joined through the hub and so have a node; null otherwise (the card then goes to the owner as before). */
export async function personOfDiscordUser(g: Pick<GraphHandle, "roQuery">, userId: string): Promise<string | null> {
  if (!/^\d{1,25}$/.test(userId)) return null;
  const id = discordPersonId(userId);
  return (await exists(g, "Person", id)) ? id : null;
}
