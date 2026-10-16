// The spreadsheet fallback for enquiries: when Gmail or WhatsApp is not connected, the owner sends a sheet of the people who wrote in
// (a CSV or an xlsx exported from the form, WhatsApp or a notebook). Every row becomes a lead in the records. This is NOT the numbers
// upload (src/connectors/upload), which refuses a sheet with people in it on purpose: here people are the point, and they go into
// this business's own records only. The same file read twice adds nothing (each row's id comes from the file name and the row).
import { createHash } from "node:crypto";
import { readTable } from "../connectors/upload/table.js";
import type { GraphHandle } from "../graph/client.js";
import { recordEnquiry } from "./graph.js";
import { parseWhen } from "./parse.js";

export interface SheetLead { name: string; email: string; phone: string; message: string; source: string; date: number | null; row: number }
export interface SheetRead { leads: SheetLead[]; skipped: number; columns: Record<string, string | null> }

const COLUMN: Array<[keyof Omit<SheetLead, "row" | "date"> | "date", RegExp]> = [
  ["email", /e-?mail/i], ["phone", /phone|mobile|whats ?app|contact (?:no|number)/i],
  ["message", /message|enquiry|inquiry|requirement|comment|question|details|note|what (?:they|you) (?:want|need|asked)/i],
  ["source", /source|channel|via|came from|platform/i], ["date", /date|received|created|time|when/i],
  ["name", /^(?:full |customer |client |lead |contact )?name$|^name\b|^contact$|^customer$|^lead$|^client$/i],
];

/** Reads a spreadsheet of enquiries by what its columns are called. Rows with no name, email or phone, or no message, are skipped. */
export function leadsFromSheet(bytes: Uint8Array, filename: string): SheetRead {
  const t = readTable(bytes, filename);
  const picked: Record<string, number> = {};
  for (const [key, re] of COLUMN) {
    const i = t.headers.findIndex((h, idx) => re.test(h.trim()) && !Object.values(picked).includes(idx));
    if (i >= 0) picked[key] = i;
  }
  const cell = (row: Array<string | number | null>, key: string): string => { const i = picked[key]; const v = i === undefined ? null : row[i]; return v === null || v === undefined ? "" : String(v).trim(); };
  const leads: SheetLead[] = [];
  let skipped = 0;
  t.rows.forEach((row, i) => {
    const l = { name: cell(row, "name"), email: cell(row, "email").toLowerCase(), phone: cell(row, "phone"), message: cell(row, "message"), source: cell(row, "source") || "sheet", date: parseWhen(cell(row, "date")), row: t.headerRow + i + 2 };
    if ((!l.name && !l.email && !l.phone) || !l.message) { skipped++; return; }
    leads.push(l);
  });
  return { leads, skipped, columns: Object.fromEntries(["name", "email", "phone", "message", "source", "date"].map((k) => [k, picked[k] === undefined ? null : t.headers[picked[k]!]!])) };
}

/** Adds every row as a lead. Repeatable: the same file again adds nobody twice. */
export async function importLeadsSheet(g: GraphHandle, bytes: Uint8Array, filename: string, o: { now: number; tenant?: string }): Promise<{ added: number; alreadyThere: number; skipped: number; leadIds: string[] }> {
  const read = leadsFromSheet(bytes, filename);
  const file = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const ids: string[] = [];
  let again = 0;
  for (const l of read.leads) {
    const r = await recordEnquiry(g, { name: l.name, email: l.email, ...(l.phone ? { phone: l.phone } : {}), channel: l.source, body: l.message, at: l.date ?? o.now, externalId: `${file}-row-${l.row}` },
      { src: `sheet:${filename.slice(0, 60)}`, now: o.now, ...(o.tenant ? { tenant: o.tenant } : {}) });
    if (r.repeated) again++; else ids.push(r.leadId);
  }
  return { added: ids.length, alreadyThere: again, skipped: read.skipped, leadIds: ids };
}
