// The website check-up tools (src/checkup): what to improve on the site, ranked by likely enquiries; whether AI
// assistants name the business; and, when DataForSEO is set up, the searches it could rank for.
//   website_checkup - the latest stored check-up: verdict, at most three scores, the top five fixes in owner words
//                     (what, why, effort, where), progress since the run before, and the full list for "Show how".
//   ai_visibility   - the latest "Does AI know you?" runs: questions, whether the business was named, who was named
//                     instead, with the honest note that this is one model's answer.
//   keyword_ideas   - paid and optional: off (and says so) without DataForSEO; with it, estimates the cost, checks this
//                     month's budget, then asks.
// The first two only read the graph (the runs are made by `npm run cli -- checkup|ai-visibility`, or a schedule): a
// crawl plus Lighthouse takes minutes, longer than an agent's turn.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { findBusinessId } from "../../actions/shared.js";
import { HONEST_NOTE, storedAiRuns } from "../../checkup/ai-visibility.js";
import {
  BudgetError, DataForSeo, DfsError, NOT_CONFIGURED, dfsConfig, estimateUsd, graphLedger, keywordIdeasCall, keywordsWrite, marketFor, withinBudget,
  type DfsConfig, type DfsFetch,
} from "../../checkup/dataforseo.js";
import type { Fix } from "../../checkup/fixes.js";
import { progress, type CheckupMetric } from "../../checkup/store.js";
import { storedCheckups } from "../../checkup/run.js";
import { writeBatch } from "../../graph/upsert.js";
import { Collector, InputError, defineTool, getNodes, refuseIfReadOnly, refuseIfStopped } from "./common.js";

// Test seam: the DataForSEO config and transport. Production reads the env file and uses fetch.
export interface WebsiteToolDeps { dfsConfig?: DfsConfig; dfsFetch?: DfsFetch }
const deps = (ctx: ToolContext): WebsiteToolDeps => (ctx as ToolContext & { website?: WebsiteToolDeps }).website ?? {};

const SCORE_WORDS: Partial<Record<CheckupMetric, string>> = {
  checkup_mobile_speed: "speed on phones", checkup_easy_to_use: "easy to use", checkup_google_basics: "Google basics",
};

async function runCheckupTool(args: { all?: boolean }, ctx: ToolContext) {
  const runs = await storedCheckups(ctx.graph, 2);
  const [cur, prev] = runs;
  if (!cur) {
    return {
      data: { found: false, why: "No website check-up has been run for this business yet.", how: "The owner starts it with the \"Check my website\" button on the plan page or /checkup on Discord (about 3 minutes, free); it can also run every week.",
        say: "Tell the owner plainly that the website has not been checked yet, that it is free and takes a few minutes, and that they can press \"Check my website\" or type /checkup; do not guess what is wrong with the site." },
      nodes: [], edges: [], sources: [], note: "No check-up stored yet.",
    };
  }
  const top = cur.top as Array<Pick<Fix, "key" | "title" | "what" | "why" | "who" | "effort" | "impact" | "tier" | "pages" | "pageCount" | "evidence">>;
  const scores = Object.fromEntries(cur.readings.filter((r) => SCORE_WORDS[r.metric as CheckupMetric]).map((r) => [SCORE_WORDS[r.metric as CheckupMetric]!, r.value]));
  const p = prev ? progress(prev.readings, cur.readings, prev.fixTitles, cur.fixTitles, prev.asOf) : undefined;
  const col = new Collector();
  const nodes = await getNodes(ctx, [cur.docId, ...(prev ? [prev.docId] : [])]);
  for (const n of nodes.values()) col.node(n);
  const losing = top.filter((f) => f.tier === "losing enquiries").length;
  const data = {
    found: true, checkedOn: cur.asOf.slice(0, 10), site: cur.url, businessKind: cur.kind,
    verdict: losing ? `The website is losing enquiries in ${losing === 1 ? "one place" : `${losing} places`}.` : top.length ? "Nothing on the website is turning customers away." : "The website is in good shape.",
    scores, scoresNote: "Out of 100; 90+ is good. Lighthouse lab test of the home page on a simulated mid-range phone over slow 4G.",
    topFixes: top.map((f, i) => ({ rank: i + 1, title: f.title, whatToChange: f.what, why: f.why, effort: f.effort, who: f.who, where: f.pageCount ? f.pages.slice(0, 5) : ["whole site"], key: f.key })),
    ...(p && p.lines.length ? { sinceLastCheckup: p.lines, previousCheckOn: prev!.asOf.slice(0, 10) } : prev ? { sinceLastCheckup: ["No change worth reporting since the last check-up."] } : {}),
    alreadyGood: cur.good, notes: cur.notes,
    ...(args.all ? { showHow: { method: "Each problem has a base score for how directly it loses an enquiry, weighted by the page (home 1, key pages 0.8, others 0.5), plus a little for each extra page; ties go to the quicker fix.", evidence: Object.fromEntries(top.map((f) => [f.key, f.evidence])) } } : {}),
    draftable: top.filter((f) => ["titles", "descriptions", "clear-offer", "image-text", "share-preview"].includes(f.key)).map((f) => ({ key: f.key, pages: f.pages })),
    say: "Lead with the verdict and the first fix. List the top fixes as: what to change, why, effort, where. Speed scores are lab tests, say so if you quote them. For a fix in `draftable`, you may draft the new text (titles, descriptions, headline) and propose it as a content_draft card for the owner's OK; never claim it was changed on the site.",
  };
  return col.result(ctx, data, `Website check-up of ${cur.asOf.slice(0, 10)}: ${top.length} top fixes.`);
}

