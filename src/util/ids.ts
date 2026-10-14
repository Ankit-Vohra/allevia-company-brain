// Deterministic ids. Every node id is `<type>:<key>` so re-ingestion MERGEs onto the same node. Keys are slugified
// (unicode-safe: Hindi stays Hindi), except Page ids, which keep the URL's dots and slashes so they stay readable.
import { createHash } from "node:crypto";
import { ENTITY_TYPES, type EntityType } from "../graph/schema.js";

const MAX_SLUG = 80;
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });

export function slugify(s: string): string {
  const base = s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/g, "");
  if ([...base].length <= MAX_SLUG) return base;
  // Cut on grapheme boundaries so a Devanagari vowel sign never dangles off a cut consonant.
  let out = "";
  for (const { segment } of graphemes.segment(base)) {
    if ([...out].length + [...segment].length > MAX_SLUG) break;
    out += segment;
  }
  return out.replace(/-+$/, "");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// "BrandRule" -> "brand-rule"
export function idPrefix(type: EntityType): string {
  return type.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

const TYPE_BY_PREFIX = new Map<string, EntityType>(ENTITY_TYPES.map((t) => [idPrefix(t), t]));

export function typeFromId(id: string): EntityType | undefined {
  const i = id.indexOf(":");
  return i > 0 ? TYPE_BY_PREFIX.get(id.slice(0, i)) : undefined;
}

// "https://WWW.Aamdani.ai/jobs/#top" -> "www.aamdani.ai/jobs": no scheme or fragment, lowercase host, no trailing slash.
export function pageKey(url: string): string {
  const k = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/#.*$/, "");
  const slash = k.indexOf("/");
  const host = (slash === -1 ? k : k.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? "" : k.slice(slash).replace(/\/+$/, "");
  return (host + path).replace(/\s+/g, "-");
}

export function entityId(type: EntityType, key: string): string {
  const k = type === "Page" ? pageKey(key) : slugify(key);
  return `${idPrefix(type)}:${k || sha256(key).slice(0, 12)}`;
}
