// The brand kit as the composer needs it, read from one business's graph and its files: the palette (the brand's own
// colours), the heading and body font files (an uploaded font, else a Google font fetched at onboarding, else fetched now
// when allowed, else the house fallback with a note), the real logo file, and the facts the business holds (name, city,
// website, handles) that a poster's words may be grounded in. Everything here is per business: one graph, one tenant dir.
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { join } from "node:path";
import { activeLogo, listBrandAssets, readAssetFile, type BrandAssetRow } from "../brand/library.js";
import { googleFont, defaultBrandFetch, type BrandFetch } from "../brand/website.js";
import type { GraphHandle } from "../graph/client.js";
import { loadStudioContext, type StudioContext } from "../studio/context.js";
import type { AssetStore } from "../studio/store.js";
import { HEX6, paletteFrom, type Palette } from "./compose/palette.js";
import { loadFont, type LoadedFont } from "./compose/type.js";
import type { BrandForCompose, FontPair } from "./compose/compose.js";

const VENDOR_FONTS = new URL("../../vendor/fonts/", import.meta.url);
const fallback = (n: string): LoadedFont | null => { try { return loadFont(readFileSync(join(VENDOR_FONTS.pathname, n))); } catch { return null; } };

// The palette of a logo file: its darkest ink, its most colourful colour, on a neutral warm paper.
export async function logoPalette(png: Buffer): Promise<Palette | null> {
  const { data, info } = await sharp(png).ensureAlpha().resize(96, 96, { fit: "inside" }).raw().toBuffer({ resolveWithObject: true });
  const px: Array<{ r: number; g: number; b: number }> = [];
  for (let i = 0; i < data.length; i += info.channels) if (data[i + 3]! > 200) px.push({ r: data[i]!, g: data[i + 1]!, b: data[i + 2]! });
  if (px.length < 20) return null;
  const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const chroma = (c: { r: number; g: number; b: number }) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const dark = [...px].sort((a, b) => lum(a) - lum(b))[Math.floor(px.length * 0.05)]!;
  const vivid = [...px].sort((a, b) => chroma(b) - chroma(a))[Math.floor(px.length * 0.03)]!;
  const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  if (chroma(vivid) < 40) return paletteFrom({ paper: "#f7f4ee", ink: hex(dark) });
  return paletteFrom({ paper: "#f7f4ee", ink: hex(dark), accent: hex(vivid) });
}

export interface ComposeKit {
  brand: BrandForCompose;
  ctx: StudioContext;
  facts: string[];                 // what a poster's words may be grounded in, besides the owner's request
  ids: { logo?: string; fonts: string[]; colours: string[]; rules: string[] };
  notes: string[];                 // honest remarks for the owner: no logo file, a fallback font, a small logo
  logoRow: BrandAssetRow | null;
  logoBytes: Buffer | null;
  colours: string[];               // every brand colour on record (roles first, then palette and guide swatches), for the design system
}

export interface KitDeps { store: AssetStore; tenant: string; businessId: string; fetchMissingFonts?: boolean; fetch?: BrandFetch; now: number }

const hostOf = (u: string): string | null => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; } };

export async function businessFacts(g: GraphHandle, ctx: StudioContext): Promise<string[]> {
  const facts = [ctx.business.name, ctx.business.city, ctx.business.country, ctx.business.industry].filter((x): x is string => !!x);
  const pages = await g.roQuery<{ url: string | null }>("MATCH (p:Page) WHERE p.url IS NOT NULL RETURN p.url AS url ORDER BY p.id LIMIT 60").catch(() => []);
  const hosts = [...new Set(pages.map((p) => (p.url ? hostOf(p.url) : null)).filter((h): h is string => !!h))].slice(0, 6);
  facts.push(...hosts);
  const chans = await g.roQuery<{ handle: string | null; name: string | null }>("MATCH (c:Channel) RETURN c.handle AS handle, c.name AS name ORDER BY c.id LIMIT 30").catch(() => []);
  for (const c of chans) { if (c.handle) facts.push(c.handle.startsWith("@") ? c.handle : `@${c.handle}`); }
  return facts;
}

const fontRoles = async (g: GraphHandle): Promise<{ heading?: string; body?: string }> => {
  const rows = await g.roQuery<{ value: string | null; role: string | null }>(
    "MATCH (a:BrandAsset) WHERE a.kind = 'font' AND coalesce(a.value, a.family) IS NOT NULL AND coalesce(a.status, 'active') <> 'superseded' RETURN coalesce(a.value, a.family) AS value, a.role AS role ORDER BY a.id LIMIT 20").catch(() => []);
  const first = (role: string) => rows.find((r) => r.role === role)?.value ?? undefined;
  const any = rows.map((r) => r.value).find((v): v is string => !!v);
  const heading = first("heading") ?? any, body = first("body") ?? any;
  return { ...(heading ? { heading } : {}), ...(body ? { body } : {}) };
};

