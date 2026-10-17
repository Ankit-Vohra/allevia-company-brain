// The graph side of posting. A post is a Content node (id content:publish-<approval>), written when the owner says OK and updated as
// it goes: scheduled -> publishing -> published | failed | cancelled (a dry run is written as dry_run: a planned post). It keeps exactly
// what was approved (platform, account, caption, the one picture or video, the time, a hash of those) plus what came of it (the post's
// address, the time, why it failed). Every change of status leaves a Version (Content.status is tracked). Wired in:
//   Content -USES_ASSET-> the Asset posted
//   Content -PUBLISHED_ON {state}-> Channel   from the moment it is scheduled (state: scheduled, then published, failed, cancelled or
//                                             dry_run), on the platform's channel (channel:instagram, which the numbers measure) AND on
//                                             the account it went from (channel:instagram:cafe, PART_OF the platform's channel), so
//                                             two accounts on one platform are two nodes
//   Content -ADVANCES-> Goal                  the goals of the Recommendation behind the card (Approval <-PROPOSES- Recommendation)
//   Approval -RESULTED_IN-> Action -RESULTED_IN-> Content
// Claims are one statement each (like the Approval's decisionToken), so a cancel, the scheduler and a retry never act on the same
// post at once; the statement that claims a post also writes the Version of the state it leaves.
import { randomBytes } from "node:crypto";
import type { GraphHandle } from "../graph/client.js";
import { ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP } from "../graph/indexes.js";
import { noteGraphWrite } from "../graph/projection.js";
import { upsertEdge, upsertNode, type Prim } from "../graph/upsert.js";
import { defined } from "../graph/validate.js";
import { advanceGoals, existingIds } from "../actions/shared.js";
import { entityId, sha256, slugify } from "../util/ids.js";
import { isoDate } from "../util/time.js";
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

/** Writes (or updates) the post. Only the fields given are changed; a field set to null is cleared. A change of status also brings the post's channel edges (state) up to date. */
export async function writePost(g: GraphHandle, id: string, name: string, change: { [K in keyof PostRow]?: PostRow[K] | null }, now: number): Promise<void> {
  const props: Record<string, Prim> = { format: "post" };
  for (const k of PROP_KEYS) {
    const v = change[k];
    if (v === undefined) continue;
    props[k] = v as Prim;
  }
  if (change.platform) props.channel = change.platform;
  await upsertNode(g, { type: "Content", id, name: name.slice(0, 200) || id, props }, now);
  if (typeof change.status === "string") await linkChannels(g, id, change.status, now);
}

/** The generic channel of a platform: channel:instagram. The numbers (followers, reach) measure it, and posts have always been PUBLISHED_ON it. */
export const platformChannelId = (platform: PlatformId): string => `channel:${platform}`;

/** The account a post goes from, as a node of its own: channel:<platform>:<handle, else the account's id>. */
export function accountChannelId(platform: PlatformId, a: { accountId: string; accountHandle?: string }): string {
  const key = slugify(a.accountHandle ?? a.accountId) || sha256(a.accountId).slice(0, 12);
  return `channel:${platform}:${key}`;
}

/**
 * Content -PUBLISHED_ON {state}-> the platform's channel and the account's channel (made when missing; the account is PART_OF the
 * platform's channel), from the first time a post is written, so a scheduled or a planned (dry run) post is already on the channel it
 * is for. `state` follows the post: scheduled, publishing, published, failed, cancelled, dry_run. Missing ends are skipped, never invented.
 */
export async function linkChannels(g: GraphHandle, id: string, status: PostStatus, now: number): Promise<void> {
  const [r] = await g.roQuery<{ platform: string | null; approval: string | null; accountId: string | null; accountName: string | null; accountHandle: string | null }>(
    "MATCH (c:Entity:Content {id:$id}) RETURN c.platform AS platform, c.approval AS approval, c.accountId AS accountId, c.accountName AS accountName, c.accountHandle AS accountHandle", { id });
  const platform = r?.platform as PlatformId | null | undefined;
  if (!r || !platform || !PLATFORMS[platform]) return;
  const spec = PLATFORMS[platform];
  const generic = platformChannelId(platform);
  const asOf = isoDate(now);
  const stamp = { since: now, asOf, ...(r.approval ? { src: r.approval } : {}) };
  try {
    if (!(await existingIds(g, [generic])).has(generic)) await upsertNode(g, { type: "Channel", id: generic, name: spec.name, props: { platform } }, now);
    await upsertEdge(g, { from: id, type: "PUBLISHED_ON", to: generic, props: { state: status }, ...stamp }, now);
    if (r.accountId) {
      const account = accountChannelId(platform, { accountId: r.accountId, ...(r.accountHandle ? { accountHandle: r.accountHandle } : {}) });
      const label = r.accountHandle ?? r.accountName ?? r.accountId;
      await upsertNode(g, {
        type: "Channel", id: account, name: `${spec.name} ${label}`,
        props: { platform, kind: "account", accountId: r.accountId, ...(r.accountHandle ? { handle: r.accountHandle } : {}), ...(r.accountName ? { accountName: r.accountName } : {}) },
        ...(r.approval ? { src: r.approval } : {}), asOf,
      }, now);
      await upsertEdge(g, { from: account, type: "PART_OF", to: generic, ...stamp }, now);
      await upsertEdge(g, { from: id, type: "PUBLISHED_ON", to: account, props: { state: status }, ...stamp }, now);
    }
  } catch {
    // the post stands without its channel edges: the next change of status writes them again
  }
}

