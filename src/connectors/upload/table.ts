// A file as a table: a header row and data rows, whatever the format. The caps are enforced here, on the way in.
import { parseCsv, decodeText, type RawRow } from "./csv.js";
import { MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS, UploadError, num } from "./limits.js";
import { cellKind } from "./numbers.js";
import { isOle, isZip, readXlsx } from "./xlsx.js";

export type Cell = string | number | null;

export interface Table {
  headers: string[];            // one per column; "" when the sheet left it blank
  rows: Cell[][];               // data rows, each as long as `headers`
  sheet?: string;               // the sheet read (XLSX)
  otherSheets?: string[];       // sheets not read
  headerRow: number;            // 0-based index in the file of the header line
}

// The header is the first line (within the first 12) with at least two text cells, followed by a line that has data. A
// title line ("Weekly report") above it, or a one-cell note, is skipped.
function findHeader(rows: RawRow[]): number {
  const limit = Math.min(rows.length - 1, 12);
  for (let i = 0; i <= limit; i++) {
    const r = rows[i]!;
    const filled = r.filter((c) => c !== null).length;
    const text = r.filter((c) => cellKind(c) === "text").length;
    if (filled >= 2 && text >= 2 && rows[i + 1] && rows[i + 1]!.filter((c) => c !== null).length >= 2) return i;
  }
  // a header made of numbers or one column wide is unusual: fall back to the first line with two cells
  for (let i = 0; i <= limit; i++) if (rows[i]!.filter((c) => c !== null).length >= 2) return i;
  return 0;
}

function toTable(rows: RawRow[], extra: { sheet?: string; otherSheets?: string[] } = {}): Table {
  if (!rows.length) throw new UploadError("There is nothing in this file. Add a row for each day or week, with the date and your numbers.", "empty");
  const h = findHeader(rows);
  const width = Math.min(MAX_COLUMNS, Math.max(...rows.slice(h).map((r) => r.length)));
  const headers = Array.from({ length: width }, (_, i) => String(rows[h]![i] ?? "").trim());
  const data = rows.slice(h + 1).map((r) => Array.from({ length: width }, (_, i): Cell => r[i] ?? null));
  if (!data.length) throw new UploadError("This file has a header but no rows of numbers under it.", "no_rows");
  if (data.length > MAX_ROWS) throw new UploadError(`This file has more than ${num(MAX_ROWS)} rows. Send one row per day or per week, or just the last year or so.`, "too_many_rows");
  return { headers, rows: data, headerRow: h, ...extra };
}

export function readTable(bytes: Uint8Array, filename: string): Table {
  if (bytes.length === 0) throw new UploadError("There is nothing in this file. Add a row for each day or week, with the date and your numbers.", "empty");
  if (bytes.length > MAX_FILE_BYTES) throw new UploadError("That file is too big: send one under 20 MB. A row per day or week is plenty.", "too_big");
  if (isZip(bytes) || isOle(bytes) || /\.xlsx?$/i.test(filename)) {
    const { sheets, allNames } = readXlsx(bytes);
    // the first sheet that has a header and a row of data under it
    for (const s of sheets) {
      if (s.rows.length >= 2) {
        const t = toTable(s.rows, { sheet: s.name, otherSheets: allNames.filter((n) => n !== s.name) });
        return t;
      }
    }
    throw new UploadError("There is nothing in this spreadsheet. Add a row for each day or week, with the date and your numbers.", "empty");
  }
  return toTable(parseCsv(decodeText(bytes)));
}
