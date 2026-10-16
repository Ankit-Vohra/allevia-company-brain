// What a connection leaves in the business's own graph, so "which numbers came from Instagram" is a traversal and not a guess.
//
//   System{kind:'connector'}            the connection itself: status (a tracked prop, so connected -> expired -> connected leaves
//                                       Versions), connectedAt, connectedBy (the owner's Person when there is one), lastPullAt,
//                                       dataThrough and factCount (how many Observations and Documents the last read wrote)
//   Business -OWNS-> System             the business has this connection
//   Channel -DEPENDS_ON-> System        the channel whose numbers the connection feeds (Search Console and Analytics: the website)
//   System -PRODUCED-> Document         the snapshot of each read; the read's Observations are SOURCED_FROM that Document
//
// Only facts go in here. A token never does: it stays in the sealed vault (src/connectors/google/store.ts).
// Every write carries `src` (who said so: the owner, else the business) and `asOf` (the moment), and none of them can fail a
// connection: a failed link is returned as words and the ladder catches up on its next sync.
//
// `src` on the System is the same on every write on purpose: upsertNode treats "same date, another source, same values already
// kept as a Version" as a replay and would skip a status that flipped back on the same day. The Document a read produced is
// named by the PRODUCED edge instead.
import { findBusiness, syncCapabilities } from "../capabilities/ladder.js";
import type { GraphHandle } from "../graph/client.js";
import { settleGoals } from "../program/late.js";
import { upsertNode, writeBatch, type EdgeInput, type NodeInput, type ObservationInput, type Prim } from "../graph/upsert.js";
import type { ConnectorCtx } from "./types.js";

/** The connection a write is about: its id (the sealed record's name), its System node, and who runs it. */
export interface ConnRef { id: string; system: { id: string; name: string }; provider: "google" | "composio" }

