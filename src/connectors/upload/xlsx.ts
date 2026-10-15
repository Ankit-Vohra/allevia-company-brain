// A small, dependency-free reader for .xlsx (a zip of XML parts). It reads only what a table of numbers needs:
// the sheet list, shared strings, which cell styles are dates, and the cell values. It is built to be safe on hostile
// input rather than complete:
//   - every part is unpacked with a hard output cap (zlib's maxOutputLength), whatever the zip claims about its size,
//     and the total is capped too, so a zip bomb stops with a plain error instead of eating memory;
//   - the zip's directory is bounded (entries, no zip64, no encryption), and nothing is ever written to disk;
//   - rows and columns are counted while reading, not afterwards.
// Dates are returned as ISO strings (YYYY-MM-DD) so the rest of the upload path sees one form; formulas give their
// last saved value. Old .xls (OLE2) files are refused with a plain "save as .xlsx" message.
import { inflateRawSync } from "node:zlib";
import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_PART_BYTES, MAX_ROWS, MAX_SHARED_STRINGS, MAX_UNPACKED_BYTES, MAX_ZIP_ENTRIES, UploadError, num } from "./limits.js";
import type { RawRow } from "./csv.js";

export const isZip = (b: Uint8Array): boolean => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05);
export const isOle = (b: Uint8Array): boolean => b.length > 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;

const unreadable = () => new UploadError("We couldn't open that file. It may be damaged or not a real spreadsheet. Save it again as .xlsx or .csv and send it once more.", "unreadable");

interface Entry { name: string; method: number; csize: number; offset: number }

function readDirectory(b: Buffer): Map<string, Entry> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65_535); i--) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw unreadable();
  const count = b.readUInt16LE(eocd + 10);
  const cdSize = b.readUInt32LE(eocd + 12);
  const cdOffset = b.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || count > MAX_ZIP_ENTRIES || cdOffset + cdSize > b.length) throw unreadable();
  const out = new Map<string, Entry>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw unreadable();
    const flags = b.readUInt16LE(p + 8);
    if (flags & 1) throw new UploadError("This spreadsheet is password-protected. Remove the password (File, Info, Protect Workbook) and send it again.", "locked");
    const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
    const name = b.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, { name, method: b.readUInt16LE(p + 10), csize: b.readUInt32LE(p + 20), offset: b.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

class Zip {
  private unpacked = 0;
  private entries: Map<string, Entry>;
  constructor(private b: Buffer) { this.entries = readDirectory(b); }
  has(name: string): boolean { return this.entries.has(name); }
  text(name: string): string | null {
    const e = this.entries.get(name);
    if (!e) return null;
    const p = e.offset;
    if (p + 30 > this.b.length || this.b.readUInt32LE(p) !== 0x04034b50) throw unreadable();
    const start = p + 30 + this.b.readUInt16LE(p + 26) + this.b.readUInt16LE(p + 28);
    if (start + e.csize > this.b.length) throw unreadable();
    const data = this.b.subarray(start, start + e.csize);
    let out: Buffer;
    try {
      if (e.method === 0) out = Buffer.from(data);
      else if (e.method === 8) out = inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES });
      else throw unreadable();
    } catch (err) {
      if (err instanceof UploadError) throw err;
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(String((err as Error).message))) throw tooBig();
      throw unreadable();
    }
    if (out.length > MAX_PART_BYTES) throw tooBig();
    this.unpacked += out.length;
    if (this.unpacked > MAX_UNPACKED_BYTES) throw tooBig();
    return out.toString("utf8");
  }
}
const tooBig = () => new UploadError("This spreadsheet is far too big once opened (it is packed very tightly). Send a smaller one: the date and the numbers you want us to track.", "unpacks_too_big");

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string): string => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
  if (g[0] === "#") {
    const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : "";
  }
  return ENTITIES[g.toLowerCase()] ?? m;
});
const textOf = (xml: string): string => {
  let out = "";
  for (const m of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) out += unescapeXml(m[1]!);
  return out;
};
const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
function isDateFormat(code: string): boolean {
  // quoted text, escaped characters and [colour]/[locale] sections are not part of the pattern; a date has a day or a year
  return /[dy]/.test(code.replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[[^\]]*\]/g, "").toLowerCase());
}

