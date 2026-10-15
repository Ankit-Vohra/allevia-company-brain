// playbook: procedural knowledge. Rules (hook formulas, SEO checks, voice rules, benchmarks, learned rules) and the
// Playbook each belongs to, found by topic words (full-text on name/summary plus a match on the rule text), by kind,
// and/or by the channel they APPLY_TO (directly or through their playbook). Returns the usable parts: text,
// template, example, howToFix, severity.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import {
  Collector, EDGE, InputError, NODE, brief, clamp, clip, defineTool, ftEntities, ftTerms, ro, type EdgeRow, type NodeRow,
} from "./common.js";
import { resolveChannel } from "./observations.js";

interface RuleRow {
  r: NodeRow; kind: string | null; text: string | null; severity: string | number | null; weight: number | null;
  template: string | null; example: string | null; howToFix: string | null; rank: number | null;
}

async function runPlaybook(args: { topic?: string; kind?: string; channel?: string; limit?: number }, ctx: ToolContext) {
  const limit = clamp(args.limit, 10, 1, 25);
  const col = new Collector();
  const channel = args.channel?.trim() ? await resolveChannel(ctx, args.channel) : null;
  if (channel) col.node(channel);

  // Candidate ids in relevance order (topic) or null (= every rule).
  let order: string[] | null = null;
  if (args.topic?.trim()) {
    const terms = ftTerms(args.topic);
    if (!terms.length) throw new InputError("The topic has no searchable words, e.g. 'hooks', 'meta description'.");
    const hits = await ftEntities(ctx, args.topic, ["Rule", "BrandRule", "Playbook"], 50);
    const [included, textual] = await Promise.all([
      ro<{ id: string }>(ctx, "UNWIND $pbs AS pid MATCH (pb:Entity {id:pid}) WITH pb MATCH (pb)-[i:INCLUDES]->(r:Entity) WHERE i.until IS NULL RETURN r.id AS id LIMIT 500",
        { pbs: hits.filter((h) => h.n.labels.includes("Playbook")).map((h) => h.n.id) }),
      ro<{ id: string }>(ctx,
        `MATCH (r:Entity) WHERE (r:Rule OR r:BrandRule) AND any(t IN $terms WHERE toLower(coalesce(r.text, '')) CONTAINS t OR toLower(coalesce(r.kind, '')) = t)
         RETURN r.id AS id ORDER BY id LIMIT 100`, { terms }),
    ]);
    order = [...new Set([...hits.filter((h) => !h.n.labels.includes("Playbook")).map((h) => h.n.id), ...included.map((i) => i.id), ...textual.map((t) => t.id)])];
  }
  let allowed: Set<string> | null = null;
  if (channel) {
    const rows = await ro<{ id: string }>(ctx,
      `MATCH (r:Entity)-[a:APPLIES_TO]->(:Entity {id:$ch}) WHERE (r:Rule OR r:BrandRule) AND a.until IS NULL RETURN r.id AS id
       UNION
       MATCH (pb:Playbook)-[a:APPLIES_TO]->(:Entity {id:$ch}) MATCH (pb)-[i:INCLUDES]->(r:Entity) WHERE a.until IS NULL AND i.until IS NULL RETURN r.id AS id`,
      { ch: channel.id });
    allowed = new Set(rows.map((r) => r.id));
  }

  const rules = await ro<RuleRow>(ctx,
    `MATCH (r:Entity) WHERE (r:Rule OR r:BrandRule) AND ($ids IS NULL OR r.id IN $ids) AND ($allowed IS NULL OR r.id IN $allowed)
       AND ($kind IS NULL OR toLower(r.kind) = $kind)
     RETURN ${NODE("r")} AS r, r.kind AS kind, r.text AS text, r.severity AS severity, r.weight AS weight, r.template AS template,
       r.example AS example, r.howToFix AS howToFix, r.rank AS rank ORDER BY coalesce(rank, 0) DESC, r.name, r.id LIMIT 500`,
    { ids: order, allowed: allowed ? [...allowed] : null, kind: args.kind?.trim().toLowerCase() || null });
  const pos = new Map((order ?? []).map((id, i) => [id, i]));
  const picked = rules.filter((r) => !allowed || allowed.has(r.r.id))
    .sort((a, b) => order ? pos.get(a.r.id)! - pos.get(b.r.id)! : (b.rank ?? 0) - (a.rank ?? 0) || String(a.r.name).localeCompare(String(b.r.name)))
    .slice(0, limit);
  const ids = picked.map((r) => r.r.id);
  const links = ids.length ? await ro<{ rid: string; x: NodeRow; e: EdgeRow; rel: string }>(ctx,
    `UNWIND $ids AS rid MATCH (rule:Entity {id:rid}) WITH rid, rule MATCH (pb:Playbook)-[e:INCLUDES]->(rule) WHERE e.until IS NULL
     WITH rid, head(collect({x: ${NODE("pb")}, e: ${EDGE("e")}})) AS y RETURN rid, y.x AS x, y.e AS e, 'playbook' AS rel
     UNION ALL
     UNWIND $ids AS rid MATCH (rule:Entity {id:rid}) WITH rid, rule MATCH (rule)-[e:APPLIES_TO]->(x:Entity) WHERE e.until IS NULL
     WITH rid, x, e ORDER BY x.id WITH rid, collect({x: ${NODE("x")}, e: ${EDGE("e")}})[0..5] AS xs UNWIND xs AS y
     RETURN rid, y.x AS x, y.e AS e, 'applies' AS rel`,
    { ids }) : [];

  const out = picked.map((r) => {
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
    };
  });
  return col.result(ctx, { topic: args.topic ?? null, kind: args.kind ?? null, channel: channel?.id ?? null, rules: out },
    out.length ? undefined : "No rules match. Try a broader topic, or drop kind/channel.");
}

export const playbook = defineTool({
  name: "playbook",
  description:
    "Know-how to apply: rules such as hook formulas, SEO checks, brand-voice rules, benchmarks and rules learned from the owner's edits, with their template, example, howToFix and severity, and the playbook each comes from. Filter by topic words, kind (hook, seo_check, voice, learned…) and channel. Example: {\"topic\":\"hooks\",\"channel\":\"instagram\"}",
  input: {
    topic: z.string().optional().describe("Words, e.g. 'hooks' or 'meta description'"),
    kind: z.string().optional().describe("Rule kind, e.g. hook, seo_check, voice, learned"),
    channel: z.string().optional().describe("Channel id or name"),
    limit: z.number().int().optional().describe("Default 10, max 25"),
  },
  run: runPlaybook,
});
