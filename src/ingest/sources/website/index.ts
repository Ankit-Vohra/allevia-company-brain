// The website source (spec §6.2): crawl → Page, Document and Chunk nodes, links between pages, the website Channel;
// then brand (brand.ts), SEO (seo.ts) and understanding (understand.ts), each a mapper to a GraphWrite. src/onboard
// runs them in order and writes the results. Sources never talk to FalkorDB themselves.
//   Page -PART_OF-> channel:website, Page -SOURCED_FROM-> Document {kind:'webpage'} -HAS_CHUNK-> Chunk,
//   Page -LINKS_TO_PAGE-> Page, channel:website -PART_OF-> Business.
import type { EdgeInput, NodeInput, Prim } from "../../../graph/upsert.js";
import { entityId, pageKey, sha256 } from "../../../util/ids.js";
import type { GraphWrite } from "../../types.js";
import { channelId, channelNode } from "../channels.js";
import { chunkText, type PageData } from "./page.js";
import { pageDocId } from "./urls.js";

export * from "./urls.js";
export * from "./fetch.js";
export * from "./robots.js";
export * from "./page.js";
export * from "./crawl.js";
export * from "./brand.js";
export * from "./seo.js";
export * from "./understand.js";
export * from "./ask.js";

export const pageId = (url: string): string => entityId("Page", url);
export const chunkId = (url: string, ord: number): string => entityId("Chunk", `${pageKey(url)} ${ord}`);

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

// The website channel itself, part of the business. Without an origin it is the bare anchor pages hang off while the
// crawl runs; with one (where the crawl landed) it also records the URL and host.
export function websiteChannelWrite(origin: string | undefined, businessId: string, asOf: string): GraphWrite {
  return {
    nodes: [channelNode("website", { asOf, ...(origin ? { props: { url: origin, handle: new URL(origin).hostname } } : {}) })],
    edges: [{ from: channelId("website"), type: "PART_OF", to: businessId, asOf }],
    observations: [],
  };
}

// One crawled page: its Page node (what SEO measures), its Document (the source) and the Document's Chunks (its text,
// for search and citations).
export function pageWrite(p: PageData): GraphWrite {
  const url = p.finalUrl;
  const u = new URL(url);
  const id = pageId(url);
  const doc = pageDocId(url);
  const asOf = p.fetchedAt;
  const name = p.title?.trim() || u.pathname;
  const props: Record<string, Prim> = {
    url, path: u.pathname + u.search, statusCode: p.status, wordCount: p.wordCount, h1Count: p.h1.length, imageCount: p.images.length,
    imagesMissingAlt: p.images.filter((i) => i.alt === null).length, internalLinkCount: p.internalLinks.length,
    externalLinkCount: p.externalLinks.length, responseMs: p.timing.responseMs, jsonLdTypes: p.jsonLdTypes,
  };
  const opt: Record<string, Prim | undefined> = {
    title: p.title, metaDescription: p.metaDescription, h1: p.h1[0], canonical: p.canonical, lang: p.lang, viewport: p.viewport,
    robots: p.robotsMeta, loadMs: p.timing.loadMs, ogTitle: p.og["og:title"], ogImage: p.og["og:image"], error: p.error,
  };
  for (const [k, v] of Object.entries(opt)) if (v !== undefined && v !== "") props[k] = typeof v === "string" ? clip(v, 500) : v;
  if (p.h2.length) props.h2 = p.h2.slice(0, 10).map((h) => clip(h, 200));
  if (p.redirects.length) props.redirectedFrom = p.redirects.slice(0, 5);

  const nodes: NodeInput[] = [
    { type: "Page", id, name: clip(name, 200), ...(p.metaDescription ? { summary: clip(p.metaDescription, 400) } : {}), src: doc, asOf, props },
    { type: "Document", id: doc, name: `Web page: ${clip(name, 180)}`, asOf,
      props: { kind: "webpage", url, title: clip(name, 300), hash: sha256(p.text), path: u.pathname } },
  ];
  const edges: EdgeInput[] = [
    { from: id, type: "PART_OF", to: channelId("website"), src: doc, asOf },
    { from: id, type: "SOURCED_FROM", to: doc, src: doc, asOf },
  ];
  chunkText(p.text).forEach((text, ord) => {
    const cid = chunkId(url, ord);
    nodes.push({ type: "Chunk", id: cid, name: `${clip(name, 120)} (part ${ord + 1})`, src: doc, asOf, props: { text, ord, url } });
    edges.push({ from: doc, type: "HAS_CHUNK", to: cid, src: doc, asOf });
  });
  return { nodes, edges, observations: [] };
}

// Links between crawled pages (only pages that are in the graph), one edge per pair.
export function linksWrite(pages: PageData[]): GraphWrite {
  const known = new Set(pages.map((p) => p.finalUrl));
  const edges: EdgeInput[] = [];
  for (const p of pages) {
    for (const l of new Set(p.internalLinks)) {
      if (l !== p.finalUrl && known.has(l)) edges.push({ from: pageId(p.finalUrl), type: "LINKS_TO_PAGE", to: pageId(l), src: pageDocId(p.finalUrl), asOf: p.fetchedAt });
    }
  }
  return { nodes: [], edges, observations: [] };
}
