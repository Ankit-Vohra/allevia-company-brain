// Tenant registry. `allevia_meta` holds one (:Tenant) node per business; each business gets its own graph
// `allevia_<slug>` with the standard indexes and a Business node (businessId(slug)) as the root of its world.
// ALLEVIA_META_GRAPH (or opts.metaGraph) points the registry elsewhere, which is how tests stay off the real one.
import { MAX_PAGE, graphName, openGraph, openGraphByName } from "./client.js";
import { ensureIndexes } from "./indexes.js";
import { ONTOLOGY_VERSION } from "./schema.js";
import { upsertNode, type Prim } from "./upsert.js";
import { entityId } from "../util/ids.js";

export const META_GRAPH = "allevia_meta";

// Region and template (product design §2.4) ride along so the API can report in the owner's currency and time zone
// without opening the tenant's graph.
export interface TenantInput {
  slug: string; name: string; domain?: string; industry?: string; city?: string;
  country?: string; currency?: string; locale?: string; timeZone?: string; templateKey?: string;
}
const OPTIONAL = ["domain", "industry", "city", "country", "currency", "locale", "timeZone", "templateKey"] as const;
export interface Tenant extends TenantInput {
  demo?: boolean;   // a public demo business: with ALLEVIA_AUTH=1 its read-only pages open without an owner link (setDemo)
  graph: string;
  businessId: string;
  ontologyVersion: number;
  createdAt: number;
  updatedAt: number;
}
export interface TenantOpts { metaGraph?: string }

// Same rule as every other id, so callers that compute entityId("Business", slug) agree ("avs_atelier" ->
// "business:avs-atelier"). The graph name keeps the underscore: allevia_avs_atelier.
export const businessId = (slug: string): string => entityId("Business", slug);

// The registry graph this call uses (tests point it at a throwaway one). Exported for the token store, which keeps its
// records in the same graph.
export const metaName = (opts?: TenantOpts): string => opts?.metaGraph ?? process.env.ALLEVIA_META_GRAPH ?? META_GRAPH;

function toTenant(p: Record<string, unknown>): Tenant {
  const t: Tenant = {
    slug: String(p.slug), name: String(p.name), graph: String(p.graph), businessId: String(p.businessId),
    ontologyVersion: Number(p.ontologyVersion), createdAt: Number(p.createdAt), updatedAt: Number(p.updatedAt),
  };
  for (const k of OPTIONAL) if (typeof p[k] === "string") t[k] = p[k];
  if (p.demo === true) t.demo = true;
  return t;
}

// Paged by slug (a result holds at most RESULTSET_SIZE rows; the rest would vanish silently).
export async function listTenants(opts?: TenantOpts): Promise<Tenant[]> {
  const meta = await openGraphByName(metaName(opts));
  try {
    const out: Tenant[] = [];
    for (let after = ""; ;) {
      const rows = await meta.roQuery<{ p: Record<string, unknown> }>(
        "MATCH (t:Tenant) WHERE t.slug > $after RETURN properties(t) AS p ORDER BY t.slug LIMIT $limit", { after, limit: MAX_PAGE });
      for (const r of rows) out.push(toTenant(r.p));
      if (rows.length < MAX_PAGE) return out;
      after = out[out.length - 1]!.slug;
    }
  } catch (e) {
    if (/empty key/i.test((e as Error).message)) return []; // registry not created yet
    throw e;
  }
}

export async function getTenant(slug: string, opts?: TenantOpts): Promise<Tenant | null> {
  const meta = await openGraphByName(metaName(opts));
  try {
    const rows = await meta.roQuery<{ p: Record<string, unknown> }>("MATCH (t:Tenant {slug:$slug}) RETURN properties(t) AS p", { slug });
    return rows[0] ? toTenant(rows[0].p) : null;
  } catch (e) {
    if (/empty key/i.test((e as Error).message)) return null;
    throw e;
  }
}

// Idempotent. Omitted optional fields keep their stored values; updatedAt moves only when something changed.
export async function ensureTenant(input: TenantInput, opts?: TenantOpts): Promise<Tenant> {
  const graph = graphName(input.slug);
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("tenant name must be a non-empty string");
  const now = Date.now();
  const props: Record<string, unknown> = {
    slug: input.slug, name: input.name.trim(), graph, businessId: businessId(input.slug), ontologyVersion: ONTOLOGY_VERSION,
  };
  for (const k of OPTIONAL) if (input[k] !== undefined) props[k] = input[k];

  const meta = await openGraphByName(metaName(opts));
  await ensureIndexes(meta, [{ label: "Tenant", prop: "slug", type: "RANGE" }]);
  const before = await getTenant(input.slug, opts);
  const changed = !before || Object.entries(props).some(([k, v]) => before[k as keyof Tenant] !== v);
  if (changed) {
    await meta.query("MERGE (t:Tenant {slug:$slug}) ON CREATE SET t.createdAt = $now SET t += $props, t.updatedAt = $now",
      { slug: input.slug, now, props });
  }

  const g = await openGraph(input.slug);
  await ensureIndexes(g);
  const bizProps = Object.fromEntries([["slug", input.slug], ...OPTIONAL.map((k) => [k, input[k]])]
    .filter(([, v]) => v !== undefined)) as Record<string, Prim>;
  await upsertNode(g, { type: "Business", id: businessId(input.slug), name: input.name.trim(), props: bizProps }, now);
  return (await getTenant(input.slug, opts))!;
}

