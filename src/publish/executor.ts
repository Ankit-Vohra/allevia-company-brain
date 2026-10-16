// What happens when the owner says OK to a "post it" card (kind publish_post). The rules, in the order they bite:
//   1. Nothing posts without the OK on THIS content: what was approved (platform, account, caption, the one picture or video, the
//      time) is hashed when the OK is given and checked again at the moment of posting; a post that changed since is never sent.
//   2. A dry run (ALLEVIA_ACTIONS_LIVE is not 1) reaches nothing: the card says it "would have posted", and nothing is kept.
//   3. A business may post `perDay` times in 24 hours (config.publish.perDay), all platforms together.
//   4. A time later than now means scheduled: the post waits as a Content node (status scheduled) and the scheduler (scheduler.ts)
//      posts it when its time comes, in the business's own time zone, unless the owner cancels it first.
//   5. Anything that goes wrong is said in plain words with what was and wasn't done, and a post that did not go out can be tried
//      again with one tap (retryPost). A post that MAY have gone out (the line dropped at the last step) is never repeated by
//      itself, and asks the owner to look first.
// The connection is the business's own (ConnectionsPort), through Composio; the post is made by post.ts.
import type { ConnectionsPort } from "../connections/service.js";
import { RateLimitedError } from "../connections/service.js";
import { NeedsAttentionError, NotAllowedError, NotConfiguredError, NotConnectedError } from "../connections/types.js";
import { loadConfig } from "../config.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertNode } from "../graph/upsert.js";
import { ensureAgentNode, type Payload } from "../actions/shared.js";
import { upsertEdge } from "../graph/upsert.js";
import { clip, oneLine } from "../insights/text.js";
import { publicAddressProblem, signMediaUrl, type MediaSigner } from "./media.js";
import { PLATFORMS, accountWords, type PlatformSpec } from "./platforms.js";
import { PublishFailure, publishPost, readAccount, type PostMedia, type PostOpts, type PostSession } from "./post.js";
import { actionIdOf, claim, cancelPost, contentIdFor, countedSince, linkPost, readPost, writePost } from "./record.js";
import { approvedHash, readBlock, type PostRow, type PostStatus, type PublishBlock } from "./types.js";
import { MIN_LEAD_MS, whenWords } from "./when.js";

export interface PublishRuntime {
  /** How the server makes a picture reachable from the internet; absent: pictures and videos can't be posted (text can). */
  signer?: MediaSigner;
  /** Posts a business may make in 24 hours (default: config). */
  perDay?: number;
  post?: PostOpts;
  now?: () => number;
}

/** What the executor and the scheduler need for one business. ExecutorDeps (src/actions/executors.ts) has the same fields. */
export interface PublishEnv {
  tenant: string;
  connections?: ConnectionsPort;
  /** True: nothing is posted; the result says what would have been. */
  dryRun?: boolean;
  publish?: PublishRuntime;
}

export type PublishStatus = "done" | "failed" | "skipped" | "dry_run";
export interface PublishOutcome { status: PublishStatus; result: string; url?: string; produced: string[]; affects?: string[] }

export interface PublishInput { approvalId: string; payload: Payload; agent?: string; now: number }

const LATE_GRACE_MS = 15 * 60_000;       // a post whose time passed less than this ago still goes out when the OK comes
const PENDING_RETRY_MS = 60_000;          // how long before the scheduler asks again about a post a platform was still preparing
const PENDING_GIVE_UP_MS = 30 * 60_000;
const STUCK_MS = 10 * 60_000;             // a post claimed this long ago and never finished (a crash): looked at, never repeated by itself

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The runtime from the server's own config: the public address pictures are served from, and the daily limit. */
export function defaultRuntime(): PublishRuntime {
  const cfg = loadConfig();
  const key = cfg.google.connectorKey ?? "";
  return { ...(key.length >= 32 ? { signer: { key, base: cfg.webBaseUrl, now: () => Date.now() } } : {}), perDay: cfg.publish.perDay };
}

const runtimeOf = (env: PublishEnv): PublishRuntime => env.publish ?? defaultRuntime();

