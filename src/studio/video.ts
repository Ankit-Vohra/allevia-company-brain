// Videos from the owner (Discord's #studio, or anywhere else the Studio is reached). Honest about what exists today:
//  - the upload is kept as a raw Asset{kind:'original', mediaType:'video'}, content-addressed like a photo, AUTHORED by the
//    owner, never edited or restyled (there is no video editing in the Studio yet);
//  - if ffmpeg is on this machine: the file's metadata (location, device) is removed without re-encoding it, and its FIRST
//    FRAME is assessed by Tara the same way a photo is (her assessment is kept on the video Asset);
//  - if it is not: the file is kept as it is, nothing is looked at, and the owner is told so in plain words.
// ffmpeg is reached through a small port, so tests run with and without it. Nothing leaves this machine.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { ensureRoster } from "../agent/memory.js";
import { assessPhoto, type PhotoAssessment } from "./assess.js";
import { loadStudioContext } from "./context.js";
import { normalizeUpload, sha256Hex } from "./image.js";
import { assetIdFor, OWNER_FALLBACK, type AssetRecord } from "./intake.js";
import { assessContextFor, DEFAULT_MODELS, type StudioModels } from "./pipeline.js";
import type { AssetStore } from "./store.js";
import type { VisionRunner } from "./vision.js";

export type VideoExt = "mp4" | "mov" | "webm";
export const VIDEO_MIME: Record<string, VideoExt> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };

export class VideoRejected extends Error {
  override name = "VideoRejected";
}

export interface Ffmpeg {
  available(): Promise<boolean>;
  /** The first frame as a JPEG, or null when it cannot be read. */
  firstFrame(bytes: Buffer, ext: VideoExt): Promise<Buffer | null>;
  /** The same video with its metadata removed (streams copied, not re-encoded), or null when that cannot be done. */
  stripMetadata(bytes: Buffer, ext: VideoExt): Promise<Buffer | null>;
}

// The container must look like what it claims to be: MP4 and MOV start with a box header, WebM with an EBML header.
export function sniffVideo(bytes: Buffer): VideoExt | null {
  if (bytes.length > 12 && ["ftyp", "moov", "mdat", "wide", "free", "skip"].includes(bytes.subarray(4, 8).toString("latin1"))) {
    return bytes.subarray(8, 12).toString("latin1") === "qt  " ? "mov" : "mp4";
  }
  if (bytes.length > 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  return null;
}

const run = (bin: string, args: string[], timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => { execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (e) => (e ? reject(e) : resolve())); });

export function realFfmpeg(bin = process.env.ALLEVIA_FFMPEG || "ffmpeg"): Ffmpeg {
  let has: Promise<boolean> | undefined;
  const withTemp = async <T>(bytes: Buffer, ext: VideoExt, fn: (dir: string, input: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "allevia-video-"));
    try {
      const input = join(dir, `in.${ext}`);
      await writeFile(input, bytes, { mode: 0o600 });
      return await fn(dir, input);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return {
    available: () => (has ??= run(bin, ["-version"], 10_000).then(() => true, () => false)),
    async firstFrame(bytes, ext) {
      return withTemp(bytes, ext, async (dir, input) => {
        const out = join(dir, "frame.jpg");
        try {
          await run(bin, ["-v", "error", "-y", "-i", input, "-frames:v", "1", "-q:v", "2", out], 60_000);
          return await readFile(out);
        } catch {
          return null;
        }
      });
    },
    async stripMetadata(bytes, ext) {
      return withTemp(bytes, ext, async (dir, input) => {
        const out = join(dir, `out.${ext}`);
        try {
          await run(bin, ["-v", "error", "-y", "-i", input, "-map_metadata", "-1", "-map_chapters", "-1", "-c", "copy", ...(ext === "webm" ? [] : ["-movflags", "+faststart"]), out], 120_000);
          return await readFile(out);
        } catch {
          return null;
        }
      });
    },
  };
}

export interface StoredVideo { asset: AssetRecord & { mediaType: "video" }; stripped: boolean; hasFfmpeg: boolean; frame: Buffer | null }

export async function storeVideo(
  g: GraphHandle, input: { tenant: string; bytes: Buffer; mime: string; note?: string; ownerId?: string | null },
  deps: { store: AssetStore; now: number; ffmpeg: Ffmpeg },
): Promise<StoredVideo> {
  const want = VIDEO_MIME[input.mime.split(";")[0]!.trim().toLowerCase()];
  const got = sniffVideo(input.bytes);
  if (!want || !got || (want === "webm") !== (got === "webm")) throw new VideoRejected("That file is not a video I can keep. Send an MP4, MOV or WebM video.");
  const ext: VideoExt = got === "webm" ? "webm" : want;
  const hasFfmpeg = await deps.ffmpeg.available();
  const clean = hasFfmpeg ? await deps.ffmpeg.stripMetadata(input.bytes, ext) : null;
  const bytes = clean ?? input.bytes;
  const sha = sha256Hex(bytes);
  const storageKey = deps.store.put(input.tenant, sha, bytes, ext);
  const id = assetIdFor(sha);
  const note = input.note?.trim().slice(0, 500);
  await upsertNode(g, {
    type: "Asset", id, name: note ? `Video: ${note.slice(0, 60)}` : `Video ${sha.slice(0, 8)}`,
    props: {
      kind: "original", mediaType: "video", mime: ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4", bytes: bytes.length, sha256: sha,
      storageKey, source: "upload", aiEdited: false, consent: false, status: "new", metadataStripped: !!clean, ...(note ? { note } : {}),
    },
  }, deps.now);
  const owner = input.ownerId ?? OWNER_FALLBACK;
  const [exists] = await g.roQuery<{ c: number }>("MATCH (p:Entity:Person {id:$id}) RETURN count(p) AS c", { id: owner });
  if (!exists?.c) await upsertNode(g, { type: "Person", id: owner, name: owner === OWNER_FALLBACK ? "Owner" : owner }, deps.now);
  await upsertEdge(g, { from: owner, type: "AUTHORED", to: id, props: { via: "studio-upload" } }, deps.now);
  const frame = hasFfmpeg ? await deps.ffmpeg.firstFrame(bytes, ext) : null;
  return { asset: { id, kind: "original", w: 0, h: 0, sha256: sha, dhash: "", storageKey, mime: "video/mp4", mediaType: "video" }, stripped: !!clean, hasFfmpeg, frame };
}

// Tara looks at the video's first frame the way she looks at a photo; her assessment is kept on the video Asset.
export async function assessFirstFrame(
  g: GraphHandle, o: { businessId: string; assetId: string; frame: Buffer; note?: string },
  deps: { vision: VisionRunner; models?: Partial<StudioModels>; now: number },
): Promise<PhotoAssessment> {
  await ensureRoster(g, { businessId: o.businessId }, deps.now); // Tara has to exist in the graph to review anything
  const norm = await normalizeUpload(o.frame, { minSide: 64 });
  const ctx = await loadStudioContext(g, o.businessId, o.note ?? "");
  return assessPhoto(g, o.assetId, norm.buffer, assessContextFor(ctx, o.note?.trim() ?? "", norm), { vision: deps.vision, model: { ...DEFAULT_MODELS, ...deps.models }.assess, now: deps.now });
}
