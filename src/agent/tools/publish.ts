// Posting to the owner's own channels (src/publish), from a request: "post this on Instagram", "put the new menu on our Page at 7 on
// Tuesday", "what is scheduled?", "cancel the Tuesday post". Rules:
//   - publish_post only PROPOSES. It makes a card (kind publish_post) that shows the account, the picture or video and the exact
//     words, with Approve, Change and No thanks. Only the owner's OK posts it, on that exact content, and a dry run until real actions
//     are on says "would have posted". Nothing here posts, whatever the team's autonomy: every post waits for the owner.
//   - A time ("Tuesday 7 pm") schedules it for then, after the OK, in the business's own time zone.
//   - A channel that is not connected is said plainly with a Connect link; nothing is made up.
//   - There is no tool that retries a post: a failed one has a Try again button (the owner's tap), so no agent can repeat a post.
import { z } from "zod";
import type { ToolResult } from "../../../shared/contracts.js";
import { findBusiness } from "../../capabilities/ladder.js";
import { assessAsset, captionProblem, cancelScheduled } from "../../publish/executor.js";
import { approvingWords, businessZone, planPublish } from "../../publish/offer.js";
import { PLATFORM_IDS, PLATFORMS, postTitle } from "../../publish/platforms.js";
import { recentPosts } from "../../publish/record.js";
import { WEEKDAYS, resolveWhen, whenWords } from "../../publish/when.js";
import { clip, oneLine } from "../../insights/text.js";
import { refusal } from "./connections.js";
import { InputError, defineTool, refuseIfReadOnly, refuseIfStopped, ro } from "./common.js";
import { runPropose } from "./actions.js";

