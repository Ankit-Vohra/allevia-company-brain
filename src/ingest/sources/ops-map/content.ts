// Content and the social channels: Instagram reels and account reach, Facebook reels, YouTube, what was published
// where, and the review queue. Content nodes are PUBLISHED_ON their Channel; captions keep their first line, redacted.
import { entityId } from "../../../util/ids.js";
import {
  arr, isDate, isObj, lastDays, numOf, obj, share100, str, CHANNELS, type Builder, type ChannelKey, type Json, type Mapper, type Win,
} from "./builder.js";

function igReel(b: Builder, r: Json, format = "reel"): string | undefined {
  const mediaId = str(r.id);
  if (!mediaId) return undefined;
  const caption = b.text(r.caption);
  const id = b.node("Content", entityId("Content", `instagram ${mediaId}`), caption ?? `Instagram ${format} ${mediaId}`, {
    platform: "instagram", format, externalId: mediaId, permalink: str(r.permalink), publishedAt: str(r.publishedAt), caption,
  }, true);
  b.edge(id, "PUBLISHED_ON", b.channel("instagram"));
  return id;
}

const reelsPerformance: Mapper = (b, { data: d }) => {
  const reelObs = (r: Json) => {
    const id = igReel(b, r);
    if (!id) return;
    b.obs(id, "reel_views", r.views, { unit: "count" });
    b.obs(id, "reel_reach", r.reach, { unit: "accounts" });
    b.obs(id, "reel_avg_watch_s", r.avgWatchS, { unit: "s" });
    b.obs(id, "reel_skip_rate_3s_pct", r.skipPct, {});
    b.obs(id, "reel_likes", r.likes, { unit: "count" });
    b.obs(id, "reel_comments", r.comments, { unit: "count" });
    b.obs(id, "reel_shares", r.shares, { unit: "count" });
    b.obs(id, "reel_saves", r.saves, { unit: "count" });
  };
  for (const r of arr(d.reels)) reelObs(r);
  const base = obj(d.baseline);
  if (isObj(base.bestReel)) reelObs(base.bestReel);
  const ig = b.channel("instagram");
  b.obs(ig, "reel_median_views", base.medianViews, { unit: "count" });
  b.obs(ig, "reel_median_skip_rate_3s_pct", base.medianSkipPct, {});
  b.obs(ig, "reel_median_avg_watch_s", base.medianAvgWatchS, { unit: "s" });
  b.obs(ig, "reels_total", base.reelsCompared, { unit: "count" });
};

const dayOf = (v: unknown) => {
  const s = str(v)?.slice(0, 10);
  return isDate(s) ? s : undefined;
};

const accountReach: Mapper = (b, { data: d, raw }) => {
  const acc = obj(d.account);
  const ig = b.channel("instagram", { handle: str(obj(raw.account).username) }); // our own account, not a person
  b.obs(ig, "followers", acc.followers, { unit: "count" });
  b.obs(ig, "following", acc.follows, { unit: "count" });
  b.obs(ig, "media_count", acc.posts, { unit: "count" });
  const nf = obj(obj(d.newFollowers).last28d);
  const nfSince = dayOf(nf.since);
  b.obs(ig, "new_followers", nf.change, { ...(nfSince ? { windowStart: nfSince, windowEnd: b.ctx.asOf } : lastDays(b.ctx.asOf, 28)), unit: "count" });
  // One window per metric: the 28 days (the 7-day numbers are inside them).
  const w28 = obj(d.last28d);
  const start = dayOf(w28.since), end = dayOf(w28.until);
  const w: Win = start && end ? { windowStart: start, windowEnd: end } : lastDays(b.ctx.asOf, 28);
  b.obs(ig, "account_reach", w28.reach, { ...w, unit: "accounts" });
  b.obs(ig, "account_views", w28.views, { ...w, unit: "count" });
  b.obs(ig, "non_follower_share_pct", share100(w28.nonFollowerShare), w);
  b.obs(ig, "profile_visits", w28.profileVisits, { ...w, unit: "count" });
  b.obs(ig, "link_taps", w28.linkTaps, { ...w, unit: "count" });
  b.obs(ig, "website_clicks", w28.websiteClicks, { ...w, unit: "count" });
  b.obs(ig, "accounts_engaged", w28.accountsEngaged, { ...w, unit: "accounts" });
  b.obs(ig, "interactions", w28.totalInteractions, { ...w, unit: "count" });
  // The stored daily history comes after today's live reading, which wins for today.
  for (const h of arr(d.followerHistory)) if (isDate(h.day)) b.obs(ig, "followers", h.followers, { unit: "count", asOf: h.day });
};

