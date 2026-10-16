// What a public-data lookup leaves in the business's own graph, with provenance on everything:
//   - one Document per lookup key (kind 'public'; source, the actor it came through, the page it describes, fetchedAt, and
//     the cleaned result as JSON so a repeat within a few days is served from the graph instead of paid for again);
//   - the facts on the node they are about: the business's Google Maps listing as a Channel (channel:google-maps, PART_OF the
//     business), its Instagram channel's handle, or a Competitor (COMPETES_WITH the business);
//   - what a rival owns, as nodes (graph audit G6): its Instagram account is a Channel the Competitor OWNS, its page or account on
//     the ad libraries is another, and each of its ads is a Content the Competitor OWNS that is PUBLISHED_ON that Channel. A
//     rival's Channel carries `rival: true` and no `platform` or `handle`, so nothing that looks for "the business's Instagram"
//     by platform or handle mistakes it for the business's own;
//   - the numbers as Observations, one per metric per day (obs:<metric>:<subject>:<day>), conf 0.9 so a connector's own
//     measurement of the same thing always wins, sourced from that Document, which the capability ladder reads as the
//     public rung, never as live data;
//   - each Google review of the business itself as its own Document (kind 'review'): stars, date, first name at most, the
//     text through the privacy filter.
// Only ever written to the graph of the business that asked (the tool's ctx.graph); nothing here names a tenant.
import type { GraphWrite } from "../ingest/types.js";
import type { EdgeInput, NodeInput, ObservationInput } from "../graph/upsert.js";
import { entityId, slugify } from "../util/ids.js";
import { observationId } from "../graph/upsert.js";
import { adLine, type Ad, type IgProfile, type IgStats, type Listing } from "./normalize.js";
import type { ActorId } from "./actors.js";

export const PUBLIC_CONF = 0.9;
export const RESULT_JSON_CAP = 12_000;
export const MAPS_CHANNEL = entityId("Channel", "google-maps");      // channel:google-maps (a GBP channel id the ladder knows)
export const INSTAGRAM_CHANNEL = entityId("Channel", "instagram");   // channel:instagram

export type LookupKind = "listing" | "instagram" | "ads-meta" | "ads-google" | "website";

export interface PublicWriteCtx {
  businessId: string;
  asOf: string;          // ISO time of the lookup
  actor: ActorId;
}

const day = (asOf: string): string => asOf.slice(0, 10);
export const lookupKey = (kind: LookupKind, key: string): string => `${kind}:${slugify(key) || "unknown"}`;
export const lookupDocId = (kind: LookupKind, key: string): string => entityId("Document", `public ${kind} ${key}`);
export const competitorId = (name: string): string => entityId("Competitor", name);

export type RivalNetwork = "instagram" | "facebook" | "google-ads";
const RIVAL_WORDS: Record<RivalNetwork, string> = { instagram: "Instagram", facebook: "Facebook and Instagram ads", "google-ads": "Google ads" };
/** A rival's own account on one network: never `channel:instagram` (the business's own), always a node of its own. */
export const rivalChannelId = (competitorName: string, network: RivalNetwork): string => entityId("Channel", `${competitorName} ${network}`);
export const adContentId = (platform: "meta" | "google", adId: string): string => entityId("Content", `${platform} ad ${adId}`);

// A rival's account as a Channel its Competitor OWNS. The Instagram handle and the ad page are kept as `username` / `url`
// (not `handle` or `platform`: the readers that find the business's own Instagram by those must not find a rival's).
function rivalChannel(c: CompetitorRef, network: RivalNetwork, ctx: PublicWriteCtx, src: string, o: { username?: string; url?: string } = {}): { nodes: NodeInput[]; edges: EdgeInput[]; id: string } {
  const id = rivalChannelId(c.name, network);
  return {
    id,
    nodes: [{
      type: "Channel", id, name: `${c.name} on ${RIVAL_WORDS[network]}`.slice(0, 160), src, asOf: ctx.asOf,
      summary: `${c.name}'s public ${RIVAL_WORDS[network]} presence, watched through public data only.`,
      props: { rival: true, network, ...(o.username ? { username: o.username } : {}), ...(o.url ? { url: o.url } : {}) },
    }],
    edges: [
      { from: competitorId(c.name), type: "OWNS", to: id, src, asOf: ctx.asOf },
      { from: id, type: "SOURCED_FROM", to: src, src, asOf: ctx.asOf },
    ],
  };
}

