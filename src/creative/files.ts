// The file behind a made Asset, for posting back to the owner (Discord attachments) or serving to the web app. Reads the
// storage key from the business's own graph and the bytes from that business's own directory, so a business can only ever
// reach its own files.
import type { GraphHandle } from "../graph/client.js";
import type { AssetStore } from "../studio/store.js";

export interface AssetFile { name: string; data: Buffer; mime: string }

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "video/mp4": "mp4" };

export async function loadAssetFile(g: Pick<GraphHandle, "roQuery">, store: AssetStore, tenant: string, assetId: string, name?: string): Promise<AssetFile | null> {
  const [row] = await g.roQuery<{ key: string | null; mime: string | null; kind: string | null; label: string | null }>(
    "MATCH (a:Entity:Asset {id:$id}) RETURN a.storageKey AS key, a.mime AS mime, a.kind AS kind, a.label AS label", { id: assetId });
  if (!row?.key) return null;
  const data = store.get(tenant, row.key);
  if (!data) return null;
  const mime = row.mime ?? "image/jpeg";
  return { data, mime, name: name ?? `${row.kind ?? "file"}-${(row.label ?? "a").toLowerCase()}.${EXT[mime] ?? "bin"}` };
}
