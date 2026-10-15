// What Discord attachments the team will pick up from a message, and how they are fetched. A message can carry a link
// to any file, so the rules are strict and live in one place:
//  - at most 4 attachments per message (the rest are left alone, and the owner is told);
//  - the address must be https on exactly cdn.discordapp.com or media.discordapp.net, with no user name, password or odd
//    port; redirects are followed by hand (at most 3) and every hop is held to the same rule;
//  - photos: JPEG, PNG or WebP, up to 10 MB (the Studio's own upload limit is 20 MB; Discord's own is 10 MB); videos:
//    MP4, MOV or WebM, up to 25 MB;
//  - the size is checked before downloading (what Discord says), while downloading (the bytes actually received, so a
//    wrong or missing length cannot slip through), and the content type the server answers with must match;
//  - what arrives is then read as an image by the Studio itself (studio/image.ts normalizeUpload), which refuses anything
//    that is not one and strips EXIF and other metadata.
// Messages to the owner are plain words.

export const ALLOWED_HOSTS: readonly string[] = ["cdn.discordapp.com", "media.discordapp.net"];
export const MAX_ATTACHMENTS = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024; // brand files: a PDF guide, a font, an SVG (the brand library re-checks each by its bytes)
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 30_000;

export interface AttachmentRef { url: string; name: string; size: number; contentType: string | null }
export type MediaKind = "image" | "video" | "file";

export class AttachmentRejected extends Error {
  override name = "AttachmentRejected";
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const EXT: Record<string, MediaKind> = { jpg: "image", jpeg: "image", png: "image", webp: "image", mp4: "video", mov: "video", webm: "video" };

// A brand file the library takes besides photos: a PDF guide, a TrueType/OpenType font, an SVG logo. Discord's own content
// type for these is often generic, so the name counts too; the bytes decide what it really is (brand/sniff.ts).
const FILE_TYPES = new Set(["application/pdf", "font/ttf", "font/otf", "font/sfnt", "application/x-font-ttf", "application/x-font-otf", "application/font-sfnt", "image/svg+xml"]);
const FILE_EXT = new Set(["pdf", "ttf", "otf", "svg"]);
export function isBrandFile(a: Pick<AttachmentRef, "name" | "contentType">): boolean {
  const t = baseType(a.contentType);
  if (FILE_TYPES.has(t)) return true;
  if (t && t !== "application/octet-stream" && !t.startsWith("font/")) return false;
  return FILE_EXT.has((/\.([a-z0-9]+)$/i.exec(a.name)?.[1] ?? "").toLowerCase());
}
export function pickBrandFiles(files: AttachmentRef[] | undefined): Array<AttachmentRef & { kind: "file" }> {
  return (files ?? []).filter((f) => mediaKind(f) === null && isBrandFile(f)).map((f) => ({ ...f, kind: "file" as const }));
}

const baseType = (t: string | null | undefined): string => (t ?? "").split(";")[0]!.trim().toLowerCase();

// Photo, video, or neither, from what Discord says the file is (its type, else its name).
export function mediaKind(a: Pick<AttachmentRef, "name" | "contentType">): MediaKind | null {
  const t = baseType(a.contentType);
  if (IMAGE_TYPES.has(t)) return "image";
  if (VIDEO_TYPES.has(t)) return "video";
  if (t.startsWith("image/") || t.startsWith("video/")) return null; // a type we do not take (HEIC, GIF, AVI ...)
  return EXT[(/\.([a-z0-9]+)$/i.exec(a.name)?.[1] ?? "").toLowerCase()] ?? null;
}

// The photos and videos worth working on, at most four, and how many were set aside.
export function pickMedia(files: AttachmentRef[] | undefined): { picked: Array<AttachmentRef & { kind: MediaKind }>; extra: number; other: number } {
  const all = files ?? [];
  const media = all.map((f) => ({ f, kind: mediaKind(f) })).filter((x): x is { f: AttachmentRef; kind: MediaKind } => x.kind !== null);
  return { picked: media.slice(0, MAX_ATTACHMENTS).map((x) => ({ ...x.f, kind: x.kind })), extra: Math.max(0, media.length - MAX_ATTACHMENTS), other: all.length - media.length };
}

// https on an allowed host and nothing else.
export function checkAttachmentUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AttachmentRejected("I can't open that file's address.");
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) {
    throw new AttachmentRejected("I only pick up files that were uploaded to Discord itself, so I did not open that one.");
  }
  return u;
}

export type FetchFn = (url: string, init: { redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

const tooBig = (kind: MediaKind, max: number): AttachmentRejected =>
  new AttachmentRejected(`That ${kind === "image" ? "photo" : kind === "file" ? "file" : "video"} is too large: send one under ${Math.round(max / (1024 * 1024))} MB.`);

export async function downloadAttachment(
  a: AttachmentRef & { kind: MediaKind }, o: { fetch?: FetchFn } = {},
): Promise<Buffer> {
  const max = a.kind === "image" ? MAX_IMAGE_BYTES : a.kind === "file" ? MAX_FILE_BYTES : MAX_VIDEO_BYTES;
  if (a.size > max) throw tooBig(a.kind, max);
  const doFetch: FetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  let url = checkAttachmentUrl(a.url);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res: Response | undefined;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    res = await doFetch(url.toString(), { redirect: "manual", signal, headers: { accept: a.kind === "image" ? "image/*" : a.kind === "file" ? "*/*" : "video/*" } }).catch(() => {
      throw new AttachmentRejected("I couldn't download that file from Discord. Try sending it again.");
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc || hop === MAX_REDIRECTS) throw new AttachmentRejected("I couldn't download that file from Discord. Try sending it again.");
      url = checkAttachmentUrl(new URL(loc, url).toString()); // every hop is held to the same rule
      continue;
    }
    break;
  }
  if (!res || !res.ok || !res.body) throw new AttachmentRejected("I couldn't download that file from Discord. Try sending it again.");

  const served = baseType(res.headers.get("content-type"));
  // a brand file's type is whatever Discord's host says (often generic): the library reads the bytes to know what it is
  const okType = a.kind === "image" ? IMAGE_TYPES.has(served) : a.kind === "file" ? true : VIDEO_TYPES.has(served);
  if (!okType) {
    throw new AttachmentRejected(a.kind === "image"
      ? "That file is not a photo I can use. Send a JPEG, PNG or WebP photo."
      : "That file is not a video I can keep. Send an MP4, MOV or WebM video.");
  }
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) throw tooBig(a.kind, max);

  const chunks: Uint8Array[] = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > max) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(a.kind, max);
    }
    chunks.push(value);
  }
  if (!got) throw new AttachmentRejected("That file arrived empty. Try sending it again.");
  return Buffer.concat(chunks);
}
