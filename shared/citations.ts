// Where an answer's [[id]] citations go when they are drawn as numbers, the way Claude and Gemini cite: one number per
// source in the order it is first cited (a repeated id keeps its number), each run of markers moved to the end of its
// clause so the sentence reads as plain prose. The server's text keeps its markers; this is only how they are drawn, by the
// web app (superscript buttons, web/src/lib/cites.ts) and by Discord (superscript digits, src/discord/format.ts).
const CITE = /\[\[([^\]\n]+)\]\]/g;
/** A run of markers that sit together ("[[a]] [[b]]"), with the space before it. */
const RUN = /[ \t]*\[\[[^\]\n]+\]\](?:[ \t]*\[\[[^\]\n]+\]\])*/;
/** Where a marker may not travel past: a link, code, a table cell, a bracket. */
const STOP = new Set(["[", "]", "(", ")", "|", "`", "<"]);
const CLAUSE_END = new Set([".", ",", ";", ":", "!", "?"]);
const EMPHASIS = new Set(["*", "_", "\"", "'", "”", "’"]);
/** The link the markdown renderer draws as a marker: #cite:<id>,<id> (each id encoded, so no comma inside one). */
export const CITE_HREF = "#cite:";

/** Every cited id, numbered in the order it is first cited (a repeated id keeps its first number). */
export function citeOrder(md: string): string[] {
  const seen: string[] = [];
  for (const m of md.matchAll(CITE)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

/** The ids in a run of markers, each once, in order. */
const idsIn = (run: string): string[] => [...new Set([...run.matchAll(CITE)].map((m) => m[1]!))];

/** Where a marker group that sat at `at` moves to: the end of its clause (after the comma or full stop that closes it,
 *  and after any closing bold or quote), or the end of the line; never past a link, code or a table cell. */
function clauseEnd(line: string, at: number): number {
  for (let k = at; k < line.length; k++) {
    const c = line[k]!;
    // a marker further on is not a wall: this one travels past it to the clause's end, where the two then group
    if (c === "[" && line[k + 1] === "[") {
      const close = line.indexOf("]]", k);
      if (close > 0) { k = close + 1; continue; }
    }
    if (STOP.has(c) || c === "\u0000") {
      let j = k;
      while (j > at && /\s/.test(line[j - 1]!)) j--;
      return j;
    }
    if (CLAUSE_END.has(c)) {
      const next = line[k + 1];
      // "3.4", "10:30", "1,200" and "e.g.x" are not the end of a clause
      if (next !== undefined && !/[\s*_"'”’)]/.test(next)) continue;
      let j = k + 1;
      while (j < line.length && EMPHASIS.has(line[j]!)) j++;
      return j;
    }
  }
  let j = line.length;
  while (j > at && /\s/.test(line[j - 1]!)) j--;
  return j;
}

/** One line with its marker runs moved to the clause ends, each written as a \u0000n,m\u0000 placeholder. */
function moveLine(line: string, num: Map<string, number>): string {
  let out = line;
  for (let m = RUN.exec(out); m; m = RUN.exec(out)) {
    const ids = idsIn(m[0]);
    let after = out.slice(m.index + m[0].length);
    // a marker set off by commas ("one option, [[a]], on approval") leaves one comma, not two
    const before = out.slice(0, m.index);
    if (/[,;]$/.test(before) && /^[,;]/.test(after)) after = after.slice(1);
    const rest = before + after;
    // right after a clause's end ("option, [[a]] on", "7 Oct. [[a]]") it stays there; otherwise it moves on to the end
    const at = /[.,;:!?]["'”’*_]*$/.test(before) ? m.index : clauseEnd(rest, m.index);
    out = `${rest.slice(0, at)}\u0000${ids.map((id) => num.get(id)).join(",")}\u0000${rest.slice(at)}`;
  }
  // groups that landed side by side become one group, numbers in order and each once
  return out.replace(/\u0000([\d,]+)\u0000(?:\s*\u0000([\d,]+)\u0000)+/g, (all) => {
    const ns = [...new Set([...all.matchAll(/\u0000([\d,]+)\u0000/g)].flatMap((g) => g[1]!.split(",").map(Number)))];
    return `\u0000${ns.join(",")}\u0000`;
  });
}

export interface Numbered { /** The text with every marker run drawn once at its clause's end. */ md: string; /** Cited ids; source n is ids[n - 1]. */ ids: string[] }

/** The markdown link the web renderer draws as superscript numbers: [1,2](#cite:<id>,<id>). */
export const citeLink = (ns: number[], ids: string[]): string => `[${ns.join(",")}](${CITE_HREF}${ids.map(encodeURIComponent).join(",")})`;

/**
 * Number an answer's citations and move each run of markers to the end of its clause, drawn by `draw` (by default as one
 * link the web renderer turns into superscript numbers). A half-streamed "[[deci" at the end is hidden. Fenced code is
 * left alone.
 */
export function numberCitations(text: string, draw: (ns: number[], ids: string[]) => string = citeLink): Numbered {
  const src = text.replace(/\[\[[^\]]*$/, "");
  const ids = citeOrder(src);
  const num = new Map(ids.map((id, i) => [id, i + 1]));
  let fenced = false;
  const lines = src.split("\n").map((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return line; }
    return fenced || !line.includes("[[") ? line : moveLine(line, num);
  });
  const md = lines.join("\n").replace(/\u0000([\d,]+)\u0000/g, (_m, ns: string) => {
    const n = ns.split(",").map(Number);
    return draw(n, n.map((k) => ids[k - 1]!));
  });
  return { md, ids };
}

/** The ids a marker link stands for. */
export const idsOfHref = (href: string): string[] => href.slice(CITE_HREF.length).split(",").filter(Boolean).map(decodeURIComponent);

/** "1, 2" for two, "1–3" for a run of three or more in a row, "1, 3, 4" otherwise. */
export function markerText(ns: number[]): string {
  const sorted = [...ns].sort((a, b) => a - b);
  const run = sorted.length >= 3 && sorted.every((n, i) => i === 0 || n === sorted[i - 1]! + 1);
  return run ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(", ");
}

