// A picture or a video, reachable from the internet for a few minutes, so Instagram and Facebook can fetch it. Both platforms post
// from a PUBLIC address (Composio has no upload for either), so the server hands out one address per file:
//   <ALLEVIA_WEB_URL>/m/<token>   token = signed { business, asset, expiry }, made with the connector key
// The token names one file of one business and runs out (an hour by default); it can't be changed, moved to another business or
// made to name another file, and it is only ever made when a post the owner approved is being posted. Nothing else is served here.
import type { Hono } from "hono";
import sharp from "sharp";
import { signState, verifyState } from "../connectors/google/crypto.js";
import type { GraphHandle } from "../graph/client.js";
import { isTenantSlug } from "../graph/slug.js";
import type { AssetStore } from "../studio/store.js";

export const MEDIA_TTL_MS = 60 * 60_000;

export interface MediaSigner { key: string; base: string; now: () => number }

/** The address a platform fetches the file from. `as: "jpeg"`: a PNG is served as a JPEG (Instagram takes JPEG pictures only). */
export function signMediaUrl(d: MediaSigner, o: { tenant: string; assetId: string; ttlMs?: number; as?: "jpeg" }): string {
  const token = signState(d.key, { k: "media", t: o.tenant, a: o.assetId, e: d.now() + (o.ttlMs ?? MEDIA_TTL_MS), ...(o.as ? { f: o.as } : {}) });
  return `${d.base.replace(/\/+$/, "")}/m/${token}`;
}

export interface MediaToken { tenant: string; assetId: string; as?: "jpeg" }

export function verifyMediaToken(key: string, token: string, now: number): MediaToken | null {
  const p = verifyState<{ k: string; t: string; a: string; e: number; f?: string }>(key, token);
  if (!p || p.k !== "media" || typeof p.t !== "string" || typeof p.a !== "string" || typeof p.e !== "number" || p.e < now) return null;
  return { tenant: p.t, assetId: p.a, ...(p.f === "jpeg" ? { as: "jpeg" as const } : {}) };
}

/** Why a platform could not fetch from this server's address, in words for the person setting it up; null when it looks public. */
export function publicAddressProblem(base: string): string | null {
  let host = "";
  try { host = new URL(base).hostname.toLowerCase(); } catch { return `ALLEVIA_WEB_URL (${base || "empty"}) isn't an address.`; }
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "::1" || host === "[::1]" || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) || host === "0.0.0.0" || !host.includes(".");
  return local ? `This server's address (${host}) can only be reached from inside its own network, so Instagram and Facebook can't fetch the picture from it. Set ALLEVIA_WEB_URL to the address the internet reaches Allevia at.` : null;
}

export interface MediaWiring {
  key: string;
  store: AssetStore;
  openGraph: (slug: string) => Promise<GraphHandle>;
  now: () => number;
}

// GET /m/:token. Every refusal is the same 404, so a guess learns nothing.
export function registerMediaRoute(app: Hono, wiring: () => Promise<MediaWiring | null>): void {
  app.get("/m/:token", async (c) => {
    const w = await wiring();
    const t = w && w.key.length >= 32 ? verifyMediaToken(w.key, c.req.param("token"), w.now()) : null;
    if (!w || !t || !isTenantSlug(t.tenant)) return c.notFound();
    const g = await w.openGraph(t.tenant);
    const [row] = await g.roQuery<{ key: string | null; mime: string | null }>("MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.mime AS mime LIMIT 1", { id: t.assetId });
    if (!row?.key) return c.notFound();
    let bytes = w.store.get(t.tenant, row.key);
    if (!bytes) return c.notFound();
    let mime = row.mime ?? "application/octet-stream";
    if (t.as === "jpeg" && mime === "image/png") {
      bytes = await sharp(bytes).flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
      mime = "image/jpeg";
    }
    return c.body(new Uint8Array(bytes), 200, { "Content-Type": mime, "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=300" });
  });
}
