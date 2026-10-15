// Reading a table the way an owner would: which column is the date, how often a row comes, what each number column is.
// previewTable makes the guess and says it in plain words; buildSeries turns a confirmed plan into the numbers to store.
// Neither decides silently: whatever is not certain is listed in `questions`, and an import is refused until each is
// answered (import.ts). Nothing here touches the graph.
import { addDays, dayMs, DAY_MS, median, shortDate } from "../../insights/text.js";
import { regionOf } from "../../onboard/region.js";
import { defaultDateOrder, detectDateOrder, parseDateCell, type DateOrder, type ParsedDate } from "./dates.js";
import { letterOf } from "./letters.js";
import { UploadError } from "./limits.js";
import { LABEL_HEADER, METRICS, customKey, guessHeader, isAdditive, metricByKey } from "./metrics.js";
import { cellKind, parseNumberCell } from "./numbers.js";
import { assertNoPersonalData } from "./privacy.js";
import type { Cell, Table } from "./table.js";
import type { Cadence, Preview, PreviewColumn, Question, Series, SeriesPoint, UploadPlan } from "./types.js";

export interface PreviewHint {
  fileName: string;
  fileHash: string;
  country?: string;            // a two-letter code or a country name: which way round 05/10 is read when the values do not say
}

const MIN_DATE_SHARE = 0.6;
const text = (c: Cell | undefined): string | null => (c === null || c === undefined ? null : typeof c === "number" ? String(c) : c);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (iso: string): string => WEEKDAYS[new Date(dayMs(iso)).getUTCDay()]!;

// ---------- the date column ----------

interface DateColumn { index: number; order: DateOrder; certain: boolean; parsed: Array<ParsedDate | null> }

function findDateColumn(t: Table, fallback: DateOrder, forced?: { index: number; order: DateOrder }): DateColumn | null {
  const consider = (j: number, order?: DateOrder): (DateColumn & { score: number }) | null => {
    const values = t.rows.map((r) => (typeof r[j] === "string" ? (r[j] as string) : null));
    const filled = values.filter((v): v is string => v !== null);
    if (!filled.length) return null;
    const det = order ? { order, certain: true } : detectDateOrder(filled, fallback);
    const parsed = values.map((v) => (v === null ? null : parseDateCell(v, det.order)));
    const ok = parsed.filter((p) => p !== null).length;
    if (!ok || ok / filled.length < MIN_DATE_SHARE) return null;
    return { index: j, order: det.order, certain: det.certain, parsed, score: ok };
  };
  if (forced) return consider(forced.index, forced.order);
  let best: (DateColumn & { score: number }) | null = null;
  for (let j = 0; j < t.headers.length; j++) {
    const c = consider(j);
    if (c && (!best || c.score > best.score)) best = c;
  }
  return best;
}

// ---------- windows ----------

const monthOf = (d: string): { start: string; end: string } => {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  return { start: `${d.slice(0, 8)}01`, end: `${d.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` };
};

// The first and last day a row covers.
function windowOf(p: ParsedDate, plan: Pick<UploadPlan, "cadence" | "weekAnchor">): { start: string; end: string } {
  if (p.grain !== "day") return { start: p.start, end: p.end };
  if (plan.cadence === "week") return plan.weekAnchor === "end" ? { start: addDays(p.start, -6), end: p.start } : { start: p.start, end: addDays(p.start, 6) };
  if (plan.cadence === "month") return monthOf(p.start);
  return { start: p.start, end: p.start };
}

// What the rows look like: from how they are written, else from the gaps between them. null: we cannot tell.
function detectCadence(parsed: ParsedDate[]): { cadence: Cadence | null; explicit: boolean } {
  const grains = new Set(parsed.map((p) => p.grain));
  if (grains.size === 1 && grains.has("month")) return { cadence: "month", explicit: true };
  if (grains.size === 1 && grains.has("week")) return { cadence: "week", explicit: true };
  if (grains.has("range")) {
    const spans = parsed.map((p) => Math.round((dayMs(p.end) - dayMs(p.start)) / DAY_MS) + 1);
    const m = median(spans) ?? 0;
    return { cadence: m <= 1 ? "day" : m >= 6 && m <= 8 ? "week" : m >= 27 && m <= 32 ? "month" : null, explicit: true };
  }
  const days = [...new Set(parsed.map((p) => p.start))].sort();
  if (days.length < 2) return { cadence: null, explicit: false };
  const gaps = days.slice(1).map((d, i) => Math.round((dayMs(d) - dayMs(days[i]!)) / DAY_MS));
  const g = median(gaps) ?? 0;
  return { cadence: g <= 1 ? "day" : g >= 6 && g <= 8 ? "week" : g >= 27 && g <= 32 ? "month" : null, explicit: false };
}

// ---------- the preview ----------

const CADENCE_ADJ: Record<Cadence, string> = { day: "daily", week: "weekly", month: "monthly" };
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const dateOrderOf = (country: string | undefined): DateOrder => {
  if (!country) return "dmy";
  const code = /^[A-Za-z]{2}$/.test(country) ? country : regionOf(country)?.countryCode;
  return defaultDateOrder(code);
};

