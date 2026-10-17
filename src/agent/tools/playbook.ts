// playbook: procedural knowledge. Rules (hook formulas, SEO checks, voice rules, benchmarks, learned rules) and the
// Playbook each belongs to, found by topic words (full-text on name/summary plus a match on the rule text), by kind,
// and/or by the channel they APPLY_TO (directly or through their playbook). Returns the usable parts: text,
// template, example, howToFix, severity.
//
// Two graphs: the business's own (rules learned from the owner's edits, its brand rules) and the shared reference graph
// (src/graph/reference.ts: the vendored playbooks every business uses). A business graph may hold a stub of a reference rule
// (same id, `refStub`: something of the business points at it); the reference copy, which has the text, answers for it.
// Rules from the reference graph come back with `general: true`, and their ids resolve for citations like any other.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import type { SourceRef } from "../../../shared/contracts.js";
import {
  Collector, EDGE, InputError, NODE, brief, clamp, clip, defineTool, fromReference, ftEntities, ftTerms, ro, sourcesFor,
  type EdgeRow, type NodeRow,
} from "./common.js";
import { resolveChannel } from "./observations.js";

interface RuleRow {
  r: NodeRow; kind: string | null; text: string | null; severity: string | number | null; weight: number | null;
  template: string | null; example: string | null; howToFix: string | null; rank: number | null; stub: boolean | null;
}
interface LinkRow { rid: string; x: NodeRow; e: EdgeRow; rel: string }
interface Found { order: string[] | null; allowed: Set<string> | null; rules: RuleRow[] }

const kindKey = (k: string | undefined): string | null => k?.trim().toLowerCase().replace(/-/g, "_") || null;

// The rules of one graph that match: candidate ids in relevance order (topic) or null (= every rule), the ids the channel
// allows (null = any), and the rule rows.
async function findRules(c: ToolContext, args: { topic?: string; kind?: string }, channel: string | null): Promise<Found> {
  let order: string[] | null = null;
  if (args.topic?.trim()) {
    const terms = ftTerms(args.topic);
    const hits = await ftEntities(c, args.topic, ["Rule", "BrandRule", "Playbook"], 50);
    const [included, textual] = await Promise.all([
      ro<{ id: string }>(c, "UNWIND $pbs AS pid MATCH (pb:Entity {id:pid}) WITH pb MATCH (pb)-[i:INCLUDES]->(r:Entity) WHERE i.until IS NULL RETURN r.id AS id LIMIT 500",
        { pbs: hits.filter((h) => h.n.labels.includes("Playbook")).map((h) => h.n.id) }),
      ro<{ id: string }>(c,
        `MATCH (r:Entity) WHERE (r:Rule OR r:BrandRule) AND any(t IN $terms WHERE toLower(coalesce(r.text, '')) CONTAINS t OR toLower(coalesce(r.kind, '')) = t)
         RETURN r.id AS id ORDER BY id LIMIT 100`, { terms }),
    ]);
    order = [...new Set([...hits.filter((h) => !h.n.labels.includes("Playbook")).map((h) => h.n.id), ...included.map((i) => i.id), ...textual.map((t) => t.id)])];
  }
  let allowed: Set<string> | null = null;
  if (channel) {
    const rows = await ro<{ id: string }>(c,
      `MATCH (ch:Entity {id:$ch}) WITH ch MATCH (r:Entity)-[a:APPLIES_TO]->(ch) WHERE (r:Rule OR r:BrandRule) AND a.until IS NULL RETURN r.id AS id
       UNION
       MATCH (ch:Entity {id:$ch}) WITH ch MATCH (pb:Playbook)-[a:APPLIES_TO]->(ch) MATCH (pb)-[i:INCLUDES]->(r:Entity) WHERE a.until IS NULL AND i.until IS NULL RETURN r.id AS id`,
      { ch: channel });
    allowed = new Set(rows.map((r) => r.id));
  }
  const rules = order && !order.length ? [] : await ro<RuleRow>(c,
    // Named rules are looked up by id; with no names it is a survey of every rule (a few hundred), which is a scan by design.
    `${order ? "UNWIND $ids AS rid MATCH (r:Entity {id:rid})" : "MATCH (r:Entity)"} WHERE (r:Rule OR r:BrandRule) AND ($allowed IS NULL OR r.id IN $allowed)
       AND ($kind IS NULL OR replace(toLower(coalesce(r.kind, '')), '-', '_') = $kind)
     RETURN ${NODE("r")} AS r, r.kind AS kind, r.text AS text, r.severity AS severity, r.weight AS weight, r.template AS template,
       r.example AS example, r.howToFix AS howToFix, r.rank AS rank, r.refStub AS stub ORDER BY coalesce(rank, 0) DESC, r.name, r.id LIMIT 500`,
    { ids: order, allowed: allowed ? [...allowed] : null, kind: kindKey(args.kind) });
  return { order, allowed, rules };
}

// Each rule's playbook and up to five things it APPLIES_TO, read in the graph the rule came from.
async function ruleLinks(c: ToolContext, ids: string[]): Promise<LinkRow[]> {
  if (!ids.length) return [];
  return ro<LinkRow>(c,
    `UNWIND $ids AS rid MATCH (rule:Entity {id:rid}) WITH rid, rule MATCH (pb:Playbook)-[e:INCLUDES]->(rule) WHERE e.until IS NULL
     WITH rid, head(collect({x: ${NODE("pb")}, e: ${EDGE("e")}})) AS y RETURN rid, y.x AS x, y.e AS e, 'playbook' AS rel
     UNION ALL
     UNWIND $ids AS rid MATCH (rule:Entity {id:rid}) WITH rid, rule MATCH (rule)-[e:APPLIES_TO]->(x:Entity) WHERE e.until IS NULL
     WITH rid, x, e ORDER BY x.id WITH rid, collect({x: ${NODE("x")}, e: ${EDGE("e")}})[0..5] AS xs UNWIND xs AS y
     RETURN rid, y.x AS x, y.e AS e, 'applies' AS rel`,
    { ids });
}

