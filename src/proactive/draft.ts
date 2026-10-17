// Each thing The Chief picked becomes something already drafted, waiting for the owner's OK: a post, a post with a poster, a
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
import { applyLearnedRules, guideCards, type ActiveRule } from "../actions/learning.js";
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

export type TextKind = "post" | "reply" | "website_text" | "follow_up" | "offer" | "headline" | "sales_email";
export interface TextJob {
  agent: string;                // roster id of who drafts it
  kind: TextKind;
  brief: string;                // The Chief's purpose-first brief
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
  /**
   * Can the poster set these words in the brand's fonts (or a font in its brand library)? Asked before anything is paid
   * for. Absent: only Latin letters are assumed to be covered.
   */
  covers?(job: { tenant: string; businessId: string; texts: string[]; now: number }): Promise<boolean>;
  /** Absent: no creating tools on this server; a poster pick is drafted as a post instead. */
  poster?(job: PosterJob): Promise<PosterDraft>;
  /** Three real free times on the owner's calendar for a reply to an enquiry. Absent or empty: the reply asks when suits them. */
  times?(job: { tenant: string; now: number; timeZone?: string }): Promise<Array<{ label: string; start: string; end: string }>>;
}

// ---------- ids ----------

const suffix = (key: string): string => `${slugify(key).slice(0, 50).replace(/-+$/, "")}-${sha256(key).slice(0, 6)}`;
export const standupRecId = (key: string, date: string): string => `recommendation:standup-${suffix(key)}-${date.replace(/-/g, "")}`;
export const standupApprovalId = (key: string, date: string): string => `approval:standup-${suffix(key)}-${date.replace(/-/g, "")}`;

