// A number as a person types it in a sheet: "1,234", "1,23,456", "£1,200.50", "(500)", "12%", "1.234,56". A blank or a
// word is null (never zero): a missing day is missing, not a day with nothing.
const BLANK = new Set(["", "-", "–", "—", "n/a", "na", "null", "none", "nil", "#n/a", "#div/0!", "#value!", "tbc", "?"]);
const CURRENCY = /[$£€₹¥]|\b(?:usd|gbp|eur|inr|aed|aud|cad|nzd|sgd|rs)\b\.?/gi;

export function parseNumberCell(cell: string | number | null | undefined): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== "string") return null;
  let s = cell.replace(/[   ]/g, " ").trim();
  if (BLANK.has(s.toLowerCase())) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  s = s.replace(CURRENCY, "").replace(/%$/, "").replace(/\s+/g, "").trim();
  if (s.startsWith("-") || s.startsWith("−")) { negative = !negative; s = s.slice(1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let plain: string;
  if (commas > 0 && dots > 0) {
    const decimal = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const group = decimal === "," ? "." : ",";
    if ((s.match(new RegExp(`\\${decimal}`, "g")) ?? []).length > 1) return null; // two decimal marks: not a number
    plain = s.split(group).join("").replace(decimal, ".");
  } else if (commas > 1) plain = s.replace(/,/g, "");
  else if (commas === 1) {
    const [head, tail] = s.split(",") as [string, string];
    plain = tail.length === 3 && head !== "0" && head !== "" ? head + tail : `${head}.${tail}`;
  } else if (dots > 1) plain = s.replace(/\./g, "");
  else plain = s;
  const n = Number(plain);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export type CellKind = "blank" | "number" | "text";
export function cellKind(cell: string | number | null | undefined): CellKind {
  if (cell === null || cell === undefined) return "blank";
  if (typeof cell === "string" && BLANK.has(cell.trim().toLowerCase())) return "blank";
  return parseNumberCell(cell) === null ? "text" : "number";
}
