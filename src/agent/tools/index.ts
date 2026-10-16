// Every graph tool the Allevia agents can call (spec §7.2), and lookup by name for the roster (shared/roster.ts lists
// each agent's tools by name). Tools are plain values: the runtime binds them to a request through ToolContext and
// records each result in ctx.touched (tools never do that themselves).
import type { AlleviaTool } from "../tool.js";
import { search } from "./search.js";
import { getEntity, history, neighbors } from "./entity.js";
import { findPaths, showPath } from "./paths.js";
import { traceDecision } from "./decisions.js";
import { whoKnows, whoOwns } from "./people.js";
import { impactOf } from "./impact.js";
import { important, topics } from "./ranking.js";
import { metricTrend } from "./metrics.js";
import { contentPerformance } from "./content.js";
import { seoReport } from "./seo.js";
import { adReport } from "./ads.js";
import { playbook } from "./playbook.js";
import { recall, remember } from "./memory.js";
import { proposeAction } from "./actions.js";
import { cypher } from "./cypher.js";
import { useSkill } from "./skills.js";
import { getBrandAsset } from "./brand.js";
import { researchTool } from "./research.js";
import { writeCopyTool } from "./copy.js";
import { generateImageTool, makePosterTool, makeReelTool } from "./creative.js";
import { aiVisibility, keywordIdeas, websiteCheckup } from "./website.js";

export const ALL_TOOLS: AlleviaTool[] = [
  search, getEntity, neighbors, findPaths, traceDecision, whoOwns, whoKnows, impactOf, important, topics, metricTrend,
  contentPerformance, seoReport, adReport, playbook, history, recall, cypher, remember, proposeAction, showPath,
  useSkill,
  // what the team can make and what it can use to make it (the brand library); see shared/toolkits.ts for who holds them
  getBrandAsset, writeCopyTool, makePosterTool, generateImageTool, makeReelTool, researchTool,
  // the website check-up (src/checkup): what to fix on the site, whether AI names the business, paid keyword ideas
  websiteCheckup, aiVisibility, keywordIdeas,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolsByName(names: string[]): AlleviaTool[] {
  const unknown = names.filter((n) => !BY_NAME.has(n));
  if (unknown.length) throw new Error(`unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  return [...new Set(names)].map((n) => BY_NAME.get(n)!);
}

export { staffAgentId } from "./actions.js";
