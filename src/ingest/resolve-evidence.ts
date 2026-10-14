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
const EDGE_PUNCT = /^[\s"'.,;:!?()[\]{}-]+|[\s"'.,;:!?()[\]{}-]+$/g;

// Each part of the quote (split on "..." or "…") must have at least MIN_QUOTE_WORDS words and appear in the
// document verbatim (normQuote on both sides). `normDoc` is normQuote(document text).
export function quoteProblem(evidence: string, normDoc: string): string | undefined {
  const parts = evidence.split(/\.{3}|…/).map((p) => normQuote(p).replace(EDGE_PUNCT, "")).filter(Boolean);
  if (!parts.length) return "no evidence quote";
  for (const p of parts) {
    const words = p.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    if (words < MIN_QUOTE_WORDS) return `evidence "${p}" is shorter than ${MIN_QUOTE_WORDS} words`;
    if (!normDoc.includes(p)) return `evidence not found in the document: "${p}"`;
  }
  return undefined;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, hazaar: 1e3, hazar: 1e3, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5,
  million: 1e6, mn: 1e6, crore: 1e7, crores: 1e7, cr: 1e7, billion: 1e9, bn: 1e9,
};
// English and Hinglish number words. Hindi words that are also common English words ("do", "teen", "char") are left
// out: they would make almost any quote "contain a number".
const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  dozen: 12, thousand: 1e3, million: 1e6, lakh: 1e5, crore: 1e7,
  ek: 1, chaar: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, bees: 20, pachaas: 50, pachas: 50, sau: 100,
  hazaar: 1e3, hazar: 1e3,
};

// Every number a quote states: digits (with Indian or Western grouping, Devanagari digits too), number words,
// "twenty five", and either followed by a multiplier ("1.2 lakh", "55k", "two lakh").
export function numbersIn(evidence: string): number[] {
  const s = evidence.normalize("NFKC").toLowerCase().replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x966));
  const out: number[] = [];
  for (const m of s.matchAll(/(\d+(?:,\d+)*(?:\.\d+)?)\s*([a-z]+)?/g)) {
    const n = Number(m[1]!.replace(/,/g, ""));
    out.push(n);
    const mult = m[2] ? MULTIPLIERS[m[2]] : undefined;
    if (mult) out.push(n * mult);
  }
  const words = s.split(/[^\p{L}\p{N}]+/u);
  words.forEach((w, i) => {
    const n = NUMBER_WORDS[w];
    if (n === undefined) return;
    const unit = NUMBER_WORDS[words[i + 1] ?? ""];
    const base = n >= 20 && n < 100 && n % 10 === 0 && unit !== undefined && unit < 10 ? n + unit : n;
    out.push(n, base);
    const mult = MULTIPLIERS[words[i + 1] ?? ""] ?? MULTIPLIERS[words[i + 2] ?? ""];
    if (mult) out.push(n * mult, base * mult);
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
