// What the Studio makes is a chain in the business's graph, and this is the one place that writes the parts of it that are
// facts about money and provenance, and reads the whole chain back with real traversals:
//   Asset(original) <-DERIVED_FROM- Asset(variant: relight, ad, premium ad) <-DERIVED_FROM- Asset(clip)
//   Asset -SOURCED_FROM-> Document{kind:'generation'}   the Higgsfield job it came from (model, mode, credits, the prompt used)
//   Observation{studio_credits_spent} -MEASURES-> Asset   what that job cost, with the job as its source
//   Asset -GUIDED_BY-> BrandRule|Rule                    the brand and fidelity rules the prompt was built from
//   Nisha -REVIEWED-> Asset{verdict}                     her check; Approval -> Action -> Content -USES_ASSET-> Asset   the OK and the post
// `assetLineage` walks it: up through DERIVED_FROM to the photo it all started from, down to what was made from it, and out to
// the job, the cost, the rules, the review, the card and the post, so "how was this ad made and what did it cost" is a read.
import type { Lineage, LineageAsset, LineageStep } from "../../shared/contracts.js";
import type { GraphHandle } from "../graph/client.js";
import { addObservation, upsertEdge, upsertNode } from "../graph/upsert.js";
import { isoDate } from "../util/time.js";

export const SPEND_METRIC = "studio_credits_spent";

export interface GenerationRecord {
  assetId: string;
  jobId: string;
  provider?: string;      // default: higgsfield
  model: string;
  credits: number;        // what it cost, in Higgsfield credits (0: replayed from a recording, nothing was spent)
  mode?: string;          // the product-photoshoot mode, "clip", "edit", ...
  prompt?: string;
  recorded?: boolean;
  guidedBy?: string[];    // BrandRule / Rule ids the prompt was built from
  now: number;
}

// One Document per job, one Observation per spend, edges from the asset: the same shape the connections' snapshots use, so a
// reading is always traceable to its source. Best effort at the edges (a missing rule must not lose the spend).
export async function recordGeneration(g: GraphHandle, r: GenerationRecord): Promise<void> {
  const provider = r.provider ?? "higgsfield";
  const docId = `document:${provider}-job-${r.jobId.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60)}`;
  const asOf = isoDate(r.now);
  await upsertNode(g, {
    type: "Document", id: docId, name: `${provider === "higgsfield" ? "Higgsfield" : provider} job ${r.jobId.slice(0, 8)} (${r.model})`,
    props: {
      kind: "generation", provider, model: r.model, jobId: r.jobId, credits: r.credits, status: "done", recorded: r.recorded === true,
      ...(r.mode ? { mode: r.mode } : {}), ...(r.prompt ? { prompt: r.prompt.slice(0, 4000) } : {}),
    },
    src: `${provider}:${r.jobId}`, asOf,
  }, r.now);
  await upsertEdge(g, { from: r.assetId, type: "SOURCED_FROM", to: docId, props: { how: "generated" }, src: docId, asOf }, r.now).catch(() => undefined);
  if (r.credits > 0 && r.recorded !== true) {
    await addObservation(g, {
      subject: r.assetId, metric: SPEND_METRIC, value: r.credits, unit: "credits", asOf, src: docId,
      evidence: `${provider} job ${r.jobId}: ${r.model}${r.mode ? ` (${r.mode})` : ""}, quoted before it ran and kept in the Studio's ledger.`,
    }, r.now).catch(() => undefined);
  }
  for (const rule of (r.guidedBy ?? []).slice(0, 12)) {
    await upsertEdge(g, { from: r.assetId, type: "GUIDED_BY", to: rule, src: docId, asOf }, r.now).catch(() => undefined);
  }
}

// ---------- reading the chain back ----------

export type { LineageAsset, LineageStep, Lineage };

const MAX_HOPS = 6;

// One hop per query (like impact_of): the chain is short and each hop starts from an indexed id.
async function hop(g: GraphHandle, ids: string[], dir: "up" | "down"): Promise<Array<{ from: string; to: string; step: string | null }>> {
  if (!ids.length) return [];
  return g.roQuery<{ from: string; to: string; step: string | null }>(
    dir === "up"
      ? `UNWIND $ids AS fid MATCH (a:Entity:Asset {id:fid})-[r:DERIVED_FROM]->(p:Entity:Asset) WHERE ID(r) >= 0 AND r.until IS NULL
         RETURN a.id AS from, p.id AS to, r.step AS step ORDER BY a.id, p.id`
      : `UNWIND $ids AS fid MATCH (c:Entity:Asset)-[r:DERIVED_FROM]->(a:Entity:Asset {id:fid}) WHERE ID(r) >= 0 AND r.until IS NULL
         RETURN c.id AS from, a.id AS to, r.step AS step ORDER BY c.id, a.id`,
    { ids });
}

