// The capability ladder in the web app (product design §2.3): how each access mode reads to an owner, and which
// capabilities an answer drew on. `capabilitiesOf` and `modesUsed` mirror src/capabilities/modes.ts (the backend's
// pure half, which the answer check uses), so the chip on an answer names the same sources the check looked at.
import type { AccessMode, CapabilityKey, CapabilityState, CapabilityStatus } from "@shared/contracts";

export const MODE_ORDER: readonly AccessMode[] = ["api", "delegated", "upload", "public", "benchmark", "none"];

/** The rung, in an owner's words: short for a chip, long for a sentence. */
export const MODE: Record<AccessMode, { chip: string; long: string; tone: "live" | "partial" | "proxy" | "none" }> = {
  api: { chip: "Live", long: "live, from your connected account", tone: "live" },
  delegated: { chip: "Delegated", long: "live, through access you delegated to us", tone: "live" },
  upload: { chip: "Your uploads", long: "from files you uploaded", tone: "partial" },
  public: { chip: "Public data", long: "from your public website or profile", tone: "proxy" },
  benchmark: { chip: "Benchmark", long: "industry benchmarks, not your own numbers", tone: "proxy" },
  none: { chip: "Not connected", long: "not connected yet", tone: "none" },
};

export const STATUS_NOTE: Record<CapabilityStatus, string | null> = {
  ok: null,
  stale: "data over 7 days old",
  down: "connection broken",
  not_connected: null,
};

/** Short names for chips: "Website analytics (GA4)" reads as "GA4". */
export const SHORT_NAME: Record<CapabilityKey, string> = {
  ga4: "GA4", search_console: "Search Console", gbp: "Business Profile", instagram_insights: "Instagram",
  reviews: "Reviews", studio: "Studio", ads: "Ads",
};

// ---------- which capabilities an answer drew on (mirrors src/capabilities/modes.ts) ----------

type EvidenceKind = "data" | "profile" | "source" | "capability";

const IG_METRICS = new Set([
  "followers", "following", "media_count", "new_followers", "account_reach", "account_views", "non_follower_share_pct",
  "profile_visits", "link_taps", "website_clicks", "accounts_engaged", "interactions",
]);
const GBP_CHANNELS = ["channel:google-business", "channel:google-business-profile", "channel:gbp", "channel:google-maps"];
const AD_CHANNELS = ["channel:meta-ads", "channel:google-ads", "channel:paid-ads"];

const SPECS: Array<{ key: CapabilityKey; systems: string[]; channels: string[]; observes: (m: string, s: string) => boolean }> = [
  { key: "ga4", systems: ["system:ga4", "system:analytics-ga4", "system:google-analytics"], channels: [], observes: (m) => m.startsWith("ga4_") },
  { key: "search_console", systems: ["system:search-console", "system:google-search-console", "system:gsc"], channels: ["channel:google-search"], observes: (m) => m.startsWith("gsc_") },
  { key: "gbp", systems: ["system:gbp", "system:google-business-profile", "system:google-my-business"], channels: GBP_CHANNELS, observes: (m) => m.startsWith("gbp_") && !/review|rating/.test(m) },
  {
    key: "instagram_insights", systems: ["system:instagram", "system:instagram-insights"], channels: ["channel:instagram"],
    observes: (m, s) => (IG_METRICS.has(m) && s === "channel:instagram") || m.startsWith("reel_") || m === "reels_total",
  },
  {
    key: "reviews", systems: ["system:gbp", "system:google-business-profile", "system:reviews", "system:trustpilot"],
    channels: [...GBP_CHANNELS, "channel:houzz", "channel:trustpilot", "channel:google-reviews"],
    observes: (m) => /^(?:gbp_)?(?:reviews?|ratings?|avg_rating|star_rating)(?:_|$)/.test(m) && !/^review_(?:cards|queue)(?:_|$)/.test(m),
  },
  { key: "studio", systems: ["system:higgsfield", "system:studio"], channels: [], observes: () => false },
  { key: "ads", systems: ["system:meta-ads", "system:google-ads", "system:facebook-ads"], channels: AD_CHANNELS, observes: (_m, s) => s.startsWith("campaign:") || AD_CHANNELS.includes(s) },
];

function parseObservationId(id: string): { metric: string; subject: string } | undefined {
  if (!id.startsWith("obs:")) return undefined;
  const rest = id.slice(4);
  const a = rest.indexOf(":");
  const z = rest.lastIndexOf(":");
  if (a <= 0 || z <= a) return undefined;
  return { metric: rest.slice(0, a), subject: rest.slice(a + 1, z) };
}

const capabilityIdOf = (key: CapabilityKey) => `capability:${key.replace(/_/g, "-")}`;

function capabilitiesOf(id: string): Array<{ key: CapabilityKey; kind: EvidenceKind }> {
  const out: Array<{ key: CapabilityKey; kind: EvidenceKind }> = [];
  const o = parseObservationId(id);
  for (const c of SPECS) {
    if (id === capabilityIdOf(c.key)) out.push({ key: c.key, kind: "capability" });
    else if (o && c.observes(o.metric, o.subject)) out.push({ key: c.key, kind: "data" });
    else if (c.channels.includes(id) || c.systems.includes(id)) out.push({ key: c.key, kind: "source" });
  }
  if (id.startsWith("campaign:")) out.push({ key: "ads", kind: "data" });
  else if (id.startsWith("rule:benchmark-")) out.push({ key: "ads", kind: "profile" });
  else if (id.startsWith("rule:seo-check-")) out.push({ key: "search_console", kind: "profile" });
  return out;
}

const NOT_LIVE: ReadonlySet<AccessMode> = new Set(["delegated", "upload", "public", "benchmark"]);
const NEEDS: Record<EvidenceKind, ReadonlySet<AccessMode>> = {
  data: new Set(["delegated", "upload", "benchmark"]), profile: NOT_LIVE, source: new Set(), capability: new Set([...NOT_LIVE, "none"]),
};

/** The capabilities, at a mode other than live, that these cited ids draw on: what the answer has to say aloud. */
export function modesUsed(ids: Iterable<string>, caps: readonly CapabilityState[]): CapabilityState[] {
  const byKey = new Map(caps.map((c) => [c.key, c] as const));
  const out = new Map<CapabilityKey, CapabilityState>();
  for (const id of ids) {
    for (const { key, kind } of capabilitiesOf(id)) {
      const c = byKey.get(key);
      if (c && c.accessMode !== "api" && NEEDS[kind].has(c.accessMode)) out.set(key, c);
    }
  }
  return [...out.values()].sort((a, b) => MODE_ORDER.indexOf(a.accessMode) - MODE_ORDER.indexOf(b.accessMode));
}
