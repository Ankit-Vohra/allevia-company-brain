// write_copy: captions, ad lines, headlines and emails in the brand's voice, checked in code (voice rules, and every number,
// price, date, address and absolute claim grounded in the request or the business's record). It writes text only and changes
// nothing: to turn the text into a draft for the owner's OK the agent proposes a content draft with it.
import { z } from "zod";
import { COPY_KINDS, writeCopy } from "../../creative/copy.js";
import { businessId } from "../../graph/tenants.js";
import type { ToolContext } from "../tool.js";
import { Collector, defineTool, getNode, refuseIfStopped, type NodeRow } from "./common.js";

async function run(a: { kind: string; brief: string; language?: string; options?: number }, ctx: ToolContext) {
  refuseIfStopped(ctx, "write_copy");
  const d = ctx.creative;
  if (!d) return { data: { made: false, why: "Writing copy isn't set up on this server yet." }, nodes: [], edges: [], sources: [], note: "Writing copy isn't set up on this server yet." };
  const r = await writeCopy(ctx.graph, businessId(ctx.tenant), {
    kind: (COPY_KINDS as readonly string[]).includes(a.kind) ? (a.kind as (typeof COPY_KINDS)[number]) : "caption", brief: a.brief, count: a.options ?? 2,
    ...(a.language ? { language: a.language } : {}), question: ctx.question ?? "",
  }, d.vision);
  const col = new Collector();
  col.node((await getNode(ctx, businessId(ctx.tenant))) as NodeRow | null);
  if (!r.ok) return col.result(ctx, { made: false, why: r.why ?? "No copy was written." }, r.why);
  return col.result(ctx, {
    made: true, variants: r.variants.map((v, i) => ({ option: i + 1, text: v.text, ...(v.hashtags.length ? { hashtags: v.hashtags } : {}), ...(v.warnings.length ? { checkBeforeUsing: v.warnings } : {}) })),
    say: "Give the owner the copy word for word. If a version has 'checkBeforeUsing', say which detail is not from them or our record. Nothing is saved or posted until they say OK.",
  });
}

export const writeCopyTool = defineTool({
  name: "write_copy",
  description:
    "Write captions, ad lines, headlines or emails in the brand's voice, checked: no invented numbers, prices, dates or promises. Text only; nothing is saved or posted. Example: {\"kind\":\"caption\",\"brief\":\"the new menu starts Friday\",\"options\":2}",
  input: {
    kind: z.enum(COPY_KINDS).describe("caption | post | reel_caption | ad_line | headline | email | other"),
    brief: z.string().min(3).max(800).describe("What it is about, in the owner's words"),
    language: z.string().max(30).optional().describe("Default: the language of the brief"),
    options: z.number().int().min(1).max(3).optional(),
  },
  writes: true,
  external: true,
  run,
});
