// A post as the web page and the decision's answer show it: where it goes, when (in the business's own words and zone), how it stands,
// and what the owner can do about it (Cancel while it waits, Try again when it did not go out).
import { PLATFORMS, accountWords } from "./platforms.js";
import type { PostRow } from "./types.js";
import { whenWords } from "./when.js";

export interface PostDto {
  id: string;
  approvalId: string;
  platform: string;
  /** "Instagram (your account @cafe)". */
  where: string;
  title: string;
  status: "scheduled" | "publishing" | "published" | "failed" | "cancelled" | "dry_run";
  /** When it is set for, or when it went out, as an ISO time and as words in the business's own zone. */
  at: string;
  when: string;
  timeZone?: string;
  url?: string;
  /** Why it did not go out, in plain words. */
  failure?: string;
  canCancel: boolean;
  canRetry: boolean;
  /** The failure may have gone out anyway: the owner looks first, then confirms. */
  checkFirst: boolean;
  /** The connection needs the owner to connect it again. */
  reconnect?: { id: string; name: string };
}

export function toDto(p: PostRow, now: number): PostDto {
  const spec = PLATFORMS[p.platform];
  const at = p.status === "published" && p.publishedAt ? p.publishedAt : p.publishAt;
  return {
    id: p.id, approvalId: p.approval, platform: p.platform, where: `${spec.name} (${accountWords(spec, { id: p.accountId, name: p.accountName, ...(p.accountHandle ? { handle: p.accountHandle } : {}) })})`,
    title: p.title, status: p.status, at: new Date(at).toISOString(), when: whenWords(at, p.tz ?? "UTC", now), ...(p.tz ? { timeZone: p.tz } : {}),
    ...(p.postUrl ? { url: p.postUrl } : {}), ...(p.status === "failed" && p.failure ? { failure: p.failure } : {}),
    canCancel: p.status === "scheduled", canRetry: p.status === "failed" && p.retryable !== false, checkFirst: p.status === "failed" && p.maybePosted === true,
    ...(p.reconnect ? { reconnect: { id: spec.connection, name: spec.name } } : {}),
  };
}