const AREA: Record<OpportunityKind, string> = {
  post: "content", poster: "content", reply: "content", website_fix: "seo", follow_up: "funnel", offer: "ads", sales_reply: "sales", sales_nudge: "sales", sales_reminder: "sales",
};
type Plain = Exclude<OpportunityKind, "poster" | "sales_reply" | "sales_nudge" | "sales_reminder">;
const TARGET: Record<Exclude<Plain, "website_fix">, string> = {
  post: "Instagram post", reply: "Reply on Google", follow_up: "Message to send (WhatsApp or email)", offer: "Offer to test",
};
const TEXT_KIND: Record<Plain, TextKind> = { post: "post", reply: "reply", website_fix: "website_text", follow_up: "follow_up", offer: "offer" };
export const isSalesKind = (k: OpportunityKind): k is "sales_reply" | "sales_nudge" | "sales_reminder" => k === "sales_reply" || k === "sales_nudge" || k === "sales_reminder";

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
  paidTried?: boolean;          // a paid picture was asked for, even if the poster then failed (it counts against the day's allowance)
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
    if (isSalesKind(p.kind) && p.sales) return await draftSales(g, p, ctx, skill, base);
    if (p.kind === "poster" && ctx.drafters.poster && ctx.businessId) {
      const made = await draftPoster(g, p, ctx, skill);
      if (made.item) return made.item;
      if (made.paidTried) base.paidTried = true;
      base.notes.push(`The poster could not be made${made.why ? ` (${made.why})` : ""}, so this is the post on its own.`);
    }
    const kind: Plain = p.kind === "poster" ? "post" : isSalesKind(p.kind) ? "follow_up" : p.kind;
    const t = await ctx.drafters.text({ agent: p.agent, kind: TEXT_KIND[kind], brief: p.purpose, facts: facts(p), question: question(p), ...(skill ? { skill } : {}) });
    if (!t.ok || !t.text.trim()) return { ...base, kind, notes: [...base.notes, t.why ?? "the writer did not return a draft"] };
    const card = await writeCard(g, p, kind, t, ctx);
    return { ...base, kind, status: "drafted", ...card, notes: [...base.notes, ...t.warnings] };
  } catch (e) {
    ctx.log?.(`stand-up: drafting "${p.title}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return { ...base, notes: [...base.notes, "the draft could not be made just now"] };
  }
}

// Words the poster fonts can set. The headline is first written in the post's own language; its letters are checked
// against the brand's fonts and the font files in its brand library (Hindi needs a Devanagari font such as Mukta) before
// anything is paid for. Not covered: it is written again in English, checked again, and the poster is skipped if that fails
// too. Without a coverage check only Latin letters are assumed to be covered.
const LATIN = /^[\p{Script=Latin}\p{N}\p{P}\p{Zs}\p{S}]+$/u;

async function draftPoster(g: GraphHandle, p: Picked, ctx: DraftCtx, skill: TextJob["skill"]): Promise<{ item: DraftedItem | null; paidTried: boolean; why?: string }> {
  const caption = await ctx.drafters.text({ agent: p.agent, kind: "post", brief: p.purpose, facts: facts(p), question: question(p), ...(skill ? { skill } : {}) });
  if (!caption.ok) return { item: null, paidTried: false, why: "the words could not be written" };
  const eyebrow = p.occasion ? p.occasion.name.replace(/^the /, "") : undefined;
  const settable = async (h: string): Promise<boolean> => {
    const texts = [h, ...(eyebrow ? [eyebrow] : []), ...(ctx.domain ? [ctx.domain] : [])];
    if (ctx.drafters.covers && ctx.businessId) return ctx.drafters.covers({ tenant: ctx.tenant, businessId: ctx.businessId, texts, now: ctx.now }).catch(() => false);
    return texts.every((t) => LATIN.test(t.trim()));
  };
  const write = (english: boolean) => ctx.drafters.text({
    agent: p.agent, kind: "headline", facts: facts(p), question: question(p),
    brief: `${p.purpose} Write the poster's headline only, ${english ? "in English with Latin letters" : "in the same language as the post"}.`,
  });
  let headline = await write(!ctx.drafters.covers);
  if (headline.ok && headline.text.trim() && !(await settable(headline.text.trim()))) headline = await write(true);
  if (!headline.ok || !headline.text.trim()) return { item: null, paidTried: false, why: "the words could not be written" };
  if (!(await settable(headline.text.trim()))) return { item: null, paidTried: false, why: "the headline is not in letters the poster fonts have" };
  const paid = ctx.paidLeft > 0;
  try {
    const made = await ctx.drafters.poster!({
      tenant: ctx.tenant, businessId: ctx.businessId!, agentId: p.agent, turnId: ctx.turnId, now: ctx.now, question: question(p),
      headline: clip(headline.text.replace(/[.\s।]+$/u, ""), 60), ...(eyebrow ? { eyebrow } : {}),
      ...(ctx.domain ? { cta: ctx.domain } : {}), caption: [caption.text, caption.hashtags.join(" ")].filter(Boolean).join("\n\n"), paid,
    });
    await tagCard(g, p, made, ctx.now, ctx.log);
    return { paidTried: paid, item: {
      key: p.key, kind: "poster", agent: p.agent, title: p.title, why: p.why, purpose: p.purpose, status: "drafted", approvalId: made.approvalId,
      recommendationId: made.recommendationId, paid: made.hfCredits > 0, paidTried: paid, hfCredits: made.hfCredits, notes: [...made.notes, ...caption.warnings].slice(0, 4),
    } };
  } catch (e) {
    ctx.log?.(`stand-up: the poster for "${p.title}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return { item: null, paidTried: paid, why: "the poster tools could not finish it" };
  }
}

// The creating tools' own card, marked as this stand-up's (so it is deduped and learned from like the rest).
async function tagCard(g: GraphHandle, p: Picked, made: PosterDraft, now: number, log?: (line: string) => void): Promise<void> {
  const [a] = await g.roQuery<{ name: string }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.name AS name", { id: made.approvalId });
  const [r] = await g.roQuery<{ name: string }>("MATCH (r:Entity:Recommendation {id:$id}) RETURN r.name AS name", { id: made.recommendationId });
  if (a) await upsertNode(g, { type: "Approval", id: made.approvalId, name: a.name, props: { standup: true, standupKey: p.key, standupKind: "poster", by: p.agent } }, now);
  if (r) {
    await upsertNode(g, { type: "Recommendation", id: made.recommendationId, name: r.name, summary: p.why, props: { source: STANDUP_SOURCE, standupKey: p.key, standupKind: "poster", purpose: p.purpose } }, now);
    await link(g, made.recommendationId, p, now, log);
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// The idea's evidence and the goals it moves, as edges. A node that is not in the graph, or an edge that could not be written, is
// said through the stand-up's log: a card with no evidence or no goal is a thing the next reader should be able to find out about.
async function link(g: GraphHandle, recId: string, p: Picked, now: number, log?: (line: string) => void): Promise<void> {
  const asOf = isoDate(now);
  const present = await existingIds(g, [...p.evidence, ...p.goals]);
  for (const e of p.evidence.slice(0, 8)) {
    if (!present.has(e)) { log?.(`stand-up: "${p.title}" is not linked to its evidence ${e}: it is not in the graph`); continue; }
    await upsertEdge(g, { from: recId, type: "EVIDENCED_BY", to: e, asOf }, now).catch((err: unknown) => log?.(`stand-up: "${p.title}" could not be linked to its evidence ${e}: ${errText(err)}`));
  }
  for (const gl of p.goals) {
    if (!present.has(gl)) { log?.(`stand-up: "${p.title}" is not linked to its goal ${gl}: it is not in the graph`); continue; }
    await upsertEdge(g, { from: recId, type: "ADVANCES", to: gl }, now).catch((err: unknown) => log?.(`stand-up: "${p.title}" could not be linked to its goal ${gl}: ${errText(err)}`));
  }
}

function bodyOf(kind: Plain, t: TextDraft, p: Picked): string {
  const checks = t.warnings.length ? ["", `Check before you use it: ${t.warnings.slice(0, 3).join("; ")}.`] : [];
  if (kind === "website_fix") {
    const where = p.facts.filter((f) => /^(Page|Address):/.test(f));
    return [`New text, ready to paste in:`, "", t.text.trim(), "", ...where, `Why: ${p.why}`, ...checks].join("\n");
  }
  return [t.text.trim(), ...(t.hashtags.length ? ["", t.hashtags.join(" ")] : []), ...checks].join("\n");
}

async function writeCard(g: GraphHandle, p: Picked, kind: Plain, t: TextDraft, ctx: DraftCtx): Promise<{ approvalId: string; recommendationId: string }> {
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
  await link(g, recId, p, now, ctx.log);

  const page = p.facts.find((f) => f.startsWith("Address: "))?.slice(9);
  let payload: Record<string, string | string[] | boolean> = {
    title: p.title, body: bodyOf(kind, t, p),
    target: kind === "website_fix" ? page ?? "Your website" : kind === "post" && p.channel ? `${p.channel.name} post` : TARGET[kind],
    ...(kind === "website_fix" ? {} : { format: kind === "post" ? "post" : kind === "reply" ? "reply" : kind === "follow_up" ? "message" : "offer", channelId: kind === "post" ? p.channel?.id ?? "channel:instagram" : "" }),
    standup: true,
  };
  let shaped: ActiveRule[] = []; // the rules that rewrote this draft: the card is GUIDED_BY each
  if (actionKind === "content_draft") {
    const applied = await applyLearnedRules(g, { title: String(payload.title), body: String(payload.body) }, {
      agentId: agentNodeId(p.agent), ...(kind === "post" ? { channelId: p.channel?.id ?? "channel:instagram" } : {}), businessId: ctx.businessId,
    });
    shaped = applied.applied;
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
  if (actionKind === "content_draft") await guideCards(g, [recId, approvalId], shaped, now, recId);
  await upsertEdge(g, { from: recId, type: "PROPOSES", to: approvalId }, now);
  for (const gl of p.goals) {
    await upsertEdge(g, { from: approvalId, type: "ADVANCES", to: gl }, now).catch((err: unknown) => ctx.log?.(`stand-up: the card for "${p.title}" could not be linked to its goal ${gl}: ${errText(err)}`));
  }
  return { approvalId, recommendationId: recId };
}

// ---------- Sales: an email to the person, waiting for the owner's OK ----------

// A reply to an enquiry, a nudge for a quiet deal or a reminder for tomorrow's call, as an email the owner approves (the card
// shows the recipient, the subject and every word). With no email address for the person (a WhatsApp enquiry) it is a message
// draft for the owner to send themselves. A reply carries three real times from the calendar when there is one.
const SUBJECT = {
  sales_reply: (s: Picked): string => (s.sales?.subject ? `Re: ${s.sales.subject.replace(/^re:\s*/i, "")}` : "Your enquiry"),
  sales_nudge: (s: Picked): string => `Following up: ${s.sales?.name ?? "our conversation"}`,
  sales_reminder: (s: Picked): string => `Our call tomorrow${s.sales?.meetingTitle ? `: ${s.sales.meetingTitle}` : ""}`.slice(0, 120),
} as const;

async function draftSales(g: GraphHandle, p: Picked, ctx: DraftCtx, skill: TextJob["skill"], base: DraftedItem): Promise<DraftedItem> {
  const sales = p.sales!;
  const kind = p.kind as "sales_reply" | "sales_nudge" | "sales_reminder";
  const notes: string[] = [];
  let times: Array<{ label: string; start: string; end: string }> = [];
  if (kind === "sales_reply" && ctx.drafters.times) {
    times = await ctx.drafters.times({ tenant: ctx.tenant, now: ctx.now }).catch(() => []);
    if (!times.length) notes.push("The calendar could not be read, so the reply asks when suits them instead of offering times.");
  }
  const jobFacts = [
    ...facts(p),
    ...(kind === "sales_reply" ? [times.length ? `Three free times (use exactly these, in this order, each with its time zone): ${times.map((t) => t.label).join("; ")}` : "No calendar is connected: do not offer times; ask when suits them."] : []),
  ];
  const t = await ctx.drafters.text({ agent: p.agent, kind: "sales_email", brief: p.purpose, facts: jobFacts, question: [p.purpose, ...jobFacts].join("\n"), ...(skill ? { skill } : {}) });
  if (!t.ok || !t.text.trim()) return { ...base, notes: [...notes, t.why ?? "the writer did not return a draft"] };
  const { now } = ctx;
  const date = isoDate(now);
  const recId = standupRecId(p.key, date);
  const approvalId = standupApprovalId(p.key, date);
  const email = sales.email;
  const actionKind: ActionKind = email ? "email_send" : "content_draft";
  const subject = SUBJECT[kind](p);
  const agentId = await ensureAgentNode(g, p.agent, now);
  await upsertNode(g, {
    type: "Recommendation", id: recId, name: p.title, summary: p.why,
    props: { status: "open", source: STANDUP_SOURCE, standupKey: p.key, standupKind: kind, standupDate: date, kind: actionKind, by: p.agent, area: AREA[kind], purpose: clip(p.purpose, 1000), score: p.score, confidence: 0.7 },
    asOf: date,
  }, now);
  await upsertEdge(g, { from: agentId, type: "PRODUCED", to: recId }, now);
  await link(g, recId, p, now, ctx.log);
  const body = [t.text.trim(), ...(t.warnings.length ? ["", `Check before you use it: ${t.warnings.slice(0, 3).join("; ")}.`] : [])].join("\n");
  let payload: Record<string, string | string[] | boolean> = email
    ? { title: subject, subject, to: [email], body, send: true, target: `Email to ${email}`, standup: true }
    : { title: p.title, body, target: `Message to ${sales.name} (WhatsApp or email)`, format: "message", standup: true };
  const applied = await applyLearnedRules(g, { title: String(payload.title), body: String(payload.body) }, { agentId: agentNodeId(p.agent), businessId: ctx.businessId });
  payload = { ...payload, title: applied.title, body: applied.body, ...(applied.applied.length ? { rulesApplied: applied.applied.map((r) => r.id) } : {}) };
  const [existing] = await g.roQuery<{ status: string | null }>("MATCH (a:Entity:Approval {id:$id}) RETURN a.status AS status", { id: approvalId });
  await upsertNode(g, {
    type: "Approval", id: approvalId, name: `${actionKind}: ${p.title}`,
    props: { kind: actionKind, payload: JSON.stringify(payload), title: String(payload.title), recommendation: recId, by: p.agent, area: AREA[kind], standup: true, standupKey: p.key, standupKind: kind, ...(existing ? {} : { status: "pending" }) },
    asOf: date,
  }, now);
  await guideCards(g, [recId, approvalId], applied.applied, now, recId);
  await upsertEdge(g, { from: recId, type: "PROPOSES", to: approvalId }, now);
  return { ...base, status: "drafted", approvalId, recommendationId: recId, notes: [...notes, ...t.warnings] };
}

/** "Miss Influencer drafted a Dussehra post" for the note. */
export function draftedLine(d: Pick<DraftedItem, "agent" | "title">): string {
  const who = agentById(d.agent)?.name ?? "Your team";
  const t = oneLine(d.title);
  return `${who} drafted ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
}
