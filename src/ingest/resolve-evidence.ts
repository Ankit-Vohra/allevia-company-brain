// Evidence checks for extracted facts. A quote must be in the document, and an observation's quote must contain its
// number. These are what turn "the model said so" into "the document says so".

// Up to case, whitespace, typographic quotes and dashes, and markdown emphasis/code marks.
export function normQuote(s: string): string {
  return s.normalize("NFKC").toLowerCase()
    .replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐‑‒–—―]/g, "-")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ").trim();
}

export const MIN_QUOTE_WORDS = 3;
// An observation's quote may be two words when they include its value: a table row such as "| Instagram | 1,200 |".
export const MIN_VALUE_QUOTE_WORDS = 2;
const EDGE_PUNCT = /^[\s"'.,;:!?()[\]{}|-]+|[\s"'.,;:!?()[\]{}|-]+$/g;
const trimQuote = (s: string) => normQuote(s).replace(EDGE_PUNCT, "");
const wordCount = (p: string) => p.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// One stretch of quote (already trimQuote'd): long enough, and in the document verbatim. `value` is set for observations.
function partProblem(p: string, normDoc: string, value: number | undefined): string | undefined {
  const words = wordCount(p);
  const enough = words >= MIN_QUOTE_WORDS
    || (value !== undefined && words >= MIN_VALUE_QUOTE_WORDS && numberProblem(value, p) === undefined);
  if (!enough) return `evidence "${p}" is shorter than ${MIN_QUOTE_WORDS} words`;
  if (!normDoc.includes(p)) return `evidence not found in the document: "${p}"`;
  return undefined;
}

// A quote passes when it appears in the document verbatim as a whole (normQuote on both sides; the document may itself
// contain "..." as in "Kal 55 naye users aaye... mast"). Otherwise it is read as an elided quote: each part (split on
// "..." or "…") must pass on its own. Every part needs MIN_QUOTE_WORDS words, or MIN_VALUE_QUOTE_WORDS for an
// observation's quote that contains its `value`. `normDoc` is normQuote(document text).
export function quoteProblem(evidence: string, normDoc: string, opts: { value?: number } = {}): string | undefined {
  const whole = trimQuote(evidence);
  if (!whole) return "no evidence quote";
  const wholeProblem = partProblem(whole, normDoc, opts.value);
  if (!wholeProblem) return undefined;
  const parts = evidence.split(/\.{3}|…/).map(trimQuote).filter(Boolean);
  if (parts.length < 2) return wholeProblem;
  for (const p of parts) {
    const problem = partProblem(p, normDoc, opts.value);
    if (problem) return problem;
  }
  return undefined;
}

// Number words are looked up after NFKC, lower-casing and dropping the Devanagari nukta (U+093C), so "हज़ार" and "हजार",
// "करोड़" and "करोड" are one key each. NFKC leaves precomposed nukta letters (U+0958-U+095F) decomposed.
const wordKey = (w: string) => w.normalize("NFKC").toLowerCase().replace(/\u093C/g, "");
// Maps, not object literals: a quote saying "constructor" must not find Object.prototype.constructor.
const keyed = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [wordKey(k), v]));