// The business's channel; one the business has not got (a new business has no Google Ads anchor) is looked up among the
// channels the shared playbooks apply to.
async function channelOf(ctx: ToolContext, channel: string): Promise<NodeRow> {
  try {
    return await resolveChannel(ctx, channel);
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    const shared = await fromReference(ctx, (ref) => resolveChannel(ref, channel).catch(() => null), null);
    if (shared) return shared;
    throw e;
  }
}

async function runPlaybook(args: { topic?: string; kind?: string; channel?: string; limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  const col = new Collector();
  if (args.topic?.trim() && !ftTerms(args.topic).length) throw new InputError("The topic has no searchable words, e.g. 'hooks', 'meta description'.");
  const channel = args.channel?.trim() ? await channelOf(ctx, args.channel) : null;
  if (channel) col.node(channel);

  const empty: Found = { order: args.topic?.trim() ? [] : null, allowed: channel ? new Set() : null, rules: [] };
  const [own, shared] = await Promise.all([
    findRules(ctx, args, channel?.id ?? null),
    fromReference(ctx, (ref) => findRules(ref, args, channel?.id ?? null), empty),
  ]);

  // One row per id: the business's own rule, except a stub, which the reference copy (with the text) answers for.
  const rows = new Map<string, { row: RuleRow; general: boolean }>();
  for (const row of own.rules) if (!own.allowed || own.allowed.has(row.r.id)) rows.set(row.r.id, { row, general: row.stub === true });
  for (const row of shared.rules) {
    if (shared.allowed && !shared.allowed.has(row.r.id)) continue;
    const have = rows.get(row.r.id);
    if (!have || have.row.stub === true) rows.set(row.r.id, { row, general: true });
  }
  const order = own.order || shared.order ? [...new Set([...(own.order ?? []), ...(shared.order ?? [])])] : null;
  const pos = new Map((order ?? []).map((id, i) => [id, i]));
  const picked = [...rows.values()]
    .sort((a, b) => order
      ? (pos.get(a.row.r.id) ?? Infinity) - (pos.get(b.row.r.id) ?? Infinity) || a.row.r.id.localeCompare(b.row.r.id)
      : (b.row.rank ?? 0) - (a.row.rank ?? 0) || String(a.row.r.name).localeCompare(String(b.row.r.name)) || a.row.r.id.localeCompare(b.row.r.id))
    .slice(0, limit);

  const fromShared = picked.filter((p) => p.general && shared.rules.some((r) => r.r.id === p.row.r.id)).map((p) => p.row.r.id);
  const fromOwn = picked.map((p) => p.row.r.id).filter((id) => !fromShared.includes(id));
  const [ownLinks, sharedLinks] = await Promise.all([
    ruleLinks(ctx, fromOwn),
    fromReference(ctx, (ref) => ruleLinks(ref, fromShared), [] as LinkRow[]),
  ]);
  const links = [...ownLinks, ...sharedLinks];

  const out = picked.map(({ row: r, general }) => {
    col.node(r.r);
    const mine = links.filter((l) => l.rid === r.r.id);
    for (const l of mine) {
      col.node(l.x);
      col.edge(l.e);
    }
    const pb = mine.find((l) => l.rel === "playbook");
    const optional = { severity: r.severity, weight: r.weight, template: clip(r.template), example: clip(r.example), howToFix: clip(r.howToFix) };
    return {
      ...brief(r.r), kind: r.kind, text: clip(r.text),
      ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== null && v !== undefined)),
      ...(pb ? { playbook: brief(pb.x) } : {}),
      appliesTo: mine.filter((l) => l.rel === "applies").map((l) => l.x.id),
      ...(general ? { general: true } : {}),
    };
  });
  const res = await col.result(ctx, { topic: args.topic ?? null, kind: args.kind ?? null, channel: channel?.id ?? null, rules: out },
    out.length ? undefined : "No rules match. Try a broader topic, or drop kind/channel.");
  // The vendored files behind the shared rules (they are in the reference graph, not the business's)
  const sharedIds = [...fromShared, ...sharedLinks.map((l) => l.x.id)];
  if (sharedIds.length) {
    const more = await fromReference(ctx, (ref) => sourcesFor(ref, sharedIds), [] as SourceRef[]);
    const have = new Set(res.sources.map((s) => s.id));
    res.sources = [...res.sources, ...more.filter((s) => !have.has(s.id))];
  }
  return res;
}

export const playbook = defineTool({
  name: "playbook",
  description:
    "How to do it, not what worked (content_performance measures that): hook formulas, SEO checks, brand-voice rules, benchmarks and rules learned from the owner's edits, with template, example, howToFix, severity and their playbook; general: true is shared know-how. Filter by topic words, kind (hook, seo_check, voice, learned…) and channel. Example: {\"topic\":\"hooks\",\"channel\":\"instagram\"}",
  input: {
    topic: z.string().optional().describe("Words, e.g. 'hooks' or 'meta description'"),
    kind: z.string().optional().describe("Rule kind, e.g. hook, seo_check, voice, learned"),
    channel: z.string().optional().describe("Channel id or name"),
    limit: z.number().int().optional().describe("Default 10, max 25"),
  },
  run: runPlaybook,
});