// ---------- the registry's relationships ----------

// The registry is a graph, so what belongs to a business hangs off its Tenant node (raw Cypher: ALLOWED_PATTERNS are for business graphs):
//   (:Tenant)-[:HAS_AREA]->(:DiscordArea)           src/discord/hub-store.ts
//   (:DiscordArea)-[:HAS_CHANNEL {kind}]->(:DiscordChannel)
//   (:Tenant)-[:ISSUED]->(:DiscordInvite)
//   (:DiscordChannel)-[:POSTED]->(:DiscordPost)      what was posted where (the business is two hops up)
//   (:Tenant)-[:HAS_TOKEN]->(:AuthToken)            src/auth/tokens.ts
// The writers MERGE each one when they write its node. This adds the ones that rows written earlier lack. Idempotent: MERGE never makes
// a second edge, and it returns how many it added (0 on a registry that is already linked). `db:migrate` and the hub's start call it.
export interface RegistryLinks { areas: number; channels: number; invites: number; posts: number; tokens: number }

const REGISTRY_LINKS: Array<{ key: keyof RegistryLinks; rel: string; link: string }> = [
  { key: "areas", rel: "HAS_AREA", link: "MATCH (a:DiscordArea) MATCH (t:Tenant) WHERE t.slug = a.slug MERGE (t)-[r:HAS_AREA]->(a) ON CREATE SET r.since = coalesce(a.createdAt, $now)" },
  { key: "channels", rel: "HAS_CHANNEL", link: "MATCH (c:DiscordChannel) WHERE c.until IS NULL MATCH (a:DiscordArea) WHERE a.slug = c.slug MERGE (a)-[r:HAS_CHANNEL]->(c) ON CREATE SET r.since = coalesce(c.mappedAt, a.createdAt, $now), r.kind = c.kind" },
  { key: "invites", rel: "ISSUED", link: "MATCH (i:DiscordInvite) MATCH (t:Tenant) WHERE t.slug = i.slug MERGE (t)-[r:ISSUED]->(i) ON CREATE SET r.since = coalesce(i.createdAt, $now)" },
  { key: "posts", rel: "POSTED", link: "MATCH (p:DiscordPost) MATCH (c:DiscordChannel) WHERE c.channelId = p.channelId MERGE (c)-[r:POSTED]->(p) ON CREATE SET r.at = coalesce(p.postedAt, $now)" },
  { key: "tokens", rel: "HAS_TOKEN", link: "MATCH (k:AuthToken) MATCH (t:Tenant) WHERE t.slug = k.scope MERGE (t)-[r:HAS_TOKEN]->(k) ON CREATE SET r.since = coalesce(k.createdAt, $now)" },
];

export async function linkRegistry(opts?: TenantOpts & { now?: number }): Promise<RegistryLinks> {
  const meta = await openGraphByName(metaName(opts));
  const now = opts?.now ?? Date.now();
  const total = async (rel: string): Promise<number> =>
    (await meta.peek<{ c: number }>(`MATCH ()-[r:${rel}]->() WHERE ID(r) >= 0 RETURN count(r) AS c`))[0]?.c ?? 0;
  const out: RegistryLinks = { areas: 0, channels: 0, invites: 0, posts: 0, tokens: 0 };
  for (const l of REGISTRY_LINKS) {
    const before = await total(l.rel);
    await meta.query(l.link, { now });
    out[l.key] = (await total(l.rel)) - before;
  }
  return out;
}

// Marks (or unmarks) a registered business as a public demo. Only a demo business is readable without an owner link when
// ALLEVIA_AUTH=1, and then only read-only. A business that is not registered cannot be marked. Returns whether it exists.
export async function setDemo(slug: string, demo: boolean, opts?: TenantOpts): Promise<boolean> {
  if (!(await getTenant(slug, opts))) return false;
  const meta = await openGraphByName(metaName(opts));
  await meta.query("MATCH (t:Tenant {slug:$slug}) SET t.demo = $demo", { slug, demo });
  return true;
}
