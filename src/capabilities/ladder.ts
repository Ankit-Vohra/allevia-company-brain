// The capability fallback ladder (product design §2.3): one Capability node per key, at the best access mode the
// tenant's graph supports right now, best first:
//   api        live connector data (measured Observations, not simulated) under 7 days old, and no connector reporting
//              an error;
//   delegated  the same, read through access the owner delegated (a System or Channel with access: 'delegated');
//   upload     numbers the owner gave us: Observations from an upload/screenshot/CSV Document, or reported ones
//              (conf < 1, e.g. read off a screenshot);
//   public     what the website crawl or a public profile shows (an SEO check on a crawled Page, the Instagram channel
//              the site links to, a Google listing, the brand assets on the site);
//   benchmark  playbook benchmarks for its channels, or simulated stand-ins built from them;
//   none.
// status: ok (working at its mode), stale (connector data over 7 days old), down (a connector feeding it reports an
// error, so it dropped a rung), not_connected (no connector at all). lastOkAt: the newest live connector data, epoch ms.
// Each node is PART_OF the Business and DEPENDS_ON the Channels and Systems it reads (those present in the graph).
// syncCapabilities is idempotent: the same graph and `now` write nothing new; a mode or status change keeps the old
// state as a Version (both are TRACKED).
import type { AccessMode, CapabilityKey, CapabilityState, CapabilityStatus } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { businessId as tenantBusinessId } from "../graph/tenants.js";
import { writeBatch, type EdgeInput, type NodeInput } from "../graph/upsert.js";
import { isoDate } from "../util/time.js";
import { CAPABILITIES, capabilityId, type CapabilityModeInfo, type CapabilitySpec } from "./modes.js";

export const FRESH_DAYS = 7;
const DAY_MS = 86_400_000;

const OK_STATUS = new Set(["ok", "connected", "active", "healthy", "live", "configured"]);
const DOWN_STATUS = new Set(["error", "down", "failed", "failing", "expired", "revoked", "broken", "disconnected", "unauthorized", "invalid"]);
const UPLOAD_KINDS = new Set(["upload", "screenshot", "csv", "export"]);
const lc = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

// ---------- what the graph holds ----------

interface Source { id: string; status: string; delegated: boolean; at: number | null }
interface ObsGroup { metric: string; subject: string; simulated: boolean; reported: boolean; src: string | null; newest: string | null }

interface LadderFacts {
  businessId: string | null;
  sources: Map<string, Source>;            // Systems and Channels any capability reads, by id
  obs: ObsGroup[];
  uploadDocs: Set<string>;
  seoChecks: number;                       // SEO checks recorded on crawled pages
  crawledPages: number;
  brandAssets: number;
  originals: number;                       // Asset{kind:'original'}: the owner's own photos
  benchmarkChannels: Set<string>;          // channels a benchmark Rule applies to
}

const toMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

// The tenant's own Business node: the given id, else business:<slug> for an allevia_<slug> graph, else the Business the
// most things are PART_OF. null when there is none.
export async function findBusiness(g: GraphHandle, given?: string): Promise<string | null> {
  const own = given ?? (g.name.startsWith("allevia_") ? tenantBusinessId(g.name.slice("allevia_".length)) : undefined);
  if (own) {
    const rows = await g.roQuery<{ id: string }>("MATCH (b:Entity:Business {id:$id}) RETURN b.id AS id", { id: own });
    if (rows[0]) return rows[0].id;
    if (given) return null;
  }
  // The business the most things are PART_OF (its channels, teams): the root of this tenant's world.
  const rows = await g.roQuery<{ id: string }>(
    "MATCH (b:Business) OPTIONAL MATCH (x:Entity)-[r:PART_OF]->(b) WHERE r.until IS NULL RETURN b.id AS id, count(x) AS c ORDER BY c DESC, id LIMIT 1");
  return rows[0]?.id ?? null;
}

