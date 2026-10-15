// Heading scanner shared by the privacy filter (drop sensitive sections) and the markdown parser (sections, chunks).
// It knows what is NOT a heading: front matter, fenced code blocks (``` and ~~~), and table or list lines before a
// "---" rule. Both ATX (`## Title`) and single-line setext (`Title` over `----`) headings count, because a section the
// privacy filter fails to see is a section that leaks.

export interface Heading {
  line: number;   // 0-based index of the heading text line
  end: number;    // 0-based index of the last line the heading occupies (the underline for setext)
  level: number;  // 1-6
  text: string;
}

const MAX_HEADING_LINE = 2000;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const NOT_PARAGRAPH = /^\s*(?:[-*+]\s|\d+[.)]\s|>|\||#|<|`{3}|~{3}|\[[^\]]+\]:)/;

// Index of the line after the closing front matter delimiter, or 0 when there is no front matter.
export function frontmatterEnd(lines: string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t === "---" || t === "...") return i + 1;
  }
  return 0;
}

// true for every line that is inside a fenced code block or is one of its fence delimiters (front matter is skipped).
export function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fence: { ch: string; len: number } | null = null;
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE.exec(line);
    if (fence) {
      mask[i] = true;
      if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len && line.trim() === f[1]) fence = null;
    } else if (f) {
      mask[i] = true;
      fence = { ch: f[1]![0]!, len: f[1]!.length };
    }
  }
  return mask;
}

export function scanHeadings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  const fenced = fenceMask(lines);
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    if (fenced[i]) continue;
    const line = lines[i]!;
    if (line.length > MAX_HEADING_LINE) continue; // not a heading, and keeps the regexes away from pathological lines
    const atx = ATX.exec(line);
    if (atx) {
      out.push({ line: i, end: i, level: atx[1]!.length, text: (atx[2] ?? "").trim() });
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && !fenced[i + 1] && line.trim() !== "" && !NOT_PARAGRAPH.test(line) && !/^ {4,}/.test(line)) {
      const u = SETEXT_UNDERLINE.exec(next);
      if (u) {
        out.push({ line: i, end: i + 1, level: u[1]![0] === "=" ? 1 : 2, text: line.trim() });
        i++;
      }
    }
  }
  return out;
}
