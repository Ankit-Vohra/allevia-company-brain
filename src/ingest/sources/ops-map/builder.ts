// The write builder the per-area ops mappers share: nodes merged on id, edges checked against the ontology,
// observations deduplicated on their deterministic id, plus the window and channel helpers.
//
// Metric naming: snake_case; a window lives in windowStart/windowEnd, never in the name (`account_reach` over 28 days,
// not `account_reach_28d`); a percentage ends in `_pct` and is 0-100. observationId is metric:subject:windowEnd, so
// one snapshot carries one window per metric and subject.
import { isAllowed, type EntityType, type RelType } from "../../../graph/schema.js";
import { businessId } from "../../../graph/tenants.js";
import { observationId, type EdgeInput, type NodeInput, type ObservationInput, type Prim } from "../../../graph/upsert.js";
import { entityId, pageKey, typeFromId } from "../../../util/ids.js";
import type { SourceResult } from "../../types.js";
import { redact } from "../../privacy.js";

export interface OpsMapContext {
  tenantSlug: string;
  asOf: string; // the snapshot's date, YYYY-MM-DD (IST)
}

// ---------- small helpers ----------

export type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
export const arr = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);
export const obj = (v: unknown): Json => (isObj(v) ? v : {});
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
export const numOf = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*-?\d+(\.\d+)?\+?\s*$/.test(v) ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
export const snake = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
/** A 0-1 share as a 0-100 percentage. */
export const share100 = (v: unknown): number | undefined => {
  const n = numOf(v);
  return n === undefined ? undefined : Math.round(n * 1000) / 10;
};

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- windows ----------

export interface Win { windowStart?: string; windowEnd?: string }

/** The app tools' IST range: data.range {from, to}. */
export const appWindow = (d: Json): Win => {
  const r = obj(d.range);
  return { windowStart: str(r.from), windowEnd: str(r.to) };
};
/** Search Console and GA4: data.window {from, to}. */
export const googleWindow = (d: Json): Win => {
  const w = obj(d.window);
  return { windowStart: str(w.from), windowEnd: str(w.to) };
};
/** `days` days ending on `end` (both counted). */
export const lastDays = (end: string, days: number): Win => ({ windowStart: addDays(end, -(days - 1)), windowEnd: end });

// ---------- channels ----------

export const CHANNELS = {
  "instagram": { name: "Instagram", platform: "instagram" },
  "facebook": { name: "Facebook", platform: "facebook" },
  "youtube": { name: "YouTube", platform: "youtube" },
  "website": { name: "Website (www.aamdani.ai)", platform: "web" },
  "web-app": { name: "Web app (app.aamdani.ai)", platform: "web" },
  "app": { name: "Aamdani app", platform: "app" },
  "app-android": { name: "Android app", platform: "android" },
  "app-ios": { name: "iOS app", platform: "ios" },
  "google-search": { name: "Google Search", platform: "google" },
  "ai-search": { name: "AI search (ChatGPT, Perplexity, Gemini…)", platform: "ai-search" },
  "play-store": { name: "Google Play Store", platform: "android" },
  "paid-ads": { name: "Paid ads", platform: "ads" },
  "poster": { name: "Job poster QR", platform: "offline" },
  "app-shares": { name: "Shares from the app", platform: "app" },
  "voice-onboarding": { name: "Voice onboarding", platform: "voice" },
  "helpline": { name: "Helpline", platform: "voice" },
} as const;
export type ChannelKey = keyof typeof CHANNELS;
export const isChannelKey = (k: string): k is ChannelKey => k in CHANNELS;

/** Which channel lives on a URL's host; anything else is not ours. */
export function siteChannel(url: string): ChannelKey | null {
  const host = pageKey(url).split("/")[0] ?? "";
  if (host === "www.aamdani.ai" || host === "aamdani.ai") return "website";
  if (host === "app.aamdani.ai") return "web-app";
  return null;
}

// ---------- the builder ----------

export class Builder {
  nodes = new Map<string, NodeInput>();
  edges = new Map<string, EdgeInput>();
  observations = new Map<string, ObservationInput>();
  redactions: Record<string, number> = {};
  readonly skipped: Array<{ ref: string; reason: string }> = [];
  readonly business: string;
  src = "";

  constructor(readonly ctx: OpsMapContext) {
    this.business = businessId(ctx.tenantSlug);
  }

