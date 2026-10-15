// Markdown parser for vault notes: front matter, sections, wiki-links (resolved against the vault's file list) and
// retrieval chunks. Pure and synchronous; it never throws on odd input (broken YAML, unclosed fences, 1 MB lines).
//
// Chunking: split on headings first, then on paragraph boundaries, packing paragraphs up to ~CHUNK_TARGET characters
// (a short chunk may take one more paragraph, up to CHUNK_MAX). A paragraph longer than CHUNK_MAX is split at line, then
// sentence, then word boundaries. The only time a word is cut is when a single token is longer than CHUNK_MAX.
import { parse as parseYaml } from "yaml";
import { fenceMask, frontmatterEnd, scanHeadings } from "./headings.js";

export const CHUNK_TARGET = 800;
export const CHUNK_MAX = 1200;
const SMALL_CHUNK = 300; // below this, a chunk may grow past the target (up to CHUNK_MAX) rather than leave a stub

export interface MdSection { heading: string; level: number; text: string }
export interface Wikilink { target: string; alias?: string; resolved?: string }
export interface MdChunk { ord: number; heading: string; text: string }
export interface ParsedMarkdown {
  title: string;
  frontmatter: Record<string, unknown>;
  sections: MdSection[];
  wikilinks: Wikilink[];
  chunks: MdChunk[];
}

// ---------- front matter ----------

