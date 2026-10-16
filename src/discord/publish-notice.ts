// What Discord says about a post after the OK: the note that a scheduled post went out (or did not), and the buttons on a card whose
// post can still be changed (Cancel while it waits for its time, Try again when it did not go out). Pure rendering plus one send; the
// buttons are handled by the business's own bot (bot.ts), which asks the same functions the web page does (src/publish/executor.ts).
import type { GraphHandle } from "../graph/client.js";
import { cancelScheduled, retryPost } from "../publish/executor.js";
import { PLATFORMS, accountWords } from "../publish/platforms.js";
import { executorsFor, type ActionOpts } from "../server/approvals.js";
import type { PostRow } from "../publish/types.js";
import { whenWords } from "../publish/when.js";
import type { ButtonSpec } from "./bot.js";
import type { ProvisionDeps } from "./hub-provision.js";

export type PublishVerb = "cancel" | "retry" | "again";
export const publishButtonId = (verb: PublishVerb, postId: string): string => `allevia:publish:${verb}:${postId}`;
export const PUBLISH_BUTTON = /^allevia:publish:(cancel|retry|again):(.+)$/;

/** The buttons a post's card carries now: none once it went out or was cancelled. */
export function publishButtons(p: Pick<PostRow, "id" | "status" | "retryable" | "maybePosted">): ButtonSpec[] {
  const fits = (id: string) => id.length <= 100;
  if (p.status === "scheduled" && fits(publishButtonId("cancel", p.id))) return [{ customId: publishButtonId("cancel", p.id), label: "Cancel this post", style: "secondary" }];
  if (p.status === "failed" && p.retryable !== false) {
    // a post that may have gone out is posted again only after the owner has looked
    const verb: PublishVerb = p.maybePosted ? "again" : "retry";
    if (fits(publishButtonId(verb, p.id))) return [{ customId: publishButtonId(verb, p.id), label: p.maybePosted ? "It isn't there, post it again" : "Try again", style: "success" }];
  }
  return [];
}

/** The note for the business's #approvals when a scheduled post (or a tried-again one) has an answer. */
export function renderPublishNotice(p: PostRow, result: string): { content: string; buttons: ButtonSpec[] } {
  const spec = PLATFORMS[p.platform];
  const where = `${spec.name} (${accountWords(spec, { id: p.accountId, name: p.accountName, ...(p.accountHandle ? { handle: p.accountHandle } : {}) })})`;
  const mark = p.status === "published" ? "✅" : p.status === "failed" ? "⚠️" : "ℹ️";
  const head = p.status === "published" ? `${mark} Your post went out on ${where}` : p.status === "failed" ? `${mark} Your post for ${where} did not go out` : `${mark} Your post for ${where}`;
  const when = p.status === "failed" ? ` (it was set for ${whenWords(p.publishAt, p.tz ?? "UTC")})` : "";
  return { content: `${head}${when}.\n${result}`.slice(0, 1900), buttons: publishButtons(p) };
}

/** Sends the note to the business's own #approvals. Never throws: a Discord problem must not undo a post. */
export async function sendPublishNotice(d: Pick<ProvisionDeps, "hub" | "store" | "log">, slug: string, p: PostRow, result: string): Promise<boolean> {
  try {
    const area = await d.store.getArea(slug);
    const channel = area?.status === "ready" ? area.channels.approvals : undefined;
    if (!channel) return false;
    const n = renderPublishNotice(p, result);
    await d.hub.sendMessage(channel, { content: n.content, buttons: n.buttons });
    return true;
  } catch (e) {
    d.log?.(`[hub] ${slug}: could not send the note about a post: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** What a business's own bot calls when its owner taps Cancel or Try again: only this business's graph and connections. */
export function botPublishPort(g: GraphHandle, slug: string, actions?: ActionOpts): NonNullable<import("./bot.js").BotDeps["publish"]> {
  return {
    cancel: async (id) => {
      const r = await cancelScheduled(g, id, { now: Date.now() });
      return { ok: r.ok, message: r.message };
    },
    retry: async (id, o) => {
      const r = await retryPost(g, id, { tenant: slug, ...executorsFor(slug, actions ?? {}) }, { now: Date.now(), ...(o.anyway ? { anyway: true } : {}) });
      return { ok: r.ok, message: r.message };
    },
  };
}
