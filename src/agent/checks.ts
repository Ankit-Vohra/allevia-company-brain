// Answer checks (spec §7.4, "make no mistakes"). Run on every final answer against the TouchedSet of the turn:
// - citations: every [[id]] was returned by a tool in this turn;
// - numbers: every number in the answer (dates, times, years, week numbers, "top N", list ordinals, ids and "last N
//   days" windows aside) appears in tool data, allowing simple rounding (97 ~ 96.8, 55 ~ 55.0), percent/fraction
//   (97% ~ 0.97), multipliers (55k, ₹1.2 lakh, 2 crore, $1.2bn, and £2.5m / $3b after a currency) and Devanagari
//   digits. A number from 1990 to 2100 is a year only next to a date or a year word ("in 2026", "FY 2026", "the 2026
//   budget", "2025-2026"); otherwise ("2045 sessions") it is a quantity and is checked. Dates in tool data are not
//   numbers (tool.ts), so "12%" is never grounded by "2026-10-12";
// - simulated: if a touched node is simulated, the answer says so;
// - freshness: if the newest asOf used is over 7 days old, the answer says "as of <date>" (or "as at", or the Hindi
//   "<date> तक" / "<date> के अनुसार") with an actual date: "as of now" doesn't count;
// - access mode: for every capability the answer cites (its [[ids]]) whose access mode is not "api", the answer says
//   where the data came from ("from your public profile", "benchmark"); see src/capabilities/modes.ts.
// Failed checks never block an answer; they are shown as "unverified" and stored on the Turn.
import type { TurnChecks } from "../../shared/contracts.js";
import { modeCheck, type CapabilityModeInfo } from "../capabilities/modes.js";
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

// A written date: 2026-10-05(T10:30Z), 2026/10/05, 05/10/2026, 5 Oct (2026), Oct 5(, 2026), Oct 2026.
const DATE_NUMERIC = String.raw`\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?|\d{4}[/.]\d{1,2}[/.]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}`;
const DATE_WORDS = String.raw`\d{1,2}(?:st|nd|rd|th)?\s+${MONTH}\b\.?(?:,?\s+\d{4})?|${MONTH}\b\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4})?|${MONTH}\b\.?,?\s+\d{4}`;
const ANY_DATE = `(?:${DATE_NUMERIC}|${DATE_WORDS})`;

// Spans that hold digits but are not quantities. Each is blanked out (same length) before numbers are read, so match
// positions still point into the original text.
const IGNORED: RegExp[] = [
  /\[\[[^\]]*\]\]/g,                                                                   // [[citations]]
  /https?:\/\/[^\s)\]>]+/g,                                                             // URLs
  /`[^`\n]*`/g,                                                                        // inline code
  /\b[a-z][a-z0-9_-]*:[^\s\])},;]+/g,                                                  // bare ids: obs:signups:2026-10-05
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, // ISO dates
  /\b\d{4}[/.]\d{1,2}[/.]\d{1,2}\b/g,                                                  // 2026/10/12
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,                                              // 05/10/2026
  /\b\d{4}-?W\d{1,2}\b/g,                                                              // 2026-W41
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b\\.?(?:,?\\s+\\d{4})?`, "g"),   // 5 Oct, 5th October 2026
  new RegExp(`\\b${MONTH}\\b\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`, "g"), // Oct 5, October 5, 2026
  new RegExp(`\\b${MONTH}\\b\\.?,?\\s+\\d{4}\\b`, "g"),                               // Oct 2026, Oct, 2026
  new RegExp(`\\d{1,2}\\s+${HINDI_MONTH}(?:\\s+\\d{4})?`, "g"),                         // 5 अक्टूबर 2026
  /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:am|pm|AM|PM))?(?:\s?IST)?/g,                     // 10:30, 9:05 pm
  /\b\d{1,2}\s?(?:am|pm|AM|PM)\b/g,                                                   // 9am
  new RegExp(`(?:\\b(?:[Ll]ast|[Pp]ast|[Nn]ext|[Pp]revious)|पिछले|अगले)\\s+\\d+\\s+${WINDOW_UNIT}`, "g"), // last 7 days
  /\b\d+(?:st|nd|rd|th)\b/g,                                                          // ordinals: 2nd
  /\b(?:[Ww]eek|[Ww]k\.?)\s?#?\d{1,2}\b/g,                                             // week numbers: week 41, wk 40
  /\b(?:[Tt]op|[Bb]ottom)\s+\d{1,3}\b/g,                                               // top 3
  /^[ \t]*(?:[-*+][ \t]+)?\d+[.)](?=\s)/gm,                                            // list ordinals: "1." "2)"
];

