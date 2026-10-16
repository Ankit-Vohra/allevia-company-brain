// Each thing Meera picked becomes something already drafted, waiting for the owner's OK: a post, a post with a poster, a
// reply to a review, new words for the website, a follow-up message or an offer to test. The words come from the drafting
// port (production: Claude on the subscription, with the business's voice check and claims check, wiring.ts); the poster
// from the existing creating tools (src/creative/poster.ts). Nothing is posted or sent: an approved post or message is a
// draft file, an approved website fix lands in the business's own tasks (src/actions/executors.ts).
//
// Graph: (Agent)-[:PRODUCED]->(Recommendation {source:'standup', standupKey})-[:PROPOSES]->(Approval {standupKey, standupKind})
//        Recommendation -[:EVIDENCED_BY]-> what it came from, -[:ADVANCES]-> the goal it moves. A poster's card is the one the
//        creating tools write; it is tagged with the same standup fields so dedupe and learning see it.
import type { ActionKind } from "../../shared/contracts.js";
import { agentById } from "../../shared/roster.js";
import { applyLearnedRules } from "../actions/learning.js";
import { agentNodeId, ensureAgentNode, existingIds } from "../actions/shared.js";
import type { GraphHandle } from "../graph/client.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { clip, oneLine } from "../insights/text.js";
import { sha256, slugify } from "../util/ids.js";
import { isoDate } from "../util/time.js";
import type { Picked } from "./choose.js";
import type { OpportunityKind } from "./opportunities.js";

export const STANDUP_SOURCE = "standup";

// ---------- the drafting port ----------

export type TextKind = "post" | "reply" | "website_text" | "follow_up" | "offer" | "headline";
export interface TextJob {
  agent: string;                // roster id of who drafts it
  kind: TextKind;
  brief: string;                // Meera's purpose-first brief
  facts: string[];              // what the drafter may use beyond the business's own record
  skill?: { name: string; guidance: string };
  question: string;             // what the claims check grounds against (the brief and the facts)
}
export interface TextDraft { ok: boolean; text: string; hashtags: string[]; warnings: string[]; why?: string }

export interface PosterJob {
  tenant: string; businessId: string; agentId: string; turnId: string; now: number;
  question: string;             // the brief and facts: what the poster's words may be grounded in
  headline: string; eyebrow?: string; cta?: string; caption: string;
  paid: boolean;                // may the image engine be paid for the artwork (else: the brand-colour ground, free)
}
export interface PosterDraft { approvalId: string; recommendationId: string; hfCredits: number; notes: string[] }

export interface Drafters {
  text(job: TextJob): Promise<TextDraft>;
  /** Absent: no creating tools on this server; a poster pick is drafted as a post instead. */
  poster?(job: PosterJob): Promise<PosterDraft>;
}

// ---------- ids ----------

const suffix = (key: string): string => `${slugify(key).slice(0, 50).replace(/-+$/, "")}-${sha256(key).slice(0, 6)}`;
export const standupRecId = (key: string, date: string): string => `recommendation:standup-${suffix(key)}-${date.replace(/-/g, "")}`;
export const standupApprovalId = (key: string, date: string): string => `approval:standup-${suffix(key)}-${date.replace(/-/g, "")}`;

const AREA: Record<OpportunityKind, string> = { post: "content", poster: "content", reply: "content", website_fix: "seo", follow_up: "funnel", offer: "ads" };
const TARGET: Record<Exclude<OpportunityKind, "poster" | "website_fix">, string> = {
  post: "Instagram post", reply: "Reply on Google", follow_up: "Message to send (WhatsApp or email)", offer: "Offer to test",
};
const TEXT_KIND: Record<Exclude<OpportunityKind, "poster">, TextKind> = { post: "post", reply: "reply", website_fix: "website_text", follow_up: "follow_up", offer: "offer" };

export interface DraftedItem {
  key: string;
  kind: OpportunityKind;        // what was drafted (a poster that could not be made is a post)
  agent: string;
  title: string;
  why: string;
  purpose: string;
  status: "drafted" | "failed";
  approvalId?: string;
  recommendationId?: string;
  paid?: boolean;
  hfCredits?: number;
  notes: string[];
}

export interface DraftCtx {
  tenant: string;
  businessId: string | null;
  businessName: string;
  domain?: string;
  now: number;
  turnId: string;               // the stand-up's own id, as the creating tools' turn
  drafters: Drafters;
  paidLeft: number;             // paid generations still allowed today for this business
  skills?: (agent: string, id: string) => { name: string; guidance: string } | undefined;
  log?: (line: string) => void;
}