const WEBSITE = "channel:website";
/** The channels a connection's numbers are about, by connection id. Only a channel that already exists in the graph is linked. */
export const FEEDS: Readonly<Record<string, readonly string[]>> = {
  "search-console": ["channel:google-search", WEBSITE],
  "google-analytics": [WEBSITE],
  instagram: ["channel:instagram"],
  "facebook-pages": ["channel:facebook"],
  linkedin: ["channel:linkedin"],
  tiktok: ["channel:tiktok"],
  "google-ads": ["channel:google-ads"],
  "meta-ads": ["channel:meta-ads"],
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** The owner's Person node when the graph has one (the founder, else a person whose role says owner). Never made up. */
export async function ownerOf(g: Pick<GraphHandle, "roQuery">): Promise<string | undefined> {
  const [p] = await g.roQuery<{ id: string }>(
    "MATCH (p:Entity:Person) WHERE p.id = 'person:founder' OR p.role IN ['founder', 'owner'] RETURN p.id AS id ORDER BY CASE WHEN p.id = 'person:founder' THEN 0 ELSE 1 END, id LIMIT 1");
  return p?.id;
}

async function existing(g: Pick<GraphHandle, "roQuery">, label: "Channel" | "System" | "Document", ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await g.roQuery<{ id: string }>(`UNWIND $ids AS id MATCH (n:Entity:${label} {id:id}) RETURN n.id AS id`, { ids: [...ids] });
  return new Set(rows.map((r) => r.id));
}

interface Who { biz: string | null; owner: string | undefined; src: string | undefined }

async function whoIs(g: GraphHandle, ctx: ConnectorCtx): Promise<Who> {
  const [biz, owner] = await Promise.all([findBusiness(g, ctx.businessId).catch(() => null), ownerOf(g).catch(() => undefined)]);
  return { biz, owner, src: owner ?? biz ?? undefined };
}

/** OWNS and DEPENDS_ON for one connection: the edges that say what the System is to the business and to the channels it feeds. */
async function structureEdges(g: GraphHandle, ref: ConnRef, who: Who, at: string): Promise<EdgeInput[]> {
  const edges: EdgeInput[] = [];
  const stamp = { asOf: at, ...(who.src ? { src: who.src } : {}) };
  if (who.biz) edges.push({ from: who.biz, type: "OWNS", to: ref.system.id, ...stamp });
  const feeds = await existing(g, "Channel", FEEDS[ref.id] ?? []);
  for (const c of FEEDS[ref.id] ?? []) if (feeds.has(c)) edges.push({ from: c, type: "DEPENDS_ON", to: ref.system.id, ...stamp });
  return edges;
}

const baseProps = (ref: ConnRef): Record<string, Prim> => ({ kind: "connector", provider: ref.provider, connector: ref.id });

/** connected (the owner said yes), pending (connected, but a website or account is still to be picked), picked (they picked it), expired, disconnected. */
export type ConnectionEvent = "connected" | "pending" | "picked" | "expired" | "disconnected";

/**
 * The connection's state changed: the owner connected it, Google stopped letting us in, or the owner removed it. The System's
 * `status` follows (ok, expired, not_connected: each change leaves a Version), and the business owns it. Returns what could not
 * be written, in words; it never throws, so a connection never fails over its record.
 */
export async function noteConnection(ctx: ConnectorCtx, ref: ConnRef, event: ConnectionEvent, extra: Record<string, Prim> = {}): Promise<string[]> {
  try {
    const g = await ctx.graph();
    const now = ctx.now();
    const at = iso(now);
    const who = await whoIs(g, ctx);
    const status = event === "connected" || event === "picked" ? "ok" : event === "pending" ? "pending" : event === "expired" ? "expired" : "not_connected";
    const props: Record<string, Prim> = {
      ...baseProps(ref), status, ...extra,
      ...(event === "connected" || event === "pending" ? { connectedAt: now, lastError: null, ...(who.owner ? { connectedBy: who.owner } : {}) } : {}),
      ...(event === "picked" ? { lastError: null } : {}),
      ...(event === "disconnected" ? { disconnectedAt: now } : {}),
    };
    await upsertNode(g, { type: "System", id: ref.system.id, name: ref.system.name, props, ...(who.src ? { src: who.src } : {}), asOf: at }, now);
    const wrote = await writeBatch(g, { edges: await structureEdges(g, ref, who, at) }, now);
    await syncCapabilities(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) }).catch(() => undefined);
    return wrote.errors.map((e) => e.error);
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

export interface ReadNote {
  /** The snapshot Document the read wrote, when it wrote one: the System PRODUCED it. */
  docId?: string;
  /** How many Observations and Documents the read wrote. */
  factCount: number;
  /** The newest day the numbers cover. */
  dataThrough?: string;
  /** More props for the System (the chosen website or property). */
  props?: Record<string, Prim>;
  /** False when the caller has already brought the plan's goals and the ladder up to date (the own Search Console reader does). */
  settle?: boolean;
}

/**
 * A read finished and wrote its facts. The System says so (ok, when, through which day, how many facts), the edges that tie it to
 * the business, its channels and the Document it produced are written, then the plan's goals and the ladder are brought up to date.
 */
export async function noteRead(ctx: ConnectorCtx, ref: ConnRef, read: ReadNote): Promise<string[]> {
  try {
    const g = await ctx.graph();
    const now = ctx.now();
    const at = iso(now);
    const who = await whoIs(g, ctx);
    await upsertNode(g, {
      type: "System", id: ref.system.id, name: ref.system.name,
      props: { ...baseProps(ref), status: "ok", lastPullAt: now, lastError: null, factCount: read.factCount, ...(read.dataThrough ? { dataThrough: read.dataThrough } : {}), ...read.props },
      ...(who.src ? { src: who.src } : {}), asOf: at,
    }, now);
    const edges = await structureEdges(g, ref, who, at);
    if (read.docId && (await existing(g, "Document", [read.docId])).has(read.docId)) {
      edges.push({ from: ref.system.id, type: "PRODUCED", to: read.docId, asOf: at, src: read.docId });
    }
    const wrote = await writeBatch(g, { edges }, now);
    if (read.settle !== false) {
      try {
        await settleGoals(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
        await syncCapabilities(g, { now, ...(ctx.businessId ? { businessId: ctx.businessId } : {}) });
      } catch {
        // the numbers are in; the goals and the ladder catch up on the next read of the plan
      }
    }
    return wrote.errors.map((e) => e.error);
  } catch (e) {
    return [e instanceof Error ? e.message : String(e)];
  }
}

export interface ReadWrite {
  /** The snapshot Document: one per read (its id carries the day), PRODUCED by the System. */
  doc: NodeInput & { type: "Document" };
  /** Other nodes the read needs first (the Channel its numbers measure, when it does not exist yet). */
  nodes?: NodeInput[];
  observations?: ObservationInput[];
  dataThrough?: string;
  props?: Record<string, Prim>;
}

/**
 * One read's whole write: the System (so a number can measure it), the Document and the other nodes, the Observations, and then
 * noteRead. `ok: false` says the facts did not go in (the first reason), and the System is then left as it was.
 */
export async function recordRead(ctx: ConnectorCtx, ref: ConnRef, w: ReadWrite): Promise<{ ok: boolean; error?: string; factCount: number; errors: string[] }> {
  const g = await ctx.graph();
  const now = ctx.now();
  const stats = await writeBatch(g, {
    nodes: [{ type: "System", id: ref.system.id, name: ref.system.name, props: baseProps(ref) }, ...(w.nodes ?? []), w.doc],
    observations: w.observations ?? [],
  }, now);
  if (stats.errors.length) return { ok: false, error: stats.errors[0]!.error, factCount: 0, errors: stats.errors.map((e) => e.error) };
  const factCount = stats.observations + 1;
  const errors = await noteRead(ctx, ref, { docId: w.doc.id, factCount, ...(w.dataThrough ? { dataThrough: w.dataThrough } : {}), ...(w.props ? { props: w.props } : {}) });
  return { ok: true, factCount, errors };
}