export async function assetLineage(g: GraphHandle, assetId: string): Promise<Lineage> {
  const steps: LineageStep[] = [];
  const up: string[] = [];
  const down: string[] = [];
  let frontier = [assetId];
  for (let i = 0; i < MAX_HOPS && frontier.length; i++) {
    const rows = await hop(g, frontier, "up");
    frontier = [];
    for (const r of rows) { steps.push({ from: r.from, to: r.to, ...(r.step ? { step: r.step } : {}) }); if (!up.includes(r.to)) { up.push(r.to); frontier.push(r.to); } }
  }
  frontier = [assetId];
  for (let i = 0; i < MAX_HOPS && frontier.length; i++) {
    const rows = await hop(g, frontier, "down");
    frontier = [];
    for (const r of rows) { steps.push({ from: r.from, to: r.to, ...(r.step ? { step: r.step } : {}) }); if (!down.includes(r.from)) { down.push(r.from); frontier.push(r.from); } }
  }
  const all = [assetId, ...up, ...down];
  const rows = await g.roQuery<{ id: string; name: string | null; kind: string | null; mediaType: string | null; label: string | null; step: string | null; status: string | null; ai: boolean | null; model: string | null; credits: number | null; badge: string | null; note: string | null }>(
    `MATCH (x:Entity:Asset) WHERE x.id IN $ids
     RETURN x.id AS id, x.name AS name, x.kind AS kind, x.mediaType AS mediaType, x.label AS label, x.step AS step, x.status AS status, x.aiEdited AS ai,
            x.model AS model, x.hfCredits AS credits, x.fidelityBadge AS badge, x.fidelityNote AS note ORDER BY x.id`, { ids: all });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const asAsset = (id: string): LineageAsset | null => {
    const r = byId.get(id);
    return r ? {
      id: r.id, name: r.name ?? r.id, kind: r.kind ?? "asset", mediaType: r.mediaType ?? "image", aiEdited: r.ai === true,
      ...(r.label ? { label: r.label } : {}), ...(r.step ? { step: r.step } : {}), ...(r.status ? { status: r.status } : {}),
      ...(r.model ? { model: r.model } : {}), ...(r.credits !== null ? { credits: r.credits } : {}), ...(r.badge ? { badge: r.badge } : {}), ...(r.note ? { note: r.note } : {}),
    } : null;
  };
  const jobs = await g.roQuery<{ assetId: string; jobId: string; model: string | null; credits: number | null; mode: string | null; doc: string }>(
    `MATCH (x:Entity:Asset)-[r:SOURCED_FROM]->(d:Entity:Document) WHERE x.id IN $ids AND ID(r) >= 0 AND d.kind = 'generation'
     RETURN x.id AS assetId, d.jobId AS jobId, d.model AS model, d.credits AS credits, d.mode AS mode, d.id AS doc ORDER BY x.id, d.id`, { ids: all });
  const rules = await g.roQuery<{ assetId: string; ruleId: string; name: string | null }>(
    `MATCH (x:Entity:Asset)-[r:GUIDED_BY]->(b:Entity) WHERE x.id IN $ids AND ID(r) >= 0 AND r.until IS NULL RETURN x.id AS assetId, b.id AS ruleId, b.name AS name ORDER BY x.id, b.id`, { ids: all });
  const reviews = await g.roQuery<{ assetId: string; by: string; verdict: string | null; note: string | null }>(
    `MATCH (n:Entity:Agent)-[r:REVIEWED]->(x:Entity:Asset) WHERE x.id IN $ids AND ID(r) >= 0 RETURN x.id AS assetId, n.id AS by, r.verdict AS verdict, r.note AS note ORDER BY x.id, n.id`, { ids: all });
  const cards = await g.roQuery<{ approvalId: string; status: string | null; title: string | null }>(
    `MATCH (rec:Entity:Recommendation)-[e:EVIDENCED_BY]->(x:Entity:Asset) WHERE x.id IN $ids AND ID(e) >= 0
     MATCH (rec)-[p:PROPOSES]->(a:Entity:Approval) WHERE ID(p) >= 0
     WITH a, count(x) AS n RETURN a.id AS approvalId, a.status AS status, a.title AS title ORDER BY a.id`, { ids: all });
  const posts = await g.roQuery<{ contentId: string; assetId: string; name: string | null; status: string | null }>(
    `MATCH (c:Entity:Content)-[u:USES_ASSET]->(x:Entity:Asset) WHERE x.id IN $ids AND ID(u) >= 0
     RETURN c.id AS contentId, x.id AS assetId, c.name AS name, c.status AS status ORDER BY c.id, x.id`, { ids: all });
  const lineageAssets = (ids: string[]): LineageAsset[] => ids.map(asAsset).filter((a): a is LineageAsset => a !== null);
  return {
    root: asAsset(assetId), ancestors: lineageAssets(up), descendants: lineageAssets(down), steps,
    jobs: jobs.map((j) => ({ assetId: j.assetId, jobId: j.jobId, model: j.model ?? "", credits: j.credits ?? 0, ...(j.mode ? { mode: j.mode } : {}), document: j.doc })),
    spent: jobs.reduce((s, j) => s + (j.credits ?? 0), 0),
    rules: rules.map((r) => ({ assetId: r.assetId, ruleId: r.ruleId, name: r.name ?? r.ruleId })),
    reviews: reviews.map((r) => ({ assetId: r.assetId, by: r.by, verdict: r.verdict ?? "", note: r.note ?? "" })),
    cards: cards.map((c) => ({ approvalId: c.approvalId, status: c.status ?? "", title: c.title ?? "" })),
    posts: posts.map((p) => ({ contentId: p.contentId, assetId: p.assetId, name: p.name ?? p.contentId, status: p.status ?? "" })),
  };
}
