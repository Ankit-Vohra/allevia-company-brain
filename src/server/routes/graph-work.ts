// "The graph at work" on the Brain page, read-only:
//   GET /api/:t/graph/map[?limit=N][&general=1]: the map (the most important things, light for a phone; business knowledge only unless general=1; see reads.mapGraph)
//   GET /api/:t/graph/story: how the brain grew
//   GET /api/:t/graph/at-work[?focus=<id or exact name>]
// What only a graph gives, from the same tools the agents call (src/agent/tools), on the selected business's graph:
// - for one system (the one with most dependents, or `focus`): "what breaks if this stops" at depth 1 and at depth 4,
//   each item with its path back to the system (impact_of: one traversal per hop over current DEPENDS_ON / AFFECTS /
//   BLOCKS edges), and who owns it (who_owns: current OWNS, else inherited through PART_OF);
// - the most connected things in the business (important: PageRank over the current-edges projection);
// - groups of related things (topics: label propagation over MENTIONS / LINKS_TO).
// An empty answer says which kind it is: "not_in_records" (the name is not in the graph: nothing ran), "not_mapped"
// (in the graph, no dependency recorded either way) or "nothing_depends" (mapped, nothing downstream).
// Every read is GRAPH.RO_QUERY; the tool context is read-only. A part that fails comes back as its own `error` and the
// rest still shows.
import type { Hono } from "hono";
import type { GraphHandle } from "../../graph/client.js";
import { TouchedSet, type AlleviaTool, type ToolContext } from "../../agent/tool.js";
import { impactOf } from "../../agent/tools/impact.js";
import { whoOwns } from "../../agent/tools/people.js";
import { important, topics } from "../../agent/tools/ranking.js";
import { plainName } from "../../util/plain.js";
import { graphStory, type StoryAxis, type StoryBucket } from "../../graph/story.js";
import { LIMITS, mapGraph } from "../reads.js";
import { HttpError, errorMessage, type RouteCtx } from "../http.js";
import { resolveShowcaseId, showcaseHides, showcaseRefusesQuery } from "../showcase.js";

export type AtWorkStatus = "impact" | "nothing_depends" | "not_mapped" | "not_in_records";
export interface Thing { id: string; name: string; type: string }
export interface PathStep { id: string; name: string; rel: string; dir: "in" | "out" } // rel joins this step to the one before
export interface ImpactItem extends Thing { hop: number; path: PathStep[] }
export interface ImpactView { depth: number; total: number; items: ImpactItem[]; more: boolean }
export interface GraphAtWorkDto {
  candidates: Array<Thing & { dependents: number }>;
  focus: null | (Thing & { status: AtWorkStatus; message?: string; shallow: ImpactView; deep: ImpactView; owners: Array<Thing & { via?: string }> });
  notFound?: { asked: string; message: string; suggestions: Thing[] };
  important: Array<Thing & { score: number }>;
  groups: Array<{ label: string; size: number; members: Thing[] }>;
  errors: string[];
}

const FOCUS_TYPES = ["System", "Channel", "Product", "Feature", "Page"]; // Page: an app screen can be what breaks (a sign-up screen) as well as a system
const READ_MS = 10_000;

export async function candidates(g: GraphHandle): Promise<GraphAtWorkDto["candidates"]> {
  return g.roQuery<Thing & { dependents: number }>(
    `MATCH (s:Entity) WHERE any(l IN labels(s) WHERE l IN $types)
     OPTIONAL MATCH (x:Entity)-[r:DEPENDS_ON]->(s) WHERE ID(r) >= 0 AND r.until IS NULL
     WITH s, count(r) AS dependents
     RETURN s.id AS id, coalesce(s.name, s.id) AS name, [l IN labels(s) WHERE l IN $types][0] AS type, dependents
     ORDER BY dependents DESC, s.id LIMIT 12`, { types: FOCUS_TYPES }, { timeoutMs: READ_MS });
}

