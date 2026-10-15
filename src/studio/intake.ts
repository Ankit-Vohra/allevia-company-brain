// Studio intake (product design §6, step 1): the owner's photo becomes an Asset{kind:'original'}. The bytes are
// re-encoded without metadata (normalizeUpload: no EXIF GPS), stored under data/assets/<tenant>/ by content address,
// fingerprinted (sha256, dHash, w×h), and AUTHORED by the owner. The Asset id comes from the content hash, so the same
// photo sent twice is one Asset. The caller streams the `asset` event this returns.
import type { AgentEvent } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { entityId } from "../util/ids.js";
import { normalizeUpload, type NormalizeOpts, type Normalized } from "./image.js";
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

export async function intake(
  g: GraphHandle, input: IntakeInput, deps: { store: AssetStore; now: number; agent: string; normalize?: NormalizeOpts },
): Promise<IntakeResult> {
  const n = await normalizeUpload(input.bytes, deps.normalize);
  const storageKey = deps.store.put(input.tenant, n.sha256, n.buffer);
  const id = assetIdFor(n.sha256);
  const note = input.note?.trim().slice(0, 500);
  await upsertNode(g, {
    type: "Asset", id, name: note ? `Photo: ${note.slice(0, 60)}` : `Photo ${n.sha256.slice(0, 8)}`,
    props: {
      kind: "original", mediaType: "image", mime: n.mime, w: n.w, h: n.h, bytes: n.bytes, sha256: n.sha256, dhash: n.dhash,
      storageKey, source: "upload", aiEdited: false, iptcSourceType: "digitalCapture", consent: false, status: "new",
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
