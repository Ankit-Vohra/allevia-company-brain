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

export const ALL_TOOLS: AlleviaTool[] = [
  search, getEntity, neighbors, findPaths, traceDecision, whoOwns, whoKnows, impactOf, important, topics, metricTrend,
  contentPerformance, seoReport, adReport, playbook, history, recall, cypher, remember, proposeAction, showPath,
  useSkill,
];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function toolsByName(names: string[]): AlleviaTool[] {
  const unknown = names.filter((n) => !BY_NAME.has(n));
  if (unknown.length) throw new Error(`unknown tool${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
  return [...new Set(names)].map((n) => BY_NAME.get(n)!);
}

export { staffAgentId } from "./actions.js";
