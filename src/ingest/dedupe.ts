// Near-duplicates at onboarding (issue #24): a website read page by page names one thing many ways. Trials 2026-10-15:
// about 15 of Plausible's 45 Features were near-duplicates ("Funnels", "Funnel analysis", "Funnels and user journeys"),
// Twitter and X were two Channels, and one renovation was four Events (German and English).
//
// Pure planning, in three tiers, same type only (never across types):
//   certain     one canonical channel (X = Twitter, IG = Instagram, a business's "Online Shop" = "Onlineshop"); the same
//               words after normalising (case, punctuation, plurals, "and", "the"); one's name is the other's alias (two
//               words or more); or the names agree as the resolver's do ("Search Console" ⊂ "Google Search Console") and
//               the vectors are close. Merged without asking anyone.
//   borderline  close vectors (local e5, the one search uses) or one name inside the other ("Funnels" ⊂ "Funnel
//               analysis"). e5-small scores distinct things of one type above 0.92 (Instagram~Facebook 0.959), so a vector
//               alone never merges: a borderline pair goes to a cheap model check (src/ingest/tidy.ts), which decides.
//   never       a pair the owner unmerged (notSameAs) or the model already judged distinct (distinctFrom), simulated with
//               real, or two registry entries.
// Each node keeps its best few borderline partners, so the model sees tens of pairs, not thousands.
import type { EntityType } from "../graph/schema.js";
import { nameKey } from "./merge.js";
import { namesAgree, normName } from "./resolve-names.js";

// The types onboarding de-duplicates. Person is left to the resolver (two people can share a name); Business to the
// retyping pass (src/ingest/retype.ts).
export const DEDUPE_TYPES: readonly EntityType[] = [
  "Product", "Feature", "Audience", "Need", "Channel", "Content", "Campaign", "Event", "System", "Query",
  "Supplier", "Partner", "Client", "Competitor",
];

export const BORDERLINE_SIMILARITY = 0.92;   // e5-small, cosine: a candidate for the model, never a merge on its own
export const AGREE_SIMILARITY = 0.88;        // names that agree, with vectors at least this close: certain
export const CONTAINED_SIMILARITY = 0.85;    // one name's words inside the other's: a candidate from this score up
export const ALIAS_SIMILARITY = 0.9;         // one's name is the other's alias, and the names do not agree: vectors this close
// One piece of content, campaign or event extended by a word is often another one ("Spring sale" / "Spring sale
// launch"): never certain by name, always the model's call.
const VERSIONED_TYPES: readonly EntityType[] = ["Content", "Campaign", "Event"];
export const PARTNERS_PER_NODE = 3;
// The quality report has no model to ask, so it counts a close-vector pair as a possible duplicate only when the names
// share a word or the vectors are very close.
export const REPORT_SIMILARITY = 0.95;
export const MAX_DEDUPE_GROUP = 6;

export interface DedupeNode {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  summary?: string;
  embedding?: number[];
  degree: number;
  registry?: boolean;
  simulated?: boolean;
  platform?: string;             // a Channel's platform prop (the socials writer sets it)
  notSameAs?: string[];          // the owner unmerged these
  distinctFrom?: string[];       // the model judged these different
}

export type PairHow = "same channel" | "same name" | "alias" | "names agree" | "similar";
export interface Pair { a: string; b: string; type: EntityType; how: PairHow; score?: number }

// ---------- names ----------

const STOP = new Set([
  "and", "the", "of", "for", "a", "an", "our", "your", "with", "to", "in", "on", "by", "at",
  "und", "der", "die", "das", "für", "y", "de", "la", "el", "los", "las", "del", "et", "le", "les", "des",
]);

// "funnels" -> "funnel", "journeys" -> "journey", "boxes" -> "box", "categories" -> "category"; short words stay.
export function stem(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(?:ches|shes|sses|xes|zes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !/(?:ss|us|is|ous)$/.test(t)) return t.slice(0, -1);
  return t;
}

// The words a name is made of: normalised, abbreviations spelled out (merge.ts nameKey), stemmed, without filler words.
export function nameWords(name: string): string[] {
  const k = nameKey(name.replace(/&/g, " and "));
  if (!k) return [];
  const words = k.split(" ").map(stem).filter((w) => w && !STOP.has(w));
  return [...new Set(words)].sort();
}

// One key per name: its words in order. Undefined for a file name or an empty name.
export const strongKey = (name: string): string | undefined => nameWords(name).join(" ") || undefined;

// ---------- channels ----------

