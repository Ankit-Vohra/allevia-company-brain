// The graph side of posting. A post is a Content node (id content:publish-<approval>), written when the owner says OK and updated as
// it goes: scheduled -> publishing -> published | failed | cancelled. It keeps exactly what was approved (platform, account, caption,
// the one picture or video, the time, a hash of those) plus what came of it (the post's address, the time, why it failed). Wired in:
//   Content -USES_ASSET-> the Asset posted     Content -PUBLISHED_ON-> Channel (Instagram, Facebook, LinkedIn)
//   Approval -RESULTED_IN-> Action -RESULTED_IN-> Content
// Claims are one statement each (like the Approval's decisionToken), so a cancel, the scheduler and a retry never act on the same
// post at once.
import { randomBytes } from "node:crypto";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode, type Prim } from "../graph/upsert.js";
import { existingIds } from "../actions/shared.js";
import { entityId } from "../util/ids.js";
import { PLATFORMS, type PlatformId } from "./platforms.js";
import type { PostRow, PostStatus } from "./types.js";

type Read = Pick<GraphHandle, "roQuery">;

export const contentIdFor = (approvalId: string): string => entityId("Content", `publish ${approvalId.replace(/^approval:/, "")}`);
// the Action's id, as executors.ts derives it from the Approval's (the same one-line rule)
export const actionIdOf = (approvalId: string): string => `action:${approvalId.replace(/^approval:/, "")}`;

const s = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const n = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const b = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export function toRow(p: Record<string, unknown>): PostRow | null {
  const platform = s(p.platform) as PlatformId | undefined;
  if (!platform || !PLATFORMS[platform] || !s(p.approvedHash) || !s(p.id)) return null;
  const status = s(p.status) as PostStatus | undefined;
  if (!status) return null;
  return {
    id: s(p.id)!, approval: s(p.approval) ?? "", platform, connection: s(p.connection) ?? PLATFORMS[platform].connection,
    accountId: s(p.accountId) ?? "", accountName: s(p.accountName) ?? "", ...(s(p.accountHandle) ? { accountHandle: s(p.accountHandle)! } : {}),
    title: s(p.title) ?? "", caption: s(p.caption) ?? "", ...(s(p.assetId) ? { assetId: s(p.assetId)! } : {}),
    ...(p.mediaKind === "image" || p.mediaKind === "video" ? { mediaKind: p.mediaKind } : {}),
    status, publishAt: n(p.publishAt) ?? 0, ...(s(p.tz) ? { tz: s(p.tz)! } : {}), approvedHash: s(p.approvedHash)!, attempts: n(p.attempts) ?? 0,
    ...(n(p.attemptedAt) !== undefined ? { attemptedAt: n(p.attemptedAt)! } : {}), ...(n(p.postedAt) !== undefined ? { postedAt: n(p.postedAt)! } : {}),
    ...(b(p.counted) !== undefined ? { counted: b(p.counted)! } : {}),
    ...(s(p.postUrl) ? { postUrl: s(p.postUrl)! } : {}), ...(s(p.postId) ? { postId: s(p.postId)! } : {}), ...(n(p.publishedAt) !== undefined ? { publishedAt: n(p.publishedAt)! } : {}),
    ...(s(p.containerId) ? { containerId: s(p.containerId)! } : {}), ...(n(p.pendingSince) !== undefined ? { pendingSince: n(p.pendingSince)! } : {}),
    ...(s(p.failure) ? { failure: s(p.failure)! } : {}), ...(b(p.retryable) !== undefined ? { retryable: b(p.retryable)! } : {}), ...(b(p.maybePosted) !== undefined ? { maybePosted: b(p.maybePosted)! } : {}),
    ...(b(p.reconnect) !== undefined ? { reconnect: b(p.reconnect)! } : {}), ...(s(p.by) ? { by: s(p.by)! } : {}),
  };
}

export async function readPost(g: Read, id: string): Promise<PostRow | null> {
  const [r] = await g.roQuery<{ p: Record<string, unknown> }>("MATCH (c:Entity:Content {id:$id}) RETURN properties(c) AS p", { id });
  return r ? toRow(r.p) : null;
}

/** The post made for an approval, if there is one. */
export async function postOfApproval(g: Read, approvalId: string): Promise<PostRow | null> {
  return readPost(g, contentIdFor(approvalId));
}

const PROP_KEYS = [
  "approval", "platform", "connection", "accountId", "accountName", "accountHandle", "title", "caption", "assetId", "mediaKind", "status", "publishAt", "tz", "approvedHash",
  "attempts", "attemptedAt", "postedAt", "counted", "postUrl", "postId", "publishedAt", "containerId", "pendingSince", "failure", "retryable", "maybePosted", "reconnect", "by",
] as const satisfies ReadonlyArray<keyof PostRow>;