const SCALES: Record<string, number> = {
  k: 1e3, K: 1e3, "हज़ार": 1e3, "हजार": 1e3,
  L: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, "लाख": 1e5,
  cr: 1e7, crore: 1e7, crores: 1e7, "\u0915\u0930\u094B\u0921\u093C": 1e7, "\u0915\u0930\u094B\u095C": 1e7, // करोड़ (both spellings)
  M: 1e6, mn: 1e6, million: 1e6,
  B: 1e9, bn: 1e9, billion: 1e9,
  m: 1e6, b: 1e9, // only after a currency (£2.5m, $3b); "5m" alone may be minutes or metres
};
const CURRENCY_ONLY_SCALES = new Set(["m", "b"]);
const SCALE_ALT = Object.keys(SCALES).sort((a, b) => b.length - a.length).join("|");

// sign, currency, numeral (1,23,456.78), percent, multiplier. A numeral glued to a letter before it (GA4, Q3, e5) is a
// name, not a quantity.
const NUMBER = new RegExp(
  "(?<![\\p{L}\\p{M}\\p{N}_.])" +
  "(?<sign>[-−])?" +
  "(?<cur>₹\\s?|[Rr]s\\.?\\s?|(?:US|AU|A|NZ|C|S|HK)?\\$\\s?|(?:INR|USD|AUD|GBP|EUR|AED)\\s?|Dhs?\\.?\\s?|€\\s?|£\\s?)?" +
  "(?<num>\\d+(?:,\\d+)*(?:\\.\\d+)?)(?![\\d])" +
  "(?<pct>\\s?(?:%|percent\\b|प्रतिशत))?" +
  `(?:\\s?(?<scale>${SCALE_ALT})(?![\\p{L}\\p{M}]))?`,
  "gud",
);

// Year words and date context around a 1990-2100 number ("in 2026", "FY 2026", "2025-2026", "the 2026 budget").
const YEAR_BEFORE = new RegExp(
  String.raw`(?:\b(?:in|since|from|until|till|through|during|before|after|between|around|circa|year|yr|fy|cy|q[1-4]|h[12]|` +
  String.raw`(?:end|start|beginning|middle|rest|spring|summer|autumn|fall|winter) of)|\b${MONTH}\.?,?|\b(?:19|20)\d\d\s*(?:to|and|vs\.?|versus|[-–—/]))\s*$`,
  "iu",
);
const YEAR_AFTER = new RegExp(
  String.raw`^(?:['’]s\b|\s*(?:[-–—/]|to\b|and\b|vs\.?|versus\b)\s*(?:19|20)?\d\d\b|` +
  String.raw`\s+(?:budget|plan|roadmap|season|strategy|calendar|edition|fiscal|financial|tax|annual|holiday|q[1-4]|h[12])\b|\s*(?:में|साल|वर्ष))`,
  "iu",
);
const isYear = (s: string, start: number, end: number): boolean => YEAR_BEFORE.test(s.slice(Math.max(0, start - 30), start)) || YEAR_AFTER.test(s.slice(end, end + 30));

function blank(s: string, re: RegExp): string {
  return s.replace(re, (m) => " ".repeat(m.length));
}

