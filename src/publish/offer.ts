// Offering to post. When something made for the owner (a poster, a picture, a reel, a Studio photo) is waiting for their OK and the
// business has the right channel connected, the card says what approving does: "Post to Instagram (your account @cafe)". Two steps:
//   planPublish       where it would go: the connection must be connected, and the account it is signed in as is read (a read only)
//   upgradeToPublish  turns the waiting draft card (content_draft) into a publish_post card with the SAME pictures and caption, so
//                     the web page, Discord and the Studio's Approve all show and handle it as before; only what approving DOES changes
// Nothing is posted here: the card still waits for the owner, and a business without the connection keeps the draft card.
import type { ConnectionsPort } from "../connections/service.js";
import { RateLimitedError } from "../connections/service.js";
import { NeedsAttentionError, NotAllowedError, NotConfiguredError, NotConnectedError } from "../connections/types.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { validZone } from "../util/zones.js";
import { clip } from "../insights/text.js";
import { PLATFORMS, accountWords, postTitle, type PlatformId, type PlatformSpec } from "./platforms.js";
import { PublishFailure, readAccount, type PostSession } from "./post.js";
import type { PublishBlock } from "./types.js";

export type Plan =
  | { ok: true; block: PublishBlock; spec: PlatformSpec }
  | { ok: false; why: string; connect?: { id: string; name: string } };

/** The platform a made thing's channel means: "instagram" is Instagram; a Story, print and anything else can't be posted from here (yet). */
export function platformOfChannel(channel: string, kind?: string): { platform: PlatformId } | { why: string } {
  const c = channel.trim().toLowerCase();
  if (c === "instagram") return { platform: "instagram" };
  if (c === "facebook") return { platform: "facebook" };
  if (c === "linkedin") return { platform: "linkedin" };
  if (c === "instagram story") return { why: "Instagram Stories can't be posted from here yet, so approving saves it as a draft." };
  if (c === "print") return { why: `${kind === "poster" ? "A flyer" : "This"} is for print, so approving saves it as a draft.` };
  return { why: "Approving saves it as a draft." };
}

export async function businessZone(g: Pick<GraphHandle, "roQuery">): Promise<string | undefined> {
  const [r] = await g.roQuery<{ tz: string | null }>("MATCH (b:Entity:Business) RETURN b.timeZone AS tz ORDER BY b.id LIMIT 1").catch(() => []);
  return validZone(r?.tz) ? r!.tz! : undefined;
}

const reconnect = (spec: PlatformSpec) => ({ id: spec.connection, name: spec.name });

/** Words for a connection that cannot be used right now (the same refusals every connection tool gives). */
export function connectionWords(e: unknown, spec: PlatformSpec): { why: string; connect?: { id: string; name: string } } | null {
  if (e instanceof NotConnectedError) return { why: `${spec.name} isn't connected yet.`, connect: reconnect(spec) };
  if (e instanceof NeedsAttentionError) return { why: `${spec.name} stopped working and needs to be connected again.`, connect: reconnect(spec) };
  if (e instanceof NotAllowedError) return { why: e.words, connect: reconnect(spec) };
  if (e instanceof NotConfiguredError) return { why: e.availability.message };
  if (e instanceof RateLimitedError) return { why: e.words };
  if (e instanceof PublishFailure) return { why: e.words, ...(e.reconnect ? { connect: reconnect(spec) } : {}) };
  return null;
}

/** Where a post to `platform` would go, when the business has it connected. */
export async function planPublish(o: { graph: GraphHandle; connections?: ConnectionsPort; agent?: string }, platform: PlatformId, when?: { at: number; tz?: string }): Promise<Plan> {
  const spec = PLATFORMS[platform];
  if (!o.connections) return { ok: false, why: `${spec.name} isn't connected yet.`, connect: reconnect(spec) };
  try {
    const view = (await o.connections.status(spec.connection)) as Awaited<ReturnType<ConnectionsPort["status"]>> & { available?: boolean }; // the port answers with the owner's view, which also says whether it is switched on
    if (view.available === false) return { ok: false, why: `Connecting ${spec.name} isn't switched on yet, so posts stay drafts.` };
    if (view.state !== "connected") return { ok: false, why: view.state === "needs_attention" ? `${spec.name} stopped working and needs to be connected again.` : `${spec.name} isn't connected yet.`, connect: reconnect(spec) };
    const account = await o.connections.run<PostSession, Awaited<ReturnType<typeof readAccount>>>(spec.connection, "read account", (s) => readAccount(spec, s), { ...(o.agent ? { actor: o.agent } : {}) });
    const tz = when?.tz ?? (await businessZone(o.graph));
    return { ok: true, spec, block: { platform, connection: spec.connection, account, ...(tz ? { tz } : {}), ...(when ? { at: when.at } : {}) } };
  } catch (e) {
    const w = connectionWords(e, spec);
    if (w) return { ok: false, ...w };
    return { ok: false, why: `${spec.name} didn't answer just now, so this stays a draft.` };
  }
}

/** The sentence that says what approving does. */
export const approvingWords = (spec: PlatformSpec, block: PublishBlock): string => `Approving posts it to ${spec.name} (${accountWords(spec, block.account)})${block.at ? " at the time shown" : " straight away"}. Nothing is posted until you approve.`;

/**
 * Turns a waiting content_draft card into a publish_post card in place. The options and the caption stay; the title, the
 * target and what approving does change. Returns false when there is nothing to change (not waiting, or not a card with options).
 */
export async function upgradeToPublish(g: GraphHandle, approvalId: string, block: PublishBlock, now: number): Promise<boolean> {
  const spec = PLATFORMS[block.platform];
  const [row] = await g.roQuery<{ status: string | null; payload: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.status AS status, a.payload AS payload", { id: approvalId });
  if (!row || row.status !== "pending" || !row.payload) return false;
  let p: Record<string, unknown>;
  try { p = JSON.parse(row.payload) as Record<string, unknown>; } catch { return false; }
  if (!p || typeof p !== "object" || !p.studio) return false;
  const made = typeof p.title === "string" ? p.title.replace(/^Post to .*?\): /, "").replace(/^Post (the )?/i, "") : "";
  const title = clip(`${postTitle(spec, block.account)}${made ? `: ${made}` : ""}`, 200);
  const next = { ...p, title, target: `${spec.name}: ${block.account.handle ?? block.account.name}`, publish: block };
  await upsertNode(g, { type: "Approval", id: approvalId, name: `publish_post: ${title}`, props: { kind: "publish_post", title, payload: JSON.stringify(next) } }, now);
  return true;
}