const WHEN = z.object({
  weekday: z.enum(WEEKDAYS).optional().describe("The next such day, in the business's time zone"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("A day, YYYY-MM-DD, in the business's time zone"),
  time: z.string().max(12).optional().describe("The time of day: 19:00 or 7pm"),
  at: z.string().max(40).optional().describe("An exact instant with its offset, e.g. 2026-10-20T19:00:00+04:00"),
}).describe("When to post. Leave it out to post as soon as the owner says OK. 'Tuesday 7 pm' is {weekday:'tuesday', time:'19:00'}");

export const publishPost = defineTool({
  name: "publish_post",
  description:
    "Proposes a post to the owner's Instagram, Facebook Page or LinkedIn; only their OK posts it (at `when`, if given). The card shows the account, picture and exact words. Instagram needs asset_id (a picture or clip); LinkedIn is text only. Example: {\"platform\":\"instagram\",\"caption\":\"Fresh bread daily\",\"asset_id\":\"asset:poster-abc\",\"when\":{\"weekday\":\"tuesday\",\"time\":\"19:00\"},\"why\":\"Owner asked\"}.",
  input: {
    platform: z.enum(PLATFORM_IDS as unknown as [string, ...string[]]),
    caption: z.string().min(3).max(5000).describe("The post's text, word for word, as it will be posted"),
    asset_id: z.string().max(200).optional().describe("The picture or video to post: an Asset id from make_poster, generate_image, the reel tools or the Studio"),
    when: WHEN.optional(),
    why: z.string().min(5).max(1000).describe("Why this post, in plain words"),
  },
  writes: true,
  external: true,
  async run(a, ctx): Promise<ToolResult> {
    refuseIfReadOnly(ctx, "publish_post");
    refuseIfStopped(ctx, "publish_post");
    const spec = PLATFORMS[a.platform as keyof typeof PLATFORMS];
    const bad = captionProblem(spec, a.caption);
    if (bad) throw new InputError(`The text can't be posted: ${bad}`);
    // the time first, so a wrong day is said before anything is read from the account
    let when: { at: number; tz: string } | undefined;
    if (a.when && (a.when.at || a.when.time || a.when.date || a.when.weekday)) {
      const tz = await businessZone(ctx.graph);
      if (!tz && !a.when.at) throw new InputError("I don't know this business's time zone yet, so I can't set a time like 'Tuesday 7pm'. Ask the owner for it, or give an exact time with its offset.");
      const r = resolveWhen(a.when, tz ?? "UTC", ctx.now);
      if (!r.ok) throw new InputError(r.error);
      when = { at: r.at, tz: tz ?? "UTC" };
    }
    // the picture or video
    let media: { id: string; check: string | null; name: string } | undefined;
    if (a.asset_id && spec.media !== "never") {
      const m = await assessAsset(ctx.graph, a.asset_id, spec);
      if (!m.ok) throw new InputError(`That picture can't be posted: ${m.words}`);
      const [n] = await ro<{ name: string | null }>(ctx, "MATCH (a:Entity:Asset {id:$id}) RETURN a.name AS name", { id: a.asset_id });
      media = { id: a.asset_id, check: m.check, name: n?.name ?? "" };
    } else if (spec.media === "required") {
      throw new InputError(`${spec.name} posts need a picture or a video. Make one first (make_poster, generate_image or the reel tool) and give its asset_id.`);
    }
    // where it would go: the connection must be there, and its account is read now so the card says whose it is
    const plan = await planPublish({ graph: ctx.graph, ...(ctx.connections ? { connections: ctx.connections } : {}), agent: ctx.agentId }, spec.id, when);
    if (!plan.ok) {
      return plan.connect
        ? refusal(plan.connect.id, plan.connect.name, plan.why, "not_connected")
        : { data: { made: false, why: plan.why, nothingChanged: true, say: `Tell the owner plainly: ${plan.why}` }, nodes: [], edges: [], sources: [], note: plan.why };
    }
    // the title names the post by its words, so two different posts are two cards and the same words are one
    const label = clip(oneLine(a.caption.split("\n")[0] ?? ""), 40);
    const title = clip(`${postTitle(spec, plan.block.account)}${label ? `: ${label}` : ""}`, 200);
    const badge = media?.check === "held" ? "held" : media?.check === "ok" ? "unchanged" : "unchecked";
    const biz = await findBusiness(ctx.graph);
    if (!biz) throw new InputError("There is no business in the records to attach this to.");
    const payload = {
        title, body: a.caption.trim(), target: `${spec.name}: ${plan.block.account.handle ?? plan.block.account.name}`, publish: plan.block,
        ...(media ? {
          studio: {
            originalId: media.id, recommended: media.id, altText: "", hashtags: [], credits: 0, voiceRuleIds: [],
            variants: [{ id: media.id, label: "A", badge, note: "", aiEdited: false }],
            creative: { kind: "image", aspect: "4:5", channel: spec.id, by: ctx.agentId, allowUnchecked: true },
          },
        } : {}),
    };
    const r = await runPropose({ title, why: a.why, kind: "publish_post", area: "content", evidence: [biz, ...(media ? [media.id] : [])], payload }, ctx);
    // the same card is already waiting (a card is one per title): what was asked for now is what it shows, never the older words
    const waiting = (r.data as { alreadyPending?: boolean; approvalId?: string }).alreadyPending ? (r.data as { approvalId: string }).approvalId : undefined;
    if (waiting) await ctx.graph.query("MATCH (a:Entity:Approval {id:$id}) WHERE a.status = 'pending' SET a.payload = $payload", { id: waiting, payload: JSON.stringify(payload) });
    const words = approvingWords(spec, plan.block);
    const timed = when ? ` It is set for ${whenWords(when.at, when.tz, ctx.now)} (${when.tz}).` : "";
    const textOnly = spec.media === "never" && a.asset_id ? ` ${spec.name} posts from here are text only, so the picture is left out.` : "";
    return {
      ...r,
      data: {
        ...(r.data as Record<string, unknown>), posted: false, waitingForOk: true, platform: spec.id, account: plan.block.account.handle ?? plan.block.account.name,
        ...(when ? { scheduledFor: whenWords(when.at, when.tz), timeZone: when.tz } : {}),
        say: `Tell the owner, in plain words: ${words}${timed}${textOnly} Show them the caption word for word, say it waits for their OK (Approve, Change or No thanks) and that nothing has been posted yet.`,
      },
      note: `${(r.note ?? "").trim()} ${words}${timed}${textOnly}`.trim(),
    };
  },
});

export const publishStatus = defineTool({
  name: "publish_status",
  description:
    "Lists the posts that are scheduled or went out lately: which platform and account, when, whether it posted (with its address), failed (and why) or was cancelled. Use it to answer \"what is scheduled?\" or \"did it post?\", and to find the id of a scheduled post to cancel. Example: {}.",
  input: {},
  async run(_a, ctx): Promise<ToolResult> {
    const rows = await recentPosts(ctx.graph, 25);
    const view = rows.map((p) => ({
      id: p.id, platform: p.platform, account: p.accountHandle ?? p.accountName, status: p.status, title: p.title,
      when: whenWords(p.status === "published" && p.publishedAt ? p.publishedAt : p.publishAt, p.tz ?? "UTC"),
      ...(p.postUrl ? { address: p.postUrl } : {}), ...(p.failure ? { whyNot: p.failure } : {}), ...(p.status === "failed" && p.retryable !== false ? { owner: "can tap Try again on the card" } : {}),
      canCancel: p.status === "scheduled",
    }));
    return {
      data: { posts: view, scheduled: view.filter((v) => v.status === "scheduled").length },
      nodes: [], edges: [], sources: [],
      note: rows.length ? `${rows.length} recent posts, ${view.filter((v) => v.status === "scheduled").length} still scheduled. Times are in each post's own zone.` : "Nothing has been scheduled or posted yet.",
    };
  },
});

export const publishCancel = defineTool({
  name: "publish_cancel",
  description:
    "Cancels a post that is scheduled and has not gone out yet (the owner asked: \"cancel the Tuesday post\"). Find its id with publish_status. A post that already went out cannot be taken back from here. Example: {\"post_id\":\"content:publish-t-100-1\"}.",
  input: { post_id: z.string().min(3).max(200).describe("The id from publish_status") },
  writes: true,
  async run(a, ctx): Promise<ToolResult> {
    refuseIfReadOnly(ctx, "publish_cancel");
    refuseIfStopped(ctx, "publish_cancel");
    const r = await cancelScheduled(ctx.graph, a.post_id, { now: ctx.now });
    return { data: { cancelled: r.ok && r.post?.status === "cancelled", message: r.message, say: `Tell the owner plainly: ${r.message}` }, nodes: [], edges: [], sources: [], note: r.message };
  },
});

export const PUBLISH_TOOLS = [publishPost, publishStatus, publishCancel];