export const websiteCheckup = defineTool({
  name: "website_checkup",
  description:
    "Answer 'what should I improve on my website': the latest free check-up (phone and desktop speed, SEO checks, a call/WhatsApp button on a phone's first screen, offer, reviews). Top 5 fixes ranked by likely enquiries (what, why, effort, page) and progress since last time. Example: {\"all\":true}",
  input: { all: z.boolean().optional().describe("Also return the evidence behind each fix") },
  run: runCheckupTool,
});

async function runAiTool(_args: Record<string, never>, ctx: ToolContext) {
  const runs = await storedAiRuns(ctx.graph, 3);
  if (!runs.length) {
    return {
      data: { found: false, why: "The AI visibility check has not been run for this business yet.", how: "`npm run cli -- ai-visibility <tenant>` asks Claude 4 customer questions on the subscription, free.",
        say: "Say it has not been checked yet; do not guess whether AI knows the business." },
      nodes: [], edges: [], sources: [], note: "No AI visibility run stored yet.",
    };
  }
  const col = new Collector();
  for (const n of (await getNodes(ctx, runs.map((r) => r.docId))).values()) col.node(n);
  const [cur, ...older] = runs;
  const data = {
    found: true, checkedOn: cur!.asOf.slice(0, 10), namedInPercentOfAnswers: cur!.mentionPct,
    questions: cur!.questions.map((q, i) => ({ question: q, named: cur!.mentioned[i] ?? "unknown" })),
    namedInstead: cur!.others.map((o) => ({ name: o.slice(0, o.lastIndexOf("|")), answers: Number(o.slice(o.lastIndexOf("|") + 1)) })),
    history: older.map((r) => ({ checkedOn: r.asOf.slice(0, 10), namedInPercentOfAnswers: r.mentionPct })),
    honestNote: HONEST_NOTE,
    say: "Say how often Claude named the business and who it named instead, then the honest note in one line. Never present it as a Google ranking.",
  };
  return col.result(ctx, data, `AI visibility of ${cur!.asOf.slice(0, 10)}.`);
}

export const aiVisibility = defineTool({
  name: "ai_visibility",
  description:
    "Answer 'does AI know us / would ChatGPT or Claude recommend us': the latest 'Does AI know you?' runs, where Claude was asked questions a customer would ask (\"best interior architect in Raipur\"), whether the business was named, who was named instead, and the trend. It measures one model's answer, not search ranking. Example: {}",
  input: {},
  run: runAiTool,
});