export function previewTable(t: Table, hint: PreviewHint): Preview {
  assertNoPersonalData(t);
  const fallback = dateOrderOf(hint.country);
  const dc = findDateColumn(t, fallback);
  if (!dc) {
    throw new UploadError("We couldn't find a date in this file. Add a column with the date for each row (like 2026-10-05 or 5 Oct 2026) and send it again.", "no_date");
  }
  const dated = dc.parsed.map((p, i) => ({ p, i })).filter((x): x is { p: ParsedDate; i: number } => x.p !== null);
  const skippedRows = dc.parsed.length - dated.length;
  const { cadence, explicit } = detectCadence(dated.map((x) => x.p));
  const dateHeader = t.headers[dc.index] || `Column ${letterOf(dc.index)}`;
  const weekAnchor: "start" | "end" = /\b(?:ending|ends?|to|w\/e|week end(?:ing)?)\b/i.test(dateHeader) ? "end" : "start";
  const planCadence: UploadPlan["cadence"] = explicit && dated.some((x) => x.p.grain === "range") ? "ranges" : cadence;
  const wins = dated.map((x) => windowOf(x.p, { cadence: planCadence, weekAnchor }));
  const from = wins.reduce((a, w) => (w.start < a ? w.start : a), wins[0]!.start);
  const to = wins.reduce((a, w) => (w.end > a ? w.end : a), wins[0]!.end);

  // number columns
  const datedRows = dated.map((x) => t.rows[x.i]!);
  const columns: PreviewColumn[] = [];
  const leftOut: Preview["leftOut"] = [];
  const planColumns: UploadPlan["columns"] = [];
  let blanks = 0;
  for (let j = 0; j < t.headers.length; j++) {
    if (j === dc.index) continue;
    const header = t.headers[j] || `Column ${letterOf(j)}`;
    const kinds = datedRows.map((r) => cellKind(r[j]));
    const numbers = kinds.filter((k) => k === "number").length;
    const filled = kinds.filter((k) => k !== "blank").length;
    if (!filled) continue;                                           // an empty column is not worth a line
    if (numbers === 0 || numbers / filled < 0.7) { leftOut.push({ index: j, header, reason: "not numbers" }); continue; }
    if (LABEL_HEADER.test(header.trim())) { leftOut.push({ index: j, header, reason: "it numbers the rows" }); planColumns.push({ index: j, metric: "skip" }); continue; }
    blanks += kinds.filter((k) => k === "blank").length;
    const g = guessHeader(t.headers[j] ?? "");
    const def = g.metric ? metricByKey(g.metric) : undefined;
    columns.push({
      index: j, letter: letterOf(j), header,
      sample: datedRows.map((r) => text(r[j])).filter((v): v is string => v !== null).slice(0, 3),
      guess: { metric: g.metric, label: def?.label ?? null, sure: g.sure },
    });
    planColumns.push({ index: j, metric: g.metric });
  }
  if (!columns.length) {
    throw new UploadError("We found dates but no columns of numbers to go with them. Add a column for each number you want us to track (visits, orders, enquiries...) and send it again.", "no_numbers");
  }

  const dupKeys = new Set<string>();
  let duplicates = 0;
  for (const w of wins) { const k = `${w.start}|${w.end}`; if (dupKeys.has(k)) duplicates++; else dupKeys.add(k); }

  const questions: Question[] = [];
  const dateOrderGuessed = !dc.certain;
  if (dateOrderGuessed) questions.push("date_order");
  if (!cadence) questions.push("cadence");
  if (columns.some((c) => c.guess.metric === null)) questions.push("metrics");

  const plan: UploadPlan = { dateColumn: dc.index, dateOrder: dc.order, cadence: planCadence, weekAnchor, columns: planColumns };
  const nouns = columns.filter((c) => c.guess.metric).map((c) => metricByKey(c.guess.metric!)!.noun);
  const span = `from ${shortDate(from)} to ${shortDate(to)}`;
  const named = nouns.length ? list([...new Set(nouns)]) : "numbers";
  const headline = !cadence
    ? `We can't tell if each row in this file is a day, a week or a month (the dates run ${span}). Which is it?`
    : `This looks like ${CADENCE_ADJ[cadence]} ${named}, ${span}.${questions.length ? " A few things need your answer." : " OK?"}`;

  const sentences: string[] = [];
  if (dateOrderGuessed) {
    const first = dated[0]!;
    const raw = String(t.rows[first.i]![dc.index]);
    sentences.push(`Dates like ${raw} could be read two ways. We read them as ${dc.order === "dmy" ? "day, then month" : "month, then day"}, so that is ${shortDate(first.p.start)} ${first.p.start.slice(0, 4)}. If that is the wrong way round, change it.`);
  }
  if (cadence === "week") {
    sentences.push(weekAnchor === "end"
      ? `Each row is the week that ends on the date, a ${weekday(wins[0]!.end)} for the first row.`
      : `Each row is the week that starts on the date, a ${weekday(wins[0]!.start)} for the first row.`);
  } else if (cadence === "month") sentences.push("Each row is a whole calendar month.");
  for (const c of columns.filter((x) => x.guess.metric && !x.guess.sure)) sentences.push(`Not sure about “${c.header}”: we think it is ${c.guess.label!.toLowerCase()}. Change it if not.`);
  if (leftOut.length) sentences.push(`Left out: ${list(leftOut.map((l) => `“${l.header}” (${l.reason})`))}.`);
  if (skippedRows) sentences.push(`${skippedRows} row${skippedRows === 1 ? "" : "s"} without a date ${skippedRows === 1 ? "was" : "were"} left out (a Total row, for example).`);
  if (blanks) sentences.push(`${blanks} blank number${blanks === 1 ? " was" : "s were"} left blank, not counted as zero.`);
  if (duplicates) sentences.push(`${duplicates === 1 ? "A date appears" : `${duplicates} dates appear`} more than once. We add those rows together (for followers and reach we keep the last one).`);
  if (t.sheet) sentences.push(`We read the sheet “${t.sheet}”${t.otherSheets?.length ? `; we left ${list(t.otherSheets.map((s) => `“${s}”`))} alone` : ""}.`);

  return {
    fileName: hint.fileName, fileHash: hint.fileHash, ...(t.sheet ? { sheet: t.sheet } : {}), ...(t.otherSheets?.length ? { otherSheets: t.otherSheets } : {}),
    rowCount: dated.length, dateColumn: { index: dc.index, letter: letterOf(dc.index), header: dateHeader }, dateOrderGuessed, cadence, from, to,
    columns, leftOut, skippedRows, blanks, duplicates, headline, sentences,
    sampleRows: dated.slice(0, 3).map((x) => [String(t.rows[x.i]![dc.index]), ...columns.map((c) => text(t.rows[x.i]![c.index]) ?? "")]),
    questions, metricOptions: METRICS.map((m) => ({ key: m.key, label: m.label })), plan,
  };
}

