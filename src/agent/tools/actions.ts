// propose_action: the only way an agent asks for something to be done. It writes a Recommendation (why, evidence,
// confidence, which agent) and a pending Approval card with the action payload; it never executes anything. The
// owner approves or rejects the card in the web app or on Discord, and an executor acts on approval (spec §9).
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import type { ActionKind } from "../../../shared/contracts.js";
import { agentById } from "../../../shared/roster.js";
import { upsertEdge, upsertNode } from "../../graph/upsert.js";
import { entityId } from "../../util/ids.js";
import { isoDate } from "../../util/time.js";
import {
  Collector, InputError, clip, defineTool, getNode, getNodes, nextId, refuseIfReadOnly, refuseIfStopped, ro, serial,
} from "./common.js";

const ACTION_KINDS = ["github_issue", "content_draft", "pause_ad", "discord_post"] as const satisfies readonly ActionKind[];
const PAYLOAD_CAP = 20_000;
const MIN_DRAFT_BODY = 20; // a draft's text: shorter than this is a label, not copy

export const staffAgentId = (rosterId: string): string => `agent:allevia-${rosterId}`;

interface Args {
  title: string; why: string; kind: ActionKind; payload: Record<string, unknown>; evidence: string[]; area?: string; confidence?: number;
}

async function runPropose(args: Args, ctx: ToolContext) {
  refuseIfReadOnly(ctx, "propose_action");
  const title = args.title.trim();
  if (title.length < 3) throw new InputError("title is too short.");
  if (args.kind === "content_draft") {
    const body = (args.payload as { body?: unknown } | undefined)?.body;
    if (typeof body !== "string" || body.trim().length < MIN_DRAFT_BODY) {
      throw new InputError(
        "A content_draft needs the text to post in payload.body: every caption and the script, word for word, ready to use. " +
        "A plan, a list of ideas or a to-do list is not a draft. Put the finished text in payload.body and propose again.");
    }
  }
  const payload = JSON.stringify(args.payload ?? {});
  if (payload.length > PAYLOAD_CAP) throw new InputError(`payload is ${payload.length} chars; keep it under ${PAYLOAD_CAP}.`);
  const wanted = [...new Set(args.evidence.map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  const found = await getNodes(ctx, wanted);
  const evidence = wanted.filter((id) => found.has(id));
  const skipped = wanted.filter((id) => !found.has(id));
  if (!evidence.length) throw new InputError(`None of the evidence ids exist (${wanted.join(", ") || "none given"}). Cite ids returned by tools.`);
  const confidence = args.confidence === undefined ? undefined : Math.min(1, Math.max(0, args.confidence));
  const src = `turn:${ctx.turnId}`;
  const asOf = isoDate(ctx.now);
  const recId = entityId("Recommendation", title);
  const agentId = staffAgentId(ctx.agentId);

  const { approvalId, reused } = await serial(ctx.graph.name, async () => {
    refuseIfStopped(ctx, "propose_action");
    if (!(await getNode(ctx, agentId))) {
      const def = agentById(ctx.agentId);
      await upsertNode(ctx.graph, {
        type: "Agent", id: agentId, name: def?.name ?? ctx.agentId,
        props: { kind: "allevia", rosterId: ctx.agentId, ...(def ? { title: def.title, department: def.department } : {}) },
      }, ctx.now);
    }
    // The same recommendation already waiting on the owner: add the new evidence, never a second card.
    const [waiting] = await ro<{ id: string }>(ctx,
      "MATCH (:Entity {id:$rid})-[p:PROPOSES]->(a:Approval) WHERE p.until IS NULL AND a.status = 'pending' RETURN a.id AS id ORDER BY id LIMIT 1", { rid: recId });
    if (waiting) {
      for (const to of evidence) await upsertEdge(ctx.graph, { from: recId, type: "EVIDENCED_BY", to, src, asOf }, ctx.now);
      return { approvalId: waiting.id, reused: true };
    }
    const approvalId = await nextId(ctx, `approval:${ctx.turnId}-`);
    await upsertNode(ctx.graph, {
      type: "Recommendation", id: recId, name: title, summary: clip(args.why.trim(), 1000),
      props: {
        status: "open", kind: args.kind, by: ctx.agentId,
        ...(args.area?.trim() ? { area: args.area.trim() } : {}), ...(confidence !== undefined ? { confidence, score: confidence } : {}),
      },
      src, asOf,
    }, ctx.now);
    await upsertNode(ctx.graph, {
      type: "Approval", id: approvalId, name: `${args.kind}: ${title}`,
      props: { status: "pending", kind: args.kind, payload, title, recommendation: recId }, src, asOf,
    }, ctx.now);
    await upsertEdge(ctx.graph, { from: recId, type: "PROPOSES", to: approvalId, src, asOf }, ctx.now);
    for (const to of evidence) await upsertEdge(ctx.graph, { from: recId, type: "EVIDENCED_BY", to, src, asOf }, ctx.now);
    await upsertEdge(ctx.graph, { from: agentId, type: "PRODUCED", to: recId, src, asOf }, ctx.now);
    return { approvalId, reused: false };
  });

  const nodes = await getNodes(ctx, [recId, approvalId, agentId, ...evidence]);
  const col = new Collector();
  for (const id of [recId, approvalId, agentId, ...evidence]) col.node(nodes.get(id));
  const edge = (from: string, type: string, to: string) => col.edge({ from, type, to, since: ctx.now, until: null });
  edge(recId, "PROPOSES", approvalId);
  for (const to of evidence) edge(recId, "EVIDENCED_BY", to);
  edge(agentId, "PRODUCED", recId);
  const said = reused ? `Already proposed and waiting for the owner (${approvalId}); added the evidence.` : `Proposed for the owner's approval (${approvalId}); nothing has been executed.`;
  return col.result(ctx, {
    recommendationId: recId, approvalId, kind: args.kind, status: "pending", title, evidence, ...(reused ? { alreadyPending: true } : {}),
    ...(skipped.length ? { skipped } : {}),
  }, `${said}${skipped.length ? ` Unknown evidence skipped: ${skipped.join(", ")}.` : ""}`);
}

export const proposeAction = defineTool({
  name: "propose_action",
  description:
    "Propose an action for the owner to approve; it never executes. Kinds: GitHub issue, content draft, pause ad, Discord post. Creates a Recommendation (your reasoning, evidence ids) and a pending Approval card; returns their ids. Example: {\"title\":\"Add meta description to /jobs\",\"why\":\"High-severity SEO fail\",\"kind\":\"github_issue\",\"payload\":{\"body\":\"…\"},\"evidence\":[\"page:www.aamdani.ai/jobs\"]}",
  input: {
    title: z.string().min(3).describe("Short imperative title"),
    why: z.string().min(1).describe("The reasoning, with the numbers"),
    kind: z.enum(ACTION_KINDS),
    payload: z.record(z.string(), z.unknown()).describe("What the executor needs, e.g. {title, body} for an issue"),
    evidence: z.array(z.string()).min(1).describe("Ids of the nodes that justify it"),
    area: z.string().optional().describe("e.g. seo, content, ads, ops"),
    confidence: z.number().min(0).max(1).optional(),
  },
  writes: true,
  run: runPropose,
});
