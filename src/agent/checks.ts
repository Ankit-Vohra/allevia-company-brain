// Answer checks (spec §7.4, "make no mistakes"). Run on every final answer against the TouchedSet of the turn:
// - citations: every [[id]] was returned by a tool in this turn;
// - numbers: every number in the answer (dates, times, standalone years, list ordinals, ids and "last N days" windows
//   aside) appears in tool data, allowing simple rounding (97 ~ 96.8, 55 ~ 55.0), percent/fraction (97% ~ 0.97),
//   multipliers (55k, ₹1.2 lakh, 2 crore) and Devanagari digits;
// - simulated: if a touched node is simulated, the answer says so;
// - freshness: if the newest asOf used is over 7 days old, the answer says "as of <date>".
// Failed checks never block an answer; they are shown as "unverified" and stored on the Turn.
import type { TurnChecks } from "../../shared/contracts.js";
import type { TouchedSet } from "./tool.js";

const DAY_MS = 86_400_000;
const FRESH_DAYS = 7;

export interface NumberMention {
  raw: string;        // as written in the answer, e.g. "₹1.2 lakh", "97%", "५५"
  value: number;      // the numeral itself (1.2, 97, 55)
  decimals: number;   // decimals written (rounding tolerance is half a unit in the last place)
  percent: boolean;
  scale: number;      // multiplier word (k = 1e3, lakh = 1e5, crore = 1e7, M = 1e6, bn = 1e9), 1 when none
}

// ---------- citations ----------

export function extractCitations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    const id = m[1]!.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

// ---------- numbers ----------

const DEVANAGARI_ZERO = 0x0966;
const toAsciiDigits = (s: string): string =>
  s.replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - DEVANAGARI_ZERO));

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const HINDI_MONTH = "(?:जनवरी|फ़रवरी|फरवरी|मार्च|अप्रैल|मई|जून|जुलाई|अगस्त|सितंबर|सितम्बर|अक्टूबर|अक्तूबर|नवंबर|नवम्बर|दिसंबर|दिसम्बर)";
const WINDOW_UNIT = "(?:days?|weeks?|months?|years?|hours?|hrs?|दिन|दिनों|हफ़्ते|हफ्ते|हफ़्तों|सप्ताह|महीने|महीनों|साल)";

