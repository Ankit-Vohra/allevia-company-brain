// Closing the loop: a post's numbers land on the post. When the business's own Instagram posts are read (the connected account,
// or the public profile through Apify), each post is a Content node PUBLISHED_ON channel:instagram with its likes, comments and
// plays as Observations that MEASURE it. A post Allevia published (src/publish/record.ts: Content content:publish-<approval>, with the
// post's postId and postUrl) is matched by its media id or its address, so the numbers land on that same node, and the next brief
// (whatworked.ts) learns from what the team made.
import type { GraphHandle } from "../graph/client.js";
import type { EdgeInput, NodeInput, ObservationInput } from "../graph/upsert.js";
import type { GraphWrite } from "../ingest/types.js";
import { entityId } from "../util/ids.js";
import { UnsafeQuery } from "../graph/errors.js";

// A read that cannot run is an empty answer, except a query the safety check refuses: that is a bug, so it surfaces.
const soft = (e: unknown): never[] => { if (e instanceof UnsafeQuery) throw e; return []; };

type Read = Pick<GraphHandle, "roQuery">;

export interface OwnPost {
  url?: string; mediaId?: string; kind: "image" | "video" | "carousel"; at?: string; caption?: string;
  likes?: number; comments?: number; views?: number; reach?: number; saves?: number;
}

/** "https://www.instagram.com/reel/Cx1_ab/" -> "Cx1_ab" */
export const shortcodeOf = (url: string | undefined | null): string | undefined => (url ? /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i.exec(url)?.[1] : undefined);

export const instagramPostId = (p: Pick<OwnPost, "url" | "mediaId">): string | undefined => {
  const key = shortcodeOf(p.url) ?? p.mediaId;
  return key ? entityId("Content", `instagram post ${key}`) : undefined;
};

/** The posts Allevia published, by Instagram media id and by shortcode -> their Content id. */
export async function publishedPosts(g: Read): Promise<Map<string, string>> {
  const rows = await g.roQuery<{ id: string; url: string | null; pid: string | null }>(
    "MATCH (c:Content) WHERE c.platform = 'instagram' AND (c.postId IS NOT NULL OR c.postUrl IS NOT NULL) RETURN c.id AS id, c.postUrl AS url, c.postId AS pid LIMIT 2000").catch(soft);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.pid) out.set(String(r.pid), r.id);
    const sc = shortcodeOf(r.url);
    if (sc) out.set(sc, r.id);
  }
  return out;
}

const METRICS: Array<[keyof OwnPost, string, string]> = [["likes", "likes", "likes"], ["comments", "comments", "comments"], ["views", "plays", "plays"], ["reach", "reach", "accounts"], ["saves", "saves", "saves"]];

/** The business's own posts and their numbers, as a graph write (a published post's numbers go on its own node). */
export function ownPostsWrite(posts: readonly OwnPost[], o: { published: Map<string, string>; asOf: string; src: string; channel: string; evidence: string; conf?: number }): GraphWrite {
  const nodes: NodeInput[] = [], edges: EdgeInput[] = [], observations: ObservationInput[] = [];
  const day = o.asOf.slice(0, 10);
  for (const p of posts) {
    const sc = shortcodeOf(p.url);
    const known = (p.mediaId ? o.published.get(p.mediaId) : undefined) ?? (sc ? o.published.get(sc) : undefined);
    const id = known ?? instagramPostId(p);
    if (!id) continue;
    if (!known) {
      const caption = (p.caption ?? "").replace(/\s+/g, " ").trim();
      nodes.push({
        type: "Content", id, name: (caption.slice(0, 80) || `Instagram ${p.kind === "video" ? "reel" : p.kind} ${p.at?.slice(0, 10) ?? ""}`).trim(), src: o.src, asOf: day,
        props: {
          platform: "instagram", format: p.kind === "video" ? "reel" : p.kind, ...(p.at ? { publishedAt: p.at.slice(0, 10) } : {}),
          ...(p.url ? { url: p.url } : {}), ...(p.mediaId ? { mediaId: p.mediaId } : {}), ...(caption ? { caption: caption.slice(0, 300) } : {}),
        },
      });
      edges.push({ from: id, type: "PUBLISHED_ON", to: o.channel, src: o.src, asOf: day, props: { state: "published" } });
    }
    for (const [k, metric, unit] of METRICS) {
      const v = p[k];
      if (typeof v === "number" && Number.isFinite(v)) observations.push({ subject: id, metric, value: v, unit, asOf: day, src: o.src, evidence: o.evidence, ...(o.conf !== undefined ? { conf: o.conf } : {}) });
    }
  }
  return { nodes, edges, observations };
}
