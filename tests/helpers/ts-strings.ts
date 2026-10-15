// Every string and template literal of a TypeScript file (comments and regex literals skipped), so a test can read the
// Cypher a module sends without running it. A template's ${…} expressions become the placeholder __EXPR__ in its text,
// and the strings inside an expression are returned as literals of their own. Not a full lexer: it knows the TypeScript
// this repo writes (no JSX, no regex after a `}`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Literal { text: string; line: number }

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", f: "\f", v: "\v" };
// A `/` after one of these starts a regex literal; after anything else it divides.
const REGEX_AFTER = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

export function stringLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  const newlines: number[] = [];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) newlines.push(i);
  const lineAt = (at: number): number => {
    let lo = 0;
    let hi = newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newlines[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  };

  // Reads code from i until the end of the file, or (nested) the `}` that closes a ${…}; returns where it stopped.
  const code = (from: number, nested: boolean): number => {
    let depth = 0;
    let prev = ""; // last significant character
    for (let i = from; i < src.length; i++) {
      const c = src[i]!;
      const n = src[i + 1];
      if (c === "/" && n === "/") { i = src.indexOf("\n", i); if (i < 0) return src.length; continue; }
      if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 1; continue; }
      if (c === "/" && (prev === "" || REGEX_AFTER.has(prev) || /\b(?:return|typeof|case|in|of)$/.test(src.slice(Math.max(0, i - 7), i).trimEnd()))) {
        let inClass = false;
        for (i++; i < src.length; i++) {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          else if (src[i] === "/" && !inClass) break;
        }
        prev = "/";
        continue;
      }
      if (c === "'" || c === '"') {
        let text = "";
        let j = i + 1;
        for (; j < src.length && src[j] !== c && src[j] !== "\n"; j++) {
          if (src[j] === "\\") { j++; text += ESCAPES[src[j]!] ?? src[j]!; } else text += src[j];
        }
        out.push({ text, line: lineAt(i) });
        i = j;
        prev = c;
        continue;
      }
      if (c === "`") {
        let text = "";
        let j = i + 1;
        for (; j < src.length && src[j] !== "`"; j++) {
          if (src[j] === "\\") { j++; text += ESCAPES[src[j]!] ?? src[j]!; }
          else if (src[j] === "$" && src[j + 1] === "{") { j = code(j + 2, true); text += "__EXPR__"; }
          else text += src[j];
        }
        out.push({ text, line: lineAt(i) });
        i = j;
        prev = "`";
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        if (nested && depth === 0) return i;
        depth--;
      }
      if (!/\s/.test(c)) prev = c;
    }
    return src.length;
  };
  code(0, false);
  return out;
}

export function sourceFiles(dir: string, ext = ".ts"): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

export const readSource = (path: string): string => readFileSync(path, "utf8");