async function pairFor(g: GraphHandle, deps: KitDeps, family: string | undefined, notes: string[], ids: string[], role: string): Promise<FontPair> {
  const load = (rows: BrandAssetRow[]): FontPair => {
    const read = (r: BrandAssetRow | undefined): LoadedFont | null => { const b = r ? readAssetFile(deps.store, deps.tenant, r) : null; return b ? loadFont(b) : null; };
    const mine = rows.filter((r) => (r.family ?? "").toLowerCase() === (family ?? "").toLowerCase());
    const regular = mine.find((r) => r.weight === 400) ?? mine.find((r) => r.origin === "upload") ?? mine.find((r) => !r.weight) ?? mine[0];
    const bold = mine.find((r) => r.weight === 700) ?? mine.find((r) => (r.weight ?? 0) >= 600) ?? regular;
    ids.push(...[regular, bold].filter((r): r is BrandAssetRow => !!r).map((r) => r.id));
    return { regular: read(regular), bold: read(bold) };
  };
  if (family) {
    let rows = await listBrandAssets(g, { kinds: ["font", "font-file"], withFile: true });
    let pair = load(rows);
    if (!pair.regular && deps.fetchMissingFonts) {
      await googleFont(g, family, { tenant: deps.tenant, businessId: deps.businessId, docId: "", store: deps.store, now: deps.now }, deps.fetch ?? defaultBrandFetch(), new Date(deps.now).toISOString().slice(0, 10)).catch(() => []);
      rows = await listBrandAssets(g, { kinds: ["font", "font-file"], withFile: true });
      pair = load(rows);
    }
    if (pair.regular || pair.bold) return pair;
    notes.push(`I don't have the ${family} font file, so the ${role} text is set in Inter. Send the font file (.ttf or .otf) in your team's channel and I'll use it.`);
  } else notes.push(`I couldn't tell which font your ${role} text uses, so it is set in Inter.`);
  return { regular: fallback("Inter-400.ttf"), bold: fallback("Inter-700.ttf") };
}

export async function loadComposeKit(g: GraphHandle, businessId: string, deps: KitDeps): Promise<ComposeKit> {
  const ctx = await loadStudioContext(g, businessId);
  const assets = await listBrandAssets(g);
  const extra = [...new Set(assets.flatMap((a) => (a.kind === "palette" || a.kind === "guide" ? a.colours : [])).filter((c) => HEX6.test(c)))];
  let palette: Palette = paletteFrom({ ...(ctx.brand.paper !== undefined && ctx.brand.ids.length ? { paper: ctx.brand.paper } : {}), ...(ctx.brand.ink ? { ink: ctx.brand.ink } : {}), ...(ctx.brand.accent ? { accent: ctx.brand.accent } : {}), ...(ctx.brand.neutral ? { neutral: ctx.brand.neutral } : {}), extra });
  const notes: string[] = [];
  const fontIds: string[] = [];
  const roles = await fontRoles(g);
  const heading = await pairFor(g, deps, roles.heading, notes, fontIds, "heading");
  const body = await pairFor(g, deps, roles.body, notes, fontIds, "body");

  const logoRow = await activeLogo(g);
  let logoBytes = logoRow ? readAssetFile(deps.store, deps.tenant, logoRow) : null;
  if (logoRow && !logoBytes) { notes.push("Your logo file is missing from storage, so the poster shows your name instead. Send the logo again."); }
  if (!logoRow) notes.push("I don't have a logo file for you yet, so the poster shows your name in your brand font. Send your logo in your team's channel and I'll use it on every poster.");
  else if (logoRow.needsBetter) notes.push(`Your logo file is ${logoRow.w ? `small or soft (${logoRow.w} px wide)` : "small or soft"}: it may look a little soft on a poster. A bigger file, an SVG or a PDF logo would fix that.`);
  if (!logoBytes) logoBytes = null;
  let fromLogoFile = false;
  // no brand colours on record but a logo file: the poster takes its colours from the logo (said so), never another brand's
  if (palette.source === "default" && logoBytes) {
    const fromLogo = await logoPalette(logoBytes).catch(() => null);
    if (fromLogo) {
      palette = fromLogo;
      fromLogoFile = true;
      notes.push("I have no exact brand colours on record, so the poster uses the colours of your logo. Tell me your colour codes to use them instead.");
    }
  } else if (palette.source === "default") notes.push("I have no brand colours on record, so the poster uses neutral warm colours. Tell me your colour codes to use them instead.");

  const brand: BrandForCompose = {
    businessName: ctx.business.name, palette, heading, body,
    logo: logoBytes && logoRow ? { bytes: logoBytes, w: logoRow.w ?? 0, h: logoRow.h ?? 0 } : null,
  };
  const colours = [...new Set([ctx.brand.ids.length ? ctx.brand.paper : undefined, ctx.brand.ink, ctx.brand.accent, ctx.brand.neutral, ...extra]
    .filter((c): c is string => !!c && HEX6.test(c)).map((c) => c.toLowerCase()))];
  return {
    brand, ctx, facts: await businessFacts(g, ctx), notes, logoRow, logoBytes, colours: colours.length && !fromLogoFile ? colours : [palette.paper, palette.dark, palette.accent],
    ids: { ...(logoRow && logoBytes ? { logo: logoRow.id } : {}), fonts: [...new Set(fontIds)], colours: ctx.brand.ids.filter((id) => /colour/.test(id)), rules: ctx.brand.ids.filter((id) => /^brand-rule:/.test(id)) },
  };
}
