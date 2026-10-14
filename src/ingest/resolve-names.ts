// Name handling for entity resolution: normalisation, when two names may be merged, the founder's aliases, Allevia's
// reserved ids, and the index of entities the graph already knows.
import type { EntityType } from "../graph/schema.js";

export const FOUNDER_ID = "person:founder";
// Allevia's own staff (shared/roster.ts) lives under these ids. Only the id prefix is reserved: a business's own
// "Marketing" team or an agent called "Meera" is not Allevia's.
export const RESERVED_ID = /^(agent|team):allevia(-|$)/;
export const isReservedId = (id: string) => RESERVED_ID.test(id);

export interface KnownEntity { id: string; type: EntityType; name: string; aliases?: string[] }

// Case, punctuation and a leading "the" do not distinguish names.
export function normName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim().replace(/^the /, "");
}

// Unnamed references to the founder or owner (after normName). A named person is the founder only through the
// tenant's founderNames.
const FOUNDER_WORDS = new Set([
  "founder", "our founder", "founder ceo", "founder and ceo", "ceo and founder", "owner", "our owner", "business owner",
]);
export const isFounderWord = (name: string) => FOUNDER_WORDS.has(normName(name));

const tokens = (s: string) => [...new Set(normName(s).split(" ").filter(Boolean))];
// "google analytics 4" → "ga4"
const initials = (ts: string[]) => ts.map((t) => (/^\p{N}+$/u.test(t) ? t : [...t][0])).join("");

function pairAgrees(x: string, y: string): boolean {
  const [a, b] = [tokens(x), tokens(y)];
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const inLong = short.every((t) => long.includes(t));
  if (inLong && short.length === long.length) return true;                          // same words, any order
  if (short.length === 1 && long.length >= 2 && short[0] === initials(long)) return true; // "GSC"
  return inLong && short.length >= 2 && long.length - short.length <= 1;           // "Search Console" ⊂ "Google Search Console"
}

// May these two sets of names be merged as one thing? Same words; an acronym; or a name of at least two words that the
// other extends by one word at most. Everything else ("Instagram"/"Instagram Ads", "Job seekers"/"Job seekers in
// Raipur", "Google"/"Google Search Console", "Meta"/"Metabase") is a different thing, or too unsure to merge.
export function namesAgree(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => pairAgrees(x, y)));
}

export function metricSlug(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60).replace(/_+$/, "");
}

// "YYYY-MM-DD" for a valid ISO date or datetime, else undefined.
export function isoDay(s: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s?.trim() ?? "");
  if (!m) return undefined;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === day ? day : undefined;
}

export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

// What the graph already knows, by id and by (type, normalised name or alias). Reserved ids are left out, so no name
// ever resolves to one of Allevia's own agents or teams.
export class KnownIndex {
  private readonly byIdMap = new Map<string, KnownEntity>();
  private readonly byNameMap = new Map<string, string>();
  constructor(existing: Iterable<KnownEntity>) {
    for (const k of existing) {
      if (isReservedId(k.id)) continue;
      this.byIdMap.set(k.id, k);
      for (const n of [k.name, ...(k.aliases ?? [])]) {
        const key = `${k.type}|${normName(n)}`;
        if (!this.byNameMap.has(key)) this.byNameMap.set(key, k.id);
      }
    }
  }
  byId(id: string): KnownEntity | undefined {
    return this.byIdMap.get(id);
  }
  byName(type: EntityType, name: string): KnownEntity | undefined {
    const id = this.byNameMap.get(`${type}|${normName(name)}`);
    return id ? this.byIdMap.get(id) : undefined;
  }
}