async function readFacts(g: GraphHandle, businessId?: string): Promise<LadderFacts> {
  const ids = [...new Set(CAPABILITIES.flatMap((c) => [...c.systems, ...c.channels]))];
  const n = async (cypher: string): Promise<number> => (await g.roQuery<{ c: number }>(cypher))[0]?.c ?? 0;
  const [biz, src, obs, seoChecks, crawledPages, brandAssets, originals, bench] = await Promise.all([
    findBusiness(g, businessId),
    g.roQuery<{ id: string; status: string | null; access: string | null; mode: string | null; asOf: string | null; at: number | null }>(
      `UNWIND $ids AS id MATCH (n:Entity {id:id}) WHERE n:System OR n:Channel
       RETURN n.id AS id, n.status AS status, n.access AS access, n.accessMode AS mode, n.asOf AS asOf, coalesce(n.checkedAt, n.updatedAt) AS at`, { ids }),
    g.roQuery<ObsGroup>(
      `MATCH (o:Observation)
       WITH o.metric AS metric,
            CASE WHEN o.subject STARTS WITH 'channel:' THEN o.subject ELSE split(coalesce(o.subject, ''), ':')[0] + ':' END AS subject,
            coalesce(o.simulated, false) AS simulated, coalesce(o.conf, 1.0) < 1.0 AS reported, o.src AS src, o.asOf AS asOf
       RETURN metric, subject, simulated, reported, src, max(asOf) AS newest`),
    // separate plain counts (FalkorDB has crashed on long OPTIONAL MATCH … WITH chains)
    n("MATCH (:Page)-[f:FAILS|PASSES]->(:Rule) WHERE f.until IS NULL RETURN count(f) AS c"),
    n("MATCH (:Page)-[r:PART_OF]->(:Entity:Channel {id:'channel:website'}) WHERE r.until IS NULL RETURN count(r) AS c"),
    n("MATCH (b:BrandAsset) RETURN count(b) AS c"),
    n("MATCH (a:Asset) WHERE a.kind = 'original' RETURN count(a) AS c"),
    g.roQuery<{ id: string }>(
      `MATCH (r:Rule)-[e:APPLIES_TO]->(c:Channel) WHERE e.until IS NULL AND (r.kind = 'benchmark' OR r.id STARTS WITH 'rule:benchmark-')
       RETURN DISTINCT c.id AS id`),
  ]);
  const srcIds = [...new Set(obs.map((o) => o.src).filter((s): s is string => !!s))];
  const docs = srcIds.length ? await g.roQuery<{ id: string; kind: string | null }>(
    "UNWIND $ids AS id MATCH (d:Entity:Document {id:id}) RETURN d.id AS id, d.kind AS kind", { ids: srcIds }) : [];
  return {
    businessId: biz,
    sources: new Map(src.map((s) => [s.id, {
      id: s.id, status: lc(s.status), delegated: lc(s.access) === "delegated" || lc(s.mode) === "delegated", at: toMs(s.asOf) ?? toMs(s.at),
    }])),
    obs: obs.filter((o) => typeof o.metric === "string"),
    uploadDocs: new Set(docs.filter((d) => UPLOAD_KINDS.has(lc(d.kind))).map((d) => d.id)),
    seoChecks, crawledPages, brandAssets, originals,
    benchmarkChannels: new Set(bench.map((b) => b.id)),
  };
}

// ---------- the ladder ----------

const CONNECT: Record<CapabilityKey, string> = {
  ga4: "Add Allevia's service account as a Viewer in Google Analytics to see real visits and where they come from.",
  search_console: "Add Allevia's service account as a user in Search Console to see the searches that bring people to your site.",
  gbp: "Add Allevia's ops account as a Manager on your Google Business Profile to read views, calls and direction requests.",
  instagram_insights: "Give Allevia partner access in your Meta business portfolio to read reach, saves and follower growth.",
  reviews: "Add Allevia's ops account as a Manager on your Google Business Profile so we can read new reviews and draft replies.",
  studio: "Upload 10 to 30 photos of your work so the Studio can make posts from them.",
  ads: "Share your Meta or Google Ads account with Allevia so we use your real spend and results instead of benchmarks.",
};

