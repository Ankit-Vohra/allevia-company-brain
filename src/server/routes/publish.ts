// The owner's posts: what is scheduled, what went out, what did not, and the two things they can do about it.
//   GET  /api/:t/publish                  { posts: [...] }  the newest posts of this business (scheduled first in time order)
//   POST /api/:t/publish/:id/retry        { anyway? }  Try again on a post that did not go out. A post that MAY have gone out (the line
//                                         dropped at the last step) needs { anyway: true }: the owner has looked and it is not there.
//   POST /api/:t/publish/:id/cancel       Cancel a post that is scheduled and has not gone out
// Writes are refused in public mode. A business only ever reaches its own posts: the graph is the business's own, and the id is read
// from it. The words are the executor's own (src/publish/executor.ts), the same ones the card shows.
import type { Hono } from "hono";
import { z } from "zod";
import { executorsFor, type ActionOpts } from "../approvals.js";
import { cancelScheduled, retryPost } from "../../publish/executor.js";
import { PLATFORMS, accountWords } from "../../publish/platforms.js";
import { readPost, recentPosts } from "../../publish/record.js";
import type { PostRow } from "../../publish/types.js";
import { whenWords } from "../../publish/when.js";
import { HttpError, readBody, type RouteCtx } from "../http.js";

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

const Retry = z.object({ anyway: z.boolean().optional() });

export function registerPublishRoutes(app: Hono, ctx: RouteCtx, h: { actions?: () => ActionOpts | undefined } = {}): void {
  app.get("/api/:t/publish", async (c) => {
    const { g } = await ctx.tenantOf(c);
    const rows = await recentPosts(g, 40);
    return c.json({ posts: rows.map((p) => toDto(p, ctx.now())) });
  });

  app.post("/api/:t/publish/:id/retry", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const body = c.req.header("content-length") === "0" ? {} : await readBody(c, Retry).catch(() => ({}) as z.infer<typeof Retry>);
    const id = c.req.param("id");
    if (!(await readPost(g, id))) throw new HttpError(404, "There is no such post.");
    const r = await retryPost(g, id, { tenant: reg.slug, ...executorsFor(reg.slug, h.actions?.() ?? {}) }, { now: ctx.now(), ...(body.anyway ? { anyway: true } : {}) });
    return c.json({ ok: r.ok, message: r.message, ...(r.post ? { post: toDto(r.post, ctx.now()) } : {}) });
  });

  app.post("/api/:t/publish/:id/cancel", async (c) => {
    const { g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const id = c.req.param("id");
    if (!(await readPost(g, id))) throw new HttpError(404, "There is no such post.");
    const r = await cancelScheduled(g, id, { now: ctx.now() });
    return c.json({ ok: r.ok, message: r.message, ...(r.post ? { post: toDto(r.post, ctx.now()) } : {}) });
  });
}
