// get_brand_asset: what the business's brand library holds (its logo, colours, fonts, brand guide, palette pictures, product
// photos, past designs), so an agent knows what it can use before it makes something and can say what is missing. Read-only.
// Files themselves never leave the server through here: the answer names them (id, kind, size, whether the owner has been
// asked for a better one) and the poster tools read the bytes.
import { z } from "zod";
import { activeLogo, listBrandAssets, type BrandAssetRow } from "../../brand/library.js";
import { loadStudioContext } from "../../studio/context.js";
import { businessId } from "../../graph/tenants.js";
import type { ToolContext } from "../tool.js";
import { Collector, defineTool, getNodes, type NodeRow } from "./common.js";

const KINDS = ["all", "logo", "colour", "font", "palette", "guide", "product-photo", "past-design"] as const;

const line = (r: BrandAssetRow) => ({
  id: r.id, kind: r.kind, name: r.name, origin: r.origin, ...(r.w ? { width: r.w, height: r.h } : {}), ...(r.family ? { family: r.family } : {}), ...(r.value ? { value: r.value } : {}),
  ...(r.colours.length ? { colours: r.colours } : {}), hasFile: !!r.storageKey, ...(r.needsBetter ? { needsBetterFile: true } : {}), ...(r.containsPerson ? { containsPerson: true } : {}),
});

async function run(a: { kind?: string; id?: string }, ctx: ToolContext) {
  const rows = await listBrandAssets(ctx.graph);
  const logo = await activeLogo(ctx.graph);
  const kind = (KINDS as readonly string[]).includes(a.kind ?? "") ? a.kind! : "all";
  const picked = rows.filter((r) => (kind === "all" || r.kind === kind || (kind === "font" && r.kind === "font-file")) && (!a.id || r.id === a.id));
  const ctxBrand = (await loadStudioContext(ctx.graph, businessId(ctx.tenant)).catch(() => null))?.brand;
  const col = new Collector();
  const found = await getNodes(ctx, picked.map((r) => r.id));
  for (const r of picked) col.node(found.get(r.id) as NodeRow | undefined);
  const missing: string[] = [];
  if (!logo) missing.push("a logo file (posters will show the business name in its brand font until the owner sends one)");
  else if (logo.needsBetter) missing.push("a sharper or bigger logo file (the one we have is small or soft)");
  if (!picked.some((r) => r.kind === "font" || r.kind === "font-file") && kind !== "logo") missing.push("brand font files");
  return col.result(ctx, {
    business: businessId(ctx.tenant), assets: picked.slice(0, 40).map(line),
    logo: logo ? line(logo) : null,
    palette: ctxBrand ? { paper: ctxBrand.paper, ink: ctxBrand.ink ?? null, accent: ctxBrand.accent ?? null, neutral: ctxBrand.neutral ?? null, fonts: ctxBrand.fonts } : null,
    missing, total: picked.length,
  }, missing.length ? `Missing: ${missing.join("; ")}.` : undefined);
}

export const getBrandAsset = defineTool({
  name: "get_brand_asset",
  description:
    "Answer 'what brand files do we have': the logo (and whether it needs a better file), colours, fonts, brand guide, palette pictures, product photos and past designs, and what is missing. Example: {\"kind\":\"logo\"}",
  input: {
    kind: z.enum(KINDS).optional().describe("Which kind (default all)"),
    id: z.string().optional().describe("One brand asset id"),
  },
  run,
});
