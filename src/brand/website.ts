// Onboarding turns the website's brand kit from references into files (the founder: "ask the owner once for a better
// file when it is small or blurry"):
//  - the LOGO: the header's own logo first, then the biggest declared icon, then og:image, then the favicon. Each candidate
//    is downloaded (SSRF-safe, size-capped), an SVG is drawn to a PNG, and it is checked: a social-media card (a wide
//    og:image with a tagline) is not a logo, a 64 px icon is too small to print, and with a vision model a candidate is
//    confirmed to be a logo before it is kept. The result is written on the site's logo node (brand-asset:logo) so the
//    graph keeps one logo per website; when nothing qualifies the node says "not a logo" and the owner is asked for the file.
//  - the FONTS: each brand family is fetched from Google Fonts (regular and bold, TrueType) when Google has it, so the
//    poster composer can set real text in the brand's type. Only Google's own hosts are fetched for this.
// A failure never stops onboarding: it becomes a note (the owner's words) and the next candidate is tried.
import { agentNodeId, ensureRoster } from "../agent/memory.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { guardedFetch } from "../ingest/sources/website/fetch.js";
import { LOGO_ASSET_ID, type BrandFont, type BrandLogo } from "../ingest/sources/website/brand.js";
import type { PageData } from "../ingest/sources/website/page.js";
import { sha256Hex } from "../studio/image.js";
import type { AssetStore } from "../studio/store.js";
import type { VisionRunner } from "../studio/vision.js";
import { entityId } from "../util/ids.js";
import { classifyImage, LIBRARIAN } from "./classify.js";
import { prepareImage, type Prepared } from "./upload.js";
import { logoQuality } from "./quality.js";
import { fontFamilyName, sniffType } from "./sniff.js";

export interface BrandFetched { status: number; headers: Record<string, string>; body: Buffer }
export type BrandFetch = (url: string, o: { maxBytes: number; accept: string }) => Promise<BrandFetched>;

export const defaultBrandFetch = (allowHosts: string[] = []): BrandFetch => async (url, o) => {
  const r = await guardedFetch(url, { maxBytes: o.maxBytes, timeoutMs: 15_000, accept: o.accept, allowHosts });
  return { status: r.status, headers: r.headers, body: r.body };
};

export interface WebsiteBrandDeps {
  tenant: string;
  businessId: string;
  docId: string;
  store: AssetStore;
  now: number;
  fetch?: BrandFetch;
  vision?: VisionRunner;
  googleFonts?: boolean;          // default true
  allowHosts?: string[];          // tests: a local server
  log?: (line: string) => void;
}

export interface WebsiteBrandResult {
  logo: "stored" | "none";
  needsBetter: boolean;
  fonts: Array<{ id: string; family: string; weight: number; storageKey: string }>;
  notes: string[];                // for the owner, in plain words
}

const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const MAX_FONT_BYTES = 3 * 1024 * 1024;
const MAX_CANDIDATES = 6;
const MAX_VISION_CHECKS = 3;
const MIN_ICON_SIDE = 128;       // below this a favicon is not a logo anyone can print
const SOCIAL_CARD_ASPECT = 1.6;
const GOOGLE_CSS = "https://fonts.googleapis.com/css2";
const GOOGLE_CSS_HOST = "fonts.googleapis.com";
const GOOGLE_FILE_HOST = "fonts.gstatic.com";
export const FONT_WEIGHTS = [400, 700] as const;

interface Candidate { source: "header" | "icon" | "og:image" | "favicon"; rank: number; url?: string; svg?: string; declared?: number }

