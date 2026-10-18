// The blog post (/blog/) in the prototype's design. Its words live in one place, docs/blog/allevia-company-brain-on-falkordb.md;
// the page shows the post itself, which starts after the draft notes (the first line that is only "---"). Only the Markdown the
// post uses is handled: headings, paragraphs, lists, bold, inline code, links, images (as figures) and one fenced code block.
// Images sit next to the page (proto/blog/images/), so Vite bundles them like any other picture.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { esc } from "./util.ts";

const POST = fileURLToPath(new URL("../../../docs/blog/allevia-company-brain-on-falkordb.md", import.meta.url));

/** Inline Markdown: code, images, links, bold. Text is escaped first; code spans are kept as they are. */
function inline(s: string): string {
  const codes: string[] = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u}">${t}</a>`)
    .replace(/(https:\/\/[^\s<)]+[^\s<).,])/g, (m, u: string, off: number, all: string) => (all.slice(Math.max(0, off - 6), off).includes('href="') ? m : `<a href="${u}">${u}</a>`))
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
}

export function blogHtml(md: string): { title: string; body: string } {
  const start = md.indexOf("\n---\n");
  const lines = (start >= 0 ? md.slice(start + 5) : md).split("\n");
  let title = "";
  const out: string[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`); para = []; };
  const flushList = () => { if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      flushPara(); flushList();
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      out.push(`<pre class="blog__code"><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const img = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (img) { flushPara(); flushList(); out.push(`<figure class="blog__fig"><img src="./${img[2]}" alt="${esc(img[1]!)}" loading="lazy"><figcaption>${esc(img[1]!)}</figcaption></figure>`); continue; }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      if (h[1] === "#") title = h[2]!;
      else out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`);
      continue;
    }
    const li = /^- (.*)$/.exec(line);
    if (li) { flushPara(); (list ??= []).push(li[1]!); continue; }
    if (list && /^ {2}\S/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return { title, body: out.join("\n") };
}

function blog(): string {
  const { title, body } = blogHtml(readFileSync(POST, "utf8"));
  return `<section class="page-head" aria-labelledby="h1"><div class="wrap"><h1 id="h1" class="page-h1 blog__h1">${esc(title)}</h1>
<p class="legal__date">18 October 2026 · Graph Hacks: Context for AI Agents</p></div></section>
<section class="legal"><div class="wrap"><article class="legal__body blog__body">${body}</article></div></section>`;
}

export const BLOG_SECTIONS: Record<string, (page: string) => string> = { blog };