// ---------- the numbers to store ----------

// The plan applied to the table: one value per metric and window. Rows that share a window are added together for counts
// and the last one is kept for levels (followers, reach). A blank is never a zero, and a count below zero is left out.
export function buildSeries(t: Table, plan: UploadPlan, fallbackCountry?: string): Series {
  const dc = findDateColumn(t, dateOrderOf(fallbackCountry), { index: plan.dateColumn, order: plan.dateOrder });
  if (!dc) throw new UploadError("We couldn't find the dates in that column. Pick the column that has the date.", "no_date");
  const wins = dc.parsed.map((p) => (p ? windowOf(p, plan) : null));
  const dated = wins.filter((w) => w !== null).length;
  const acc = new Map<string, SeriesPoint & { rows: number }>();
  let blanks = 0, negatives = 0, duplicates = 0;
  const seenWindow = new Set<string>();
  for (const w of wins) { if (!w) continue; const k = `${w.start}|${w.end}`; if (seenWindow.has(k)) duplicates++; else seenWindow.add(k); }
  for (const col of plan.columns) {
    if (col.metric === null || col.metric === "skip") continue;
    const def = col.metric === "other" ? undefined : metricByKey(col.metric);
    if (col.metric !== "other" && !def) throw new UploadError(`We don't know what “${col.metric}” is. Pick one from the list for column ${letterOf(col.index)}.`, "bad_plan");
    const key = col.metric === "other" ? customKey(col.label ?? "") : col.metric;
    const label = def?.label ?? (col.label ?? "Your numbers").slice(0, 60);
    const header = t.headers[col.index] || `Column ${letterOf(col.index)}`;
    t.rows.forEach((row, i) => {
      const w = wins[i];
      if (!w) return;
      const v = parseNumberCell(row[col.index]);
      if (v === null) { blanks++; return; }
      if (v < 0 && key !== "revenue" && !key.startsWith("custom_")) { negatives++; return; }
      const id = `${key}|${w.start}|${w.end}`;
      const have = acc.get(id);
      if (!have) acc.set(id, { metric: key, label, windowStart: w.start, windowEnd: w.end, value: v, header, rows: 1 });
      else { have.value = isAdditive(key) ? have.value + v : v; have.rows++; }
    });
  }
  const points = [...acc.values()].map(({ rows: _r, ...p }) => ({ ...p, value: Math.round(p.value * 1e6) / 1e6 }))
    .sort((a, b) => (a.windowEnd < b.windowEnd ? -1 : a.windowEnd > b.windowEnd ? 1 : a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
  const starts = wins.filter((w): w is { start: string; end: string } => w !== null);
  return {
    points, rowCount: dated, skippedRows: wins.length - dated, blanks, duplicates, negatives,
    from: starts.length ? starts.reduce((a, w) => (w.start < a ? w.start : a), starts[0]!.start) : null,
    to: starts.length ? starts.reduce((a, w) => (w.end > a ? w.end : a), starts[0]!.end) : null,
  };
}