const SOURCE_WORDS: Record<LookupKind, string> = {
  listing: "Google Maps listing (public)", instagram: "Instagram profile (public)", "ads-meta": "Meta Ad Library (public)",
  "ads-google": "Google Ads Transparency Center (public)", website: "Public website (read through Apify)",
};

export function lookupDoc(kind: LookupKind, key: string, ctx: PublicWriteCtx, o: { name: string; summary: string; url?: string; result: unknown }): NodeInput {
  const json = JSON.stringify(o.result);
  return {
    type: "Document", id: lookupDocId(kind, key), name: o.name.slice(0, 160), summary: o.summary.slice(0, 1200), asOf: ctx.asOf,
    props: {
      kind: "public", source: SOURCE_WORDS[kind], via: `apify:${ctx.actor}`, lookupKey: lookupKey(kind, key), fetchedAt: ctx.asOf,
      result: json.length <= RESULT_JSON_CAP ? json : JSON.stringify({ truncated: true }),
      ...(o.url ? { url: o.url } : {}),
    },
  };
}

const obs = (subject: string, metric: string, value: number | undefined, unit: string, src: string, ctx: PublicWriteCtx, evidence: string): ObservationInput[] =>
  value === undefined || !Number.isFinite(value) ? [] : [{ subject, metric, value, unit, asOf: day(ctx.asOf), src, conf: PUBLIC_CONF, evidence }];

// ---------- Google Maps ----------

export function listingSummary(l: Listing, asOfDay: string): string {
  return [
    `${l.name} on Google Maps${l.category ? ` (${l.category})` : ""}.`,
    l.address ? `Address: ${l.address}.` : undefined,
    l.hours.length ? `Hours: ${l.hours.join("; ")}.` : "Hours: not shown on the listing.",
    l.rating !== undefined ? `Rated ${l.rating} out of 5 from ${l.reviewCount ?? "an unknown number of"} reviews (as of ${asOfDay}).` : undefined,
    l.closed ? `The listing says it is ${l.closed} closed.` : undefined,
  ].filter(Boolean).join(" ");
}

/** The business's own listing: the Maps channel with its facts, the rating and review count, and each review as a Document. */
export function ownListingWrite(l: Listing, ctx: PublicWriteCtx, key: string): GraphWrite {
  const doc = lookupDoc("listing", key, ctx, { name: `Google Maps listing: ${l.name}`, summary: listingSummary(l, day(ctx.asOf)), ...(l.mapsUrl ? { url: l.mapsUrl } : {}), result: l });
  const nodes: NodeInput[] = [doc, {
    type: "Channel", id: MAPS_CHANNEL, name: "Google Maps listing", summary: listingSummary(l, day(ctx.asOf)), src: doc.id, asOf: ctx.asOf,
    props: {
      platform: "google-maps", hours: l.hours, phoneListed: l.phoneListed,
      ...(l.mapsUrl ? { url: l.mapsUrl } : {}), ...(l.address ? { address: l.address } : {}), ...(l.category ? { category: l.category } : {}),
      ...(l.placeId ? { placeId: l.placeId } : {}), ...(l.rating !== undefined ? { rating: l.rating } : {}),
      ...(l.reviewCount !== undefined ? { reviewCount: l.reviewCount } : {}), ...(l.website ? { website: l.website } : {}),
      closed: l.closed ?? null,
    },
  }];
  const edges: EdgeInput[] = [
    { from: MAPS_CHANNEL, type: "PART_OF", to: ctx.businessId, src: doc.id, asOf: ctx.asOf },
    { from: MAPS_CHANNEL, type: "SOURCED_FROM", to: doc.id, src: doc.id, asOf: ctx.asOf },
  ];
  for (const r of l.reviews) {
    const id = entityId("Document", `google review ${r.id}`);
    const when = r.publishedAt?.slice(0, 10);
    nodes.push({
      type: "Document", id, name: `Google review${r.stars !== undefined ? `, ${r.stars} star${r.stars === 1 ? "" : "s"}` : ""}${when ? ` (${when})` : ""}`,
      summary: r.text ?? "(a rating with no text)", asOf: r.publishedAt ?? ctx.asOf, src: doc.id,
      props: {
        kind: "review", platform: "google", source: SOURCE_WORDS.listing, ownerReplied: r.ownerReplied,
        ...(r.stars !== undefined ? { stars: r.stars } : {}), ...(r.firstName ? { author: r.firstName } : {}), ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
      },
    });
    edges.push({ from: id, type: "MENTIONS", to: MAPS_CHANNEL, src: doc.id, asOf: ctx.asOf }, { from: id, type: "SOURCED_FROM", to: doc.id, src: doc.id, asOf: ctx.asOf });
  }
  const ev = `Google Maps listing, ${day(ctx.asOf)}`;
  const observations = [
    ...obs(MAPS_CHANNEL, "rating", l.rating, "stars", doc.id, ctx, ev),
    ...obs(MAPS_CHANNEL, "review_count", l.reviewCount, "reviews", doc.id, ctx, ev),
  ];
  return { nodes, edges, observations };
}

