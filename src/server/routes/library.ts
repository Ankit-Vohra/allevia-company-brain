// The Library (read-only): every picture, ad and clip the team made for this business and every photo the owner sent, newest
// first, so nothing made is lost in a chat thread.
//   GET /api/:t/library   { items: LibraryItem[] }
// Read from the graph, never written: the Asset nodes the Studio and the creative desks save (src/studio, src/creative), the card
// that proposes each one (Recommendation -EVIDENCED_BY-> Asset, Recommendation -PROPOSES-> Approval) and the post that uses it
// (Content -USES_ASSET-> Asset). How each one was made is the lineage route (GET /api/:t/assets/:id/lineage, server/studio.ts).
// Left out: files that are not kept (a refused photo), the artwork behind a poster (the poster's lineage shows it), and the
// brand files (GET /api/:t/brand).
import type { Hono } from "hono";
import type { LibraryDto, LibraryItem, LibraryKind, LibraryState } from "../../../shared/contracts.js";
import type { GraphHandle } from "../../graph/client.js";
import { assetUrl } from "../../studio/intake.js";
import type { RouteCtx } from "../http.js";

const LIMIT = 300;
const READ_MS = 10_000;

interface Row {
  id: string; name: string | null; kind: string | null; mediaType: string | null; mime: string | null; step: string | null; source: string | null;
  label: string | null; status: string | null; credits: number | null; recorded: boolean | null; badge: string | null; check: string | null;
  headline: string | null; at: number | null; generatedAt: number | null;
}

/** What kind of thing an Asset is, in the Library's words. */
export function libraryKind(r: Pick<Row, "kind" | "mediaType" | "mime" | "step" | "headline">): LibraryKind {
  const video = r.mediaType === "video" || (r.mime ?? "").startsWith("video/");
  if (r.kind === "original") return video ? "your-video" : "your-photo";
  if (video || r.kind === "clip" || r.step === "clip") return "clip";
  if (r.kind === "poster") return "poster";
  if (r.step === "premium-ad") return "product-shoot";
  if (r.step === "generative-ad" || r.headline) return "ad";
  return "picture";
}

const OK_STATUSES = new Set(["approved", "edited", "executed"]);

/** Where it stands: posted beats everything; then the asset's own record after an OK; then the card that proposes it. */
export function libraryState(o: { mine: boolean; status: string | null; posted: boolean; cards: Array<{ status: string }> }): LibraryState | null {
  if (o.posted) return "posted";
  if (o.mine) return null;
  if (o.status === "approved") return "approved";
  if (o.status === "declined") return "declined";
  if (o.cards.some((c) => c.status === "pending")) return "waiting";
  if (o.cards.some((c) => c.status === "rejected")) return "declined";
  if (o.cards.some((c) => OK_STATUSES.has(c.status))) return "approved";
  return null;
}

const checkOf = (badge: string | null, check: string | null): LibraryItem["check"] => {
  const b = check ?? badge;
  if (b === "ok" || b === "unchanged") return "ok";
  if (b === "held" || b === "changed" || b === "reject") return "held";
  if (b === "unchecked") return "unchecked";
  return null;
};

export async function readLibrary(g: GraphHandle, tenant: string): Promise<LibraryItem[]> {
  const rows = await g.roQuery<Row>(
    `MATCH (a:Entity:Asset)
     WHERE a.storageKey IS NOT NULL AND a.storageKey <> '' AND coalesce(a.status, '') <> 'blocked' AND coalesce(a.kind, '') <> 'artwork'
     RETURN a.id AS id, a.name AS name, a.kind AS kind, a.mediaType AS mediaType, a.mime AS mime, a.step AS step, a.source AS source,
            a.label AS label, a.status AS status, a.hfCredits AS credits, a.recorded AS recorded, a.fidelityBadge AS badge, a.check AS check,
            a.adHeadline AS headline, a.createdAt AS at, a.generatedAt AS generatedAt
     ORDER BY at DESC, id LIMIT $limit`, { limit: LIMIT }, { timeoutMs: READ_MS });
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [cards, posts] = await Promise.all([
    g.roQuery<{ assetId: string; approvalId: string; status: string | null }>(
      `UNWIND $ids AS aid MATCH (rec:Entity:Recommendation)-[e:EVIDENCED_BY]->(x:Entity:Asset {id:aid}) WHERE ID(e) >= 0
       MATCH (rec)-[p:PROPOSES]->(ap:Entity:Approval) WHERE ID(p) >= 0
       RETURN x.id AS assetId, ap.id AS approvalId, ap.status AS status, ap.createdAt AS cat ORDER BY cat DESC, approvalId`, { ids }, { timeoutMs: READ_MS }),
    g.roQuery<{ assetId: string }>(
      `UNWIND $ids AS aid MATCH (c:Entity:Content)-[u:USES_ASSET]->(x:Entity:Asset {id:aid}) WHERE ID(u) >= 0 AND (c.status = 'published' OR c.publishedAt IS NOT NULL)
       RETURN DISTINCT x.id AS assetId`, { ids }, { timeoutMs: READ_MS }),
  ]);
  const cardsOf = new Map<string, Array<{ approvalId: string; status: string }>>();
  for (const c of cards) {
    const list = cardsOf.get(c.assetId) ?? [];
    if (!list.some((x) => x.approvalId === c.approvalId)) list.push({ approvalId: c.approvalId, status: c.status ?? "" });
    cardsOf.set(c.assetId, list);
  }
  const posted = new Set(posts.map((p) => p.assetId));
  return rows.map((r): LibraryItem => {
    const kind = libraryKind(r);
    const mine = kind === "your-photo" || kind === "your-video";
    const media = kind === "clip" || kind === "your-video" ? "video" : "image";
    const list = cardsOf.get(r.id) ?? [];
    const state = libraryState({ mine, status: r.status, posted: posted.has(r.id), cards: list });
    const card = list.find((c) => c.status === "pending") ?? list[0];
    const credits = typeof r.credits === "number" && Number.isFinite(r.credits) && r.credits > 0 && r.recorded !== true ? r.credits : null;
    return {
      id: r.id, title: r.name ?? r.id, kind, media, mine, state, approvalId: card?.approvalId ?? null,
      at: r.at ?? r.generatedAt ?? 0, credits, label: r.label ?? null, check: mine ? null : checkOf(r.badge, r.check),
      url: assetUrl(tenant, r.id), thumb: media === "video" ? assetUrl(tenant, r.id) : assetUrl(tenant, r.id, 480),
    };
  });
}

export function registerLibraryRoutes(app: Hono, ctx: RouteCtx): void {
  app.get("/api/:t/library", async (c) => {
    const { reg, g } = await ctx.tenantOf(c);
    const dto: LibraryDto = { items: await readLibrary(g, reg.slug) };
    return c.json(dto);
  });
}