// The platform a channel name stands for. Keys are normalised names (normName) with the business's own name, and words
// like "profile" or "page", taken off.
const PLATFORMS: Record<string, string> = {
  x: "x", twitter: "x", "x twitter": "x", "twitter x": "x", "x com": "x", "twitter com": "x", "x formerly twitter": "x", "x formerly known as twitter": "x",
  instagram: "instagram", ig: "instagram", insta: "instagram", "instagram com": "instagram",
  facebook: "facebook", fb: "facebook", "facebook com": "facebook",
  linkedin: "linkedin", "linked in": "linkedin", "linkedin com": "linkedin",
  youtube: "youtube", yt: "youtube", "youtube com": "youtube",
  tiktok: "tiktok", "tik tok": "tiktok", pinterest: "pinterest", threads: "threads", bluesky: "bluesky", mastodon: "mastodon",
  whatsapp: "whatsapp", wa: "whatsapp", "whatsapp business": "whatsapp",
  "google business profile": "google-maps", "google my business": "google-maps", gbp: "google-maps", gmb: "google-maps",
  "google maps": "google-maps", "google maps listing": "google-maps",
  "online shop": "online-shop", onlineshop: "online-shop", webshop: "online-shop", "web shop": "online-shop", "online store": "online-shop",
  eshop: "online-shop", "e shop": "online-shop", "e commerce shop": "online-shop", tienda: "online-shop", "tienda online": "online-shop",
  newsletter: "newsletter", "email newsletter": "newsletter", "e mail newsletter": "newsletter",
  // not social profiles, but channels whose names must never pair with each other on a close vector alone
  website: "website", "web site": "website", homepage: "website", "google search": "google-search", "google organic search": "google-search",
  "google ads": "google-ads", adwords: "google-ads", "google adwords": "google-ads", "meta ads": "meta-ads", "facebook ads": "meta-ads",
  "instagram ads": "meta-ads", "meta ads manager": "meta-ads", email: "email", "e mail": "email",
};
const CHANNEL_FILLER = /\b(?:profile|page|account|channel|feed|handle|official)\b/g;

export function channelPlatform(name: string, business?: string): string | undefined {
  const raw = normName(name.replace(/\(([^)]*)\)/g, " $1 "));
  const biz = business ? normName(business) : "";
  const candidates = new Set<string>([raw]);
  const bare = biz && raw.startsWith(`${biz} `) ? raw.slice(biz.length + 1) : raw;
  candidates.add(bare);
  for (const c of [...candidates]) candidates.add(c.replace(CHANNEL_FILLER, " ").replace(/\s+/g, " ").trim());
  for (const c of candidates) if (PLATFORMS[c]) return PLATFORMS[c];
  return undefined;
}

// ---------- pairs ----------

export function cosine(a: number[] | undefined, b: number[] | undefined): number | undefined {
  if (!a || !b || a.length !== b.length || !a.length) return undefined;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! ** 2; nb += b[i]! ** 2; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : undefined;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
export { pairKey };

function never(x: DedupeNode, y: DedupeNode): boolean {
  if ((x.simulated === true) !== (y.simulated === true)) return true;
  if (x.registry && y.registry) return true;
  return [x.notSameAs, x.distinctFrom].some((l) => l?.includes(y.id)) || [y.notSameAs, y.distinctFrom].some((l) => l?.includes(x.id));
}

// The tier one pair falls in, or undefined when it is no candidate at all.
export function judgePair(x: DedupeNode, y: DedupeNode, business?: string): Pair | undefined {
  if (x.type !== y.type || x.id === y.id || never(x, y)) return undefined;
  const base = { a: x.id < y.id ? x.id : y.id, b: x.id < y.id ? y.id : x.id, type: x.type };
  const score = cosine(x.embedding, y.embedding);
  const withScore = score === undefined ? {} : { score: Math.round(score * 1000) / 1000 };
  if (x.type === "Channel") {
    const px = (x.platform && channelPlatform(x.platform)) ?? channelPlatform(x.name, business);
    const py = (y.platform && channelPlatform(y.platform)) ?? channelPlatform(y.name, business);
    if (px && py) return px === py ? { ...base, how: "same channel", ...withScore } : undefined; // two known platforms that differ never merge
  }
  const [kx, ky] = [strongKey(x.name), strongKey(y.name)];
  if (!kx || !ky) return undefined;
  if (kx === ky) return { ...base, how: "same name", ...withScore };
  const [wx, wy] = [kx.split(" "), ky.split(" ")];
  const agree = namesAgree([kx], [ky]);
  // extraction's aliases are noisy ("Discord #jarvis" listed "#marketing-staging"): an alias counts with names that
  // agree or vectors that are close
  const aliasKeys = (n: DedupeNode) => new Set(n.aliases.map(strongKey).filter((k): k is string => !!k && k.includes(" ")));
  if ((aliasKeys(y).has(kx) || aliasKeys(x).has(ky)) && (agree || (score ?? 0) >= ALIAS_SIMILARITY)) return { ...base, how: "alias", ...withScore };
  // "Employer launch reel" and "… v3", "Diwali sale" and "… 2025": a version or a year makes another piece of content
  const extra = [...wx.filter((w) => !wy.includes(w)), ...wy.filter((w) => !wx.includes(w))];
  const versioned = extra.some((w) => /\d/.test(w)) || VERSIONED_TYPES.includes(x.type);
  if (!versioned && Math.min(wx.length, wy.length) >= 2 && agree && (score ?? 1) >= AGREE_SIMILARITY) return { ...base, how: "names agree", ...withScore };
  const shared = wx.filter((w) => wy.includes(w)).length;
  const contained = shared === Math.min(wx.length, wy.length);
  if (score !== undefined ? score >= BORDERLINE_SIMILARITY || (contained && score >= CONTAINED_SIMILARITY) : contained) {
    return { ...base, how: "similar", ...withScore };
  }
  return undefined;
}

export interface DuplicatePairs { certain: Pair[]; borderline: Pair[] }

export function findDuplicatePairs(nodes: readonly DedupeNode[], opts: { business?: string } = {}): DuplicatePairs {
  const certain: Pair[] = [];
  const borderline: Pair[] = [];
  const byType = new Map<EntityType, DedupeNode[]>();
  for (const n of nodes) if (DEDUPE_TYPES.includes(n.type)) byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
  for (const list of byType.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : 1));
    const maybe: Pair[] = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = judgePair(list[i]!, list[j]!, opts.business);
        if (!p) continue;
        (p.how === "similar" ? maybe : certain).push(p);
      }
    }
    // each node keeps its best few candidates; a pair stays when either end keeps it
    const kept = new Set<string>();
    const per = new Map<string, Pair[]>();
    for (const p of maybe) for (const id of [p.a, p.b]) per.set(id, [...(per.get(id) ?? []), p]);
    for (const ps of per.values()) {
      ps.sort((x, y) => (y.score ?? 0) - (x.score ?? 0) || pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)));
      for (const p of ps.slice(0, PARTNERS_PER_NODE)) kept.add(pairKey(p.a, p.b));
    }
    borderline.push(...maybe.filter((p) => kept.has(pairKey(p.a, p.b))));
  }
  return { certain, borderline };
}