// ---------- competitors ----------

export interface CompetitorRef { name: string; instagram?: string; domain?: string; facebook?: string }

export function competitorNode(c: CompetitorRef, ctx: PublicWriteCtx, src: string): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const id = competitorId(c.name);
  const handles = [c.instagram ? `Instagram @${c.instagram}` : undefined, c.domain ? `website ${c.domain}` : undefined].filter(Boolean).join(", ");
  return {
    nodes: [{
      type: "Competitor", id, name: c.name.slice(0, 120), src, asOf: ctx.asOf,
      summary: `A competitor, watched through public data only${handles ? ` (${handles})` : ""}.`,
      props: { ...(c.instagram ? { instagram: c.instagram } : {}), ...(c.domain ? { domain: c.domain } : {}), ...(c.facebook ? { facebook: c.facebook } : {}) },
    }],
    edges: [
      { from: id, type: "COMPETES_WITH", to: ctx.businessId, src, asOf: ctx.asOf },
      { from: id, type: "SOURCED_FROM", to: src, src, asOf: ctx.asOf },
    ],
  };
}

export function competitorListingWrite(l: Listing, c: CompetitorRef, ctx: PublicWriteCtx, key: string): GraphWrite {
  // a competitor's listing keeps its numbers, not its reviewers' words
  const doc = lookupDoc("listing", key, ctx, { name: `Google Maps listing: ${l.name}`, summary: listingSummary(l, day(ctx.asOf)), ...(l.mapsUrl ? { url: l.mapsUrl } : {}), result: { ...l, reviews: [] } });
  const comp = competitorNode(c, ctx, doc.id);
  const id = competitorId(c.name);
  comp.edges.push({ from: doc.id, type: "MENTIONS", to: id, src: doc.id, asOf: ctx.asOf });
  const ev = `Google Maps listing, ${day(ctx.asOf)}`;
  return {
    nodes: [doc, ...comp.nodes], edges: comp.edges,
    observations: [...obs(id, "gmaps_rating", l.rating, "stars", doc.id, ctx, ev), ...obs(id, "gmaps_review_count", l.reviewCount, "reviews", doc.id, ctx, ev)],
  };
}

// ---------- Instagram ----------

export function igSummary(p: IgProfile, s: IgStats): string {
  const parts = [
    `@${p.handle} on Instagram${p.category ? ` (${p.category})` : ""}: ${p.followers !== undefined ? `${p.followers} followers` : "followers not shown"}, ${p.posts !== undefined ? `${p.posts} posts` : "posts not shown"}.`,
    s.postsLooked ? `Over the last ${s.postsLooked} posts: ${s.postsPerWeek !== undefined ? `about ${s.postsPerWeek} a week` : "frequency unknown"}, average ${s.avgLikes ?? "?"} likes and ${s.avgComments ?? "?"} comments${s.avgViews !== undefined ? `, ${s.avgViews} views per video` : ""}${s.engagementRatePct !== undefined ? ` (engagement ${s.engagementRatePct}% of followers per post)` : ""}.` : "No public posts were readable.",
  ];
  return parts.join(" ");
}