const PUBLISH_CHANNELS: Record<string, ChannelKey> = { instagram: "instagram", facebook: "facebook", youtube: "youtube" };

const publishedContent: Mapper = (b, c) => {
  const w = lastDays(b.ctx.asOf, numOf(c.args.days) ?? 14); // the tool's default window is 14 days
  const ok: Record<string, number> = {}, failed: Record<string, number> = {};
  for (const it of arr(c.data.items)) {
    const kind = str(it.kind) ?? "post";
    const caption = b.text(it.caption);
    for (const ch of arr(it.channels)) {
      const key = PUBLISH_CHANNELS[str(ch.channel) ?? ""];
      if (!key) continue;
      if (ch.ok !== true) { failed[key] = (failed[key] ?? 0) + 1; continue; }
      ok[key] = (ok[key] ?? 0) + 1;
      const extId = str(ch.id);
      if (!extId || extId === "DRY_RUN") continue;
      const format = key === "youtube" ? "short" : kind;
      const id = b.node("Content", entityId("Content", `${key} ${extId}`), caption ?? `${CHANNELS[key].name} ${format} ${extId}`, {
        platform: key, format, externalId: extId, permalink: str(ch.link), publishedAt: str(it.publishedAt), caption,
      });
      b.edge(id, "PUBLISHED_ON", b.channel(key));
    }
  }
  for (const key of new Set([...Object.keys(ok), ...Object.keys(failed)])) {
    const id = b.channel(key as ChannelKey);
    b.obs(id, "posts_published", ok[key] ?? 0, { ...w, unit: "count" });
    b.obs(id, "publish_failures", failed[key] ?? 0, { ...w, unit: "count" });
  }
};

const facebookReels: Mapper = (b, { data: d }) => {
  const fb = b.channel("facebook");
  for (const r of arr(d.reels)) {
    const extId = str(r.id);
    if (!extId) continue;
    const caption = b.text(r.caption);
    const id = b.node("Content", entityId("Content", `facebook ${extId}`), caption ?? `Facebook reel ${extId}`, {
      platform: "facebook", format: "reel", externalId: extId, permalink: str(r.permalink), publishedAt: str(r.created), caption,
    }, true);
    b.edge(id, "PUBLISHED_ON", fb);
    b.obs(id, "reel_plays", r.plays, { unit: "count" });
    b.obs(id, "reel_avg_watch_s", r.avgWatchS, { unit: "s" });
    b.obs(id, "reel_interactions", r.socialActions, { unit: "count" });
    b.obs(id, "reel_new_followers", r.newFollowers, { unit: "count" });
  }
};

const youtubeStats: Mapper = (b, { data: d }) => {
  const ch = obj(d.channel);
  const yt = b.channel("youtube", { handle: str(ch.handle) });
  b.obs(yt, "subscribers", ch.subscribers, { unit: "count" });
  b.obs(yt, "yt_views", ch.views, { unit: "count" });
  b.obs(yt, "yt_video_count", ch.videoCount, { unit: "count" });
  for (const v of arr(d.videos)) {
    const extId = str(v.id);
    if (!extId) continue;
    const title = b.text(v.title);
    const format = v.isShort === true ? "short" : "video";
    const id = b.node("Content", entityId("Content", `youtube ${extId}`), title ?? `YouTube ${format} ${extId}`, {
      platform: "youtube", format, externalId: extId, permalink: str(v.url), publishedAt: str(v.publishedAt), caption: title,
      privacy: str(v.privacy),
    }, true);
    b.edge(id, "PUBLISHED_ON", yt);
    b.obs(id, "yt_views", v.views, { unit: "count" });
    b.obs(id, "yt_likes", v.likes, { unit: "count" });
    b.obs(id, "yt_comments", v.comments, { unit: "count" });
  }
};

const reviewCards: Mapper = (b, { data: d }) => {
  const s = obj(d.summary), all = obj(d.allPending);
  b.obs(b.business, "review_cards_awaiting_approval", s.awaitingApproval, { unit: "count" });
  b.obs(b.business, "review_cards_scheduled", s.scheduled, { unit: "count" });
  b.obs(b.business, "review_queue_pending", all.total, { unit: "count" });
  b.obs(b.business, "review_queue_stale", all.stale, { unit: "count" });
  b.obs(b.business, "review_queue_older_than_30_days", obj(all.byAge).over30Days, { unit: "count" });
};

export const CONTENT_MAPPERS: Record<string, Mapper> = {
  reels_performance: reelsPerformance, account_reach: accountReach, published_content: publishedContent,
  facebook_reels: facebookReels, youtube_stats: youtubeStats, review_cards: reviewCards,
};
