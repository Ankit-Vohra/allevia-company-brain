// Reading GRAPH.EXPLAIN output. A plan is a list of operator lines, indented by depth:
//
//     Project
//         Conditional Traverse | (s)<-[r:IN_SESSION]-(t:Turn)
//             Node By Index Scan | (s:Entity:Session)       <- an index lookup: what an id anchor should plan as
//             Node By Label Scan | (t:Turn)                 <- a scan of every Turn
//             All Node Scan | (n)                            <- a scan of every node
//
// scansDespiteIdAnchor is the rule tests/graph/explain.test.ts holds every query the product sends to: a query that
// looks a node up by id (Entity.id has a range index, and a UNIQUE constraint) must not also scan a label or the whole
// graph, because that scan is O(label) on every call and the label (Turn, Document, Observation…) only grows. A query
// that scans on purpose (a survey of a whole type) has no id anchor, so it is not asked to avoid one.
import { idAnchors } from "./cypher-lint.js";

export interface PlanScan { op: "label" | "all" | "index"; alias: string; labels: string[] }

const SCAN = /(Node By Label Scan|All Node Scan|Node By Index Scan)\s*\|\s*\((\w*)((?::\w+)*)\)/;

export function planScans(plan: readonly string[]): PlanScan[] {
  const out: PlanScan[] = [];
  for (const line of plan) {
    const m = SCAN.exec(line);
    if (!m) continue;
    out.push({ op: m[1] === "Node By Index Scan" ? "index" : m[1] === "All Node Scan" ? "all" : "label", alias: m[2]!, labels: m[3]!.split(":").filter(Boolean) });
  }
  return out;
}

// The scans (as "(alias:Label)") that a query with an id anchor should not have; [] when it has no anchor or no scan.
export function scansDespiteIdAnchor(cypher: string, plan: readonly string[]): string[] {
  if (!idAnchors(cypher).length) return [];
  return planScans(plan).filter((s) => s.op !== "index").map((s) => `${s.op === "all" ? "All Node Scan" : "Node By Label Scan"} (${s.alias}${s.labels.map((l) => `:${l}`).join("")})`);
}

export const normalizeCypher = (q: string): string => q.replace(/\s+/g, " ").trim();