function candidates(home: PageData, kit: { logo: BrandLogo | null }): Candidate[] {
  const out: Candidate[] = [];
  const l = home.logo;
  if (l?.kind === "svg" && l.svg) out.push({ source: "header", rank: 0, svg: l.svg });
  else if (kit.logo?.format === "svg" && kit.logo.value.startsWith("data:image/svg+xml;base64,")) out.push({ source: "header", rank: 0, svg: Buffer.from(kit.logo.value.split(",")[1] ?? "", "base64").toString("utf8") });
  if (l?.kind === "img" && l.src) out.push({ source: "header", rank: 0, url: l.src });
  const size = (s?: string): number => Math.max(0, ...[...(s ?? "").matchAll(/(\d+)x(\d+)/g)].map((m) => Number(m[1]))) || (s === "any" ? 4096 : 0);
  for (const i of [...(home.iconLinks ?? [])].sort((a, b) => size(b.sizes) - size(a.sizes))) out.push({ source: "icon", rank: 1, url: i.href, declared: size(i.sizes) });
  const og = home.og["og:image"];
  if (og) out.push({ source: "og:image", rank: 2, url: og });
  if (home.favicon) out.push({ source: "favicon", rank: 3, url: home.favicon });
  const seen = new Set<string>();
  return out.filter((c) => { const k = c.url ?? c.svg!.slice(0, 200); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_CANDIDATES);
}

const http = (u: string): boolean => /^https?:\/\//i.test(u);

export async function fetchWebsiteBrandFiles(
  g: GraphHandle, home: PageData, kit: { logo: BrandLogo | null; fonts: BrandFont[] }, deps: WebsiteBrandDeps,
): Promise<WebsiteBrandResult> {
  const fetchFn = deps.fetch ?? defaultBrandFetch(deps.allowHosts);
  const log = deps.log ?? (() => {});
  const asOf = new Date(deps.now).toISOString().slice(0, 10);
  const result: WebsiteBrandResult = { logo: "none", needsBetter: false, fonts: [], notes: [] };

  // ----- the logo -----
  const rejected: string[] = [];
  let chosen: { c: Candidate; img: Prepared; quality: Awaited<ReturnType<typeof logoQuality>> } | undefined;
  let visionChecks = 0;
  const found: Array<{ c: Candidate; img: Prepared }> = [];
  for (const c of candidates(home, kit)) {
    try {
      let bytes: Buffer;
      if (c.svg) bytes = Buffer.from(c.svg, "utf8");
      else {
        if (!c.url || !http(c.url)) continue;
        const r = await fetchFn(c.url, { maxBytes: MAX_LOGO_BYTES, accept: "image/*,*/*;q=0.5" });
        if (r.status < 200 || r.status >= 300 || !r.body.length) { rejected.push(`I couldn't download ${c.source === "header" ? "the logo" : "an icon"} from the website`); continue; }
        bytes = r.body;
      }
      const type = sniffType(bytes);
      if (type !== "png" && type !== "jpeg" && type !== "webp" && type !== "svg") { rejected.push("a file the website calls a logo was not a picture I can read"); continue; }
      const img = await prepareImage(bytes, type);
      const side = Math.max(img.w, img.h);
      if (c.source === "og:image" && img.w / img.h >= SOCIAL_CARD_ASPECT && Math.min(img.w, img.h) >= 300) { rejected.push("the website's only big picture is a social-media card, not a logo"); continue; }
      if ((c.source === "favicon" || c.source === "icon") && side < MIN_ICON_SIDE) { rejected.push(`the website's icon is only ${img.w} px wide, too small to print`); continue; }
      found.push({ c, img });
    } catch (e) {
      rejected.push(`I couldn't read a picture from the website (${(e instanceof Error ? e.message : String(e)).slice(0, 80)})`);
    }
  }
  // header first, then the rank; within a rank the biggest picture
  found.sort((a, b) => a.c.rank - b.c.rank || b.img.w * b.img.h - a.img.w * a.img.h);
  for (const f of found) {
    if (deps.vision && visionChecks < MAX_VISION_CHECKS) {
      visionChecks++;
      try {
        const v = await classifyImage(deps.vision, { image: f.img.buffer });
        if (v.kind !== "logo") { rejected.push(`the website's ${f.c.source === "header" ? "header picture" : f.c.source} is ${v.description || "not a logo"}, not a logo`); continue; }
      } catch (e) {
        log(`[brand] logo check failed (${e instanceof Error ? e.message : String(e)}); going by size and shape`);
      }
    }
    chosen = { ...f, quality: await logoQuality(f.img.buffer) };
    break;
  }

  const logoName = "Logo";
  if (chosen) {
    const { img, c, quality } = chosen;
    const sha256 = sha256Hex(img.buffer);
    const storageKey = deps.store.put(deps.tenant, sha256, img.buffer, img.ext === "jpg" ? "jpg" : "png");
    const needsBetter = quality.lowRes || quality.blurry;
    await upsertNode(g, {
      type: "BrandAsset", id: LOGO_ASSET_ID, name: logoName, summary: `The logo, downloaded from the website's ${c.source === "header" ? "header" : c.source}.`, src: deps.docId, asOf,
      props: {
        kind: "logo", origin: "website", mediaType: "image", mime: img.mime, w: img.w, h: img.h, bytes: img.buffer.length, sha256, storageKey, status: "active",
        fileFrom: c.url ?? "the website's inline SVG", ...(img.convertedFrom ? { convertedFrom: img.convertedFrom, step: "svg-to-png" } : {}), metadataStripped: true,
        hasAlpha: quality.hasAlpha, sharpness: quality.sharpness, lowRes: quality.lowRes, blurry: quality.blurry, needsBetter,
      },
    }, deps.now);
    await upsertEdge(g, { from: deps.businessId, type: "OWNS", to: LOGO_ASSET_ID, src: deps.docId, asOf }, deps.now).catch(() => undefined);
    result.logo = "stored";
    result.needsBetter = needsBetter;
    if (needsBetter) result.notes.push(quality.lowRes
      ? `The logo on your website is small (${quality.w} px wide). If you have a bigger file or an SVG, send it in your team's channel and I'll use that.`
      : "The logo on your website looks a little blurry. If you have a sharper file or an SVG, send it in your team's channel and I'll use that.");
  } else {
    const reason = rejected[0] ?? "the website doesn't show a logo file I could find";
    result.notes.push(`I couldn't find a logo file on your website (${reason}). Until you send one, posters will show your name in your brand font. Send your logo in your team's channel and I'll use it.`);
    result.needsBetter = true;
    const [existing] = await g.roQuery<{ id: string }>("MATCH (a:Entity:BrandAsset {id:$id}) RETURN a.id AS id", { id: LOGO_ASSET_ID });
    if (existing) {
      // what the site only pointed at (often a social card) is not a logo: it stays on record, marked, with no file
      await upsertNode(g, { type: "BrandAsset", id: LOGO_ASSET_ID, name: logoName, props: { status: "not-a-logo", needsBetter: true, storageKey: null, notALogoBecause: rejected[0] ?? "no logo file found" } }, deps.now);
    }
  }

  // ----- the fonts -----
  if (deps.googleFonts !== false) {
    for (const f of kit.fonts.slice(0, 3)) {
      try {
        result.fonts.push(...await googleFont(g, f.family, deps, fetchFn, asOf));
      } catch (e) {
        log(`[brand] font ${f.family}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  // the librarian filed the logo file and fonts; a small provenance edge so the path view shows who did
  await ensureRoster(g, { businessId: deps.businessId }, deps.now).catch(() => undefined);
  if (result.logo === "stored") await upsertEdge(g, { from: agentNodeId(LIBRARIAN), type: "PRODUCED", to: LOGO_ASSET_ID, src: deps.docId, asOf }, deps.now).catch(() => undefined);
  return result;
}

// Regular and bold TrueType files of a family, from Google Fonts. [] when Google does not have the family.
async function googleFont(g: GraphHandle, family: string, deps: WebsiteBrandDeps, fetchFn: BrandFetch, asOf: string): Promise<WebsiteBrandResult["fonts"]> {
  const q = `${GOOGLE_CSS}?family=${encodeURIComponent(`${family}:wght@${FONT_WEIGHTS.join(";")}`)}`;
  const u = new URL(q);
  if (u.hostname !== GOOGLE_CSS_HOST) return [];
  const css = await fetchFn(q, { maxBytes: 200_000, accept: "text/css,*/*;q=0.1" });
  if (css.status !== 200) return [];
  const faces = [...css.body.toString("utf8").matchAll(/font-weight:\s*(\d+);[^}]*?src:\s*url\((https:\/\/[^)\s]+)\)\s*format\('truetype'\)/g)];
  const out: WebsiteBrandResult["fonts"] = [];
  for (const m of faces) {
    const weight = Number(m[1]);
    const url = new URL(m[2]!);
    if (!(FONT_WEIGHTS as readonly number[]).includes(weight) || url.hostname !== GOOGLE_FILE_HOST) continue; // only Google's own file host
    const r = await fetchFn(url.toString(), { maxBytes: MAX_FONT_BYTES, accept: "font/ttf,*/*;q=0.1" });
    if (r.status !== 200 || sniffType(r.body) !== "ttf") continue;
    const sha256 = sha256Hex(r.body);
    const storageKey = deps.store.put(deps.tenant, sha256, r.body, "ttf");
    const id = entityId("BrandAsset", `font file ${family} ${weight}`);
    await upsertNode(g, {
      type: "BrandAsset", id, name: `${family} ${weight === 700 ? "bold" : "regular"} (font file)`, summary: `The ${family} ${weight} font file, from Google Fonts.`, src: deps.docId, asOf,
      props: {
        kind: "font-file", family, weight, mediaType: "font", mime: "font/ttf", bytes: r.body.length, sha256, storageKey, origin: "google-fonts", status: "active",
        fileFamily: fontFamilyName(r.body) ?? family, license: "SIL Open Font License, from Google Fonts",
      },
    }, deps.now);
    await upsertEdge(g, { from: deps.businessId, type: "OWNS", to: id, src: deps.docId, asOf }, deps.now).catch(() => undefined);
    out.push({ id, family, weight, storageKey });
  }
  return out;
}
