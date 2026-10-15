// The privacy filter for an uploaded sheet. A file of numbers has no reason to hold a person: a column that names one
// (by its header) or a cell that carries an e-mail address, a phone number or a secret (by its text) is a reason to
// refuse the file, in plain words, before anything is read further or stored. Nothing is ever redacted around: the owner
// removes the column and sends it again. The message names the column, never the value.
import { findSensitive } from "../../ingest/redact.js";
import { UploadError } from "./limits.js";
import { PERSONAL_HEADER } from "./metrics.js";
import { cellKind } from "./numbers.js";
import { letterOf } from "./letters.js";
import type { Table } from "./table.js";

const MAX_UNIQUE_SCANNED = 200_000;

export function findPersonalColumns(t: Table): Array<{ index: number; header: string; why: "header" | "cell" }> {
  const hits = new Map<number, "header" | "cell">();
  t.headers.forEach((h, i) => {
    if (!h) return;
    if (PERSONAL_HEADER.test(h.trim()) || findSensitive(h).length) hits.set(i, "header");
  });
  const seen = new Set<string>();
  outer: for (const row of t.rows) {
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (typeof c !== "string" || hits.has(i) || cellKind(c) !== "text") continue;
      if (seen.has(c)) continue;
      if (seen.size >= MAX_UNIQUE_SCANNED) break outer;
      seen.add(c);
      if (findSensitive(c).length) hits.set(i, "cell");
    }
  }
  return [...hits].sort((a, b) => a[0] - b[0]).map(([index, why]) => ({ index, header: t.headers[index] || `Column ${letterOf(index)}`, why }));
}

export function assertNoPersonalData(t: Table): void {
  const found = findPersonalColumns(t);
  if (!found.length) return;
  const names = found.slice(0, 4).map((f) => `“${f.header.length > 40 ? `${f.header.slice(0, 37)}...` : f.header}”`).join(", ");
  const own = found.some((f) => f.why === "header")
    ? `${found.length === 1 ? "A column here looks" : "Some columns here look"} like it holds people's details`
    : `${found.length === 1 ? "A column here has" : "Some columns here have"} what looks like an email address, phone number or password in it`;
  throw new UploadError(
    `${own} (${names}). We only need the numbers, so please take ${found.length === 1 ? "it" : "them"} out and send the file again. Nothing from this file was kept.`,
    "personal");
}
