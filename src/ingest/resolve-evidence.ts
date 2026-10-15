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

// One-letter multipliers count only when they touch the digits and end the word: "1.5L", "55k", "1.2M". So "5 m tall"
// is 5 (not 5 million), "2 l bottle" is 2 (not 2 lakh) and "5km" is 5. "cr" may follow after one space: "₹2 cr".
const SUFFIX_MULTIPLIERS = new Map([["k", 1e3], ["l", 1e5], ["m", 1e6]]);
// Multiplier words (two letters or more), after a number ("3 hundred", "₹1.2 लाख", "do hazaar", "paanch sau") or on
// their own ("a lakh", "sau log").
const MULTIPLIERS = keyed({
  hundred: 100, sau: 100, "सौ": 100,
  thousand: 1e3, hazaar: 1e3, hazar: 1e3, hajar: 1e3, hajaar: 1e3, "हज़ार": 1e3,
  lakh: 1e5, lakhs: 1e5, laakh: 1e5, lac: 1e5, lacs: 1e5, "लाख": 1e5,
  million: 1e6, mn: 1e6,
  crore: 1e7, crores: 1e7, cr: 1e7, karod: 1e7, karor: 1e7, karode: 1e7, "करोड़": 1e7,
  billion: 1e9, bn: 1e9,
});
// Number words that count anywhere: English, and Hinglish words that are not also common English words.
const NUMBER_WORDS = keyed({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12,
  ek: 1, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  chalis: 40, chaalis: 40, pachas: 50, pachaas: 50, sattar: 70, assi: 80, nabbe: 90, nabbey: 90,
});
// Numbers only when the next word is a multiplier, because they are also everyday words: "do hazaar" is 2,000 but
// "do it" is not 2; "bees hazaar" is 20,000 but "bees" are insects; "saath hazaar" is 60,000 but "unke saath" is "with
// them"; "dedh lakh" is 1.5 lakh but "dedh baje" (half past one) is no amount.
const BEFORE_MULTIPLIER = keyed({
  do: 2, teen: 3, char: 4, paanch: 5, panch: 5, bees: 20, tees: 30, saath: 60,
  dedh: 1.5, derh: 1.5, dhai: 2.5, dhaai: 2.5, adhai: 2.5, sawa: 1.25, sava: 1.25,
  "दो": 2, "तीन": 3, "चार": 4, "पाँच": 5, "पांच": 5, "डेढ़": 1.5, "ढाई": 2.5, "सवा": 1.25,
});
// A quarter or a half more than the number after it, before a multiplier: "sawa do lakh" 2.25 lakh, "saade teen lakh" 3.5.
const PLUS = keyed({ sawa: 0.25, sava: 0.25, "सवा": 0.25, saade: 0.5, saadhe: 0.5, sade: 0.5, "साढ़े": 0.5 });
// Words that may join the parts of one amount: "1 lakh aur 20 hazaar" ("or" offers an alternative, not a sum).
const JOINERS = new Set(["and", "aur"]);

// A quote as tokens: numbers (with a touching suffix multiplier already applied) and words. Devanagari vowel signs
// are marks (\p{M}), so a word is letters and marks.
type Tok = { n: number; mult?: number } | { w: string };
const TOKEN = /(\d+(?:,\d+)*(?:\.\d+)?)(?:([klm])(?![\p{L}\p{M}\p{N}])|\s?(cr)(?![\p{L}\p{M}\p{N}]))?|([\p{L}\p{M}]+)/gu;
function tokenize(evidence: string): Tok[] {
  const s = wordKey(evidence).replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966));
  return [...s.matchAll(TOKEN)].map((m): Tok => {
    if (m[4] !== undefined) return { w: m[4] };
    const n = Number(m[1]!.replace(/,/g, ""));
    const mult = m[2] !== undefined ? SUFFIX_MULTIPLIERS.get(m[2]) : m[3] !== undefined ? 1e7 : undefined;
    return mult ? { n, mult } : { n };
  });
}

