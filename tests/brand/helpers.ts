// Shared helpers for the brand and creative tests: synthetic logos, a tiny hand-built TrueType font (a `name` table
// only: enough to be recognised and named, never drawn), and a throwaway data dir.
import sharp from "sharp";

// A crisp wordmark-like logo with a transparent background.
export async function crispLogo(w = 1200, h = 400): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${w * 0.05}" y="${h * 0.2}" width="${h * 0.6}" height="${h * 0.6}" fill="#a8542e"/>
    <rect x="${w * 0.3}" y="${h * 0.35}" width="${w * 0.55}" height="${h * 0.08}" fill="#191714"/>
    <rect x="${w * 0.3}" y="${h * 0.55}" width="${w * 0.4}" height="${h * 0.08}" fill="#191714"/>
    <circle cx="${w * 0.9}" cy="${h * 0.5}" r="${h * 0.2}" fill="none" stroke="#191714" stroke-width="${h * 0.04}"/>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// The same drawing, blown up from a small version: soft edges, the way a thumbnail looks stretched.
export async function blurryLogo(): Promise<Buffer> {
  const small = await sharp(await crispLogo(1200, 400)).resize(80).png().toBuffer();
  return sharp(small).resize(1200, 400, { kernel: "cubic" }).blur(2).png().toBuffer();
}

export const svgLogo = (): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100"><rect width="300" height="100" fill="none"/><circle cx="50" cy="50" r="30" fill="#a8542e"/><rect x="100" y="40" width="160" height="20" fill="#191714"/></svg>`;

export async function photo(w = 1200, h = 900, colour = "#8da2b8"): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: colour } })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${w * 0.2}" y="${h * 0.3}" width="${w * 0.5}" height="${h * 0.5}" fill="#5d4a3a"/></svg>`) }])
    .jpeg({ quality: 88 })
    .withExif({ IFD0: { Make: "TestCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 27/1 0/1" } })
    .toBuffer();
}

// A TrueType file that only holds a `name` table with the given family (nameID 1) and full name (nameID 4).
export function tinyFont(family: string, kind: "ttf" | "otf" = "ttf"): Buffer {
  const strings: Array<[number, string]> = [[1, family], [2, "Regular"], [4, `${family} Regular`]];
  const rec = (id: number, s: string, off: number): { r: Buffer; data: Buffer } => {
    const data = Buffer.from(s, "utf16le").swap16();
    const r = Buffer.alloc(12);
    r.writeUInt16BE(3, 0); r.writeUInt16BE(1, 2); r.writeUInt16BE(0x409, 4); r.writeUInt16BE(id, 6); r.writeUInt16BE(data.length, 8); r.writeUInt16BE(off, 10);
    return { r, data };
  };
  let off = 0;
  const parts = strings.map(([id, s]) => { const p = rec(id, s, off); off += p.data.length; return p; });
  const head = Buffer.alloc(6);
  head.writeUInt16BE(0, 0); head.writeUInt16BE(parts.length, 2); head.writeUInt16BE(6 + 12 * parts.length, 4);
  const table = Buffer.concat([head, ...parts.map((p) => p.r), ...parts.map((p) => p.data)]);
  const dir = Buffer.alloc(12 + 16);
  if (kind === "otf") dir.write("OTTO", 0, "latin1"); else dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(1, 4);
  dir.write("name", 12, "latin1");
  dir.writeUInt32BE(0, 16);
  dir.writeUInt32BE(28, 20);
  dir.writeUInt32BE(table.length, 24);
  return Buffer.concat([dir, table]);
}