async function portFor(env: PublishEnv): Promise<ConnectionsPort> {
  return env.connections ?? (await import("../connections/production.js")).productionConnections().port(env.tenant);
}

// ---------- what a post is made of ----------

interface Media { assetId: string; sha: string; kind: "image" | "video"; w?: number; h?: number }

interface StudioLike { variants?: Array<{ id: string; label?: string; badge?: string; note?: string }>; recommended?: string; creative?: { allowUnchecked?: boolean } }

// The one picture or video this approval posts: the option the owner picked (remembered on the card), else the one we recommended,
// else the single asset the card names. An option Nisha held back is never posted.
async function resolveMedia(g: GraphHandle, approvalId: string, p: Payload, block: PublishBlock, spec: PlatformSpec): Promise<{ ok: true; media?: Media } | { ok: false; words: string }> {
  const studio = (p.studio && typeof p.studio === "object" ? p.studio : undefined) as StudioLike | undefined;
  const [chosen] = await g.roQuery<{ v: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.chosenVariant AS v", { id: approvalId });
  const assetId = str(chosen?.v) ?? str(studio?.recommended) ?? block.assetId;
  if (!assetId) {
    return spec.media === "required" ? { ok: false, words: `Nothing was posted: ${spec.name} posts need a picture or a video, and this card has none.` } : { ok: true };
  }
  if (studio?.variants?.length) {
    const v = studio.variants.find((x) => x.id === assetId);
    if (!v) return { ok: false, words: "Nothing was posted: the picture chosen isn't one of this card's options." };
    const may = v.badge === "unchanged" || (v.badge === "unchecked" && studio.creative?.allowUnchecked === true);
    if (!may) return { ok: false, words: `Nothing was posted: Nisha held option ${v.label ?? ""} back${v.note ? ` (${clip(oneLine(v.note), 120)})` : ""}. Pick another option.`.replace("option  back", "that option back") };
  }
  const [a] = await g.roQuery<{ mime: string | null; sha: string | null; w: number | null; h: number | null; check: string | null }>(
    "MATCH (a:Entity:Asset {id:$id}) RETURN a.mime AS mime, a.sha256 AS sha, a.w AS w, a.h AS h, a.check AS check", { id: assetId });
  if (!a?.sha) return { ok: false, words: "Nothing was posted: the picture or video for this post is missing from your records." };
  if (!studio?.variants?.length && a.check === "held") return { ok: false, words: "Nothing was posted: the picture was held back in the quality check." };
  const kind = a.mime?.startsWith("video/") ? "video" as const : "image" as const;
  if (spec.id === "instagram" && kind === "image" && a.w && a.h) {
    const ratio = a.w / a.h;
    if (ratio < 0.79 || ratio > 1.92) {
      return { ok: false, words: `Nothing was posted: this picture is ${a.w} by ${a.h}, and Instagram's feed takes shapes between 4:5 (tall) and 1.91:1 (wide). Make it again in a feed shape.` };
    }
  }
  return { ok: true, media: { assetId, sha: a.sha, kind, ...(a.w ? { w: a.w } : {}), ...(a.h ? { h: a.h } : {}) } };
}

const hashOf = (spec: PlatformSpec, block: PublishBlock, caption: string, m: Media | undefined, at: number | undefined): string =>
  approvedHash({ platform: spec.id, accountId: block.account.id, caption, ...(m ? { assetSha: m.sha } : {}), ...(at !== undefined ? { at } : {}) });

// ---------- words ----------

const tzOf = (row: Pick<PostRow, "tz">): string => row.tz ?? "UTC";
const placeOf = (row: Pick<PostRow, "platform" | "accountName" | "accountHandle">): string =>
  `${PLATFORMS[row.platform].name} (${accountWords(PLATFORMS[row.platform], { id: "", name: row.accountName, ...(row.accountHandle ? { handle: row.accountHandle } : {}) })})`;

export const dryRunWords = (spec: PlatformSpec, block: PublishBlock, caption: string, now: number): string =>
  `Dry run: would have posted to ${spec.name} (${accountWords(spec, block.account)})${block.at && block.at > now ? ` at ${whenWords(block.at, block.tz ?? "UTC", now)}` : ""}: "${clip(oneLine(caption), 90)}". Nothing was posted; ALLEVIA_ACTIONS_LIVE=1 posts it.`;

export const scheduledWords = (row: Pick<PostRow, "platform" | "accountName" | "accountHandle" | "publishAt" | "tz">, now: number): string =>
  `Scheduled for ${whenWords(row.publishAt, tzOf(row), now)} on ${placeOf(row)}. You can cancel it until then.`;

function postedWords(row: PostRow, spec: PlatformSpec, textOnly: boolean): string {
  const base = `Posted to ${spec.name}${textOnly ? " as text (LinkedIn's connection can't attach pictures from here yet)" : ""}`;
  return row.postUrl ? `${base}: ${row.postUrl}` : `${base}. It went out, but no link came back: look for it on ${spec.id === "facebook" ? "your Page" : "your account"}.`;
}

const failedWords = (f: { words: string; maybePosted?: boolean }): string =>
  f.maybePosted || /nothing was posted|couldn't confirm|already posted/i.test(f.words) ? f.words : `${f.words} Nothing was posted.`;

// Words for a connection that is missing or refused, from the same errors the other executors map.
function refusalOf(e: unknown, spec: PlatformSpec): { words: string; reconnect?: boolean } | null {
  if (e instanceof NotConnectedError) return { words: `${spec.name} isn't connected. Connect it from Connections, then try again.`, reconnect: true };
  if (e instanceof NeedsAttentionError) return { words: `${spec.name} stopped letting us in. Connect it again, then try again.`, reconnect: true };
  if (e instanceof NotAllowedError) return { words: e.words, reconnect: true };
  if (e instanceof NotConfiguredError) return { words: e.availability.message };
  if (e instanceof RateLimitedError) return { words: e.words };
  return null;
}

// ---------- the executor ----------

const fail = (result: string): PublishOutcome => ({ status: "failed", result, produced: [] });

/** The executor for kind publish_post (src/actions/executors.ts calls it). */
export async function publishPostAction(g: GraphHandle, input: PublishInput, env: PublishEnv): Promise<PublishOutcome> {
  const p = input.payload;
  const block = readBlock(p.publish);
  if (!block) return fail("Nothing was posted: this card doesn't say where to post.");
  const spec = PLATFORMS[block.platform];
  const caption = String(p.body ?? "").trim();
  if (!caption) return fail("Nothing was posted: the post has no text.");
  if (caption.length > spec.captionMax) return fail(`Nothing was posted: the text is ${caption.length} characters and ${spec.name} takes ${spec.captionMax}. Shorten it and approve again.`);
  if (spec.id === "instagram" && (caption.match(/#[\p{L}\p{N}_]+/gu)?.length ?? 0) > 30) return fail("Nothing was posted: Instagram allows 30 hashtags at most. Remove a few and approve again.");

  const m = await resolveMedia(g, input.approvalId, p, block, spec);
  if (!m.ok) return fail(m.words);

  const now = input.now;
  const rt = runtimeOf(env);
  if (block.at !== undefined && block.at < now - LATE_GRACE_MS) {
    return fail(`Nothing was posted: the time you chose (${whenWords(block.at, block.tz ?? "UTC", now)}) has already passed. Ask your team to post it now or set a new time.`);
  }
  const later = block.at !== undefined && block.at > now + MIN_LEAD_MS;
  if (env.dryRun) return { status: "dry_run", result: dryRunWords(spec, block, caption, now), produced: [] };

  const id = contentIdFor(input.approvalId);
  const publishAt = later ? block.at! : now;
  const snapshot: PostRow = {
    id, approval: input.approvalId, platform: spec.id, connection: spec.connection, accountId: block.account.id, accountName: block.account.name,
    ...(block.account.handle ? { accountHandle: block.account.handle } : {}), title: String(p.title ?? spec.name), caption,
    ...(m.media ? { assetId: m.media.assetId, mediaKind: m.media.kind } : {}), status: "scheduled", publishAt, ...(block.tz ? { tz: block.tz } : {}),
    approvedHash: hashOf(spec, block, caption, m.media, publishAt), attempts: 0, ...(input.agent ? { by: input.agent } : {}),
  };
  await writePost(g, id, snapshot.title, { ...snapshot, failure: null, retryable: null, maybePosted: null }, now);
  await linkPost(g, snapshot, now, { published: false });
  if (input.agent) {
    const agentNode = await ensureAgentNode(g, input.agent, now);
    await upsertEdge(g, { from: agentNode, type: "PRODUCED", to: id }, now).catch(() => undefined);
  }
  if (later) return { status: "done", result: scheduledWords(snapshot, now), produced: [id] };

  const r = await runJob(g, id, env, { from: ["scheduled"], now });
  return { status: r.outcome.status, result: r.outcome.result, ...(r.outcome.url ? { url: r.outcome.url } : {}), produced: [id] };
}

// ---------- doing it (now, when its time comes, or again) ----------

export interface JobResult { outcome: PublishOutcome; post: PostRow | null }

const failedJob = async (g: GraphHandle, row: PostRow, f: { words: string; retryable?: boolean; maybePosted?: boolean; reconnect?: boolean; containerId?: string }, now: number): Promise<JobResult> => {
  const result = failedWords(f);
  await writePost(g, row.id, row.title, {
    status: "failed", failure: result, retryable: f.retryable !== false, maybePosted: f.maybePosted === true, reconnect: f.reconnect === true, pendingSince: null,
    ...(f.containerId ? { containerId: f.containerId } : {}), ...(f.maybePosted ? { counted: true } : {}),
  }, now);
  return { outcome: { status: "failed", result, produced: [row.id] }, post: await readPost(g, row.id) };
};

/**
 * Posts one stored post. `from` says which state it may be taken from: "scheduled" (its time came, or the OK was just given),
 * "failed" (the owner tapped Try again) or "publishing" (the platform was still preparing it). The claim is one statement, so a
 * cancel or a second scheduler never posts the same thing twice.
 */
export async function runJob(g: GraphHandle, id: string, env: PublishEnv, o: { from: PostStatus[]; now: number; anyway?: boolean }): Promise<JobResult> {
  const now = o.now;
  const before = await readPost(g, id);
  if (!before) return { outcome: fail("That post isn't in your records any more."), post: null };
  const spec = PLATFORMS[before.platform];
  if (!o.from.includes(before.status)) return { outcome: { status: "skipped", result: `This post is ${before.status}, so nothing was done.`, produced: [id] }, post: before };
  if (before.status === "failed") {
    if (before.retryable === false) return { outcome: fail(before.failure ?? "This one can't be tried again."), post: before };
    if (before.maybePosted && !o.anyway) return { outcome: fail(`${before.failure ?? "We couldn't confirm it."} Check ${spec.id === "facebook" ? "your Page" : "your account"} first. If it isn't there, post it again.`), post: before };
  }
  const token = await claim(g, id, o.from, now);
  if (!token) {
    const now2 = await readPost(g, id);
    return { outcome: { status: "skipped", result: `This post is ${now2?.status ?? "gone"}, so nothing was done.`, produced: [id] }, post: now2 };
  }
  const row = (await readPost(g, id))!;

  // the OK must still stand, and the post must be exactly what was approved
  const [ap] = await g.roQuery<{ status: string | null; decision: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.status AS status, a.decision AS decision", { id: row.approval });
  if (!ap || ap.decision !== "approve") return failedJob(g, row, { words: "This post has no OK from you on record, so it was not sent.", retryable: false }, now);
  let sha: string | undefined;
  if (row.assetId) {
    const [a] = await g.roQuery<{ sha: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.sha256 AS sha", { id: row.assetId });
    sha = a?.sha ?? undefined;
    if (!sha) return failedJob(g, row, { words: "The picture or video for this post is missing, so it was not sent.", retryable: false }, now);
  }
  const hash = approvedHash({ platform: row.platform, accountId: row.accountId, caption: row.caption, ...(sha ? { assetSha: sha } : {}), at: row.publishAt });
  if (hash !== row.approvedHash) {
    return failedJob(g, row, { words: "This post changed after you approved it, so it was not sent. Ask your team to propose it again.", retryable: false }, now);
  }

  const rt = runtimeOf(env);
  if (env.dryRun) {
    const words = `Dry run: would have posted to ${placeOf(row)}: "${clip(oneLine(row.caption), 90)}". Nothing was posted; ALLEVIA_ACTIONS_LIVE=1 posts it.`;
    await writePost(g, id, row.title, { status: "dry_run", failure: words, retryable: false }, now);
    return { outcome: { status: "dry_run", result: words, produced: [id] }, post: await readPost(g, id) };
  }

  // the daily limit counts posts that went out (or may have), not this one's own earlier attempt
  const perDay = rt.perDay ?? loadConfig().publish.perDay;
  if (!row.counted && (await countedSince(g, now - 86_400_000)) >= perDay) {
    return failedJob(g, row, { words: `You've reached today's limit of ${perDay} posts, so this one was held back. Nothing was posted. Tap Try again tomorrow, or later today once an earlier post is more than a day old.`, retryable: true }, now);
  }

  let media: PostMedia | undefined;
  if (row.assetId && spec.media !== "never") {
    const problem = rt.signer ? publicAddressProblem(rt.signer.base) : "This server has no key to make a safe picture address with. Set ALLEVIA_CONNECTOR_KEY.";
    if (problem || !rt.signer) return failedJob(g, row, { words: problem ?? "", retryable: true }, now);
    media = { kind: row.mediaKind ?? "image", url: signMediaUrl(rt.signer, { tenant: env.tenant, assetId: row.assetId, ...(spec.id === "instagram" && row.mediaKind !== "video" ? { as: "jpeg" as const } : {}) }) };
  }

  let posted;
  try {
    posted = await (await portFor(env)).run<PostSession, Awaited<ReturnType<typeof publishPost>>>(spec.connection, "post", async (s) => {
      const acct = await readAccount(spec, s, row.accountId);
      if (acct.id !== row.accountId) {
        throw new PublishFailure(`${spec.name} is now connected as ${accountWords(spec, acct)}, not ${accountWords(spec, { id: row.accountId, name: row.accountName, ...(row.accountHandle ? { handle: row.accountHandle } : {}) })} that you approved. Nothing was posted.`, { retryable: false, reconnect: true });
      }
      return publishPost(spec, s, { caption: row.caption, account: acct, ...(media ? { media } : {}), ...(row.containerId ? { containerId: row.containerId } : {}) }, rt.post);
    }, { ...(row.by ? { actor: row.by } : {}) });
  } catch (e) {
    if (e instanceof PublishFailure) {
      if (e.pending) {
        const t = rt.now?.() ?? now;
        await writePost(g, id, row.title, { status: "publishing", pendingSince: row.pendingSince ?? t, ...(e.containerId ? { containerId: e.containerId } : {}), postedAt: row.postedAt ?? now }, now);
        return { outcome: { status: "done", result: `${e.words}`, produced: [id] }, post: await readPost(g, id) };
      }
      return failedJob(g, row, { words: e.words, retryable: e.retryable, maybePosted: e.maybePosted, reconnect: e.reconnect, ...(e.containerId ? { containerId: e.containerId } : {}) }, now);
    }
    const refused = refusalOf(e, spec);
    if (refused) return failedJob(g, row, { words: refused.words, retryable: true, ...(refused.reconnect ? { reconnect: true } : {}) }, now);
    // anything unexpected after the claim: we cannot say whether it went out, so it is never repeated by itself
    return failedJob(g, row, { words: `Something went wrong and we can't tell whether ${spec.name} took it. Check ${spec.id === "facebook" ? "your Page" : "your account"} before trying again.`, retryable: true, maybePosted: true }, now);
  }

  await writePost(g, id, row.title, {
    status: "published", counted: true, postedAt: row.postedAt ?? now, publishedAt: now, pendingSince: null, failure: null, retryable: null, maybePosted: null, reconnect: null,
    ...(posted.url ? { postUrl: posted.url } : {}), ...(posted.id ? { postId: posted.id } : {}), ...(posted.containerId ? { containerId: posted.containerId } : {}),
  }, now);
  const done = (await readPost(g, id))!;
  await linkPost(g, done, now, { published: true });
  const textOnly = spec.media === "never" && !!row.assetId;
  return { outcome: { status: "done", result: postedWords(done, spec, textOnly), ...(done.postUrl ? { url: done.postUrl } : {}), produced: [id] }, post: done };
}

// ---------- after the fact: the card's own record follows the post ----------

/**
 * Brings the Action and the Approval in line with what became of a post that was handled after the OK (the scheduler's post, a retry,
 * a cancel), so the web card and Discord show the result where the owner looks.
 */
export async function recordOutcome(g: GraphHandle, row: PostRow, outcome: { status: PublishStatus | "cancelled"; result: string; url?: string }, now: number): Promise<void> {
  const [ap] = await g.roQuery<{ name: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name", { id: row.approval });
  if (!ap) return;
  const actionStatus: PublishStatus = outcome.status === "cancelled" ? "failed" : outcome.status;
  await upsertNode(g, {
    type: "Action", id: actionIdOf(row.approval), name: clip(`publish_post: ${row.title}`, 160),
    props: { kind: "publish_post", status: actionStatus, result: outcome.result, at: now, approval: row.approval, ...(outcome.url ? { url: outcome.url } : {}), ...(row.by ? { by: row.by } : {}) },
  }, now);
  const approvalStatus = outcome.status === "done" ? "executed" : outcome.status === "dry_run" ? "approved" : "failed";
  await upsertNode(g, { type: "Approval", id: row.approval, name: ap.name ?? row.approval, props: { status: approvalStatus, result: outcome.result, actionId: actionIdOf(row.approval) } }, now);
}

export interface Handled { ok: boolean; message: string; post: PostRow | null }

/** The owner tapped Try again. `anyway`: they have looked, and it did not go out (for a post that may have). */
export async function retryPost(g: GraphHandle, id: string, env: PublishEnv, o: { now: number; anyway?: boolean }): Promise<Handled> {
  const before = await readPost(g, id);
  if (!before) return { ok: false, message: "That post isn't in your records.", post: null };
  if (before.status !== "failed") return { ok: false, message: before.status === "published" ? "It already went out." : `This post is ${before.status}, so there is nothing to try again.`, post: before };
  const r = await runJob(g, id, env, { from: ["failed"], now: o.now, ...(o.anyway ? { anyway: true } : {}) });
  if (r.post && r.outcome.status !== "skipped") await recordOutcome(g, r.post, r.outcome, o.now);
  return { ok: r.outcome.status === "done" || r.outcome.status === "dry_run", message: r.outcome.result, post: r.post };
}

/** Cancels a scheduled post that has not gone out. */
export async function cancelScheduled(g: GraphHandle, id: string, o: { now: number }): Promise<Handled> {
  const row = await readPost(g, id);
  if (!row) return { ok: false, message: "That post isn't in your records.", post: null };
  if (row.status === "cancelled") return { ok: true, message: "It was already cancelled. Nothing will be posted.", post: row };
  if (!(await cancelPost(g, id, o.now))) {
    const now = await readPost(g, id);
    const why = now?.status === "published" ? "It already went out, so it can't be cancelled from here." : now?.status === "publishing" ? "It is being posted right now, so it can't be cancelled." : `This post is ${now?.status ?? "gone"}, so there is nothing to cancel.`;
    return { ok: false, message: why, post: now };
  }
  const done = (await readPost(g, id))!;
  const words = `Cancelled. ${placeOf(done)} will not get this post (it was set for ${whenWords(done.publishAt, tzOf(done))}). Nothing was posted.`;
  await recordOutcome(g, done, { status: "cancelled", result: words }, o.now);
  return { ok: true, message: words, post: done };
}

export { claim, PENDING_RETRY_MS, PENDING_GIVE_UP_MS, STUCK_MS };