const wordOf = (t: Tok | undefined) => (t && "w" in t ? t.w : undefined);
const multiplierAt = (t: Tok | undefined) => {
  const w = wordOf(t);
  return w && w.length > 1 ? MULTIPLIERS.get(w) : undefined;
};
const quantityAt = (t: Tok | undefined) =>
  t === undefined ? undefined : "n" in t ? (t.mult ? undefined : t.n) : NUMBER_WORDS.get(t.w) ?? BEFORE_MULTIPLIER.get(t.w);

// One amount starting at token i: its value, its (smallest) multiplier, how many tokens it used, and other numbers it
// states on the way ("twenty five" also says 20). Undefined when no amount starts there.
interface Term { n: number; mult: number; used: number; also: number[] }
function termAt(toks: Tok[], i: number): Term | undefined {
  const t = toks[i]!;
  if ("n" in t) {
    if (t.mult) return { n: t.n * t.mult, mult: t.mult, used: 1, also: [t.n] };
    const m = multiplierAt(toks[i + 1]);
    return m ? { n: t.n * m, mult: m, used: 2, also: [t.n] } : { n: t.n, mult: 1, used: 1, also: [] };
  }
  const plus = PLUS.get(t.w);
  const plusBase = quantityAt(toks[i + 1]);
  const plusMult = multiplierAt(toks[i + 2]);
  if (plus !== undefined && plusBase !== undefined && plusMult) return { n: (plusBase + plus) * plusMult, mult: plusMult, used: 3, also: [] };
  const alone = multiplierAt(t);
  if (alone) return { n: alone, mult: alone, used: 1, also: [] };
  let q = NUMBER_WORDS.get(t.w);
  let used = 1;
  const also: number[] = [];
  if (q !== undefined) {
    const unit = NUMBER_WORDS.get(wordOf(toks[i + 1]) ?? "");
    if (q >= 20 && q < 100 && q % 10 === 0 && unit !== undefined && unit > 0 && unit < 10) {
      also.push(q);
      q += unit;
      used = 2;
    }
    const m = multiplierAt(toks[i + used]);
    return m ? { n: q * m, mult: m, used: used + 1, also: [...also, q] } : { n: q, mult: 1, used, also };
  }
  const before = BEFORE_MULTIPLIER.get(t.w);
  const m = multiplierAt(toks[i + 1]);
  return before !== undefined && m ? { n: before * m, mult: m, used: 2, also: [] } : undefined;
}

// Every number a quote states: digits (with Indian or Western grouping, Devanagari digits too), number words,
// "twenty five", either followed by a multiplier ("1.2 lakh", "55k", "two lakh", "paanch sau"), Hinglish amounts before a
// multiplier ("do hazaar", "dedh lakh", "saade teen lakh"), and compound amounts whose multipliers fall ("1 lakh 20
// thousand" = 120,000; "do hazaar paanch sau" = 2,500). A word that is not part of an amount ends a compound one.
export function numbersIn(evidence: string): number[] {
  const toks = tokenize(evidence);
  const out: number[] = [];
  let compound: { sum: number; mult: number } | undefined;
  for (let i = 0; i < toks.length;) {
    const term = termAt(toks, i);
    if (!term) {
      if (!(compound && JOINERS.has(wordOf(toks[i]) ?? ""))) compound = undefined;
      i++;
      continue;
    }
    out.push(term.n, ...term.also);
    if (compound && term.mult < compound.mult) {
      compound = { sum: compound.sum + term.n, mult: term.mult };
      out.push(compound.sum);
    } else {
      compound = term.mult > 1 ? { sum: term.n, mult: term.mult } : undefined;
    }
    i += term.used;
  }
  return out;
}

// The value must be readable off the quote: its digits appear, or a number word (times a multiplier) gives it.
export function numberProblem(value: number, evidence: string): string | undefined {
  const ns = numbersIn(evidence);
  if (!ns.length) return "observation evidence contains no number";
  const v = Math.abs(value);
  return ns.some((n) => Math.abs(n - v) <= 1e-9 * Math.max(1, v)) ? undefined : `observation value ${value} does not appear in its evidence`;
}
