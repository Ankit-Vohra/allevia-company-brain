// What a file really is, read from its first bytes. A file name or a claimed content type is a hint at best, so nothing
// here looks at them. Also a small reader for a font's family name (the TrueType/OpenType `name` table), so an uploaded
// font can be matched to the family the brand guide names.
export type FileType = "png" | "jpeg" | "webp" | "svg" | "pdf" | "ttf" | "otf" | "woff" | "woff2" | "unknown";

export function sniffType(b: Buffer): FileType {
  if (b.length < 4) return "unknown";
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  const tag = b.toString("latin1", 0, 4);
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (b.readUInt32BE(0) === 0x00010000 || tag === "true") return "ttf";
  // svg is text: look at the first few hundred bytes only
  const head = b.toString("utf8", 0, Math.min(b.length, 600)).replace(/^﻿/, "").trimStart();
  if (/^<svg[\s>]/i.test(head) || (/^<\?xml/i.test(head) && /<svg[\s>]/i.test(head))) return "svg";
  return "unknown";
}

// The weight class a font file declares (OS/2 usWeightClass: 400 regular, 700 bold), or null.
export function fontWeight(b: Buffer): number | null {
  try {
    if (b.length < 12) return null;
    const count = b.readUInt16BE(4);
    for (let i = 0; i < count && i < 64; i++) {
      const at = 12 + i * 16;
      if (at + 16 > b.length) return null;
      if (b.toString("latin1", at, at + 4) !== "OS/2") continue;
      const off = b.readUInt32BE(at + 8);
      if (off + 6 > b.length) return null;
      const w = b.readUInt16BE(off + 4);
      return w >= 100 && w <= 1000 ? w : null;
    }
  } catch { /* not a font we can read */ }
  return null;
}

// The font's family name (nameID 16, else 1) from a TrueType/OpenType file; null when it cannot be read.
export function fontFamilyName(b: Buffer): string | null {
  try {
    if (b.length < 12) return null;
    const count = b.readUInt16BE(4);
    for (let i = 0; i < count && i < 64; i++) {
      const at = 12 + i * 16;
      if (at + 16 > b.length) return null;
      if (b.toString("latin1", at, at + 4) !== "name") continue;
      const off = b.readUInt32BE(at + 8);
      const len = b.readUInt32BE(at + 12);
      if (off + len > b.length || len < 6) return null;
      const n = b.readUInt16BE(off + 2);
      const strOff = off + b.readUInt16BE(off + 4);
      const names = new Map<number, string>();
      for (let r = 0; r < n && r < 200; r++) {
        const p = off + 6 + r * 12;
        if (p + 12 > off + len) break;
        const platform = b.readUInt16BE(p);
        const id = b.readUInt16BE(p + 6);
        const slen = b.readUInt16BE(p + 8);
        const soff = strOff + b.readUInt16BE(p + 10);
        if (soff + slen > b.length || (id !== 1 && id !== 16)) continue;
        // platform 3 (Windows) and 0 (Unicode) are UTF-16BE; platform 1 (Mac) is single-byte Roman
        const text = platform === 1 ? b.toString("latin1", soff, soff + slen) : Buffer.from(b.subarray(soff, soff + slen)).swap16().toString("utf16le");
        if (text.trim() && (!names.has(id) || platform === 3)) names.set(id, text.trim());
      }
      return names.get(16) ?? names.get(1) ?? null;
    }
    return null;
  } catch {
    return null;
  }
}