/** The edges around a post: the asset it posts, the goals its card advances. Missing ends are skipped, never invented. */
export async function linkPost(g: GraphHandle, row: Pick<PostRow, "id" | "approval" | "assetId">, now: number): Promise<void> {
  if (row.assetId && (await existingIds(g, [row.assetId])).has(row.assetId)) {
    await upsertEdge(g, { from: row.id, type: "USES_ASSET", to: row.assetId, since: now, asOf: isoDate(now), ...(row.approval ? { src: row.approval } : {}) }, now).catch(() => undefined);
  }
  // the post advances what the card advanced: Approval <-PROPOSES- Recommendation -ADVANCES-> Goal, copied onto the Content
  if (row.approval) await advanceGoals(g, { from: row.id, approvalId: row.approval, src: row.approval, now });
}

// One atomic step from one of `from` to a new status, for one caller only: the state it leaves is written as a Version in the same
// statement (the way src/graph/nodes.ts does for a tracked prop, with the version's id inside the CREATE), and `rev` moves so an
// upsertNode that read the old state retries. A statement that lost a race to a change of another prop reads again and tries again.
async function step(g: GraphHandle, id: string, from: PostStatus[], to: PostStatus, set: Record<string, Prim>, inc: number, now: number): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [cur] = await g.peek<{ kv: Array<[string, unknown]> }>(
      "MATCH (c:Entity:Content {id:$id}) RETURN [k IN keys(c) WHERE NOT k IN $skip | [k, c[k]]] AS kv LIMIT 1", { id, skip: [ENTITY_VECTOR_PROP, CHUNK_VECTOR_PROP] });
    if (!cur) return false;
    const old = Object.fromEntries(cur.kv);
    if (typeof old.status !== "string" || !from.includes(old.status as PostStatus)) return false;
    const rev = n(old.rev) ?? 0;
    const snapshot = JSON.stringify(old);
    const since = n(old.stateSince) ?? n(old.updatedAt) ?? n(old.createdAt) ?? now;
    const vid = `version:${id}@${now}-${sha256(snapshot).slice(0, 8)}`;
    const version = defined({ id: vid, name: "", of: id, props: snapshot, changed: ["status"], since, until: Math.max(since, now), src: s(old.src), asOf: s(old.asOf), createdAt: now, updatedAt: now });
    const rows = await g.query<{ c: number }>(
      `MATCH (c:Entity:Content {id:$id}) WHERE c.status IN $from AND coalesce(c.rev, 0) = $rev
       CREATE (c)-[h:HAD_VERSION]->(v:Entity:Version {id: $vid}) SET v += $version, h += $hv
       SET c += $set, c.status = $to, c.attempts = coalesce(c.attempts, 0) + $inc, c.rev = $rev + 1, c.updatedAt = $now, c.stateSince = $now
       RETURN count(c) AS c`,
      { id, from, rev, vid, version, hv: { since: now, recordedAt: now }, set, to, inc, now });
    if (rows[0]?.c) {
      await noteGraphWrite(g.name); // a Version node and a HAD_VERSION edge appeared
      return true;
    }
  }
  return false;
}

/** One atomic claim: the post moves to `publishing` for this caller only. Null when it was not in one of the `from` states (or someone else got it first). */
export async function claim(g: GraphHandle, id: string, from: PostStatus[], now: number): Promise<string | null> {
  const token = randomBytes(8).toString("hex");
  return (await step(g, id, from, "publishing", { claim: token, attemptedAt: now }, 1, now)) ? token : null;
}

/** Cancels a post that has not gone out. False when it already went, is going, or was cancelled. */
export async function cancelPost(g: GraphHandle, id: string, now: number): Promise<boolean> {
  if (!(await step(g, id, ["scheduled"], "cancelled", { cancelledAt: now }, 0, now))) return false;
  await linkChannels(g, id, "cancelled", now);
  return true;
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