// After a number: "1.5L", "55k", "1.2M", "₹2cr", "3 hundred", "₹1.2 लाख", "do hazaar". The one-letter ones (k, l, m)
// count only straight after digits.
const MULTIPLIERS = keyed({
  k: 1e3, l: 1e5, m: 1e6,
  hundred: 100, thousand: 1e3, hazaar: 1e3, hazar: 1e3, "हज़ार": 1e3,
  lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, "लाख": 1e5,
  million: 1e6, mn: 1e6, crore: 1e7, crores: 1e7, cr: 1e7, "करोड़": 1e7, billion: 1e9, bn: 1e9,
});
const wordMultiplier = (w: string | undefined) => (w && w.length > 1 ? MULTIPLIERS.get(w) : undefined);
// English and Hinglish number words. Hindi words that are also common English words ("do", "teen", "char") are left
// out here: they would make almost any quote "contain a number". They count only before a multiplier (BEFORE_MULTIPLIER).
const NUMBER_WORDS = keyed({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  dozen: 12, thousand: 1e3, million: 1e6, lakh: 1e5, crore: 1e7,
  ek: 1, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, bees: 20, pachaas: 50, pachas: 50, sau: 100,
  hazaar: 1e3, hazar: 1e3,
});
// Numbers only when the next word is a multiplier: "do hazaar" is 2,000, "do it" is not 2; "dedh lakh" is 1.5 lakh,
// "dedh baje" (half past one) is no amount.
const BEFORE_MULTIPLIER = keyed({
  do: 2, teen: 3, char: 4, paanch: 5, panch: 5, dedh: 1.5, derh: 1.5, dhai: 2.5, dhaai: 2.5, adhai: 2.5, sawa: 1.25, sava: 1.25,
  "दो": 2, "तीन": 3, "चार": 4, "पाँच": 5, "पांच": 5, "डेढ़": 1.5, "ढाई": 2.5, "सवा": 1.25,
});
// A quarter or a half more than the number after it, before a multiplier: "sawa do lakh" 2.25 lakh, "saade teen lakh" 3.5.
const PLUS = keyed({ sawa: 0.25, sava: 0.25, "सवा": 0.25, saade: 0.5, saadhe: 0.5, sade: 0.5, "साढ़े": 0.5 });

// Every number a quote states: digits (with Indian or Western grouping, Devanagari digits too), number words,
// "twenty five", and either followed by a multiplier ("1.2 lakh", "55k", "two lakh", "1.5L"), plus Hinglish amounts
// before a multiplier ("do hazaar", "dedh lakh", "saade teen lakh").
export function numbersIn(evidence: string): number[] {
  const s = wordKey(evidence).replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966));
  const out: number[] = [];
  for (const m of s.matchAll(/(\d+(?:,\d+)*(?:\.\d+)?)\s*([\p{L}\p{M}]+)?/gu)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    out.push(n);
    const mult = m[2] ? MULTIPLIERS.get(m[2]) : undefined;
    if (mult) out.push(n * mult);
  }
  // Devanagari vowel signs are marks (\p{M}), so a word is letters, marks and digits.
  const words = s.split(/[^\p{L}\p{M}\p{N}]+/u);
  const numberAt = (w: string | undefined) =>
    w === undefined ? undefined : (NUMBER_WORDS.get(w) ?? BEFORE_MULTIPLIER.get(w) ?? (/^\d+$/.test(w) ? Number(w) : undefined));
  words.forEach((w, i) => {
    const n = NUMBER_WORDS.get(w);
    if (n !== undefined) {
      const unit = NUMBER_WORDS.get(words[i + 1] ?? "");
      const base = n >= 20 && n < 100 && n % 10 === 0 && unit !== undefined && unit < 10 ? n + unit : n;
      out.push(n, base);
      const mult = wordMultiplier(words[i + 1]) ?? wordMultiplier(words[i + 2]);
      if (mult) out.push(n * mult, base * mult);
    }
    const small = BEFORE_MULTIPLIER.get(w);
    const next = wordMultiplier(words[i + 1]);
    if (small !== undefined && next) out.push(small * next);
    const plus = PLUS.get(w);
    const plusBase = numberAt(words[i + 1]);
    const after = wordMultiplier(words[i + 2]);
    if (plus !== undefined && plusBase !== undefined && after) out.push((plusBase + plus) * after);
  });
  return out;
}

// The value must be readable off the quote: its digits appear, or a number word (times a multiplier) gives it.
export function numberProblem(value: number, evidence: string): string | undefined {
  const ns = numbersIn(evidence);
  if (!ns.length) return "observation evidence contains no number";
  const v = Math.abs(value);
  return ns.some((n) => Math.abs(n - v) <= 1e-9 * Math.max(1, v)) ? undefined : `observation value ${value} does not appear in its evidence`;
}