function readFrontmatter(lines: string[], end: number): Record<string, unknown> {
  if (end === 0) return {};
  try {
    const v: unknown = parseYaml(lines.slice(1, end - 1).join("\n"), { uniqueKeys: false });
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ---------- wiki-links ----------

// Blank out fenced blocks and inline code so links inside them are not links. Same length, so offsets are stable.
function maskCode(lines: string[], from: number): string[] {
  const fenced = fenceMask(lines);
  return lines.map((line, i) => {
    if (i < from || fenced[i]) return " ".repeat(line.length);
    if (!line.includes("`") || line.length > 5000) return line;
    return line.replace(/(`+)(?!`)(.*?[^`])\1(?!`)/g, (m) => " ".repeat(m.length));
  });
}

interface FileIndex {
  exact: Map<string, string>;
  lower: Map<string, string[]>;
  byBase: Map<string, string[]>;
  noExt: Array<[string, string]>; // [lower-cased path without .md, file]
}

const indexCache = new WeakMap<readonly string[], FileIndex>();

function buildIndex(files: readonly string[]): FileIndex {
  const cached = indexCache.get(files);
  if (cached) return cached;
  const idx: FileIndex = { exact: new Map(), lower: new Map(), byBase: new Map(), noExt: [] };
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const raw of files) {
    const f = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    const noExt = f.replace(/\.md$/i, "");
    const lower = noExt.toLowerCase();
    idx.exact.set(noExt, f);
    push(idx.lower, lower, f);
    push(idx.byBase, lower.slice(lower.lastIndexOf("/") + 1), f);
    idx.noExt.push([lower, f]);
  }
  indexCache.set(files, idx);
  return idx;
}

const only = (xs: string[] | undefined): string | undefined => (xs && xs.length === 1 ? xs[0] : undefined);

function resolveLink(target: string, files: readonly string[]): string | undefined {
  const idx = buildIndex(files);
  const t = target.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
  const tl = t.toLowerCase();
  return idx.exact.get(t)
    ?? only(idx.lower.get(tl))
    ?? (t.includes("/")
      ? only(idx.noExt.filter(([p]) => p.endsWith(`/${tl}`)).map(([, f]) => f))
      : only(idx.byBase.get(tl)));
}

function readWikilinks(masked: string[], files?: readonly string[]): Wikilink[] {
  const out: Wikilink[] = [];
  const seen = new Set<string>();
  for (const line of masked) {
    if (!line.includes("[[")) continue;
    for (const m of line.matchAll(/\[\[([^[\]\n]{1,300})\]\]/g)) {
      const inner = m[1]!.replace(/\\\|/g, "|");
      const bar = inner.indexOf("|");
      const left = bar === -1 ? inner : inner.slice(0, bar);
      const alias = bar === -1 ? undefined : inner.slice(bar + 1).trim() || undefined;
      const hash = left.indexOf("#");
      const target = (hash === -1 ? left : left.slice(0, hash)).trim();
      if (!target) continue; // [[#heading]] points into the same note
      const key = `${target}|${alias ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const link: Wikilink = { target };
      if (alias) link.alias = alias;
      const resolved = files ? resolveLink(target, files) : undefined;
      if (resolved) link.resolved = resolved;
      out.push(link);
    }
  }
  return out;
}

// ---------- chunks ----------

interface Piece { text: string; sep: string } // sep: what joined this piece to the previous one

// Paragraphs = blocks separated by blank lines; a fenced code block stays in one piece even if it has blank lines.
export function splitParagraphs(text: string): string[] {
  const lines = text.split("\n");
  const fenced = fenceMask(lines);
  const out: string[] = [];
  let cur: string[] = [];
  const flush = () => { const p = cur.join("\n").trim(); if (p) out.push(p); cur = []; };
  lines.forEach((line, i) => {
    if (!fenced[i] && line.trim() === "") flush();
    else cur.push(line);
  });
  flush();
  return out;
}

// Cut a token longer than CHUNK_MAX on code point boundaries.
function hardSplit(word: string): string[] {
  const cps = Array.from(word);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += CHUNK_MAX) out.push(cps.slice(i, i + CHUNK_MAX).join(""));
  return out;
}

// Words packed greedily up to CHUNK_TARGET.
function packWords(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    for (const piece of w.length > CHUNK_MAX ? hardSplit(w) : [w]) {
      if (cur && cur.length + 1 + piece.length > CHUNK_TARGET) { out.push(cur); cur = piece; }
      else cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// A block longer than CHUNK_MAX becomes pieces of at most CHUNK_MAX: lines first, then sentences, then words.
function explode(block: string): Piece[] {
  if (block.length <= CHUNK_MAX) return [{ text: block, sep: "\n\n" }];
  const pieces: Piece[] = [];
  const lines = block.split("\n");
  lines.forEach((line, li) => {
    const lineSep = li === 0 ? "\n\n" : "\n";
    if (line.length <= CHUNK_MAX) { pieces.push({ text: line, sep: lineSep }); return; }
    const sentences = line.split(/(?<=[.!?।])\s+/).filter(Boolean);
    sentences.forEach((sent, si) => {
      const sep = si === 0 ? lineSep : " ";
      if (sent.length <= CHUNK_MAX) pieces.push({ text: sent, sep });
      else packWords(sent).forEach((w, wi) => pieces.push({ text: w, sep: wi === 0 ? sep : " " }));
    });
  });
  return pieces;
}

function pack(pieces: Piece[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (!cur) { cur = p.text; continue; }
    const joined = cur + p.sep + p.text;
    if (joined.length <= CHUNK_TARGET || (cur.length < SMALL_CHUNK && joined.length <= CHUNK_MAX)) cur = joined;
    else { out.push(cur); cur = p.text; }
  }
  if (cur) out.push(cur);
  return out;
}

function chunkSection(text: string): string[] {
  return pack(splitParagraphs(text).flatMap(explode)).map((c) => c.trim()).filter(Boolean);
}

// ---------- entry point ----------

export function parseMarkdown(path: string, text: string, vaultFiles?: string[]): ParsedMarkdown {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const fmEnd = frontmatterEnd(lines);
  const frontmatter = readFrontmatter(lines, fmEnd);
  const headings = scanHeadings(lines);

  const sections: MdSection[] = [];
  const firstLine = headings[0]?.line ?? lines.length;
  const preamble = lines.slice(fmEnd, firstLine).join("\n").trim();
  if (preamble) sections.push({ heading: "", level: 0, text: preamble });
  headings.forEach((h, i) => {
    const stop = headings[i + 1]?.line ?? lines.length;
    sections.push({ heading: h.text, level: h.level, text: lines.slice(h.end + 1, stop).join("\n").trim() });
  });

  const fmTitle = frontmatter.title;
  const base = path.split("/").pop() ?? path;
  const title =
    (typeof fmTitle === "string" || typeof fmTitle === "number" ? String(fmTitle).trim() : "")
    || headings.find((h) => h.level === 1 && h.text)?.text
    || base.replace(/\.[^.]+$/, "");

  const wikilinks = readWikilinks(maskCode(lines, fmEnd), vaultFiles);

  const chunks: MdChunk[] = [];
  for (const s of sections) {
    for (const c of chunkSection(s.text)) chunks.push({ ord: chunks.length, heading: s.heading || title, text: c });
  }
  return { title, frontmatter, sections, wikilinks, chunks };
}