const PUBLIC_LEAD: Partial<Record<CapabilityKey, string>> = {
  search_console: "Based on a crawl of your public website.",
  instagram_insights: "Reading your public Instagram profile only.",
  gbp: "Reading your public Google listing only.",
  reviews: "Reading only the reviews anyone can see.",
  studio: "Working from the images on your website.",
};

export interface DerivedCapability extends CapabilityState { spec: CapabilitySpec }

function derive(spec: CapabilitySpec, f: LadderFacts, now: number): DerivedCapability {
  const present = [...spec.systems, ...spec.channels].map((id) => f.sources.get(id)).filter((s): s is Source => !!s);
  const systems = present.filter((s) => spec.systems.includes(s.id));
  const down = present.some((s) => DOWN_STATUS.has(s.status));
  const delegatedGrant = present.some((s) => s.delegated);
  const mine = f.obs.filter((o) => spec.observes(o.metric, o.subject));
  const fromUpload = (o: ObsGroup) => o.reported || (!!o.src && f.uploadDocs.has(o.src));
  const measured = mine.filter((o) => !o.simulated && !fromUpload(o));
  const newest = measured.map((o) => toMs(o.newest)).filter((t): t is number => t !== null).reduce<number | null>((a, b) => (a === null || b > a ? b : a), null);
  const uploads = mine.some((o) => !o.simulated && fromUpload(o));
  const simulated = mine.some((o) => o.simulated);
  const fresh = newest !== null && now - newest <= FRESH_DAYS * DAY_MS;

  let isPublic = false;
  switch (spec.key) {
    case "search_console": isPublic = f.seoChecks > 0 || f.crawledPages > 0; break;
    case "instagram_insights": case "gbp": case "reviews": isPublic = present.some((s) => spec.channels.includes(s.id)); break;
    case "studio": isPublic = f.brandAssets > 0; break;
    default: isPublic = false;
  }
  const benchmark = simulated || spec.channels.some((c) => f.benchmarkChannels.has(c));

  let accessMode: AccessMode;
  let lastOkAt = newest;
  if (spec.key === "studio") {
    // The Studio has no numbers: its engine is live when a studio System says ok; else it works from uploaded photos.
    const engine = systems.find((s) => OK_STATUS.has(s.status));
    lastOkAt = engine?.at ?? null;
    accessMode = engine && !down ? "api" : f.originals > 0 ? "upload" : isPublic ? "public" : "none";
  } else if (fresh && !down) accessMode = delegatedGrant ? "delegated" : "api";
  else if (uploads) accessMode = "upload";
  else if (isPublic) accessMode = "public";
  else if (benchmark) accessMode = "benchmark";
  else accessMode = "none";

  // A connector only planned or not configured is not connected; one that says ok (or had data) but gives nothing
  // current is stale.
  const live = accessMode === "api" || accessMode === "delegated";
  const connected = systems.some((s) => OK_STATUS.has(s.status)) || delegatedGrant;
  const status: CapabilityStatus = down ? "down" : live ? "ok" : newest !== null || connected ? "stale" : "not_connected";

  return {
    spec, id: capabilityId(spec.key), key: spec.key, name: spec.name, accessMode, status, lastOkAt,
    upgradeHint: upgradeHint(spec.key, accessMode, status, newest),
    dependsOn: present.map((s) => s.id).sort(),
  };
}

