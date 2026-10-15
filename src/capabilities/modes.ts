// The capability ladder's pure half (product design §2.3): the capability keys, the access modes best first, which
// graph ids are evidence of which capability, and how an answer discloses a mode. No graph access here, so the answer
// checks (src/agent/checks.ts) and the prompts can use it; src/capabilities/ladder.ts derives the modes from the graph.
//
// Modes, best first: api (live connector data under 7 days old) -> delegated (the same, through access the owner
// delegated to Allevia) -> upload (numbers the owner gave us: a CSV, a screenshot, a document) -> public (the website
// crawl or a public profile) -> benchmark (playbook norms, and simulated stand-ins built from them) -> none.
import type { AccessMode, CapabilityKey } from "../../shared/contracts.js";
import { entityId } from "../util/ids.js";

export type { AccessMode, CapabilityKey, CapabilityStatus } from "../../shared/contracts.js";

export const CAPABILITY_KEYS: readonly CapabilityKey[] = ["ga4", "search_console", "gbp", "instagram_insights", "reviews", "studio", "ads"];
export const ACCESS_MODES: readonly AccessMode[] = ["api", "delegated", "upload", "public", "benchmark", "none"];

export const capabilityId = (key: CapabilityKey): string => entityId("Capability", key); // capability:search-console
export const isCapabilityKey = (s: string): s is CapabilityKey => (CAPABILITY_KEYS as readonly string[]).includes(s);

// What one capability reads: the connector Systems that feed it, the Channels it is about, and which Observations are
// its data (by metric and subject).
export interface CapabilitySpec {
  key: CapabilityKey;
  name: string;
  systems: string[];   // System ids (system:<connector>) whose connector feeds it
  channels: string[];  // Channel ids it is about (DEPENDS_ON targets when present)
  observes: (metric: string, subject: string) => boolean;
}

const IG_METRICS = new Set([
  "followers", "following", "media_count", "new_followers", "account_reach", "account_views", "non_follower_share_pct",
  "profile_visits", "link_taps", "website_clicks", "accounts_engaged", "interactions",
]);
const GBP_CHANNELS = ["channel:google-business", "channel:google-business-profile", "channel:gbp", "channel:google-maps"];
const AD_CHANNELS = ["channel:meta-ads", "channel:google-ads", "channel:paid-ads"];

export const CAPABILITIES: readonly CapabilitySpec[] = [
  {
    key: "ga4", name: "Website analytics (GA4)",
    systems: ["system:ga4", "system:analytics-ga4", "system:google-analytics"], channels: [],
    observes: (m) => m.startsWith("ga4_"),
  },
  {
    key: "search_console", name: "Google Search Console",
    systems: ["system:search-console", "system:google-search-console", "system:gsc"], channels: ["channel:google-search"],
    observes: (m) => m.startsWith("gsc_"),
  },
  {
    key: "gbp", name: "Google Business Profile",
    systems: ["system:gbp", "system:google-business-profile", "system:google-my-business"], channels: GBP_CHANNELS,
    observes: (m) => m.startsWith("gbp_") && !/review|rating/.test(m),
  },
  {
    key: "instagram_insights", name: "Instagram insights",
    systems: ["system:instagram", "system:instagram-insights"], channels: ["channel:instagram"],
    observes: (m, s) => (IG_METRICS.has(m) && s === "channel:instagram") || m.startsWith("reel_") || m === "reels_total",
  },
  {
    key: "reviews", name: "Reviews",
    systems: ["system:gbp", "system:google-business-profile", "system:reviews", "system:trustpilot"],
    channels: [...GBP_CHANNELS, "channel:houzz", "channel:trustpilot", "channel:google-reviews"],
    // customer reviews and ratings; review_cards_* and review_queue_* are the content approval queue, not reviews
    observes: (m) => /^(?:gbp_)?(?:reviews?|ratings?|avg_rating|star_rating)(?:_|$)/.test(m) && !/^review_(?:cards|queue)(?:_|$)/.test(m),
  },
  {
    key: "studio", name: "Studio (photo and video)",
    systems: ["system:higgsfield", "system:studio"], channels: [],
    observes: () => false,
  },
  {
    key: "ads", name: "Ads",
    systems: ["system:meta-ads", "system:google-ads", "system:facebook-ads"], channels: AD_CHANNELS,
    observes: (_m, s) => s.startsWith("campaign:") || AD_CHANNELS.includes(s),
  },
];

export const capabilitySpec = (key: CapabilityKey): CapabilitySpec => CAPABILITIES.find((c) => c.key === key)!;

// obs:<metric>:<subject>:<date>, where the subject is itself an id with a colon (channel:instagram).
export function parseObservationId(id: string): { metric: string; subject: string } | undefined {
  if (!id.startsWith("obs:")) return undefined;
  const rest = id.slice(4);
  const a = rest.indexOf(":");
  const z = rest.lastIndexOf(":");
  if (a <= 0 || z <= a) return undefined;
  return { metric: rest.slice(0, a), subject: rest.slice(a + 1, z) };
}