const igObs = (subject: string, p: IgProfile, s: IgStats, src: string, ctx: PublicWriteCtx): ObservationInput[] => {
  const ev = `Public Instagram profile @${p.handle}, ${day(ctx.asOf)}`;
  return [
    ...obs(subject, "followers", p.followers, "followers", src, ctx, ev),
    ...obs(subject, "media_count", p.posts, "posts", src, ctx, ev),
    ...obs(subject, "ig_posts_per_week", s.postsPerWeek, "posts per week", src, ctx, ev),
    ...obs(subject, "ig_avg_likes", s.avgLikes, "likes per post", src, ctx, ev),
    ...obs(subject, "ig_avg_comments", s.avgComments, "comments per post", src, ctx, ev),
    ...obs(subject, "ig_avg_views", s.avgViews, "views per video", src, ctx, ev),
    ...obs(subject, "ig_engagement_rate_pct", s.engagementRatePct, "%", src, ctx, ev),
  ];
};

const igResult = (p: IgProfile, s: IgStats) => ({ profile: { ...p, latest: undefined }, stats: s });

/** The business's own public Instagram: its channel (PART_OF the business) and its public numbers. */
export function ownInstagramWrite(p: IgProfile, s: IgStats, ctx: PublicWriteCtx): GraphWrite {
  const doc = lookupDoc("instagram", p.handle, ctx, { name: `Public Instagram profile @${p.handle}`, summary: igSummary(p, s), url: `https://www.instagram.com/${p.handle}/`, result: igResult(p, s) });
  return {
    nodes: [doc, {
      type: "Channel", id: INSTAGRAM_CHANNEL, name: "Instagram", src: doc.id, asOf: ctx.asOf, summary: `Instagram profile @${p.handle}.`,
      props: { platform: "instagram", handle: p.handle, url: `https://www.instagram.com/${p.handle}/` },
    }],
    edges: [
      { from: INSTAGRAM_CHANNEL, type: "PART_OF", to: ctx.businessId, src: doc.id, asOf: ctx.asOf },
      { from: INSTAGRAM_CHANNEL, type: "SOURCED_FROM", to: doc.id, src: doc.id, asOf: ctx.asOf },
    ],
    observations: igObs(INSTAGRAM_CHANNEL, p, s, doc.id, ctx),
  };
}

export function competitorInstagramWrite(p: IgProfile, s: IgStats, c: CompetitorRef, ctx: PublicWriteCtx): GraphWrite {
  const doc = lookupDoc("instagram", p.handle, ctx, { name: `Public Instagram profile @${p.handle}`, summary: igSummary(p, s), url: `https://www.instagram.com/${p.handle}/`, result: igResult(p, s) });
  const comp = competitorNode(c, ctx, doc.id);
  const id = competitorId(c.name);
  const ch = rivalChannel(c, "instagram", ctx, doc.id, { username: p.handle, url: `https://www.instagram.com/${p.handle}/` });
  comp.edges.push({ from: doc.id, type: "MENTIONS", to: id, src: doc.id, asOf: ctx.asOf }, ...ch.edges);
  // The numbers are the Instagram account's: they MEASURE the rival's Channel. The same reading also MEASURES the Competitor, so
  // what already reads a rival's numbers through the Competitor (the stand-up's "a rival moved") keeps working.
  const observations = igObs(ch.id, p, s, doc.id, ctx);
  const alsoRival: EdgeInput[] = observations.map((o) => ({ from: observationId(o), type: "MEASURES", to: id, src: doc.id, asOf: day(ctx.asOf), conf: PUBLIC_CONF }));
  return { nodes: [doc, ...comp.nodes, ...ch.nodes], edges: [...comp.edges, ...alsoRival], observations };
}