async function runKeywordIdeas(args: { seeds: string[]; limit?: number; country?: string }, ctx: ToolContext) {
  const d = deps(ctx);
  const cfg = d.dfsConfig ?? dfsConfig();
  if (!cfg.credentials) {
    return { data: { configured: false, why: NOT_CONFIGURED, say: "Tell the owner keyword research is an optional paid add-on that is off, in one line, and carry on with what the free check-up shows." }, nodes: [], edges: [], sources: [], note: "DataForSEO is not set up." };
  }
  refuseIfReadOnly(ctx, "keyword_ideas"); // it spends money and records the spend
  const seeds = [...new Set(args.seeds.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 5);
  if (!seeds.length) throw new InputError("Give one to five seed searches, e.g. [\"interior designer raipur\"].");
  const limit = Math.min(50, Math.max(5, args.limit ?? 20));
  const bid = await findBusinessId(ctx.graph, ctx.tenant);
  if (!bid) throw new InputError("No business in the records to charge the search to.");
  const [b] = await ctx.graph.roQuery<{ country: string | null }>("MATCH (b:Entity:Business {id:$id}) RETURN b.country AS country LIMIT 1", { id: bid });
  const client = new DataForSeo(cfg.credentials, d.dfsFetch ? { fetch: d.dfsFetch } : {});
  const ledger = graphLedger(ctx.graph, bid, async (w) => { await writeBatch(ctx.graph, w, ctx.now); });
  refuseIfStopped(ctx, "keyword_ideas");
  try {
    const r = await withinBudget(keywordIdeasCall(client, seeds, marketFor(args.country ?? b?.country), limit), ledger, cfg.monthlyBudgetUsd, ctx.now);
    const asOf = new Date(ctx.now).toISOString().slice(0, 19) + "Z";
    await writeBatch(ctx.graph, keywordsWrite({ asOf, host: ctx.tenant, ideas: r.value }), ctx.now);
    const ideas = r.value.sort((a, b2) => (b2.volume ?? 0) - (a.volume ?? 0)).slice(0, limit);
    return {
      data: {
        configured: true, seeds, ideas: ideas.map((k) => ({ search: k.keyword, monthlySearches: k.volume, difficulty: k.difficulty, intent: k.intent })),
        costUsd: r.costUsd, spentThisMonthUsd: Math.round(r.spentThisMonthUsd * 1000) / 1000, monthlyBudgetUsd: r.budgetUsd,
        say: "Pick the 3 to 5 searches that fit what the business sells and where, and say which page should answer each. Say the monthly searches are Google estimates.",
      },
      nodes: [], edges: [], sources: [{ id: "dataforseo", title: "DataForSEO Google keyword data", asOf }], note: `DataForSEO keyword ideas, cost $${r.costUsd.toFixed(4)}.`,
    };
  } catch (e) {
    if (e instanceof BudgetError || e instanceof DfsError) {
      return { data: { configured: true, ran: false, why: e.message, estimateUsd: estimateUsd("keyword_ideas", limit) }, nodes: [], edges: [], sources: [], note: e.message };
    }
    throw e;
  }
}

export const keywordIdeas = defineTool({
  name: "keyword_ideas",
  description:
    "Optional and paid (DataForSEO, about 1-2 US cents a call, within the business's monthly budget): Google searches related to the seeds, with monthly search volume, difficulty and intent. When DataForSEO is not set up it says so and spends nothing. Example: {\"seeds\":[\"interior designer raipur\"]}",
  input: {
    seeds: z.array(z.string().min(2).max(80)).min(1).max(5).describe("1-5 searches a customer would type"),
    limit: z.number().int().optional().describe("Ideas to return, default 20, max 50"),
    country: z.string().length(2).optional().describe("Two-letter country, default the business's"),
  },
  writes: true,
  external: true,
  run: runKeywordIdeas,
});
