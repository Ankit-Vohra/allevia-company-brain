// The blog post (/blog/) in the prototype's design. Its words live in one place, docs/blog/allevia-company-brain-on-falkordb.md;
// the page shows the post itself, which starts after the draft notes (the first line that is only "---"). A small build-time
// Markdown converter, for what the post uses:
//   - `#` is the title; an image right after it is the cover; `##` and `###` are headings (the `##` ones get ids and fill the
//     contents list, a sticky column on wide screens and a closed <details> on phones);
//   - paragraphs, `- ` and `1. ` lists, bold, inline code, links;
//   - images as figures (captioned with their alt text; they may run wider than the text column on desktop);
//   - `> **8×** fewer tokens…` as a key-number callout (the bold part is the big number);
//   - tables as the site's `.ledger` (each cell labelled for the phone layout);
//   - fenced code, with simple highlighting for cypher and ts (keywords, strings, comments, numbers) done here, at build time.
// Images sit next to the page (proto/blog/images/), so Vite bundles them like any other picture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { esc } from "./util.ts";

const POST = fileURLToPath(new URL("../../../docs/blog/allevia-company-brain-on-falkordb.md", import.meta.url));
export const BYLINE = { author: "Ankit Vohra", date: "18 October 2026" };
const WORDS_PER_MINUTE = 230;

/** Inline Markdown: code, links, bold. Text is escaped first; code spans are kept as they are. */
function inline(s: string): string {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
    .replace(/(https:\/\/[^\s<)]+[^\s<).,])/g, (m, u: string, off: number, all: string) => (all.slice(Math.max(0, off - 6), off).includes('href="') ? m : `<a href="${u}">${u}</a>`))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

/** An id for a heading: lowercase words joined by hyphens. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/`/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

// ---------- code highlighting ----------

const KEYWORDS: Record<string, { words: Set<string>; caseless: boolean }> = {
  cypher: {
    caseless: true,
    words: new Set(("match optional where return with order by limit skip unwind as call yield create merge set delete detach remove " +
      "and or not in is null true false case when then else end distinct asc desc union all on foreach exists").split(" ")),
  },
  ts: {
    caseless: false,
    words: new Set(("const let var function return if else for of in new throw await async export import from type interface " +
      "true false null undefined typeof as extends class this").split(" ")),
  },
};

const TOKEN = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|(\b\d[\d_,.]*\b)|([A-Za-z_$][\w$]*)|([\s\S])/g;

/** Escapes `code` and wraps keywords, strings, comments and numbers in spans; any other language is only escaped. */
export function highlight(code: string, lang: string): string {
  const kw = KEYWORDS[lang === "typescript" ? "ts" : lang];
  if (!kw) return esc(code);
  let out = "";
  for (const m of code.matchAll(TOKEN)) {
    const [all, comment, str, num, word] = m;
    if (comment) out += `<span class="tk-c">${esc(comment)}</span>`;
    else if (str) out += `<span class="tk-s">${esc(str)}</span>`;
    else if (num) out += `<span class="tk-n">${esc(num)}</span>`;
    else if (word) out += kw.words.has(kw.caseless ? word.toLowerCase() : word) ? `<span class="tk-k">${esc(word)}</span>` : esc(word);
    else out += esc(all);
  }
  return out;
}

// ---------- the converter ----------

export interface Heading { id: string; text: string }
export interface Post { title: string; cover: { src: string; alt: string } | null; body: string; toc: Heading[]; minutes: number }