const facts = (p: Picked): string[] => [...p.facts, `Why now: ${p.why}`];
const question = (p: Picked): string => [p.purpose, ...facts(p)].join("\n");

export async function draftPick(g: GraphHandle, p: Picked, ctx: DraftCtx): Promise<DraftedItem> {
  const base: DraftedItem = { key: p.key, kind: p.kind, agent: p.agent, title: p.title, why: p.why, purpose: p.purpose, status: "failed", notes: [] };
  const skill = ctx.skills?.(p.skill.agent, p.skill.id);
  try {
    if (p.kind === "poster" && ctx.drafters.poster && ctx.businessId) {
      const made = await draftPoster(g, p, ctx, skill);
      if (made) return made;
      base.notes.push("The poster could not be made, so this is the post on its own.");
    }
    const kind: Exclude<OpportunityKind, "poster"> = p.kind === "poster" ? "post" : p.kind;
    const t = await ctx.drafters.text({ agent: p.agent, kind: TEXT_KIND[kind], brief: p.purpose, facts: facts(p), question: question(p), ...(skill ? { skill } : {}) });
    if (!t.ok || !t.text.trim()) return { ...base, kind, notes: [...base.notes, t.why ?? "the writer did not return a draft"] };
    const card = await writeCard(g, p, kind, t, ctx);
    return { ...base, kind, status: "drafted", ...card, notes: [...base.notes, ...t.warnings] };
  } catch (e) {
    ctx.log?.(`stand-up: drafting "${p.title}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...base, notes: [...base.notes, "the draft could not be made just now"] };
  }
}

async function draftPoster(g: GraphHandle, p: Picked, ctx: DraftCtx, skill: TextJob["skill"]): Promise<DraftedItem | null> {
  const caption = await ctx.drafters.text({ agent: p.agent, kind: "post", brief: p.purpose, facts: facts(p), question: question(p), ...(skill ? { skill } : {}) });
  const headline = await ctx.drafters.text({ agent: p.agent, kind: "headline", brief: `${p.purpose} Write the poster's headline only.`, facts: facts(p), question: question(p) });
  if (!caption.ok || !headline.ok || !headline.text.trim()) return null;
  const paid = ctx.paidLeft > 0;
  try {
    const made = await ctx.drafters.poster!({
      tenant: ctx.tenant, businessId: ctx.businessId!, agentId: p.agent, turnId: ctx.turnId, now: ctx.now, question: question(p),
      headline: clip(headline.text.replace(/[.\s]+$/, ""), 60), ...(p.occasion ? { eyebrow: p.occasion.name.replace(/^the /, "") } : {}),
      ...(ctx.domain ? { cta: ctx.domain } : {}), caption: [caption.text, caption.hashtags.join(" ")].filter(Boolean).join("\n\n"), paid,
    });
    await tagCard(g, p, made, ctx.now);
    return {
      key: p.key, kind: "poster", agent: p.agent, title: p.title, why: p.why, purpose: p.purpose, status: "drafted", approvalId: made.approvalId,
      recommendationId: made.recommendationId, paid: made.hfCredits > 0, hfCredits: made.hfCredits, notes: [...made.notes, ...caption.warnings].slice(0, 4),
    };
  } catch (e) {
    ctx.log?.(`stand-up: the poster for "${p.title}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// The creating tools' own card, marked as this stand-up's (so it is deduped and learned from like the rest).
async function tagCard(g: GraphHandle, p: Picked, made: PosterDraft, now: number): Promise<void> {
  const [a] = await g.roQuery<{ name: string }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name", { id: made.approvalId });
  const [r] = await g.roQuery<{ name: string }>("MATCH (r:Entity:Recommendation {id:$id}) RETURN r.name AS name", { id: made.recommendationId });
  if (a) await upsertNode(g, { type: "Approval", id: made.approvalId, name: a.name, props: { standup: true, standupKey: p.key, standupKind: "poster", by: p.agent } }, now);
  if (r) {
    await upsertNode(g, { type: "Recommendation", id: made.recommendationId, name: r.name, summary: p.why, props: { source: STANDUP_SOURCE, standupKey: p.key, standupKind: "poster", purpose: p.purpose } }, now);
    await link(g, made.recommendationId, p, now);
  }
}

async function link(g: GraphHandle, recId: string, p: Picked, now: number): Promise<void> {
  const asOf = isoDate(now);
  const present = await existingIds(g, [...p.evidence, ...p.goals]);
  for (const e of p.evidence.slice(0, 8)) if (present.has(e)) await upsertEdge(g, { from: recId, type: "EVIDENCED_BY", to: e, asOf }, now).catch(() => undefined);
  for (const gl of p.goals) if (present.has(gl)) await upsertEdge(g, { from: recId, type: "ADVANCES", to: gl }, now).catch(() => undefined);
}

function bodyOf(kind: Exclude<OpportunityKind, "poster">, t: TextDraft, p: Picked): string {
  const checks = t.warnings.length ? ["", `Check before you use it: ${t.warnings.slice(0, 3).join("; ")}.`] : [];
  if (kind === "website_fix") {
    const where = p.facts.filter((f) => /^(Page|Address):/.test(f));
    return [`New text, ready to paste in:`, "", t.text.trim(), "", ...where, `Why: ${p.why}`, ...checks].join("\n");
  }
  return [t.text.trim(), ...(t.hashtags.length ? ["", t.hashtags.join(" ")] : []), ...checks].join("\n");
}

async function writeCard(g: GraphHandle, p: Picked, kind: Exclude<OpportunityKind, "poster">, t: TextDraft, ctx: DraftCtx): Promise<{ approvalId: string; recommendationId: string }> {
  const { now } = ctx;
  const date = isoDate(now);
  const recId = standupRecId(p.key, date);
  const approvalId = standupApprovalId(p.key, date);
  const asOf = date;
  const actionKind: ActionKind = kind === "website_fix" ? "github_issue" : "content_draft";
  const agentId = await ensureAgentNode(g, p.agent, now);
  await upsertNode(g, {
    type: "Recommendation", id: recId, name: p.title, summary: p.why,
    props: {
      status: "open", source: STANDUP_SOURCE, standupKey: p.key, standupKind: kind, standupDate: date, kind: actionKind, by: p.agent, area: AREA[kind],
      purpose: clip(p.purpose, 1000), score: p.score, confidence: 0.7,
    },
    asOf,
  }, now);
  await upsertEdge(g, { from: agentId, type: "PRODUCED", to: recId }, now);
  await link(g, recId, p, now);

  const page = p.facts.find((f) => f.startsWith("Address: "))?.slice(9);
  let payload: Record<string, string | string[] | boolean> = {
    title: p.title, body: bodyOf(kind, t, p),
    target: kind === "website_fix" ? page ?? "Your website" : TARGET[kind],
    ...(kind === "website_fix" ? {} : { format: kind === "post" ? "post" : kind === "reply" ? "reply" : kind === "follow_up" ? "message" : "offer", channelId: kind === "post" ? "channel:instagram" : "" }),
    standup: true,
  };
  if (actionKind === "content_draft") {
    const applied = await applyLearnedRules(g, { title: String(payload.title), body: String(payload.body) }, {
      agentId: agentNodeId(p.agent), ...(kind === "post" ? { channelId: "channel:instagram" } : {}), businessId: ctx.businessId,
    });
    payload = { ...payload, title: applied.title, body: applied.body, ...(applied.applied.length ? { rulesApplied: applied.applied.map((r) => r.id) } : {}) };
  }
  if (payload.channelId === "") delete payload.channelId;
  const [existing] = await g.roQuery<{ status: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.status AS status", { id: approvalId });
  await upsertNode(g, {
    type: "Approval", id: approvalId, name: `${actionKind}: ${p.title}`,
    props: {
      kind: actionKind, payload: JSON.stringify(payload), title: String(payload.title), recommendation: recId, by: p.agent, area: AREA[kind],
      standup: true, standupKey: p.key, standupKind: kind, ...(existing ? {} : { status: "pending" }),
    },
    asOf,
  }, now);
  await upsertEdge(g, { from: recId, type: "PROPOSES", to: approvalId }, now);
  for (const gl of p.goals) await upsertEdge(g, { from: approvalId, type: "ADVANCES", to: gl }, now).catch(() => undefined);
  return { approvalId, recommendationId: recId };
}

/** "Tara drafted a Dussehra post" for the note. */
export function draftedLine(d: Pick<DraftedItem, "agent" | "title">): string {
  const who = agentById(d.agent)?.name ?? "Your team";
  const t = oneLine(d.title);
  return `${who} drafted ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}
