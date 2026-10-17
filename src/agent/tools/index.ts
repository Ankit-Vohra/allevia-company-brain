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
import { adLibrary, competitorWatch, googleListing, instagramPublic } from "./publicdata.js";
import { aiVisibility, keywordIdeas, websiteCheckup } from "./website.js";
import { CONNECTION_TOOLS } from "./connections.js";
import { SALES_TOOLS } from "./sales.js";
import { PUBLISH_TOOLS } from "./publish.js";
import { meetingsRead } from "./meetings.js";

export const ALL_TOOLS: AlleviaTool[] = [
  search, getEntity, neighbors, findPaths, traceDecision, whoOwns, whoKnows, impactOf, important, topics, metricTrend,
  contentPerformance, seoReport, adReport, playbook, history, recall, cypher, remember, proposeAction, showPath,
  useSkill,
  // what the team can make and what it can use to make it (the brand library); see shared/toolkits.ts for who holds them
  getBrandAsset, writeCopyTool, makePosterTool, generateImageTool, makeReelTool, researchTool,
  // public data (Apify, budgeted): the business's listing and public profile, competitors and the ad libraries
  googleListing, instagramPublic, competitorWatch, adLibrary,
  // the website check-up (src/checkup): what to fix on the site, whether AI names the business, paid keyword ideas
  websiteCheckup, aiVisibility, keywordIdeas,
  // the business's connected tools (src/connections): Calendar, Gmail, Analytics, Search Console, Ads, and any connected toolkit
  ...CONNECTION_TOOLS,
  // the Sales desk: enquiries waiting, the pipeline, leads and deals in the records (src/sales)
  ...SALES_TOOLS,
  // posting to the owner's own Instagram, Facebook Page and LinkedIn after their OK, now or at a time (src/publish)
  ...PUBLISH_TOOLS,
  // the business's meetings: what was decided and who does what (the notes "remember this meeting" saved, src/agent/meeting.ts)
  meetingsRead,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolsByName(names: string[]): AlleviaTool[] {
  const unknown = names.filter((n) => !BY_NAME.has(n));
  if (unknown.length) throw new Error(`unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  return [...new Set(names)].map((n) => BY_NAME.get(n)!);
}

export { staffAgentId } from "./actions.js";
