// What a "post it" card carries, and what is kept of a post.
//
// The card (an Approval of kind publish_post) has a payload {title, body, target, publish, studio?}:
//   title    "Post to Instagram (your account @cafe): Diwali sale poster"
//   body     the caption, word for word; the owner may change it before saying OK
//   publish  where it goes: the platform, the connection, the ACCOUNT (id and name, as the connection was signed in when the card
//            was made), and when (an instant and the business's time zone) when it is not "as soon as it is OK"
//   studio   the picture or video options, in the same shape the Studio's cards use, so the web page and Discord show them
//            and the owner can choose; a text-only post has none
// What the owner approves is exactly: the platform, the account, the caption, the one picture or video and the time. A hash of
// those is kept when the OK is given and checked again at the moment of posting (executor.ts), so a post that changed after the
// OK is never sent.
import { createHash } from "node:crypto";
import { PLATFORMS, type Account, type PlatformId, type PlatformSpec } from "./platforms.js";

export interface PublishBlock {
  platform: PlatformId;
  connection: string;
  account: Account;
  /** The instant it goes out, epoch ms. Absent: as soon as the owner says OK. */
  at?: number;
  /** The business's time zone, for the words. */
  tz?: string;
  /** The one picture or video, when the card names one directly (the Studio's options are in `studio`). */
  assetId?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The publish block of a payload, or null when it is missing or not a block we would act on. */
export function readBlock(v: unknown): PublishBlock | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const platform = str(o.platform) as PlatformId | undefined;
  const spec: PlatformSpec | undefined = platform ? PLATFORMS[platform] : undefined;
  const a = o.account && typeof o.account === "object" ? (o.account as Record<string, unknown>) : {};
  const id = str(a.id), name = str(a.name);
  if (!spec || !id || !name) return null;
  return {
    platform: spec.id, connection: spec.connection, account: { id, name, ...(str(a.handle) ? { handle: str(a.handle)! } : {}) },
    ...(typeof o.at === "number" && Number.isFinite(o.at) ? { at: o.at } : {}), ...(str(o.tz) ? { tz: str(o.tz)! } : {}), ...(str(o.assetId) ? { assetId: str(o.assetId)! } : {}),
  };
}

/** What was approved, as one fingerprint. */
export function approvedHash(o: { platform: string; accountId: string; caption: string; assetSha?: string; at?: number }): string {
  return createHash("sha256").update(JSON.stringify([o.platform, o.accountId, o.caption.trim(), o.assetSha ?? "", o.at ?? 0])).digest("hex");
}

export type PostStatus = "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "dry_run";

/** A post as the graph keeps it (a Content node), read back. */
export interface PostRow {
  id: string;
  approval: string;
  platform: PlatformId;
  connection: string;
  accountId: string;
  accountName: string;
  accountHandle?: string;
  title: string;
  caption: string;
  assetId?: string;
  mediaKind?: "image" | "video";
  status: PostStatus;
  publishAt: number;
  tz?: string;
  approvedHash: string;
  attempts: number;
  attemptedAt?: number;
  postedAt?: number;
  counted?: boolean;
  postUrl?: string;
  postId?: string;
  publishedAt?: number;
  containerId?: string;
  pendingSince?: number;
  failure?: string;
  retryable?: boolean;
  maybePosted?: boolean;
  reconnect?: boolean;
  by?: string;
}