// "a -[REL]-> b": the parent of `x` is the end that is not x; DEPENDS_ON points at the parent (x depends on it),
// AFFECTS and BLOCKS point at x (the parent affects or blocks it).
const EDGE_TEXT = /^(.+) -\[([A-Z_]+)\]-> (.+)$/;
export function impactView(data: { depth: number; total: number; id: string; name: string; impacted?: Array<{ hop: number; items: Array<Thing & { because: string }> }> }, note?: string): ImpactView {
  const items = (data.impacted ?? []).flatMap((h) => h.items.map((i) => ({ ...i, hop: h.hop })));
  const byId = new Map<string, { name: string; parent?: string; rel?: string; dir?: "in" | "out" }>([[data.id, { name: data.name }]]);
  for (const i of items) {
    const m = EDGE_TEXT.exec(i.because);
    const [from, rel, to] = m ? [m[1]!, m[2]!, m[3]!] : [undefined, undefined, undefined];
    const parent = from === i.id ? to : from;
    byId.set(i.id, { name: i.name, parent, rel, dir: from === i.id ? "out" : "in" });
  }
  const pathOf = (id: string): PathStep[] => {
    const out: PathStep[] = [];
    for (let cur: string | undefined = id, guard = 0; cur && cur !== data.id && guard < 8; guard++) {
      const n = byId.get(cur);
      if (!n) break;
      out.unshift({ id: cur, name: n.name, rel: n.rel ?? "", dir: n.dir ?? "in" });
      cur = n.parent;
    }
    return out;
  };
  return {
    depth: data.depth, total: data.total, more: /there are more/.test(note ?? ""),
    items: items.map((i) => ({ id: i.id, name: i.name, type: i.type, hop: i.hop, path: pathOf(i.id) })),
  };
}

