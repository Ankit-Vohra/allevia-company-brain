// "What worked": the brain read behind every post, poster, reel and ad. The founder, 2026-10-17: "Every agent should refer to the
// brain … while generating a reel it should refer to the brain, see the past top ones, and build the next one from those learnings.
// Otherwise how is this product even useful."
// One read of the business's graph, by code (no model, no spend):
//   - its own posts and reels with real numbers (Observations that MEASURE the Content: reach, plays, views, saves, likes, clicks;
//     from the Instagram connection, the public-profile reads and posts we published), best and weakest against the usual;
//   - things the team learned from the owner's edits (Rule{kind:'learned'}) and the owner's own brand rules;
//   - recent decisions;
//   - rivals' ads on record (the ad-library reads);
//   - the main goal (src/northstar) and its call to action.
// It returns the facts, one "Built from: …" line for the card (each item a real node, so it is on the map path), a short
// "learnings" sentence for the writer, and, when there are no post numbers, one honest line saying so.
import type { GraphHandle } from "../graph/client.js";
import type { NorthStar } from "../northstar/northstar.js";
import { UnsafeQuery } from "../graph/errors.js";

// A read that cannot run is an empty answer, except a query the safety check refuses: that is a bug, so it surfaces.
const soft = (e: unknown): never[] => { if (e instanceof UnsafeQuery) throw e; return []; };

type Read = Pick<GraphHandle, "roQuery">;

// Most telling first: reach and plays are what a post earned; likes are the weakest signal but often the only public one.
export const PERFORMANCE_METRICS = ["reach", "account_reach", "plays", "views", "video_views", "impressions", "saves", "shares", "clicks", "link_clicks", "likes", "ig_likes", "comments"] as const;

export interface PostResult {
  id: string; name: string; format: string | null; hook: string | null; publishedAt: string | null;
  metric: string; value: number; multiple: number | null; simulated: boolean;
}
export interface BrainLine { id: string; text: string }