export function findNumbers(text: string): NumberMention[] {
  const ascii = toAsciiDigits(text);
  let s = ascii;
  for (const re of IGNORED) s = blank(s, re);
  const out: NumberMention[] = [];
  for (const m of s.matchAll(NUMBER)) {
    const g = m.groups!;
    const at = m.indices!.groups!;
    const num = g.num!;
    const value = Number(num.replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const decimals = num.includes(".") ? num.split(".")[1]!.length : 0;
    const percent = !!g.pct;
    const scaleOk = !!g.scale && (!!g.cur || !CURRENCY_ONLY_SCALES.has(g.scale));
    const scale = scaleOk ? SCALES[g.scale!] ?? 1 : 1;
    const end = scaleOk ? m.index! + m[0].length : (at.pct ?? at.num)![1];
    // A year (1990-2100 next to a date or a year word) is a date, not a quantity.
    if (!g.cur && !percent && scale === 1 && !num.includes(",") && decimals === 0 && value >= 1990 && value <= 2100 && isYear(ascii, at.num![0], at.num![1])) continue;
    const raw = text.slice(m.index!, end).trim();
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

// "as of / as at <date>" (optionally "the week to <date>"); Hindi: "<date> तक (की स्थिति)" or "<date> के अनुसार".
const AS_OF = new RegExp(String.raw`\bas (?:of|at)\s+(?:(?:the\s+)?(?:week|month|day|quarter)\s+(?:to|ending|of)\s+)?${ANY_DATE}`, "iu");
const HINDI_AS_OF = new RegExp(String.raw`(?:${ANY_DATE}|\d{1,2}\s+${HINDI_MONTH}(?:\s+\d{4})?)\s*(?:तक|के अनुसार)`, "u");

// "simulated", or the owner's word for it: "sample numbers / data / figures" (docs/owner-words.md).
const SIMULATED_SAID = /simulated|\bsample (?:numbers|data|figures)\b|सिम्युलेटेड|सिमुलेटेड|सैंपल (?:नंबर|आंकड़े|डेटा)|नमूना (?:संख्या|आंकड़े|डेटा)/i;

export interface CheckOpts {
  now?: number;
  question?: string; // numbers the owner wrote in the question ("3 reel ideas") are allowed in the answer
  capabilities?: readonly CapabilityModeInfo[]; // the tenant's capability ladder; without it modeDisclosed is true
}

export function checkTurn(answer: string, touched: TouchedSet, opts: CheckOpts = {}): TurnChecks {
  const now = opts.now ?? Date.now();

  const cited = extractCitations(answer);
  const invalidCitations = cited.filter((id) => !touched.has(id));

  const data = [...touched.numbers()].map(Number).filter(Number.isFinite);
  if (opts.question) for (const q of findNumbers(opts.question)) data.push(q.value, ...(q.scale !== 1 ? [q.value * q.scale] : []));
  const ungroundedNumbers: string[] = [];
  for (const m of findNumbers(answer)) {
    if (!isGrounded(m, data) && !ungroundedNumbers.includes(m.raw)) ungroundedNumbers.push(m.raw);
  }

  const simulatedDisclosed = !touched.anySimulated() || SIMULATED_SAID.test(answer);

  const newest = touched.newestAsOf();
  const newestMs = newest ? Date.parse(newest) : NaN;
  const fresh = !Number.isFinite(newestMs) || now - newestMs <= FRESH_DAYS * DAY_MS;
  const ascii = toAsciiDigits(answer);
  const freshnessDisclosed = fresh || AS_OF.test(ascii) || HINDI_AS_OF.test(ascii);

  // Only citations a tool returned this turn count as drawn on (a made-up id is the citation check's failure).
  const modeDisclosed = modeCheck(answer, cited.filter((id) => touched.has(id)), opts.capabilities ?? []).ok;

  return {
    citationsValid: invalidCitations.length === 0, invalidCitations,
    numbersGrounded: ungroundedNumbers.length === 0, ungroundedNumbers,
    simulatedDisclosed, freshnessDisclosed, modeDisclosed,
  };
}

// True when a text carries at least one checkable number (used to decide whether the CoE desk reviews a finding).
export function hasNumbers(text: string): boolean {
  return findNumbers(text).length > 0;
}