// What kind of evidence a graph id is for a capability:
// - data: one of its numbers (an Observation, a Campaign);
// - profile: what it knows without a connector (an SEO check from the crawl, a playbook benchmark);
// - source: a Channel or System it reads. Citing one is not drawing on its data ("the connector breaks the Instagram
//   channel"), so it never fails the check; it only tells the Chief which sources a turn's data came near;
// - capability: the Capability node itself.
export type EvidenceKind = "data" | "profile" | "source" | "capability";

export function capabilitiesOf(id: string): Array<{ key: CapabilityKey; kind: EvidenceKind }> {
  const out: Array<{ key: CapabilityKey; kind: EvidenceKind }> = [];
  const o = parseObservationId(id);
  for (const c of CAPABILITIES) {
    if (id === capabilityId(c.key)) out.push({ key: c.key, kind: "capability" });
    else if (o && c.observes(o.metric, o.subject)) out.push({ key: c.key, kind: "data" });
    else if (c.channels.includes(id) || c.systems.includes(id)) out.push({ key: c.key, kind: "source" });
  }
  if (id.startsWith("campaign:")) out.push({ key: "ads", kind: "data" });
  else if (id.startsWith("rule:benchmark-")) out.push({ key: "ads", kind: "profile" });
  else if (id.startsWith("rule:seo-check-")) out.push({ key: "search_console", kind: "profile" });
  return out;
}

// ---------- disclosure ----------

// How an answer says where its data came from, per mode. "simulated" also discloses benchmark: the simulated stand-ins
// (simulated ads) are built from benchmark norms.
const DISCLOSURE: Record<Exclude<AccessMode, "api">, RegExp> = {
  delegated: /\bdelegat|\baccess you (?:gave|granted|shared)|\bservice account\b|\bpartner access\b/i,
  upload: /\bupload|\bscreenshot|\b(?:file|csv|spreadsheet|export|report) you (?:sent|shared|gave|uploaded)/i,
  public: /\bpublic(?:ly)?\b|\bcrawl|\b(?:visible|shown) on your (?:site|website|profile)|सार्वजनिक/i,
  benchmark: /\bbenchmark|\bindustry (?:norm|average|typical)|\btypical for\b|\bsimulated\b|\bsample (?:numbers|data|figures)\b|बेंचमार्क|सिम्युलेटेड|सिमुलेटेड/i,
  none: /\bnot (?:yet )?connected\b|\bno (?:data|access)\b|\bisn'?t connected\b|\bnot recorded\b/i,
};

// The phrase the Chief is asked to use for each mode.
export const MODE_PHRASE: Record<AccessMode, string> = {
  api: "live, connected",
  delegated: "through the access you delegated to us",
  upload: "from what you uploaded",
  public: "from your public profile or website",
  benchmark: "benchmark (industry norms, not your own numbers)",
  none: "not connected: no data",
};

export interface CapabilityModeInfo { key: CapabilityKey; name: string; accessMode: AccessMode }

// Which modes need saying for this kind of evidence. Data under a public/benchmark/none mode is stale connector data
// (the freshness check asks for "as of"); a profile under none is nothing to disclose. "prompt" is the wider net for
// telling the Chief: a source (Channel, System) counts there too.
const NOT_LIVE: ReadonlySet<AccessMode> = new Set(["delegated", "upload", "public", "benchmark"]);
const NEEDS: Record<"check" | "prompt", Record<EvidenceKind, ReadonlySet<AccessMode>>> = {
  check: {
    data: new Set(["delegated", "upload", "benchmark"]), profile: NOT_LIVE, source: new Set(),
    capability: new Set([...NOT_LIVE, "none"]),
  },
  prompt: {
    data: new Set(["delegated", "upload", "benchmark"]), profile: NOT_LIVE, source: NOT_LIVE,
    capability: new Set([...NOT_LIVE, "none"]),
  },
};

// The capabilities (with a mode other than api) the given ids draw on, each with the mode it needs disclosed.
export function modesUsed(ids: Iterable<string>, caps: readonly CapabilityModeInfo[], purpose: "check" | "prompt" = "check"): CapabilityModeInfo[] {
  const byKey = new Map(caps.map((c) => [c.key, c] as const));
  const out = new Map<CapabilityKey, CapabilityModeInfo>();
  for (const id of ids) {
    for (const { key, kind } of capabilitiesOf(id)) {
      const c = byKey.get(key);
      if (c && NEEDS[purpose][kind].has(c.accessMode)) out.set(key, c);
    }
  }
  return [...out.values()];
}

// The answer's check: every non-api capability it cites (its [[ids]]) has its mode said somewhere in the answer, outside
// the citations themselves ([[rule:benchmark-…]] does not say "benchmark").
export function modeCheck(answer: string, citedIds: readonly string[], caps: readonly CapabilityModeInfo[]): { ok: boolean; missing: CapabilityModeInfo[] } {
  const prose = answer.replace(/\[\[[^\]]*\]\]/g, " ");
  const missing = modesUsed(citedIds, caps).filter((c) => c.accessMode !== "api" && !DISCLOSURE[c.accessMode].test(prose));
  return { ok: missing.length === 0, missing };
}
