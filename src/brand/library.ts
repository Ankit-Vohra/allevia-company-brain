// Reading the brand library: the BrandAsset nodes of one business's graph (one graph per tenant, so a read here can only
// ever see its own business's assets), and the files behind them. Files live under <dataDir>/assets/<tenant>/ (store.ts).
import type { GraphHandle } from "../graph/client.js";
import type { AssetStore } from "../studio/store.js";

export type BrandKind = "logo" | "palette" | "font" | "font-sample" | "product-photo" | "past-design" | "guide" | "colour" | "other";

export interface BrandAssetRow {
  id: string;
  kind: string;
  name: string;
  origin: string;                 // website | upload | derived
  mime: string | null;
  w: number | null;
  h: number | null;
  storageKey: string | null;
  status: string;                 // active | superseded
  description: string | null;
  family: string | null;          // fonts
  value: string | null;           // colours and website references
  colours: string[];              // a palette image's or a guide's colours
  needsBetter: boolean;
  askedForBetter: boolean;        // the owner has been asked once for a better file
  containsPerson: boolean;
  source: string | null;
  createdAt: number | null;
}

const COLUMNS = `a.id AS id, a.kind AS kind, a.name AS name, a.origin AS origin, a.mime AS mime, a.w AS w, a.h AS h,
  a.storageKey AS storageKey, a.status AS status, a.description AS description, a.family AS family, a.value AS value,
  a.colours AS colours, a.guideColours AS guideColours, a.needsBetter AS needsBetter, a.askedForBetter AS askedForBetter,
  a.containsPerson AS containsPerson, a.source AS source, a.createdAt AS createdAt`;

interface Raw {
  id: string; kind: string | null; name: string | null; origin: string | null; mime: string | null; w: number | null; h: number | null;
  storageKey: string | null; status: string | null; description: string | null; family: string | null; value: string | null;
  colours: string[] | null; guideColours: string[] | null; needsBetter: boolean | null; askedForBetter: boolean | null;
  containsPerson: boolean | null; source: string | null; createdAt: number | null;
}

const toRow = (r: Raw): BrandAssetRow => ({
  id: r.id, kind: r.kind ?? "other", name: r.name ?? r.id, origin: r.origin ?? "upload", mime: r.mime, w: r.w, h: r.h, storageKey: r.storageKey,
  status: r.status ?? "active", description: r.description, family: r.family, value: r.value,
  colours: [...(r.colours ?? []), ...(r.guideColours ?? [])], needsBetter: r.needsBetter === true, askedForBetter: r.askedForBetter === true,
  containsPerson: r.containsPerson === true, source: r.source, createdAt: r.createdAt,
});

// Every active brand asset that has a file or a value, newest last (the id breaks ties so the order is stable).
export async function listBrandAssets(g: Pick<GraphHandle, "roQuery">, o: { kinds?: string[]; withFile?: boolean } = {}): Promise<BrandAssetRow[]> {
  const rows = await g.roQuery<Raw>(
    `MATCH (a:BrandAsset) WHERE coalesce(a.status, 'active') <> 'superseded' RETURN ${COLUMNS} ORDER BY a.createdAt, a.id LIMIT 200`);
  return rows.map(toRow).filter((r) => (!o.kinds || o.kinds.includes(r.kind)) && (!o.withFile || !!r.storageKey));
}

export async function getBrandAsset(g: Pick<GraphHandle, "roQuery">, id: string): Promise<BrandAssetRow | null> {
  const [r] = await g.roQuery<Raw>(`MATCH (a:Entity:BrandAsset {id:$id}) RETURN ${COLUMNS}`, { id });
  return r ? toRow(r) : null;
}

// The logo to use: a file the owner uploaded beats one fetched from the website; the newest wins within each. A logo
// the site only pointed at (no file) or that turned out not to be a logo is not a logo.
export async function activeLogo(g: Pick<GraphHandle, "roQuery">): Promise<BrandAssetRow | null> {
  const logos = (await listBrandAssets(g, { kinds: ["logo"], withFile: true })).filter((r) => r.status !== "not-a-logo");
  logos.sort((a, b) => Number(b.origin === "upload") - Number(a.origin === "upload") || (b.createdAt ?? 0) - (a.createdAt ?? 0) || b.id.localeCompare(a.id));
  return logos[0] ?? null;
}

// A font file for a family (an upload or one fetched from Google Fonts), regular weight preferred.
export async function fontFile(g: Pick<GraphHandle, "roQuery">, family: string): Promise<BrandAssetRow | null> {
  const want = family.trim().toLowerCase();
  const all = await listBrandAssets(g, { kinds: ["font", "font-file"], withFile: true });
  const hits = all.filter((r) => (r.family ?? "").toLowerCase() === want);
  return hits.find((r) => r.origin === "upload") ?? hits[0] ?? null;
}

export function readAssetFile(store: AssetStore, tenant: string, row: Pick<BrandAssetRow, "storageKey">): Buffer | null {
  return row.storageKey ? store.get(tenant, row.storageKey) : null;
}
