// The Brain map's logic, kept apart from the drawing so it can be tested: decode the light map the server sends
// (GET /api/:t/graph/map), choose what to draw (filters, crowded kinds trimmed, a cap for phones), the order the brain
// was learned in ("Watch it grow"), what the team is reading right now, and the words around the map. Owner words only:
// things, links, how we know (docs/owner-words.md).
import type { AgentEvent, AgentId, EdgeRef, NodeRef } from "../../../shared/contracts.js";
import { MAP_KINDS, kindOf, labelOfId } from "./labels.js";

/** One thing on the map: importance 0–1 (PageRank over its top value), a topic, and when the team learned it (ms). */
export interface MapNode extends NodeRef { rank: number; community?: number; learnedAt?: number }

/** What GET /api/:t/graph/map returns (src/server/types.ts BrainMapDto). */
export interface BrainMapDto {
  nodes: MapNode[];
  types: string[];
  links: Array<[number, number, number]>;
  counts: Record<string, number>;
  totals: { things: number; links: number };
  capped: boolean;
}

export interface BrainMap { nodes: MapNode[]; edges: EdgeRef[]; counts: Record<string, number>; totals: { things: number; links: number }; capped: boolean }

/** The index triples back into links; a triple that points outside the lists is dropped. */
export function decodeMap(dto: BrainMapDto): BrainMap {
  const edges: EdgeRef[] = [];
  for (const [a, b, t] of dto.links) {
    const from = dto.nodes[a], to = dto.nodes[b], type = dto.types[t];
    if (from && to && type) edges.push({ from: from.id, type, to: to.id });
  }
  return { nodes: dto.nodes, edges, counts: dto.counts, totals: dto.totals, capped: dto.capped };
}

/** The business itself, drawn in ink at the centre: the most important Business on the map. */
export function centreOf(nodes: MapNode[]): string | undefined {
  let best: MapNode | undefined;
  for (const n of nodes) if (n.label === "Business" && (!best || n.rank > best.rank)) best = n;
  return best?.id;
}