export function upgradeHint(key: CapabilityKey, mode: AccessMode, status: CapabilityStatus, newest: number | null): string {
  const asOf = newest !== null ? isoDate(newest) : undefined;
  if (status === "down") return `The connection stopped working, so this is down to ${mode === "none" ? "no data" : `${mode} mode`}. Reconnect it to get live numbers back.`;
  if (mode === "api") return `Connected and current${asOf ? ` (newest data ${asOf})` : ""}. Nothing to do.`;
  if (mode === "delegated") return `Working through the access you delegated${asOf ? ` (newest data ${asOf})` : ""}. Nothing to do.`;
  const stale = status === "stale" && asOf ? `The newest connected data is from ${asOf}, over a week old: refresh or reconnect it. ` : "";
  if (key === "studio") {
    if (mode === "upload") return "Working from the photos you uploaded, with local touch-ups. AI variants switch on when the Studio's media engine is connected.";
    return `${mode === "public" ? `${PUBLIC_LEAD.studio} ` : ""}${CONNECT.studio}`;
  }
  const lead = mode === "upload" ? "Using the numbers you uploaded."
    : mode === "public" ? PUBLIC_LEAD[key] ?? "Reading only what is public."
    : mode === "benchmark" ? "Using industry benchmarks, not your own numbers."
    : "Not connected yet.";
  return `${stale}${lead} ${CONNECT[key]}`;
}

// Read-only: the ladder as the graph supports it at `now`.
export async function deriveCapabilities(g: GraphHandle, opts: { now?: number; businessId?: string } = {}): Promise<DerivedCapability[]> {
  const facts = await readFacts(g, opts.businessId);
  const now = opts.now ?? Date.now();
  return CAPABILITIES.map((spec) => derive(spec, facts, now));
}

// What a turn needs: each capability's mode (for the Chief's prompt and the modeDisclosed check). Read-only.
export async function capabilityModes(g: GraphHandle, now?: number): Promise<CapabilityModeInfo[]> {
  return (await deriveCapabilities(g, now === undefined ? {} : { now })).map(({ key, name, accessMode }) => ({ key, name, accessMode }));
}

const MODE_LABEL: Record<AccessMode, string> = {
  api: "live", delegated: "live, through delegated access", upload: "from your uploads", public: "public data only",
  benchmark: "benchmarks only", none: "not connected",
};

function capabilityWrites(caps: DerivedCapability[], businessId: string | null): { nodes: NodeInput[]; edges: EdgeInput[] } {
  const nodes: NodeInput[] = caps.map((c) => ({
    type: "Capability", id: c.id, name: c.name, summary: `${c.name}: ${MODE_LABEL[c.accessMode]}. ${c.upgradeHint}`,
    props: { key: c.key, accessMode: c.accessMode, status: c.status, lastOkAt: c.lastOkAt, upgradeHint: c.upgradeHint },
  }));
  const edges: EdgeInput[] = caps.flatMap((c) => [
    ...(businessId ? [{ from: c.id, type: "PART_OF" as const, to: businessId }] : []),
    ...c.dependsOn.map((to) => ({ from: c.id, type: "DEPENDS_ON" as const, to })),
  ]);
  return { nodes, edges };
}

const strip = ({ spec: _spec, ...c }: DerivedCapability): CapabilityState => c;

// Derives the ladder and writes it: Capability nodes PART_OF the Business, DEPENDS_ON their Channels and Systems.
export async function syncCapabilities(g: GraphHandle, opts: { now?: number; businessId?: string } = {}): Promise<{ capabilities: CapabilityState[]; errors: string[] }> {
  const now = opts.now ?? Date.now();
  const facts = await readFacts(g, opts.businessId);
  const caps = CAPABILITIES.map((spec) => derive(spec, facts, now));
  const s = await writeBatch(g, capabilityWrites(caps, facts.businessId), now);
  return { capabilities: caps.map(strip), errors: s.errors.map((e) => `${e.kind}: ${e.error}`) };
}

// For GET /api/:t/capabilities: the ladder, written to the graph first (idempotent), in the fixed key order (ga4,
// search_console, gbp, instagram_insights, reviews, studio, ads).
export async function getCapabilities(g: GraphHandle, opts: { now?: number; businessId?: string } = {}): Promise<CapabilityState[]> {
  const { capabilities, errors } = await syncCapabilities(g, opts);
  if (errors.length) throw new Error(`capabilities: ${errors.join("; ")}`);
  return capabilities;
}