export interface WhatWorked {
  metric: string | null;          // the measure posts were compared on
  usual: number | null;           // the median of that measure across the business's posts
  considered: number;             // posts with a number
  top: PostResult[];              // at most 3, best first, each above the usual
  weak: PostResult[];             // at most 1, the furthest below the usual
  rules: BrainLine[];             // learned from the owner's edits, then the owner's brand rules
  decisions: BrainLine[];
  rivalAds: Array<BrainLine & { rival: string | null }>;
  northStar: NorthStar | null;
  noData: string | null;          // said when there are no post numbers to learn from
  builtFrom: string;              // the card line
  learnings: string;              // a sentence for the writer: what to copy, what to avoid
  ids: string[];                  // every node the read used (for citations and the map path)
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const human = (metric: string): string => metric.replace(/^ig_|^account_/, "").replace(/_/g, " ");
const kindOf = (format: string | null): string => (format && /reel|video|clip/i.test(format) ? "reel" : format && /carousel/i.test(format) ? "carousel" : "post");

interface ObsRow { id: string; name: string | null; format: string | null; hook: string | null; publishedAt: string | null; metric: string; value: number | null; simulated: boolean | null }

/** The business's own posts with numbers: the newest reading of each measure on each post (rivals' content left out). */
async function ownPosts(g: Read): Promise<ObsRow[]> {
  return g.roQuery<ObsRow>(
    `MATCH (o:Observation)-[r:MEASURES]->(c:Content) WHERE o.metricKey IN $metrics AND r.until IS NULL
     OPTIONAL MATCH (rival:Competitor)-[ow:OWNS]->(c)
     WITH c, o, ow WHERE ow IS NULL
     WITH c, o.metricKey AS metric, o ORDER BY coalesce(o.windowEnd, o.asOf) DESC, o.id DESC
     WITH c, metric, head(collect(o)) AS o
     RETURN c.id AS id, c.name AS name, c.format AS format, coalesce(c.hook, c.caption) AS hook, c.publishedAt AS publishedAt,
            metric, o.value AS value, o.simulated AS simulated, o.id AS oid
     ORDER BY id, metric, oid LIMIT 2000`, { metrics: [...PERFORMANCE_METRICS] }).catch(soft);
}

export async function readWhatWorked(g: Read, o: { northStar?: NorthStar | null } = {}): Promise<WhatWorked> {
  const [rows, learned, brand, decisions, ads] = await Promise.all([
    ownPosts(g),
    g.roQuery<{ id: string; text: string | null }>(
      "MATCH (r:Rule) WHERE r.kind = 'learned' AND coalesce(r.status, 'active') = 'active' RETURN r.id AS id, coalesce(r.text, r.name) AS text ORDER BY coalesce(r.confidence, 0) DESC, id LIMIT 3").catch(soft),
    g.roQuery<{ id: string; text: string | null }>(
      "MATCH (b:BrandRule) WHERE b.origin = 'owner' RETURN b.id AS id, coalesce(b.text, b.name) AS text ORDER BY id LIMIT 2").catch(soft),
    g.roQuery<{ id: string; text: string | null }>(
      "MATCH (d:Decision) RETURN d.id AS id, d.name AS text ORDER BY coalesce(d.decidedAt, d.asOf, '') DESC, id LIMIT 2").catch(soft),
    g.roQuery<{ id: string; text: string | null; rival: string | null }>(
      "MATCH (comp:Competitor)-[:OWNS]->(c:Content) RETURN c.id AS id, coalesce(c.name, c.summary) AS text, comp.name AS rival ORDER BY coalesce(c.asOf, '') DESC, id LIMIT 2").catch(soft),
  ]);
  const ns = o.northStar ?? null;

  // the measure most posts have, in the order above
  const byPost = new Map<string, Map<string, ObsRow>>();
  for (const r of rows) {
    if (typeof r.value !== "number" || !Number.isFinite(r.value)) continue;
    const m = byPost.get(r.id) ?? new Map<string, ObsRow>();
    m.set(r.metric, r);
    byPost.set(r.id, m);
  }
  const counts = PERFORMANCE_METRICS.map((m) => [m, [...byPost.values()].filter((x) => x.has(m)).length] as const);
  const best = Math.max(0, ...counts.map(([, n]) => n));
  const metric = best ? counts.find(([, n]) => n === best)![0] : null;
  const posts: PostResult[] = metric ? [...byPost.values()].flatMap((x) => {
    const r = x.get(metric);
    return r ? [{ id: r.id, name: r.name ?? r.id, format: r.format, hook: r.hook, publishedAt: r.publishedAt, metric, value: r.value!, multiple: null, simulated: r.simulated === true }] : [];
  }) : [];
  const usual = median(posts.map((p) => p.value));
  for (const p of posts) p.multiple = usual ? round1(p.value / usual) : null;
  const ranked = [...posts].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id));
  const top = (posts.length >= 2 ? ranked.filter((p) => (p.multiple ?? 0) > 1) : ranked).slice(0, 3);
  const weak = posts.length >= 3 ? ranked.slice(-1).filter((p) => (p.multiple ?? 1) < 1) : [];

  const rules: BrainLine[] = [...learned, ...brand].filter((r) => r.text).map((r) => ({ id: r.id, text: clip(r.text!, 90) })).slice(0, 3);
  const decs: BrainLine[] = decisions.filter((d) => d.text).map((d) => ({ id: d.id, text: clip(d.text!, 90) }));
  const rivalAds = ads.filter((a) => a.text).map((a) => ({ id: a.id, text: clip(a.text!, 80), rival: a.rival }));

  const sample = top.some((p) => p.simulated) ? " (sample numbers)" : "";
  const noData = posts.length ? null
    : "No post numbers on record yet (connect Instagram so your team can see what works), so this is built from your main goal, your brand kit and rivals' posts.";
  const parts: string[] = [];
  const t = top[0];
  if (t) {
    const vs = t.multiple && posts.length >= 2 ? `${t.multiple}× your usual ${human(t.metric)}` : `${t.value} ${human(t.metric)}`;
    parts.push(`your top ${kindOf(t.format)} "${clip(t.name, 50)}" (${vs}${t.hook && t.hook !== t.name ? `, hook "${clip(t.hook, 40)}"` : ""})${sample}`);
  }
  if (weak[0]) parts.push(`avoiding what "${clip(weak[0].name, 40)}" did (${weak[0].multiple}× usual)`);
  if (rules[0]) parts.push(`the edit rule "${rules[0].text}"`);
  if (decs[0]) parts.push(`the decision "${decs[0].text}"`);
  if (!t && rivalAds[0]) parts.push(`${rivalAds[0].rival ?? "a rival"}'s ad "${rivalAds[0].text}"`);
  if (ns) parts.push(`goal: ${ns.outcome}`);
  const builtFrom = parts.length ? `Built from: ${parts.join(" · ")}` : "Built from: your brief only (nothing on record yet)";

  const learnings = [
    top.length ? `What worked here: ${top.map((p) => `"${clip(p.hook ?? p.name, 60)}" (${p.multiple ? `${p.multiple}× usual` : `${p.value}`} ${human(p.metric)})`).join("; ")}${sample}. Use the same kind of hook and opening, not the same words.` : "",
    weak.length ? `What fell flat: "${clip(weak[0]!.hook ?? weak[0]!.name, 60)}" (${weak[0]!.multiple}× usual): don't repeat its opening.` : "",
    rules.length ? `Follow: ${rules.map((r) => r.text).join("; ")}.` : "",
    noData ?? "",
  ].filter(Boolean).join(" ");

  const ids = [...new Set([...top.map((p) => p.id), ...weak.map((p) => p.id), ...rules.map((r) => r.id), ...decs.map((d) => d.id), ...rivalAds.map((a) => a.id), ...(ns ? [ns.id] : [])])];
  return { metric, usual, considered: posts.length, top, weak, rules, decisions: decs, rivalAds, northStar: ns, noData, builtFrom, learnings, ids };
}