function dateStyles(styles: string | null): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], "numFmtId")), code = attr(m[0], "formatCode");
    if (Number.isFinite(id) && code !== undefined) custom.set(id, unescapeXml(code));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  let i = 0;
  for (const m of xfs.matchAll(/<xf\b[^>]*?(?:\/>|>)/g)) {
    const id = Number(attr(m[0], "numFmtId") ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)!))) out.add(i);
    i++;
  }
  return out;
}

const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

function serialToIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

export interface XlsxSheet { name: string; rows: RawRow[] }

// The first sheets with any data, at most `limit` of them read in full (the rest are named, not read).
export function readXlsx(bytes: Uint8Array, limit = 4): { sheets: XlsxSheet[]; allNames: string[] } {
  if (isOle(bytes)) {
    throw new UploadError("This is an old Excel file (.xls). Open it in Excel or Sheets and choose Save As .xlsx (or .csv), then send it again.", "old_excel");
  }
  if (!isZip(bytes)) throw unreadable();
  const zip = new Zip(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const workbook = zip.text("xl/workbook.xml");
  if (!workbook) throw unreadable();
  const rels = zip.text("xl/_rels/workbook.xml.rels") ?? "";
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id"), t = attr(m[0], "Target");
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`);
  }
  const date1904 = /<workbookPr\b[^>]*date1904="(?:1|true)"/i.test(workbook);
  const listed = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unescapeXml(attr(m[0], "name") ?? "Sheet"), part: target.get(attr(m[0], "r:id") ?? attr(m[0], "id") ?? "") ?? "",
  })).filter((s) => s.part);
  if (!listed.length) throw unreadable();

  const strings: string[] = [];
  const sst = zip.text("xl/sharedStrings.xml");
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
      strings.push(m[1] === undefined ? "" : textOf(m[1]).slice(0, MAX_CELL_CHARS));
      if (strings.length > MAX_SHARED_STRINGS) throw tooBig();
    }
  }
  const dates = dateStyles(zip.text("xl/styles.xml"));

  const sheets: XlsxSheet[] = [];
  for (const s of listed) {
    if (sheets.length >= limit) break;
    const xml = zip.text(s.part);
    if (!xml) continue;
    sheets.push({ name: s.name, rows: readSheet(xml, strings, dates, date1904) });
  }
  return { sheets, allNames: listed.map((s) => s.name) };
}

function readSheet(xml: string, strings: string[], dates: Set<number>, date1904: boolean): RawRow[] {
  const rows: RawRow[] = [];
  let seen = 0;
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const body = rm[1];
    if (body === undefined) continue;
    if (++seen > MAX_ROWS + 60) throw new UploadError(`This file has more than ${num(MAX_ROWS)} rows. Send one row per day or per week, or just the last year or so.`, "too_many_rows");
    const row: RawRow = [];
    let next = 0;
    for (const cm of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = cm[1]!, inner = cm[2] ?? "";
      const ref = attr(head, "r");
      const at = ref ? colIndex(ref) : next;
      if (at >= MAX_COLUMNS) { if (inner && /<v>|<is>/.test(inner)) throw new UploadError(`This file has more than ${MAX_COLUMNS} columns. Keep the date and the numbers you want us to track, then send it again.`, "too_many_columns"); continue; }
      next = at + 1;
      const t = attr(head, "t") ?? "n";
      const style = Number(attr(head, "s") ?? 0);
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let cell: string | number | null = null;
      if (t === "inlineStr") cell = textOf(inner).slice(0, MAX_CELL_CHARS).trim() || null;
      else if (v !== undefined) {
        if (t === "s") cell = (strings[Number(v)] ?? "").trim() || null;
        else if (t === "str") cell = unescapeXml(v).slice(0, MAX_CELL_CHARS).trim() || null;
        else if (t === "b") cell = v === "1" ? 1 : 0;
        else if (t === "e") cell = null;
        else {
          const n = Number(v);
          cell = !Number.isFinite(n) ? null : dates.has(style) ? serialToIso(n, date1904) : n;
        }
      }
      while (row.length < at) row.push(null);
      row[at] = cell;
    }
    if (row.some((c) => c !== null)) rows.push(row);
  }
  return rows;
}
