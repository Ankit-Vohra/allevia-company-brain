// Where a post can go and exactly which Composio actions put it there. The action names and the argument names below were read
// from Composio's own catalogue (its tools list, through our client) on 16 October 2026, not guessed:
//   Instagram  INSTAGRAM_CREATE_MEDIA_CONTAINER (image_url or video_url, a public address) then INSTAGRAM_CREATE_POST (creation_id)
//   Facebook   FACEBOOK_CREATE_PHOTO_POST (url) / FACEBOOK_CREATE_VIDEO_POST (file_url) / FACEBOOK_CREATE_POST (message)
//   LinkedIn   LINKEDIN_CREATE_LINKED_IN_POST (author, commentary): text only, the toolkit has no picture upload
// `verifyPublishTools` asks the live tools list again and says which action or argument has gone missing, so a change on
// Composio's side is found by `connect publish-check` (and refused in the executor) rather than by a customer's post.
import type { ComposioToolInfo } from "../connections/composio.js";

export type PlatformId = "instagram" | "facebook" | "linkedin";
export const PLATFORM_IDS: readonly PlatformId[] = ["instagram", "facebook", "linkedin"];

/** The account a post goes to: what the connection is signed in as. `handle` is how the owner knows it (@cafe). */
export interface Account { id: string; name: string; handle?: string }

export interface ActionSpec {
  slug: string;
  /** The arguments this code sends to it (each is checked against the arguments Composio lists for the action). */
  args: readonly string[];
}

export interface PlatformSpec {
  id: PlatformId;
  /** What the owner calls it. */
  name: string;
  /** Allevia's connection id (shared/connection-map.ts). */
  connection: string;
  /** Composio's toolkit slug. */
  toolkit: string;
  captionMax: number;
  /** Instagram posts are pictures or video; Facebook can be text or a picture; the LinkedIn toolkit posts text only. */
  media: "required" | "optional" | "never";
  actions: Record<string, ActionSpec>;
}

export const PLATFORMS: Record<PlatformId, PlatformSpec> = {
  instagram: {
    id: "instagram", name: "Instagram", connection: "instagram", toolkit: "instagram", captionMax: 2200, media: "required",
    actions: {
      account: { slug: "INSTAGRAM_GET_USER_INFO", args: [] },
      container: { slug: "INSTAGRAM_CREATE_MEDIA_CONTAINER", args: ["ig_user_id", "caption", "image_url", "video_url", "content_type"] },
      status: { slug: "INSTAGRAM_GET_POST_STATUS", args: ["creation_id"] },
      publish: { slug: "INSTAGRAM_CREATE_POST", args: ["ig_user_id", "creation_id"] },
      recent: { slug: "INSTAGRAM_GET_USER_MEDIA", args: ["ig_user_id", "limit"] },
    },
  },
  facebook: {
    id: "facebook", name: "Facebook", connection: "facebook-pages", toolkit: "facebook", captionMax: 5000, media: "optional",
    actions: {
      account: { slug: "FACEBOOK_GET_USER_PAGES", args: [] },
      photo: { slug: "FACEBOOK_CREATE_PHOTO_POST", args: ["page_id", "url", "message", "published"] },
      video: { slug: "FACEBOOK_CREATE_VIDEO_POST", args: ["page_id", "file_url", "description", "published"] },
      text: { slug: "FACEBOOK_CREATE_POST", args: ["page_id", "message", "published"] },
    },
  },
  linkedin: {
    id: "linkedin", name: "LinkedIn", connection: "linkedin", toolkit: "linkedin", captionMax: 3000, media: "never",
    actions: {
      account: { slug: "LINKEDIN_GET_MY_INFO", args: [] },
      post: { slug: "LINKEDIN_CREATE_LINKED_IN_POST", args: ["author", "commentary", "visibility", "lifecycleState"] },
    },
  },
};

export const platformOf = (id: unknown): PlatformSpec | undefined => (typeof id === "string" ? PLATFORMS[id as PlatformId] : undefined);
export const platformByConnection = (connection: string): PlatformSpec | undefined => PLATFORM_IDS.map((p) => PLATFORMS[p]).find((s) => s.connection === connection);

/** "your account @cafe", "your Page Cafe", "your profile Jane Doe": how the owner recognises where it goes. */
export function accountWords(spec: PlatformSpec, a: Account): string {
  if (spec.id === "instagram") return `your account ${a.handle ?? `@${a.name}`}`;
  if (spec.id === "facebook") return `your Page ${a.name}`;
  return `your profile ${a.name}`;
}

/** The card's title: "Post to Instagram (your account @cafe)". */
export const postTitle = (spec: PlatformSpec, a: Account): string => `Post to ${spec.name} (${accountWords(spec, a)})`;

/** The action slugs a platform may call, once each. */
export const slugsOf = (spec: PlatformSpec): string[] => Object.values(spec.actions).map((a) => a.slug);

export interface ToolCheck { ok: boolean; missing: string[]; badArgs: Array<{ slug: string; arg: string }> }

/** Compares what we call with what Composio's tools list says exists. An action Composio does not list, or an argument it does not know, is a problem. */
export function verifyPublishTools(spec: PlatformSpec, listed: readonly ComposioToolInfo[]): ToolCheck {
  const by = new Map(listed.map((t) => [t.slug, t]));
  const missing: string[] = [];
  const badArgs: ToolCheck["badArgs"] = [];
  for (const a of Object.values(spec.actions)) {
    const t = by.get(a.slug);
    if (!t) { missing.push(a.slug); continue; }
    if (!t.params) continue; // a list without schemas can only prove the action exists
    for (const arg of a.args) if (!t.params.properties.includes(arg)) badArgs.push({ slug: a.slug, arg });
  }
  return { ok: !missing.length && !badArgs.length, missing, badArgs };
}