export function registerGraphWorkRoutes(app: Hono, rc: RouteCtx): void {
  // "How your team's brain grew" (Brain page, `graph:story` in the CLI): nodes and edges per day or week by kind, counted in
  // the business's own graph. ?by=recorded (when the team learned it, the default) or happened (the date of the source);
  // ?bucket=day|week. Read-only: three grouped GRAPH.RO_QUERY reads.
  app.get("/api/:t/graph/story", async (c) => {
    const { reg, g } = await rc.tenantOf(c);
    const by = c.req.query("by") ?? "recorded";
    const bucket = c.req.query("bucket") ?? "auto";
    if (!["recorded", "happened"].includes(by) || !["auto", "day", "week"].includes(bucket)) throw new HttpError(400, "by is recorded or happened; bucket is day or week.");
    try {
      return c.json(await graphStory(g, { axis: (by === "recorded" ? "recorded" : "source") as StoryAxis, bucket: bucket as StoryBucket | "auto", tenant: reg.slug }));
    } catch (e) {
      rc.log(`[api] graph story for ${reg.slug}: ${errorMessage(e)}`);
      throw new HttpError(503, "The growth story could not be read just now.");
    }
  });

  // The Brain page's map and Home's living brain: the top things by importance (?limit=1..400), when each was learned,
  // the links between them as index triples, and the size of the whole brain. Read-only.
  app.get("/api/:t/graph/map", async (c) => {
    const { g } = await rc.tenantOf(c);
    const raw = c.req.query("limit");
    const limit = raw === undefined ? LIMITS.mapNodes : Number(raw);
    if (!Number.isFinite(limit) || limit < 1) throw new HttpError(400, `limit is a number from 1 to ${LIMITS.mapNodes}.`);
    // ?general=1: the Brain page's "Show general know-how" (the shared playbooks drawn too, marked general)
    const general = c.req.query("general");
    if (general !== undefined && general !== "0" && general !== "1") throw new HttpError(400, "general is 1 (show general know-how) or 0.");
    return c.json(await mapGraph(g, limit, { general: general === "1" }));
  });

  app.get("/api/:t/graph/at-work", async (c) => {
    const { reg, g } = await rc.tenantOf(c);
    const raw = (c.req.query("focus") ?? "").trim();
    if (raw.length > 200) throw new HttpError(400, "That name is too long (200 characters at most).");
    // A showcase visitor (showcase.ts) names a masked node by its masked id. A private one asked for by its real id or name is
    // "not in your records", in words that do not repeat what was asked (masked, the echo would say what the name is).
    const byId = /^[a-z]+:/.test(raw);
    const hidden = !!raw && (byId ? resolveShowcaseId(raw) === null : showcaseRefusesQuery(raw));
    const asked = hidden ? "" : byId ? resolveShowcaseId(raw) ?? raw : raw;
    const NOT_THERE = { asked: "", message: "I don't have that in your records.", suggestions: [] };
    const ctx: ToolContext = {
      graph: g, tenant: reg.slug, turnId: "brain-at-work", agentId: "librarian", asker: "person:owner", touched: new TouchedSet(),
      now: rc.now(), readOnly: true,
    };
    const errors: string[] = [];
    const part = async <T>(what: string, fn: () => Promise<T>, empty: T): Promise<T> => {
      try { return await fn(); } catch (e) { rc.log(`[api] at-work ${what} for ${reg.slug}: ${errorMessage(e)}`); errors.push(`${what} could not be read just now`); return empty; }
    };
    const run = (tool: AlleviaTool, args: Record<string, unknown>) => tool.run(args as never, ctx);

    const [cands, imp, top] = await Promise.all([
      part("systems", () => candidates(g), []),
      part("most connected", () => run(important, { limit: 6 }), null),
      part("groups", () => run(topics, { limit: 4 }), null),
    ]);
    const focusArg = hidden ? undefined : asked || cands[0]?.id;
    let focus: GraphAtWorkDto["focus"] = null;
    let notFound: GraphAtWorkDto["notFound"] = hidden ? NOT_THERE : undefined;
    if (focusArg) {
      const key = asked ? (/^[a-z]+:/.test(asked) ? { id: asked } : { query: asked }) : { id: focusArg };
      const [shallow, deep] = await Promise.all([run(impactOf, { ...key, depth: 1 }), run(impactOf, { ...key, depth: 4 })]);
      const d = deep.data as Record<string, unknown>;
      if (d.error) {
        if (d.notInRecords) {
          const sug = (d.suggestions as Thing[] | undefined) ?? [];
          notFound = { asked: raw, message: `I don't have "${raw}" in your records.`, suggestions: sug.slice(0, 4) };
        } else errors.push(String(d.error));
      } else if (asked && showcaseHides(String(d.id), String(d.type))) {
        // a visitor to a showcase cannot test whether a person or a customer is in the records
        notFound = NOT_THERE;
      } else {
        const owners = await part("owner", () => run(whoOwns, { id: d.id as string }), null);
        const od = (owners?.data ?? {}) as { owners?: Thing[]; ownedVia?: Array<Thing & { via: Thing }> };
        const status = d.status as AtWorkStatus;
        focus = {
          id: d.id as string, name: d.name as string, type: d.type as string, status,
          ...(deep.note && status !== "impact" ? { message: deep.note.replace(String(d.id), String(d.name)) } : {}),
          shallow: impactView(shallow.data as never, shallow.note), deep: impactView(d as never, deep.note),
          owners: [...(od.owners ?? []).map((o) => ({ id: o.id, name: o.name, type: o.type })),
            ...(od.ownedVia ?? []).map((o) => ({ id: o.id, name: o.name, type: o.type, via: o.via.name }))].slice(0, 4),
        };
      }
    }
    const impData = (imp?.data ?? {}) as { items?: Array<Thing & { score: number }> };
    const topData = (top?.data ?? {}) as { topics?: Array<{ label: string; size: number; members: Thing[] }> };
    const dto: GraphAtWorkDto = {
      candidates: cands, focus, ...(notFound ? { notFound } : {}),
      important: (impData.items ?? []).map((i) => ({ id: i.id, name: i.name, type: i.type, score: i.score })),
      groups: (topData.topics ?? []).map((t) => ({ label: t.label, size: t.size, members: t.members.slice(0, 5).map((m) => ({ id: m.id, name: m.name, type: m.type })) })),
      errors,
    };
    return c.json(plainNames(dto));
  });
}

// A project reference the privacy filter replaced reads "Supabase prod ([redacted:supabase-ref])" on the Brain page (found in the
// audit on the real business): the owner sees the name without the marker.
export function plainNames<T>(dto: T): T {
  return JSON.parse(JSON.stringify(dto), (_k, v) => (typeof v === "string" && v.includes("[redacted:") ? plainName(v) : v)) as T;
}
