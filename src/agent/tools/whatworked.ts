// what_worked: the brain read before any creative work (src/creative/whatworked.ts). The business's best and weakest posts and reels
// by their real numbers, things the team learned from the owner's edits, recent decisions, rivals' ads on record, and the main goal
// with its call to action, in one call; plus the "Built from: …" line the draft opens with. Read-only.
import { loadNorthStar } from "../../northstar/northstar.js";
import { readWhatWorked } from "../../creative/whatworked.js";
import type { ToolContext } from "../tool.js";
import { Collector, defineTool, getNodes } from "./common.js";

async function runWhatWorked(_a: Record<string, never>, ctx: ToolContext) {
  const ns = await loadNorthStar(ctx.graph).catch(() => null);
  const w = await readWhatWorked(ctx.graph, { northStar: ns });
  const col = new Collector();
  const found = await getNodes(ctx, w.ids);
  for (const id of w.ids) col.node(found.get(id));
  col.provenance(w.ids);
  return col.result(ctx, {
    mainGoal: ns ? { id: ns.id, outcome: ns.outcome, cta: ns.cta, ...(ns.altCta ? { altCta: ns.altCta } : {}), audiences: ns.audiences } : null,
    comparedOn: w.metric, usual: w.usual, postsWithNumbers: w.considered,
    top: w.top, weak: w.weak, learnedRules: w.rules, decisions: w.decisions, rivalAds: w.rivalAds,
    builtFrom: w.builtFrom, learnings: w.learnings,
    ...(w.top.some((p) => p.simulated) ? { simulated: true } : {}),
  }, w.noData ?? undefined);
}

export const whatWorked = defineTool({
  name: "what_worked",
  description:
    "Read the brain before writing any post, reel, ad or caption: this business's top and weakest posts by real numbers (× its usual), things learned from the owner's edits, recent decisions, rivals' ads on record, and the main goal's call to action. Returns the \"Built from: …\" line to open the draft with. Example: {}",
  input: {},
  run: runWhatWorked,
});