  /** State before one file is mapped, so a mapper that throws half-way leaves nothing behind. */
  checkpoint() {
    return structuredClone({ nodes: this.nodes, edges: this.edges, observations: this.observations, redactions: this.redactions });
  }
  restore(cp: ReturnType<Builder["checkpoint"]>): void {
    ({ nodes: this.nodes, edges: this.edges, observations: this.observations, redactions: this.redactions } = cp);
  }

  count(kind: string, n = 1): void {
    if (n) this.redactions[kind] = (this.redactions[kind] ?? 0) + n;
  }

  /** Free text (a caption, a query): first line only, redacted, then bounded. */
  text(s: unknown, max = 160): string | undefined {
    const first = str(s)?.split(/\r?\n/)[0]?.trim();
    if (!first) return undefined;
    const { text, counts } = redact(first); // redact before cutting, so a cut never leaves half an address behind
    for (const [k, n] of Object.entries(counts)) this.count(k, n);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // Merge on id. By default the first value of each prop wins (a later sparse mention never blanks a rich one);
  // `authoritative` lets the platform's own tool (reels_performance for an Instagram reel) override what another
  // tool said about the same node (published_content's copy of the caption), whatever order the files load in.
  node(type: EntityType, id: string, name: string, props: Record<string, Prim | undefined> = {}, authoritative = false): string {
    const clean = Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== null)) as Record<string, Prim>;
    const prev = this.nodes.get(id);
    if (prev) {
      if (authoritative) {
        prev.props = { ...prev.props, ...clean };
        prev.name = name;
        prev.src = this.src;
      } else {
        prev.props = { ...clean, ...prev.props };
      }
      return id;
    }
    this.nodes.set(id, { type, id, name, props: clean, src: this.src, asOf: this.ctx.asOf });
    return id;
  }

  channel(key: ChannelKey, props: Record<string, Prim | undefined> = {}): string {
    const id = this.node("Channel", entityId("Channel", key), CHANNELS[key].name, { platform: CHANNELS[key].platform, ...props });
    this.edge(id, "PART_OF", this.business);
    return id;
  }

  audience(key: "seekers" | "employers"): string {
    return this.node("Audience", entityId("Audience", key), key === "seekers" ? "Seekers" : "Employers");
  }

  page(url: string): string {
    const key = pageKey(url);
    const slash = key.indexOf("/");
    const id = this.node("Page", entityId("Page", url), key, {
      url: /^https?:\/\//i.test(url) ? url : `https://${key}`, host: slash === -1 ? key : key.slice(0, slash),
      path: slash === -1 ? "/" : key.slice(slash),
    });
    const site = siteChannel(url);
    if (site) this.edge(id, "PART_OF", this.channel(site));
    return id;
  }

  edge(from: string, type: RelType, to: string): void {
    const f = typeFromId(from), t = typeFromId(to);
    if (!f || !t || !isAllowed(f, type, t)) throw new Error(`ops mapper bug: ${from} -[${type}]-> ${to} is not an allowed pattern`);
    const k = `${from}|${type}|${to}`;
    if (!this.edges.has(k)) this.edges.set(k, { from, type, to, src: this.src, asOf: this.ctx.asOf });
  }

  obs(subject: string, metric: string, value: unknown, o: Win & { unit?: string; asOf?: string } = {}): void {
    const v = numOf(value);
    if (v === undefined) return;
    if (metric.endsWith("_pct") && (v < 0 || v > 100)) throw new Error(`ops mapper bug: ${metric} = ${v} is not a 0-100 percentage`);
    const input: ObservationInput = {
      subject, metric, value: v, asOf: isDate(o.asOf) ? o.asOf : this.ctx.asOf, src: this.src,
      ...(metric.endsWith("_pct") ? { unit: "%" } : o.unit ? { unit: o.unit } : {}),
      ...(isDate(o.windowStart) ? { windowStart: o.windowStart } : {}),
      ...(isDate(o.windowEnd) ? { windowEnd: o.windowEnd } : {}),
    };
    const id = observationId(input);
    if (!this.observations.has(id)) this.observations.set(id, input);
  }

  result(): SourceResult {
    return {
      source: "ops",
      docs: [],
      write: { nodes: [...this.nodes.values()], edges: [...this.edges.values()], observations: [...this.observations.values()] },
      skipped: this.skipped,
      redactions: this.redactions,
    };
  }
}

// ---------- mapper contract ----------

// `data` has personal-looking fields stripped; `raw` is the envelope's data as recorded, read only for a field that is
// known to be the business's own (its Instagram username). `args` are the call's arguments from the manifest.
export interface Call { tool: string; variant?: string; file: string; data: Json; raw: Json; args: Json }
export type Mapper = (b: Builder, c: Call) => void;
