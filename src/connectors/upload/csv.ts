// CSV and other delimited text into rows of cells, with the caps applied while reading (so a hostile file stops early
// instead of being read whole and counted afterwards). UTF-8 (with or without a byte-order mark), UTF-16 from Excel's
// "Unicode text", and windows-1252 as the last resort. The delimiter is sniffed from the first lines.
import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_ROWS, UploadError, num } from "./limits.js";

export type RawRow = Array<string | number | null>;

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function sniffDelimiter(text: string): string {
  const lines = text.split(/\r?\n/, 8).filter((l) => l.trim());
  let best = ",", bestScore = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const first = counts[0] ?? 0;
    if (first === 0) continue;
    const consistent = counts.filter((c) => c === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

const clean = (s: string): string | null => {
  const t = (s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s).trim();
  return t === "" ? null : t;
};

// Rows of at most MAX_COLUMNS cells, MAX_ROWS + a few header lines. Throws UploadError past the caps.
export function parseCsv(text: string, maxRows = MAX_ROWS + 50): RawRow[] {
  const d = sniffDelimiter(text);
  const rows: RawRow[] = [];
  let row: RawRow = [];
  let cell = "";
  let quoted = false;
  let started = false; // anything seen on this line (a quoted empty string still counts)
  const endCell = () => {
    row.push(clean(cell));
    cell = "";
    if (row.length > MAX_COLUMNS) throw new UploadError(`This file has more than ${MAX_COLUMNS} columns. Keep the date and the numbers you want us to track, then send it again.`, "too_many_columns");
  };
  const endRow = () => {
    if (started || row.length) {
      endCell();
      if (row.some((c) => c !== null)) {
        rows.push(row);
        if (rows.length > maxRows) throw new UploadError(`This file has more than ${num(MAX_ROWS)} rows. Send one row per day or per week, or just the last year or so.`, "too_many_rows");
      }
    }
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else if (cell.length <= MAX_CELL_CHARS + 1) cell += c;
      continue;
    }
    if (c === '"' && cell === "") { quoted = true; started = true; continue; }
    if (c === d) { started = true; endCell(); continue; }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    started = true;
    if (cell.length <= MAX_CELL_CHARS + 1) cell += c;
  }
  endRow();
  return rows;
}
