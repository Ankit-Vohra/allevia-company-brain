// A page the crawl found before and no longer finds (graph audit G26). Onboarding re-run on a business whose website lost a page
// used to leave that page `PART_OF channel:website` for good. The edge is closed instead, with the reason, never deleted, so
// "when did this page leave the site" is a read, and the page comes back (a new edge) if a later crawl finds it again.
//
// A crawl that did not see the whole site must not be taken as proof a page is gone, so the caller closes only after a complete
// one (`crawlWasComplete`): it did not stop at its time limit or its page cap, no page failed to load, and a browser read them all.
// Only pages the crawl itself wrote (those with a webpage Document) are candidates: a page the check-up or a keyword ranking
// named is not the crawl's to retire.
import type { GraphHandle } from "../graph/client.js";
import { closeEdge } from "../graph/upsert.js";
import type { CrawlResult, PageData } from "../ingest/sources/website/index.js";
import { pageId } from "../ingest/sources/website/index.js";
import { channelId } from "../ingest/sources/channels.js";

export const VANISHED_REASON = "no longer found on the website";

type Read = Pick<GraphHandle, "roQuery">;

export function crawlWasComplete(crawl: Pick<CrawlResult, "timedOut" | "browserError">, pages: PageData[], maxPages: number): boolean {
  return !crawl.timedOut && !crawl.browserError && pages.length > 0 && pages.length < maxPages && !pages.some((p) => !!p.error);
}

const bare = (host: string): string => host.toLowerCase().replace(/^www\./, "");

/** The website's pages (the ones a crawl wrote) that this crawl did not find, on the same site. */
export async function vanishedPages(g: Read, crawled: PageData[], origin: string): Promise<string[]> {
  const found = new Set(crawled.map((p) => pageId(p.finalUrl)));
  const host = bare(new URL(origin).hostname);
  // from the website channel out, so the walk starts at an indexed node; the kind of document is checked after, not scanned for
  const rows = await g.roQuery<{ id: string; url: string | null; kind: string | null; doc: string }>(
    `MATCH (:Entity:Channel {id:$site})<-[r:PART_OF]-(p:Entity:Page)-[s:SOURCED_FROM]->(d:Entity) WHERE r.until IS NULL AND s.until IS NULL
     RETURN p.id AS id, p.url AS url, d.kind AS kind, d.id AS doc ORDER BY id, doc LIMIT 20000`, { site: channelId("website") });
  const written = new Set(rows.filter((r) => r.kind === "webpage").map((r) => r.id));
  return [...new Map(rows.filter((r) => written.has(r.id)).map((r) => [r.id, r])).values()].filter((r) => {
    try {
      return !!r.url && bare(new URL(r.url).hostname) === host && !found.has(r.id);
    } catch {
      return false;
    }
  }).map((r) => r.id);
}

/** Closes the PART_OF edge of each page this complete crawl no longer finds; returns how many. */
export async function closeVanishedPages(g: GraphHandle, crawled: PageData[], origin: string, now: number): Promise<string[]> {
  const gone = await vanishedPages(g, crawled, origin);
  const closed: string[] = [];
  for (const id of gone) if (await closeEdge(g, id, "PART_OF", channelId("website"), now, VANISHED_REASON)) closed.push(id);
  return closed;
}
