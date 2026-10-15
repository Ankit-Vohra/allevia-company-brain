// Real material first. Before any scene is generated, the composer looks for what the business really has:
//   - its own photos in the brand library (projects, products, the place: BrandAsset product-photo / past-design), and
//     pictures the owner already approved (Asset status approved);
//   - its real app screens (BrandAsset app-screen), each with the crop and the focus box that say what part matters;
// and ranks them against what the brief sells. A generated scene is the last resort, and its prompt is specific to this
// business and its place (a Raipur home, a worker with a phone at a site), never a generic stock office.
// Pictures travel into the page as data: URLs, resized here (a phone photo is 4000 px; the page needs 1800).
import sharp from "sharp";
import type { GraphHandle } from "../../graph/client.js";
import type { AssetStore } from "../../studio/store.js";
import { dataUrl } from "./render.js";
import type { Picture } from "./layouts.js";

export interface ScreenCrop { y0?: number; y1?: number; statusBar?: number }

// A photo for the page: at most 1800 px on its long side, with the point sharp's attention finder would keep (the focal
// point for every crop the layout makes).
export async function photoPicture(bytes: Buffer, o: { id?: string; label?: string; kind?: "photo" | "scene" } = {}): Promise<Picture> {
  const img = sharp(bytes).rotate();
  const meta = await img.metadata();
  const resized = await img.resize({ width: 1800, height: 1800, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  let focal: Picture["focal"];
  try {
    const probe = await sharp(resized.data).resize(200, 200, { fit: "cover", position: sharp.strategy.attention }).toBuffer({ resolveWithObject: true });
    const ax = (probe.info as { attentionX?: number }).attentionX, ay = (probe.info as { attentionY?: number }).attentionY;
    if (typeof ax === "number" && typeof ay === "number") focal = { x: Math.max(0, Math.min(1, ax / 200)), y: Math.max(0, Math.min(1, ay / 200)) };
  } catch { /* the centre then */ }
  return {
    url: dataUrl(resized.data, "image/jpeg"), w: resized.info.width, h: resized.info.height, kind: o.kind ?? "photo",
    ...(o.id ? { id: o.id } : {}), ...(o.label ? { label: o.label } : {}), ...(focal ? { focal } : {}),
    ...(meta.width && meta.height ? {} : {}),
  };
}

// A real app screen for a phone frame: optionally cropped (y0..y1, fractions) with the status bar kept on top, its own
// background colour sampled from its bottom edge (fills the phone below a short crop), and the focus box re-based onto
// the crop so a callout points at the right place.
export async function screenPicture(bytes: Buffer, o: { id?: string; label?: string; crop?: ScreenCrop; focus?: Picture["focus"] } = {}): Promise<Picture> {
  const meta = await sharp(bytes).metadata();
  const W = meta.width ?? 0, H = meta.height ?? 0;
  const y0 = Math.max(0, Math.min(0.9, o.crop?.y0 ?? 0)), y1 = Math.max(y0 + 0.05, Math.min(1, o.crop?.y1 ?? 1));
  const bar = o.crop?.statusBar && y0 > 0 ? Math.round(H * o.crop.statusBar) : 0;
  const top = Math.round(H * y0), height = Math.round(H * (y1 - y0));
  const body = await sharp(bytes).extract({ left: 0, top, width: W, height }).png().toBuffer();
  let png = body;
  if (bar) {
    const strip = await sharp(bytes).extract({ left: 0, top: 0, width: W, height: bar }).png().toBuffer();
    png = await sharp({ create: { width: W, height: bar + height, channels: 4, background: "#ffffff" } }).composite([{ input: strip, top: 0, left: 0 }, { input: body, top: bar, left: 0 }]).png().toBuffer();
  }
  const outH = bar + height;
  const edge = await sharp(png).extract({ left: 0, top: Math.max(0, outH - 4), width: W, height: Math.min(4, outH) }).stats();
  const bg = `#${edge.channels.slice(0, 3).map((c) => Math.round(c.mean).toString(16).padStart(2, "0")).join("")}`;
  const focus = o.focus ? { x: o.focus.x, w: o.focus.w, y: (bar + (o.focus.y - y0) * H) / outH, h: (o.focus.h * H) / outH } : undefined;
  const small = await sharp(png).resize({ width: Math.min(W, 1100), withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  return { url: dataUrl(small.data, "image/png"), w: small.info.width, h: small.info.height, kind: "screen", bg, ...(o.id ? { id: o.id } : {}), ...(o.label ? { label: o.label } : {}), ...(focus ? { focus } : {}) };
}

export interface MaterialRow {
  id: string; kind: string; name: string | null; summary: string | null; storageKey: string | null;
  crop: string | null; focus: string | null; containsPerson: boolean | null; status: string | null; note?: string | null;
}

export interface Material { photos: Picture[]; screens: Picture[]; used: string[]; notes: string[] }

const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const json = <T,>(s: string | null): T | undefined => { try { return s ? (JSON.parse(s) as T) : undefined; } catch { return undefined; } };

// Ranks the business's own pictures against what the brief sells (shared words in the name and description), people last:
// a stranger's face on an ad needs their consent, which the library does not record.
export function rankMaterial(rows: MaterialRow[], about: string): MaterialRow[] {
  const want = new Set(words(about));
  const score = (r: MaterialRow) => words(`${r.name ?? ""} ${r.summary ?? ""} ${r.note ?? ""}`).filter((w) => want.has(w)).length - (r.containsPerson ? 5 : 0) + (r.status === "approved" ? 1 : 0);
  return [...rows].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}

// The business's own photos and app screens, from its own graph and its own directory (never another tenant's).
export async function findMaterial(g: Pick<GraphHandle, "roQuery">, store: AssetStore, tenant: string, o: { about: string; maxPhotos?: number; maxScreens?: number; include?: string[] }): Promise<Material> {
  const rows = await g.roQuery<MaterialRow>(
    `MATCH (a:BrandAsset) WHERE a.kind IN ['product-photo', 'past-design', 'app-screen'] AND a.storageKey IS NOT NULL AND coalesce(a.status, 'active') <> 'superseded'
     RETURN a.id AS id, a.kind AS kind, a.name AS name, a.summary AS summary, a.storageKey AS storageKey, a.crop AS crop, a.focus AS focus, a.containsPerson AS containsPerson, a.status AS status, a.note AS note
     ORDER BY a.id LIMIT 60`).catch(() => [] as MaterialRow[]);
  const approved = await g.roQuery<MaterialRow>(
    `MATCH (a:Asset) WHERE a.status = 'approved' AND a.kind IN ['original', 'variant', 'image'] AND a.storageKey IS NOT NULL
     RETURN a.id AS id, 'approved-photo' AS kind, a.name AS name, a.summary AS summary, a.storageKey AS storageKey, null AS crop, null AS focus, a.containsPerson AS containsPerson, a.status AS status
     ORDER BY a.id LIMIT 30`).catch(() => [] as MaterialRow[]);
  const include = new Set(o.include ?? []);
  const pick = (r: MaterialRow) => include.size === 0 || include.has(r.id);
  const photoRows = rankMaterial([...rows.filter((r) => r.kind !== "app-screen"), ...approved].filter(pick), o.about);
  const screenRows = rankMaterial(rows.filter((r) => r.kind === "app-screen").filter(pick), o.about);
  // an asked-for picture keeps the order it was asked in
  if (include.size) for (const list of [photoRows, screenRows]) list.sort((a, b) => [...include].indexOf(a.id) - [...include].indexOf(b.id));
  const out: Material = { photos: [], screens: [], used: [], notes: [] };
  for (const r of photoRows.slice(0, o.maxPhotos ?? 4)) {
    const bytes = r.storageKey ? store.get(tenant, r.storageKey) : null;
    if (!bytes) continue;
    // the caption under a photo is the owner's own words for it (a project's name), never the librarian's description
    const label = r.note && r.note.trim().length <= 40 ? r.note.trim() : undefined;
    out.photos.push(await photoPicture(bytes, { id: r.id, ...(label ? { label } : {}) }));
    out.used.push(r.id);
  }
  for (const r of screenRows.slice(0, o.maxScreens ?? 2)) {
    const bytes = r.storageKey ? store.get(tenant, r.storageKey) : null;
    if (!bytes) continue;
    const crop = json<ScreenCrop>(r.crop), focus = json<Picture["focus"]>(r.focus);
    out.screens.push(await screenPicture(bytes, { id: r.id, ...(crop ? { crop } : {}), ...(focus ? { focus } : {}) }));
    out.used.push(r.id);
  }
  if (photoRows.some((r) => r.containsPerson)) out.notes.push("Some of your photos show people; I kept them out unless nothing else fit, because I don't know if those people agreed to be in an ad.");
  return out;
}

// "Product photo: Retreat pool house" -> "Retreat pool house"
export const cleanLabel = (name: string): string => name.replace(/^(product photo|past design|app screen|photo)\s*[:\-–]\s*/i, "").replace(/\s*\((?:photo|screen)\)\s*$/i, "").trim().slice(0, 40);

// The scene prompt for a generated picture: this business, this place, the people who would really be there, and the
// layout's calm area. Nothing generic: no stock office, no laptop-on-a-desk, no words, no logos, no visible screen.
export function scenePrompt(o: { business: string; industry?: string; city?: string; country?: string; idea: string; audience?: string; aspect: string; calm: "top" | "bottom" | "left" | "right" | "none"; style?: string }): string {
  const where = [o.city, o.country].filter(Boolean).join(", ");
  const calm = o.calm === "none" ? "" : `Leave the ${o.calm} part of the frame calm and uncluttered (a plain wall, sky, floor or soft background) so words can be set there later.`;
  return [
    `A natural, photorealistic photograph, aspect ${o.aspect}, for ${o.business}${o.industry ? `, a ${o.industry} business` : ""}${where ? ` in ${where}` : ""}.`,
    `It shows: ${o.idea.trim()}.`,
    o.audience ? `The people in it are the kind of people this is for: ${o.audience}, ordinary and dignified, candid, not posed stock models.` : "",
    where ? `The place looks like ${where} today: real local streets, homes and workplaces, local clothing and light, nothing generic or Western-stock.` : "",
    o.style ? `Brand look: ${o.style}.` : "",
    calm,
    "One continuous photograph, no panels or collage. No writing anywhere: no letters, numbers, signs, posters, labels, logos or brand marks on clothes or objects. Any phone is seen from the back or the edge, its screen not visible. No laptops-on-a-desk office scene.",
  ].filter(Boolean).join(" ");
}