/** How many things of each kind the whole brain holds (the chips' numbers), biggest first, empty kinds left out. */
export function kindTotals(counts: Record<string, number>): Array<{ id: string; name: string; hue: number; count: number }> {
  return MAP_KINDS
    .map((k) => ({ id: k.id, name: k.name, hue: k.hue, count: k.labels.reduce((s, l) => s + (k.id === "documents" && (l === "Chunk" || l === "Version") ? 0 : counts[l] ?? 0), 0) }))
    .filter((k) => k.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Kinds that start hidden: numbers come in the thousands and are summed up by their measures. */
export const HIDDEN_AT_FIRST: ReadonlySet<string> = new Set(["numbers"]);

export interface Pick { nodes: MapNode[]; edges: EdgeRef[]; trimmed: number }

/**
 * What to draw: the most important things first, without the hidden kinds, at most `cap` of them, and no kind taking
 * more than `share` of the map (a site with 180 website checks would otherwise be all checks). `keep` (the thing that is
 * open, what the team is reading) is always drawn.
 */
export function pickForMap(nodes: MapNode[], edges: EdgeRef[], o: { cap: number; hidden?: ReadonlySet<string>; keep?: ReadonlySet<string>; share?: number }): Pick {
  const perKind = Math.max(24, Math.floor(o.cap * (o.share ?? 0.25)));
  const used = new Map<string, number>();
  const out: MapNode[] = [];
  const taken = new Set<string>();
  let trimmed = 0;
  const sorted = [...nodes].sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  for (const n of sorted) {
    if (!o.keep?.has(n.id)) continue;
    out.push(n); taken.add(n.id);
  }
  for (const n of sorted) {
    if (taken.has(n.id)) continue;
    const k = kindOf(n.label).id;
    if (o.hidden?.has(k)) continue;
    if (out.length >= o.cap) { trimmed++; continue; }
    if ((used.get(k) ?? 0) >= perKind && n.label !== "Business") { trimmed++; continue; }
    used.set(k, (used.get(k) ?? 0) + 1);
    out.push(n); taken.add(n.id);
  }
  return { nodes: out, edges: edges.filter((e) => taken.has(e.from) && taken.has(e.to)), trimmed };
}

/** The order the team learned things in: by when it was recorded, else by its own date, the important ones first on a tie. */
export function growOrder(nodes: MapNode[]): MapNode[] {
  const when = (n: MapNode) => n.learnedAt ?? (n.asOf ? Date.parse(n.asOf) : NaN);
  return [...nodes].sort((a, b) => {
    const x = when(a), y = when(b);
    if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
    if (Number.isFinite(x) !== Number.isFinite(y)) return Number.isFinite(x) ? -1 : 1;
    return b.rank - a.rank || a.id.localeCompare(b.id);
  });
}

/** How many things are on the map after each frame of "Watch it grow": a slow start, then faster, ending on all of them. */
export function growFrames(total: number, reducedMotion = false): number[] {
  if (total <= 0) return [];
  const frames = reducedMotion ? 5 : Math.min(70, Math.max(12, Math.ceil(total / 5)));
  const out: number[] = [];
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const n = Math.max(1, Math.round(total * t * t));
    if (n !== out.at(-1)) out.push(n);
  }
  if (out.at(-1) !== total) out.push(total);
  return out;
}

/** The rank at or above which a thing is labelled at the first zoom: the top `n` things, at least 0.05. */
export function labelFloor(nodes: Array<{ rank: number }>, n: number): number {
  const ranks = nodes.map((x) => x.rank).sort((a, b) => b - a);
  return Math.max(0.05, ranks[Math.min(n, ranks.length) - 1] ?? 1);
}

/** Size by importance: small things stay visible, the few big ones stand out (square root, so 0.25 is half way). */
export const rankRadius = (rank: number, min: number, max: number) => min + (max - min) * Math.sqrt(Math.max(0, Math.min(1, rank)));

// ---------------------------------------------------------------- the line above the map

const n0 = (n: number, locale?: string) => new Intl.NumberFormat(locale ?? "en-GB", { maximumFractionDigits: 0 }).format(n);
const plural = (n: number, one: string, many: string, locale?: string) => `${n0(n, locale)} ${n === 1 ? one : many}`;

/** "3,529 things · 10,899 links · learned from 12 sources" (each part only when known). */
export function mapHeadline(o: { things?: number; links?: number; sources?: number }, locale?: string): string[] {
  const parts: string[] = [];
  if (o.things !== undefined) parts.push(plural(o.things, "thing", "things", locale));
  if (o.links !== undefined) parts.push(plural(o.links, "link", "links", locale));
  if (o.sources) parts.push(`learned from ${plural(o.sources, "source", "sources", locale)}`);
  return parts;
}

/** Home's line under the living brain: "3,529 things your team knows". */
export const knowsLine = (things: number, locale?: string) => `${plural(things, "thing", "things", locale)} your team knows`;

// ---------------------------------------------------------------- reading right now

export interface Reading { ids: string[]; nodes: NodeRef[]; edges: EdgeRef[]; who: AgentId[] }
export const NOT_READING: Reading = { ids: [], nodes: [], edges: [], who: [] };

/**
 * What the team is reading right now, from a run's events: the things each person's latest look-up returned, for the
 * last few people who looked something up. A run that has its answer is not reading anything.
 */
export function readingNow(events: AgentEvent[], o: { people?: number; max?: number } = {}): Reading {
  if (events.some((e) => e.type === "final" || e.type === "error")) return NOT_READING;
  const people = o.people ?? 3, max = o.max ?? 16;
  const who: AgentId[] = [];
  const ids = new Set<string>();
  const nodes: NodeRef[] = [];
  const edges: EdgeRef[] = [];
  for (let i = events.length - 1; i >= 0 && who.length < people; i--) {
    const e = events[i]!;
    if (e.type !== "tool_result" || who.includes(e.agent) || !e.nodes.length) continue;
    who.push(e.agent);
    for (const n of e.nodes) {
      if (ids.size >= max) break;
      if (!ids.has(n.id)) { ids.add(n.id); nodes.push(n); }
    }
    for (const x of e.edges) if (ids.has(x.from) && ids.has(x.to)) edges.push(x);
  }
  return ids.size ? { ids: [...ids], nodes, edges, who } : NOT_READING;
}

/** "Memory Keeper", "Memory Keeper and Data Detective", "Memory Keeper, Data Detective and The Chief". */
export function namesWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Memory Keeper is reading 5 things", "Memory Keeper and Data Detective are reading 1 thing". */
export function readingWords(names: string[], count: number): string {
  if (!names.length || !count) return "";
  return `${namesWords(names)} ${names.length === 1 ? "is" : "are"} reading ${count} ${count === 1 ? "thing" : "things"}`;
}

/** Several runs at once (two questions in two tabs): everything any of them is reading. */
export function mergeReading(list: Reading[]): Reading {
  const live = list.filter((r) => r.ids.length);
  if (live.length <= 1) return live[0] ?? NOT_READING;
  const ids = new Set<string>(), nodes: NodeRef[] = [], edges: EdgeRef[] = [], who: AgentId[] = [];
  for (const r of live) {
    for (const n of r.nodes) if (!ids.has(n.id)) { ids.add(n.id); nodes.push(n); }
    edges.push(...r.edges);
    for (const a of r.who) if (!who.includes(a)) who.push(a);
  }
  return { ids: [...ids], nodes, edges, who };
}

// ---------------------------------------------------------------- the side panel

/** Bookkeeping a thing carries that is not a fact about the business. */
const NOT_FACTS = new Set([
  "id", "name", "summary", "text", "body", "createdAt", "updatedAt", "stateSince", "recordedAt", "src", "embedKey", "embedding",
  "textEmbedding", "aliases", "community", "rank", "slug", "templateKey", "asOf", "simulated", "rev", "path", "kind", "vertical",
  "privacyRegime", "weekStart", "countryCode", "since", "until", "retiredAt", "backdated", "of", "changed", "hash", "sha", "url",
]);

/** The facts worth a line: short plain values, at most `max`, in the order the record keeps them. */
export function factsOf(props: Record<string, unknown>, max = 4): Array<[string, string | number | boolean]> {
  const out: Array<[string, string | number | boolean]> = [];
  for (const [k, v] of Object.entries(props)) {
    if (out.length >= max) break;
    if (NOT_FACTS.has(k) || k.startsWith("_")) continue;
    if (typeof v === "number" && Number.isFinite(v)) out.push([k, v]);
    else if (typeof v === "boolean") out.push([k, v]);
    else if (typeof v === "string" && v.trim() && v.length <= 80 && !/^[a-z]+:[\w-]/.test(v)) out.push([k, v.trim()]);
  }
  return out;
}

/** What a thing is, in one line: the first sentence of its summary, cut at a word if it runs long. */
export function oneLine(summary: string | undefined, max = 150): string | undefined {
  const s = summary?.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  const first = /^(.+?[.!?])(\s|$)/.exec(s)?.[1] ?? s;
  if (first.length <= max) return first;
  const cut = first.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max * 0.6)).trimEnd()}…`;
}

/** One thing that stops, with the steps back to the thing that stopped (GET /api/:t/graph/at-work, `focus.deep.items`). */
export interface ImpactStep { id: string; name: string; rel: string; dir: "in" | "out" }
export interface ImpactThing { id: string; name: string; type: string; hop: number; path: ImpactStep[] }

/**
 * "What breaks if this stops", drawn: the thing, everything that stops, and the real links between them, so the map can
 * light the chain. A step that points "out" is the one that needs the step before it (A -DEPENDS_ON-> B).
 */
export function impactLinks(focus: { id: string; name: string; type: string }, items: ImpactThing[]): { ids: string[]; nodes: NodeRef[]; edges: EdgeRef[] } {
  const nodes = new Map<string, NodeRef>([[focus.id, { id: focus.id, label: focus.type, name: focus.name }]]);
  const edges = new Map<string, EdgeRef>();
  for (const item of items) {
    let prev = focus.id;
    for (const p of item.path) {
      if (!nodes.has(p.id)) nodes.set(p.id, { id: p.id, label: p.id === item.id ? item.type : labelOfId(p.id), name: p.name });
      const e: EdgeRef = p.dir === "out" ? { from: p.id, type: p.rel, to: prev } : { from: prev, type: p.rel, to: p.id };
      if (e.type) edges.set(`${e.from}|${e.type}|${e.to}`, e);
      prev = p.id;
    }
  }
  return { ids: [...nodes.keys()], nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** "If Instagram stops, 3 things stop straight away, 9 in all." and its two quieter cases. */
export function impactLine(name: string, status: string, now: number, all: number): string {
  if (status === "not_mapped") return `Nothing is recorded as depending on ${name} yet.`;
  if (status === "nothing_depends" || all === 0) return `Nothing depends on ${name}.`;
  const head = `If ${name} stops, ${now} ${now === 1 ? "thing stops" : "things stop"} straight away`;
  return all > now ? `${head}, ${all} in all.` : `${head}.`;
}

/** The question "Ask about this" fills in. */
export const askAbout = (name: string) => `What should I know about ${name}?`;
