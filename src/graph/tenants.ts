// Tenant registry. `allevia_meta` holds one (:Tenant) node per business; each business gets its own graph
// `allevia_<slug>` with the standard indexes and a Business node (businessId(slug)) as the root of its world.
// ALLEVIA_META_GRAPH (or opts.metaGraph) points the registry elsewhere, which is how tests stay off the real one.
import { graphName, openGraph, openGraphByName } from "./client.js";
import { ensureIndexes } from "./indexes.js";
import { ONTOLOGY_VERSION } from "./schema.js";
import { upsertNode, type Prim } from "./upsert.js";
import { entityId } from "../util/ids.js";

export const META_GRAPH = "allevia_meta";

export interface TenantInput { slug: string; name: string; domain?: string; industry?: string; city?: string }
export interface Tenant extends TenantInput {
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

const metaName = (opts?: TenantOpts) => opts?.metaGraph ?? process.env.ALLEVIA_META_GRAPH ?? META_GRAPH;

function toTenant(p: Record<string, unknown>): Tenant {
  const t: Tenant = {
    slug: String(p.slug), name: String(p.name), graph: String(p.graph), businessId: String(p.businessId),
    ontologyVersion: Number(p.ontologyVersion), createdAt: Number(p.createdAt), updatedAt: Number(p.updatedAt),
  };
  for (const k of ["domain", "industry", "city"] as const) if (typeof p[k] === "string") t[k] = p[k];
  return t;
}

export async function listTenants(opts?: TenantOpts): Promise<Tenant[]> {
  const meta = await openGraphByName(metaName(opts));
  try {
    const rows = await meta.roQuery<{ p: Record<string, unknown> }>("MATCH (t:Tenant) RETURN properties(t) AS p ORDER BY t.slug");
    return rows.map((r) => toTenant(r.p));
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
  for (const k of ["domain", "industry", "city"] as const) if (input[k] !== undefined) props[k] = input[k];

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
  const bizProps = Object.fromEntries(Object.entries({ slug: input.slug, domain: input.domain, industry: input.industry, city: input.city })
    .filter(([, v]) => v !== undefined)) as Record<string, Prim>;
  await upsertNode(g, { type: "Business", id: businessId(input.slug), name: input.name.trim(), props: bizProps }, now);
  return (await getTenant(input.slug, opts))!;
}