// ---------- ads ----------

export function adsSummary(platform: "meta" | "google", who: string, ads: Ad[]): string {
  const lib = platform === "meta" ? "Meta's Ad Library" : "Google's Ads Transparency Center";
  if (!ads.length) return `No ads for ${who} were found in ${lib}.`;
  const active = ads.filter((a) => a.active === true).length;
  return `${ads.length} ad${ads.length === 1 ? "" : "s"} for ${who} in ${lib}${platform === "meta" ? `, ${active} running now` : ""}. ${ads.slice(0, 4).map(adLine).join(" | ")}`;
}

/**
 * Ads seen in a public library for `subject` (a Competitor, or the business itself), with counts as Observations. A rival's ads
 * are also nodes (graph audit G6): each is a Content the Competitor OWNS, PUBLISHED_ON the rival's own channel on that library
 * (its Facebook page, or its Google ads account), so "what is this rival running, and since when" is a traversal.
 */
export function adsWrite(platform: "meta" | "google", ads: Ad[], ctx: PublicWriteCtx, o: { key: string; who: string; subject: string; competitor?: CompetitorRef }): GraphWrite {
  const kind: LookupKind = platform === "meta" ? "ads-meta" : "ads-google";
  const doc = lookupDoc(kind, o.key, ctx, { name: `${platform === "meta" ? "Meta" : "Google"} ads: ${o.who}`, summary: adsSummary(platform, o.who, ads), result: ads });
  doc.props = { ...doc.props, ads: ads.slice(0, 20).map(adLine) };
  const comp = o.competitor ? competitorNode(o.competitor, ctx, doc.id) : { nodes: [], edges: [] };
  const ev = `${SOURCE_WORDS[kind]}, ${day(ctx.asOf)}`;
  const nodes: NodeInput[] = [doc, ...comp.nodes];
  const edges: EdgeInput[] = [...comp.edges, { from: doc.id, type: "MENTIONS", to: o.subject, src: doc.id, asOf: ctx.asOf }];
  if (o.competitor && ads.length) {
    const ch = rivalChannel(o.competitor, platform === "meta" ? "facebook" : "google-ads", ctx, doc.id,
      { ...(o.competitor.facebook && platform === "meta" ? { username: o.competitor.facebook } : {}), ...(o.competitor.domain && platform === "google" ? { url: `https://${o.competitor.domain}` } : {}) });
    nodes.push(...ch.nodes);
    edges.push(...ch.edges);
    const owner = competitorId(o.competitor.name);
    const seen = new Set<string>();
    for (const a of ads.slice(0, 20)) {
      const id = adContentId(platform, a.id);
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        type: "Content", id, name: (a.title ?? a.text ?? `${platform === "meta" ? "Meta" : "Google"} ad`).slice(0, 160), summary: adLine(a).slice(0, 400), src: doc.id, asOf: ctx.asOf,
        props: {
          format: "ad", platform, rival: true, ...(a.active !== undefined ? { active: a.active } : {}), ...(a.startedAt ? { startedAt: a.startedAt } : {}),
          ...(a.endedAt ? { endedAt: a.endedAt } : {}), ...(a.cta ? { cta: a.cta } : {}), ...(a.link ? { link: a.link } : {}), ...(a.format ? { adFormat: a.format } : {}),
        },
      });
      edges.push(
        { from: owner, type: "OWNS", to: id, src: doc.id, asOf: ctx.asOf },
        { from: id, type: "PUBLISHED_ON", to: ch.id, src: doc.id, asOf: ctx.asOf },
        { from: id, type: "SOURCED_FROM", to: doc.id, src: doc.id, asOf: ctx.asOf },
      );
    }
  }
  return {
    nodes, edges,
    observations: [
      ...obs(o.subject, `ads_${platform}_seen`, ads.length, "ads", doc.id, ctx, ev),
      ...(platform === "meta" ? obs(o.subject, "ads_meta_running", ads.filter((a) => a.active === true).length, "ads", doc.id, ctx, ev) : []),
    ],
  };
}