/** Writes (or updates) the post. Only the fields given are changed; a field set to null is cleared. */
export async function writePost(g: GraphHandle, id: string, name: string, change: { [K in keyof PostRow]?: PostRow[K] | null }, now: number): Promise<void> {
  const props: Record<string, Prim> = { format: "post" };
  for (const k of PROP_KEYS) {
    const v = change[k];
    if (v === undefined) continue;
    props[k] = v as Prim;
  }
  if (change.platform) props.channel = change.platform;
  await upsertNode(g, { type: "Content", id, name: name.slice(0, 200) || id, props }, now);
}

/** The edges around a post: the asset it posts, where it went, who made it. Missing ends are skipped, never invented. */
export async function linkPost(g: GraphHandle, row: Pick<PostRow, "id" | "platform" | "assetId" | "by">, now: number, o: { published: boolean }): Promise<void> {
  const channelId = `channel:${row.platform}`;
  if (o.published) {
    if (!(await existingIds(g, [channelId])).has(channelId)) await upsertNode(g, { type: "Channel", id: channelId, name: PLATFORMS[row.platform].name, props: { platform: row.platform } }, now);
    await upsertEdge(g, { from: row.id, type: "PUBLISHED_ON", to: channelId }, now).catch(() => undefined);
  }
  if (row.assetId && (await existingIds(g, [row.assetId])).has(row.assetId)) await upsertEdge(g, { from: row.id, type: "USES_ASSET", to: row.assetId }, now).catch(() => undefined);
}

/** One atomic claim: the post moves to `publishing` for this caller only. Null when it was not in one of the `from` states (or someone else got it first). */
export async function claim(g: GraphHandle, id: string, from: PostStatus[], now: number): Promise<string | null> {
  const token = randomBytes(8).toString("hex");
  const rows = await g.query<{ mine: boolean }>(
    "MATCH (c:Entity:Content {id:$id}) WHERE c.status IN $from SET c.status = 'publishing', c.claim = $token, c.attemptedAt = $now, c.attempts = coalesce(c.attempts, 0) + 1 RETURN c.claim = $token AS mine",
    { id, from, token, now });
  return rows[0]?.mine ? token : null;
}

/** Cancels a post that has not gone out. False when it already went, is going, or was cancelled. */
export async function cancelPost(g: GraphHandle, id: string, now: number): Promise<boolean> {
  const rows = await g.query<{ id: string }>("MATCH (c:Entity:Content {id:$id}) WHERE c.status = 'scheduled' SET c.status = 'cancelled', c.cancelledAt = $now RETURN c.id AS id", { id, now });
  return rows.length > 0;
}

/** Posts waiting for their time: the oldest first. */
export async function dueIds(g: Read, now: number, limit = 20): Promise<string[]> {
  const rows = await g.roQuery<{ id: string }>(
    "MATCH (c:Entity:Content) WHERE c.status = 'scheduled' AND c.publishAt <= $now RETURN c.id AS id ORDER BY c.publishAt, c.id LIMIT $limit", { now, limit });
  return rows.map((r) => r.id);
}

/** Posts that were handed to a platform that was still preparing them (Instagram video): the scheduler asks again. */
export async function pendingIds(g: Read, olderThan: number, limit = 20): Promise<string[]> {
  const rows = await g.roQuery<{ id: string }>(
    "MATCH (c:Entity:Content) WHERE c.status = 'publishing' AND c.pendingSince IS NOT NULL AND c.attemptedAt <= $olderThan RETURN c.id AS id ORDER BY c.attemptedAt, c.id LIMIT $limit", { olderThan, limit });
  return rows.map((r) => r.id);
}

/** Posts a crash left half way: claimed a while ago and never finished, and not waiting on a platform. */
export async function stuckIds(g: Read, olderThan: number, limit = 20): Promise<string[]> {
  const rows = await g.roQuery<{ id: string }>(
    "MATCH (c:Entity:Content) WHERE c.status = 'publishing' AND c.pendingSince IS NULL AND c.attemptedAt <= $olderThan RETURN c.id AS id ORDER BY c.attemptedAt, c.id LIMIT $limit", { olderThan, limit });
  return rows.map((r) => r.id);
}

/** Posts that went out, or may have, since `since`: what the daily limit counts. */
export async function countedSince(g: Read, since: number): Promise<number> {
  const [r] = await g.roQuery<{ n: number }>("MATCH (c:Entity:Content) WHERE c.counted = true AND c.postedAt >= $since RETURN count(c) AS n", { since });
  return r?.n ?? 0;
}

/** The newest posts, for the page that lists them (scheduled first). */
export async function recentPosts(g: Read, limit = 40): Promise<PostRow[]> {
  const rows = await g.roQuery<{ p: Record<string, unknown> }>(
    "MATCH (c:Entity:Content) WHERE c.approvedHash IS NOT NULL AND c.platform IS NOT NULL RETURN properties(c) AS p ORDER BY c.publishAt DESC, c.id LIMIT $limit", { limit });
  return rows.map((r) => toRow(r.p)).filter((x): x is PostRow => !!x);
}