// Spans that hold digits but are not quantities. Each is blanked out (same length) before numbers are read, so match
// positions still point into the original text.
const IGNORED: RegExp[] = [
  /\[\[[^\]]*\]\]/g,                                                                   // [[citations]]
  /https?:\/\/[^\s)\]>]+/g,                                                             // URLs
  /`[^`\n]*`/g,                                                                        // inline code
  /\b[a-z][a-z0-9_-]*:[^\s\])},;]+/g,                                                  // bare ids: obs:signups:2026-10-05
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, // ISO dates
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,                                              // 05/10/2026
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b\\.?(?:,?\\s+\\d{4})?`, "g"),   // 5 Oct, 5th October 2026
  new RegExp(`\\b${MONTH}\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "g"), // Oct 5, October 5, 2026
  new RegExp(`\\b${MONTH}\\b\\.?\\s+\\d{4}\\b`, "g"),                                  // Oct 2026
  new RegExp(`\\d{1,2}\\s+${HINDI_MONTH}(?:\\s+\\d{4})?`, "g"),                         // 5 अक्टूबर 2026
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:am|pm|AM|PM))?(?:\s?IST)?/g,                     // 10:30, 9:05 pm
  /\b\d{1,2}\s?(?:am|pm|AM|PM)\b/g,                                                   // 9am
  new RegExp(`(?:\\b(?:[Ll]ast|[Pp]ast|[Nn]ext|[Pp]revious)|पिछले|अगले)\\s+\\d+\\s+${WINDOW_UNIT}`, "g"), // last 7 days
  /\b\d+(?:st|nd|rd|th)\b/g,                                                          // ordinals: 2nd
  /^[ \t]*(?:[-*+][ \t]+)?\d+[.)](?=\s)/gm,                                            // list ordinals: "1." "2)"
];

const SCALES: Record<string, number> = {
  k: 1e3, K: 1e3, "हज़ार": 1e3, "हजार": 1e3,
  L: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, "लाख": 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, "\u0915\u0930\u094B\u0921\u093C": 1e7, "\u0915\u0930\u094B\u095C": 1e7, // करोड़ (both spellings)
  M: 1e6, mn: 1e6, million: 1e6,
  B: 1e9, bn: 1e9, billion: 1e9,
};
const SCALE_ALT = Object.keys(SCALES).sort((a, b) => b.length - a.length).join("|");

// sign, currency, numeral (1,23,456.78), percent, multiplier. A numeral glued to a letter before it (GA4, Q3, e5) is a
// name, not a quantity.
const NUMBER = new RegExp(
  "(?<![\\p{L}\\p{M}\\p{N}_.])" +
  "(?<sign>[-−])?" +
  "(?<cur>₹\\s?|[Rr]s\\.?\\s?|INR\\s?|\\$\\s?|€\\s?|£\\s?)?" +
  "(?<num>\\d+(?:,\\d+)*(?:\\.\\d+)?)(?![\\d])" +
  "(?<pct>\\s?(?:%|percent\\b|प्रतिशत))?" +
  `(?:\\s?(?<scale>${SCALE_ALT})(?![\\p{L}\\p{M}]))?`,
  "gu",
);

function blank(s: string, re: RegExp): string {
  return s.replace(re, (m) => " ".repeat(m.length));
}

export function findNumbers(text: string): NumberMention[] {
  let s = toAsciiDigits(text);
  for (const re of IGNORED) s = blank(s, re);
  const out: NumberMention[] = [];
  for (const m of s.matchAll(NUMBER)) {
    const g = m.groups!;
    const num = g.num!;
    const value = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = num.includes(".") ? num.split(".")[1]!.length : 0;
    const percent = !!g.pct;
    const scale = g.scale ? SCALES[g.scale] ?? 1 : 1;
    // A standalone year (1990-2100) is a date, not a quantity.
    if (!g.cur && !percent && scale === 1 && !num.includes(",") && decimals === 0 && value >= 1990 && value <= 2100) continue;
    const raw = text.slice(m.index!, m.index! + m[0].length).trim();
    out.push({ raw, value: g.sign ? -value : value, decimals, percent, scale });
  }
  return out;
}

function candidates(m: NumberMention): Array<{ v: number; tol: number }> {
  const tol = 0.5 * 10 ** -m.decimals + 1e-9;
  const v = Math.abs(m.value);
  const c = [{ v, tol }];
  if (m.scale !== 1) c.push({ v: v * m.scale, tol: tol * m.scale });
  if (m.percent) c.push({ v: v / 100, tol: tol / 100 });
  return c;
}

export function isGrounded(m: NumberMention, data: readonly number[]): boolean {
  const cs = candidates(m);
  return data.some((d) => cs.some((c) => Math.abs(Math.abs(d) - c.v) <= c.tol));
}

// ---------- the checks ----------

export interface CheckOpts {
  now?: number;
  question?: string; // numbers the owner wrote in the question ("3 reel ideas") are allowed in the answer
}

export function checkTurn(answer: string, touched: TouchedSet, opts: CheckOpts = {}): TurnChecks {
  const now = opts.now ?? Date.now();

  const invalidCitations = extractCitations(answer).filter((id) => !touched.has(id));

  const data = [...touched.numbers()].map(Number).filter(Number.isFinite);
  if (opts.question) for (const q of findNumbers(opts.question)) data.push(q.value, ...(q.scale !== 1 ? [q.value * q.scale] : []));
  const ungroundedNumbers: string[] = [];
  for (const m of findNumbers(answer)) {
    if (!isGrounded(m, data) && !ungroundedNumbers.includes(m.raw)) ungroundedNumbers.push(m.raw);
  }

  const simulatedDisclosed = !touched.anySimulated() || /simulated|सिम्युलेटेड|सिमुलेटेड/i.test(answer);

  const newest = touched.newestAsOf();
  const newestMs = newest ? Date.parse(newest) : NaN;
  const fresh = !Number.isFinite(newestMs) || now - newestMs <= FRESH_DAYS * DAY_MS;
  const freshnessDisclosed = fresh || /\bas of\b/i.test(answer) || /तक की स्थिति|के अनुसार/.test(answer);

  return {
    citationsValid: invalidCitations.length === 0, invalidCitations,
    numbersGrounded: ungroundedNumbers.length === 0, ungroundedNumbers,
    simulatedDisclosed, freshnessDisclosed,
  };
}

// True when a text carries at least one checkable number (used to decide whether the CoE desk reviews a finding).
export function hasNumbers(text: string): boolean {
  return findNumbers(text).length > 0;
}