// A borderline pair worth reporting without a model's verdict.
export function plausible(p: Pair, byId: ReadonlyMap<string, Pick<DedupeNode, "name">>): boolean {
  if (p.how !== "similar") return true;
  if ((p.score ?? 0) >= REPORT_SIMILARITY) return true;
  const [a, b] = [nameWords(byId.get(p.a)?.name ?? ""), nameWords(byId.get(p.b)?.name ?? "")];
  return a.some((w) => b.includes(w));
}

// ---------- groups ----------

export interface DedupeGroup { type: EntityType; canonical: string; members: Array<{ id: string; basis: string }> }

// Union-find over the accepted pairs. A group holding a pair judged distinct, two registry entries, or more than
// MAX_DEDUPE_GROUP nodes is left alone (reported in `skipped`). The canonical node: the registry's; a channel the socials
// writer made (it has the platform, url and handle); the most connected; a name written out in full; the shorter id.
export function groupPairs(nodes: readonly DedupeNode[], accepted: readonly Pair[], distinct: ReadonlySet<string> = new Set()):
  { groups: DedupeGroup[]; skipped: Array<{ ids: string[]; why: string }> } {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while ((parent.get(r) ?? r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
  const basis = new Map<string, string>();
  for (const p of [...accepted].sort((x, y) => pairKey(x.a, x.b).localeCompare(pairKey(y.a, y.b)))) {
    if (!byId.has(p.a) || !byId.has(p.b)) continue;
    const [ra, rb] = [find(p.a), find(p.b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    const why = `${p.how}${p.score !== undefined ? ` (${p.score})` : ""}`;
    for (const id of [p.a, p.b]) if (!basis.has(id)) basis.set(id, why);
  }
  const sets = new Map<string, DedupeNode[]>();
  for (const id of parent.keys()) { const r = find(id); sets.set(r, [...(sets.get(r) ?? []), byId.get(id)!]); }
  const groups: DedupeGroup[] = [];
  const skipped: Array<{ ids: string[]; why: string }> = [];
  for (const set of [...sets.values()].sort((a, b) => (a[0]!.id < b[0]!.id ? -1 : 1))) {
    const uniq = [...new Map(set.map((n) => [n.id, n])).values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    if (uniq.length < 2) continue;
    const ids = uniq.map((n) => n.id);
    if (uniq.length > MAX_DEDUPE_GROUP) { skipped.push({ ids, why: `more than ${MAX_DEDUPE_GROUP} nodes in one group` }); continue; }
    if (uniq.filter((n) => n.registry).length > 1) { skipped.push({ ids, why: "two registry entries" }); continue; }
    if (ids.some((a, i) => ids.slice(i + 1).some((b) => distinct.has(pairKey(a, b))))) { skipped.push({ ids, why: "holds a pair judged different" }); continue; }
    const words = (n: DedupeNode) => nameWords(n.name).length;
    const canonical = [...uniq].sort((a, b) => Number(!!b.registry) - Number(!!a.registry) || Number(!!b.platform) - Number(!!a.platform) ||
      b.degree - a.degree || words(b) - words(a) || a.id.length - b.id.length || (a.id < b.id ? -1 : 1))[0]!;
    groups.push({
      type: canonical.type, canonical: canonical.id,
      members: uniq.filter((n) => n.id !== canonical.id).map((n) => ({ id: n.id, basis: basis.get(n.id) ?? "same thing" })),
    });
  }
  return { groups, skipped };
}