const cells = (row: string): string[] => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function blogHtml(md: string): Post {
  const start = md.indexOf("\n---\n");
  const lines = (start >= 0 ? md.slice(start + 5) : md).split("\n");
  let title = "";
  let cover: Post["cover"] = null;
  let words = 0;
  const toc: Heading[] = [];
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const count = (s: string) => { words += s.split(/\s+/).filter(Boolean).length; };
  const flushPara = () => { if (para.length) { count(para.join(" ")); out.push(`<p>${inline(para.join(" "))}</p>`); } para = []; };
  const flushList = () => {
    if (list) { list.items.forEach(count); out.push(`<${list.tag}>${list.items.map((li) => `<li>${inline(li)}</li>`).join("")}</${list.tag}>`); }
    list = null;
  };
  const flush = () => { flushPara(); flushList(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      const lang = fence[1] ?? "";
      out.push(`<pre class="blog__code"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${highlight(code.join("\n"), lang)}</code></pre>`);
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) {
      flush();
      if (title && !out.length && !cover) { cover = { src: `./${img[2]!}`, alt: img[1]! }; continue; }
      out.push(`<figure class="blog__fig"><img src="./${img[2]}" alt="${esc(img[1]!)}" loading="lazy"><figcaption>${esc(img[1]!)}</figcaption></figure>`);
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flush();
      if (h[1] === "#") { title = h[2]!; continue; }
      if (h[1] === "##") {
        const id = slug(h[2]!);
        toc.push({ id, text: h[2]! });
        out.push(`<h2 id="${id}">${inline(h[2]!)}</h2>`);
      } else out.push(`<h3>${inline(h[2]!)}</h3>`);
      continue;
    }
    const quote = /^> (.*)$/.exec(line);
    if (quote) {
      flush();
      const q = /^\*\*([^*]+)\*\*\s*(.*)$/.exec(quote[1]!);
      count(quote[1]!);
      out.push(q
        ? `<aside class="blog__callout"><span class="blog__callout-n">${esc(q[1]!)}</span><span class="blog__callout-t">${inline(q[2]!)}</span></aside>`
        : `<aside class="blog__callout"><span class="blog__callout-t">${inline(quote[1]!)}</span></aside>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      if (/^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) i++;
      while (i + 1 < lines.length && /^\|.*\|\s*$/.test(lines[i + 1]!)) rows.push(cells(lines[++i]!));
      rows.forEach((r) => r.forEach(count));
      out.push(`<div class="table-wrap"><table class="ledger blog__table"><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c, k) => `<td data-label="${esc(head[k] ?? "")}">${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = /^- (.*)$/.exec(line);
    const oli = /^\d+\. (.*)$/.exec(line);
    if (li || oli) {
      flushPara();
      const tag = li ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      (list ??= { tag, items: [] }).items.push((li ?? oli)![1]!);
      continue;
    }
    if (list && /^ {2,3}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    if (!line.trim()) { flush(); continue; }
    flushList();
    para.push(line.trim());
  }
  flush();
  return { title, cover, body: out.join("\n"), toc, minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)) };
}

function tocList(toc: Heading[]): string {
  return `<ol>${toc.map((h) => `<li><a href="#${h.id}">${inline(h.text)}</a></li>`).join("")}</ol>`;
}

function blog(): string {
  const { title, cover, body, toc, minutes } = blogHtml(readFileSync(POST, "utf8"));
  const byline = `${BYLINE.author} · ${BYLINE.date} · ${minutes} min read`;
  return `<section class="page-head blog__head" aria-labelledby="h1"><div class="wrap"><h1 id="h1" class="page-h1 blog__h1">${esc(title)}</h1>
<p class="legal__date blog__byline">${esc(byline)}</p>
${cover ? `<figure class="blog__cover"><img src="${cover.src}" alt="${esc(cover.alt)}" fetchpriority="high"></figure>` : ""}</div></section>
<section class="legal blog"><div class="wrap blog__in">
<nav class="blog__nav" aria-label="On this page">
<div class="legal__toc blog__toc"><p class="legal__toc-h">On this page</p>${tocList(toc)}</div>
<details class="legal__toc blog__toc-m"><summary class="legal__toc-h">On this page</summary>${tocList(toc)}</details>
</nav>
<article class="legal__body blog__body">${body}</article></div></section>`;
}

export const BLOG_SECTIONS: Record<string, (page: string) => string> = { blog };
