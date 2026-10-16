// Team settings and "Tell your team" (product design §2.4, §8):
//   GET   /api/:t/agents                  every roster agent: its stats (as before) merged with its settings (enabled,
//                                         mode, autonomy, status note, standing instructions) and its active learned rules
//   PATCH /api/:t/agents/:id              {enabled?, mode?, autonomy?, statusNote?}; the old state is kept as a Version
//   DELETE /api/:t/skill-notes/:id        retire one of this business's own skill rules or skills
//   POST  /api/:t/directives              {text, actor?}: the owner's words as typed patches and a diff, nothing applied
//   POST  /api/:t/directives/:id/apply    writes a previewed directive (applying twice writes nothing more)
import type { Hono } from "hono";
import { z } from "zod";
import type { AgentSettings, LearnedRuleDto, SkillView } from "../../../shared/contracts.js";
import { plainTool } from "../../../shared/plain-tools.js";
import { agentById } from "../../../shared/roster.js";
import type { GraphHandle } from "../../graph/client.js";
import type { LlmRunner } from "../../ingest/llm.js";
import { learnedRules } from "../../actions/feed.js";
import { retireSkillNote } from "../../agent/skills/business.js";
import { businessCatalog, skillViewsFor } from "../../agent/skills/views.js";
import { applyDirective, getDirective, previewDirective } from "../../settings/directives.js";
import { agentChangeRefusal, listAgentsWithSettings, setAgentSettings } from "../../settings/team.js";
import * as reads from "../reads.js";
import type { AgentSummaryDto } from "../types.js";
import { HttpError, errorMessage, readBody, type RouteCtx } from "../http.js";

export type AgentViewDto = AgentSummaryDto & AgentSettings & {
  learnedRules: Array<Pick<LearnedRuleDto, "id" | "text" | "confidence" | "appliedCount" | "learnedAt">>;
  tools: Array<{ name: string; words: string }>; // what they can look at and do, in the owner's words
  skills: SkillView[];                           // how they work: the shipped skills with this business's own laid over them
};

const AgentPatch = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(["full", "light", "off"]).optional(),
  autonomy: z.number().int().min(0).max(3).optional(),
  statusNote: z.string().trim().max(200).nullable().optional(),
  skillsOff: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/)).max(60).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: "says nothing to change" });

const DirectiveBody = z.object({ text: z.string().trim().min(1).max(2000), actor: z.string().regex(/^person:[a-z0-9-]+$/).max(80).optional() });

async function agentViews(g: GraphHandle): Promise<AgentViewDto[]> {
  const [summaries, settings, rules, { catalog, learned }] = await Promise.all([reads.agentSummaries(g), listAgentsWithSettings(g), learnedRules(g), businessCatalog(g)]);
  return summaries.map((s) => {
    const set = settings.find((x) => x.id === s.id)!;
    const mine = rules.filter((r) => r.status === "active" && r.agents.includes(s.id))
      .map(({ id, text, confidence, appliedCount, learnedAt }) => ({ id, text, confidence, appliedCount, learnedAt }));
    const tools = (agentById(s.id)?.tools ?? []).map((name) => ({ name, words: plainTool(name) }));
    return { ...s, ...set, learnedRules: mine, tools, skills: skillViewsFor(catalog, s.id, learned, set.skillsOff ?? []) };
  });
}

export function registerTeamRoutes(app: Hono, ctx: RouteCtx, o: { directiveLlm?: LlmRunner | null } = {}): void {
  app.get("/api/:t/agents", async (c) => {
    const { g } = await ctx.tenantOf(c);
    return c.json(await agentViews(g));
  });

  app.patch("/api/:t/agents/:id", async (c) => {
    const { g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const id = c.req.param("id");
    if (!agentById(id)) throw new HttpError(404, "No such agent on the team.");
    const body = await readBody(c, AgentPatch);
    const change = body;
    const why = agentChangeRefusal(id, change);
    if (why) throw new HttpError(400, why);
    await setAgentSettings(g, id, change, { now: ctx.now() });
    return c.json((await agentViews(g)).find((a) => a.id === id));
  });

  // Take one of this business's own skill rules or skills out of use (it stays in the records, retired).
  app.delete("/api/:t/skill-notes/:id", async (c) => {
    const { g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const id = c.req.param("id");
    if (!/^memory:[A-Za-z0-9_.:-]{1,120}$/.test(id)) throw new HttpError(404, "No such skill note.");
    if (!(await retireSkillNote(g, id, ctx.now()))) throw new HttpError(404, "No such skill note.");
    return c.json({ id, status: "retired" });
  });

  app.post("/api/:t/directives", async (c) => {
    const { g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const body = await readBody(c, DirectiveBody);
    try {
      return c.json(await previewDirective(g, { text: body.text, ...(body.actor ? { actor: body.actor } : {}) }, {
        now: ctx.now(), ...(o.directiveLlm !== undefined ? { llm: o.directiveLlm } : {}),
      }));
    } catch (e) {
      throw new HttpError(400, errorMessage(e));
    }
  });

  app.post("/api/:t/directives/:id/apply", async (c) => {
    const { g } = await ctx.tenantOf(c);
    ctx.refuseInPublicMode();
    const id = c.req.param("id");
    if (!(await getDirective(g, id))) throw new HttpError(404, "No such directive preview.");
    return c.json(await applyDirective(g, id, { now: ctx.now() }));
  });
}
