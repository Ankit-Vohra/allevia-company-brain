// Studio intake (product design §6, step 1): the owner's photo becomes an Asset{kind:'original'}. The bytes are
// re-encoded without metadata (normalizeUpload: no EXIF GPS), stored under data/assets/<tenant>/ by content address,
// fingerprinted (sha256, dHash, w×h), and AUTHORED by the owner. The Asset id comes from the content hash, so the same
// photo sent twice is one Asset. The caller streams the `asset` event this returns.
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { entityId } from "../util/ids.js";
import { normalizeUpload, sha256Hex, type NormalizeOpts, type Normalized } from "./image.js";
import type { AssetStore } from "./store.js";

export const OWNER_FALLBACK = "person:owner";

export interface AssetRecord {
  id: string;
  kind: "original" | "variant" | "final";
  w: number;
  h: number;
  sha256: string;
  dhash: string;
  storageKey: string;
  mime: string;
}

export interface IntakeInput {
  tenant: string;
  bytes: Buffer;
  note?: string;
  ownerId?: string | null;   // the Person who sent it (the business owner when known)
  filename?: string;
}

export const assetUrl = (tenant: string, id: string, w?: number): string =>
  `/api/${encodeURIComponent(tenant)}/assets/${encodeURIComponent(id)}${w ? `?w=${w}` : ""}`;

export const assetIdFor = (sha256: string): string => entityId("Asset", sha256.slice(0, 24));

export interface IntakeResult { asset: AssetRecord; normalized: Normalized; event: Extract<AgentEvent, { type: "asset" }> }

// persist:false holds the photo in memory only (content trial 2026-10-15): the pipeline decides after Tara's look whether
// the photo may be kept at all, and in what form (keepOriginal), so an unblurred person never reaches the disk.
export async function intake(
  g: GraphHandle, input: IntakeInput, deps: { store: AssetStore; now: number; agent: string; normalize?: NormalizeOpts; persist?: boolean },
): Promise<IntakeResult> {
  const n = await normalizeUpload(input.bytes, deps.normalize);
  const persist = deps.persist !== false;
  const storageKey = persist ? deps.store.put(input.tenant, n.sha256, n.buffer) : "";
  const id = assetIdFor(n.sha256);
  const note = input.note?.trim().slice(0, 500);
  await upsertNode(g, {
    type: "Asset", id, name: note ? `Photo: ${note.slice(0, 60)}` : `Photo ${n.sha256.slice(0, 8)}`,
    props: {
      kind: "original", mediaType: "image", mime: n.mime, w: n.w, h: n.h, bytes: n.bytes, sha256: n.sha256, dhash: n.dhash,
      ...(persist ? { storageKey } : {}), source: "upload", aiEdited: false, iptcSourceType: "digitalCapture", consent: false, status: persist ? "new" : "received",
      metadataStripped: true, ...(note ? { note } : {}),
    },
  }, deps.now);
  const owner = input.ownerId ?? OWNER_FALLBACK;
  const [exists] = await g.roQuery<{ c: number }>("MATCH (p:Entity:Person {id:$id}) RETURN count(p) AS c", { id: owner });
  if (!exists?.c) await upsertNode(g, { type: "Person", id: owner, name: owner === OWNER_FALLBACK ? "Owner" : owner }, deps.now);
  await upsertEdge(g, { from: owner, type: "AUTHORED", to: id, props: { via: "studio-upload" } }, deps.now);
  const asset: AssetRecord = { id, kind: "original", w: n.w, h: n.h, sha256: n.sha256, dhash: n.dhash, storageKey, mime: n.mime };
  return { asset, normalized: n, event: { type: "asset", agent: deps.agent, assetId: id, kind: "original", thumb: assetUrl(input.tenant, id, 640) } };
}

// Keeps the owner's photo, in the form privacy allows: the bytes as they are, or (with privacy boxes) the same frame with
// every box blurred, so a person or a plate is never on disk unblurred. The Asset keeps the original's fingerprint
// (sha256, dHash) as its identity; storageKey points at what was actually kept.
export async function keepOriginal(
  g: GraphHandle, o: { tenant: string; asset: AssetRecord; kept: Buffer; redacted: boolean; containsPerson: boolean; store: AssetStore; now: number },
): Promise<AssetRecord> {
  const storageKey = o.store.put(o.tenant, sha256Hex(o.kept), o.kept);
  const [row] = await g.roQuery<{ name: string }>("MATCH (x:Entity:Asset {id:$id}) RETURN x.name AS name", { id: o.asset.id });
  await upsertNode(g, {
    type: "Asset", id: o.asset.id, name: row?.name ?? o.asset.id,
    props: { storageKey, status: "new", ...(o.redacted ? { privacyRedacted: true } : {}), ...(o.containsPerson ? { containsPerson: true } : {}) },
  }, o.now);
  return { ...o.asset, storageKey };
}

// The photo is not kept at all (a possible minor, or people who cannot be blurred). The Asset stays as a record that a photo
// was received and why it was refused; it holds no file and nothing about what the photo showed.
export async function blockOriginal(g: GraphHandle, o: { asset: AssetRecord; reason: string; now: number }): Promise<void> {
  const [row] = await g.roQuery<{ name: string }>("MATCH (x:Entity:Asset {id:$id}) RETURN x.name AS name", { id: o.asset.id });
  await upsertNode(g, { type: "Asset", id: o.asset.id, name: row?.name ?? o.asset.id, props: { status: "blocked", blockedReason: o.reason } }, o.now);
}
