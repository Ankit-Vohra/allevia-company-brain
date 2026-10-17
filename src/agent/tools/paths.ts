// How things connect: find_paths (up to 3 shortest current paths between two nodes, any direction) and show_path
// (the explanation path an answer ends with: the agent's ordered ids, each consecutive pair joined by a direct edge or
// a short path, returned in order for the UI; ids no tool returned this turn are refused). Memory plumbing (Turn TOUCHED/CITED…) is never a connection: a Turn
// touches everything it read, so a path through one explains nothing.
import { z } from "zod";
import type { ToolContext } from "../tool.js";
import { REL_TYPES, type RelType } from "../../graph/schema.js";
import { shortestPaths } from "../../graph/algorithms.js";
import { typeFromId } from "../../util/ids.js";
import {
  ALGO_BUDGET, Collector, EDGE, InputError, MEMORY_RELS, PATH_RELS, TOOL_ALGO_TIMEOUT_MS, clamp, defineTool, edgeText,
  getNodes, parseAsOf, requireNode, ro, type EdgeRow,
} from "./common.js";

// ---------- find_paths ----------

async function runFindPaths(args: { from: string; to: string; rels?: RelType[]; maxPaths?: number; asOf?: string }, ctx: ToolContext) {
  const asOf = parseAsOf(args.asOf);
  if (args.from === args.to) throw new InputError("from and to are the same node.");
  const [a, b] = await Promise.all([requireNode(ctx, args.from), requireNode(ctx, args.to)]);
  const maxPaths = clamp(args.maxPaths, 3, 1, 3);
  const paths = await shortestPaths(ctx.graph, a.id, b.id, { relTypes: args.rels?.length ? args.rels : PATH_RELS, maxPaths, asOf, ...ALGO_BUDGET });
  const col = new Collector();
  col.node(a);
  col.node(b);
  const out = paths.map((p) => {
    for (const n of p.nodes) col.ref(n);
    for (const e of p.edges) col.edgeRef(e);
    return { length: p.length, nodes: p.nodes.map((n) => n.id), steps: p.edges.map(edgeText) };
  });
  const note = out.length ? undefined
    : `No ${asOf === undefined ? "current" : `as-of-${args.asOf}`} connection within 6 hops${args.rels?.length ? ` over ${args.rels.join("/")}` : ""}.`;
  return col.result(ctx, { from: a.id, to: b.id, paths: out }, note);
}

export const findPaths = defineTool({
  name: "find_paths",
  description:
    "How two nodes are connected: up to 3 shortest paths over current relationships (direction ignored; steps keep the stored arrow). Optional rels restricts relationship types; asOf time-travels. Returns {length, nodes, steps:['a -[REL]-> b']}. Example: {\"from\":\"person:founder\",\"to\":\"system:ig-connector\",\"maxPaths\":2}",
  input: {
    from: z.string().min(1),
    to: z.string().min(1),
    rels: z.array(z.enum(REL_TYPES)).optional().describe("Only these relationship types"),
    maxPaths: z.number().int().optional().describe("1 to 3, default 3"),
    asOf: z.string().optional().describe("ISO date to see past connections"),
  },
  run: runFindPaths,
});

// ---------- show_path ----------

// A card the team just proposed (a Recommendation, its Approval, an Action) is what we suggest, not part of why: the
// explanation path is drawn through the business's own records, so these are left out when two or more other ids remain.
const PROPOSED = new Set(["Recommendation", "Approval", "Action"]);
// Allevia's own staff (agent:allevia-*) are not part of the business either: they know about everything, so a path through one explains nothing.
// The relationships our own cards and staff add between records they cite or know about.
const PAPERWORK_RELS: RelType[] = ["PROPOSES", "EVIDENCED_BY", "PRODUCED", "KNOWS_ABOUT"];
const isOurs = (id: string): boolean => PROPOSED.has(typeFromId(id) ?? "") || id.startsWith("agent:allevia-");

// An agent's turn (a `turn:` id) keeps everything its tools returned in ctx.touched, and the recall brief's ids count as seen:
// show_path holds the explanation to those, so a path never walks through a record nobody looked at this turn. A one-off
// call (the MCP server, an API read, a test) has no earlier lookups to hold it to.
const inATurn = (ctx: ToolContext): boolean => ctx.turnId.startsWith("turn:");

async function runShowPath(args: { ids: string[] }, ctx: ToolContext) {
  const asked = args.ids.map((s) => s.trim()).filter(Boolean).filter((id, i, a) => i === 0 || a[i - 1] !== id);
  if (!asked.length) throw new InputError("Pass the ordered ids of your explanation, e.g. [\"decision:x\", \"observation:y\"].");
  const found = await getNodes(ctx, asked);
  const missing = asked.filter((id) => !found.has(id));
  // In the records but not returned by any tool this turn: refused, not drawn.
  const unseen = inATurn(ctx) ? asked.filter((id) => found.has(id) && !ctx.touched.has(id)) : [];
  const given = asked.filter((id) => found.has(id) && !unseen.includes(id));
  const records = given.filter((id) => !isOurs(id));
  const left = records.length >= 2 && records.length < given.length ? given.filter((id) => !records.includes(id)) : [];
  const present = left.length ? records : given;
  const pairs = present.slice(1).map((b, i): [string, string] => [present[i]!, b]).filter(([a, b]) => a !== b);
  const direct = pairs.length ? await ro<{ a: string; b: string; e: EdgeRow }>(ctx,
    `UNWIND $pairs AS p MATCH (a:Entity {id:p[0]}) WITH p, a MATCH (a)-[r]-(b:Entity {id:p[1]}) WHERE r.until IS NULL AND NOT type(r) IN $mem
     WITH p, head(collect(${EDGE("r")})) AS e RETURN p[0] AS a, p[1] AS b, e`, { pairs, mem: MEMORY_RELS }) : [];
  const directByPair = new Map<string, EdgeRow>();
  for (const d of direct) if (!directByPair.has(`${d.a}|${d.b}`)) directByPair.set(`${d.a}|${d.b}`, d.e);

  const col = new Collector();
  const links: Array<{ from: string; to: string; hops: number; steps: string[] }> = [];
  const unconnected: Array<{ from: string; to: string }> = [];
  const unchecked: Array<{ from: string; to: string }> = [];
  // A node is drawn only through a link that was found: one with no connection to its neighbour in the list (or one we ran
  // out of time to check) is reported below and left off the path, so the drawing never joins what the records do not.
  // One TOOL_ALGO_TIMEOUT_MS budget for every pair's search together (up to 11 searches run one after another).
  const deadline = Date.now() + TOOL_ALGO_TIMEOUT_MS;
  for (const [a, b] of pairs) {
    const e = directByPair.get(`${a}|${b}`);
    if (e) {
      col.node(found.get(a));
      col.node(found.get(b));
      col.edge(e);
      links.push({ from: a, to: b, hops: 1, steps: [edgeText(e)] });
      continue;
    }
    const left = deadline - Date.now();
    if (left < 100) {
      unchecked.push({ from: a, to: b });
      continue;
    }
    let [p] = await shortestPaths(ctx.graph, a, b, { maxPaths: 1, maxLen: 4, relTypes: PATH_RELS, timeoutMs: left });
    // A card drafted this very turn, or one of our own staff, can be the shortest way between two records (a recommendation
    // EVIDENCED_BY both, an agent that KNOWS_ABOUT both). That is a route through our own paperwork, not an explanation: look
    // again over the business's own relationships.
    if (p && p.nodes.some((n) => isOurs(n.id) && !present.includes(n.id))) {
      const own = PATH_RELS.filter((r) => !PAPERWORK_RELS.includes(r));
      [p] = await shortestPaths(ctx.graph, a, b, { maxPaths: 1, maxLen: 4, relTypes: own, timeoutMs: Math.max(100, deadline - Date.now()) });
    }
    if (p) {
      col.node(found.get(a));
      for (const n of p.nodes) col.ref(n);
      for (const pe of p.edges) col.edgeRef(pe);
      links.push({ from: a, to: b, hops: p.length, steps: p.edges.map(edgeText) });
    } else {
      unconnected.push({ from: a, to: b });
    }
  }
  if (!col.nodes.size && present.length === 1) col.node(found.get(present[0]!)); // a path of one record
  const drawn = new Set(col.nodes.keys());
  const problems = [
    ...(left.length ? [`Left out of the path: ${left.join(", ")} (a proposed card is what we suggest, not part of why).`] : []),
    ...(missing.length ? [`Unknown ids: ${missing.join(", ")}.`] : []),
    ...(unseen.length ? [`Left out of the path: ${unseen.join(", ")} (no tool returned ${unseen.length === 1 ? "it" : "them"} this turn, so the answer cannot rest on ${unseen.length === 1 ? "it" : "them"}).`] : []),
    ...(unconnected.length ? [`Not linked in the records within 4 hops, so not drawn as part of the path (say so in the answer): ${unconnected.map((u) => `${u.from} -> ${u.to}`).join("; ")}.`] : []),
    ...(unchecked.length ? [`Not checked in time, so not drawn as part of the path: ${unchecked.map((u) => `${u.from} -> ${u.to}`).join("; ")}.`] : []),
    ...(!drawn.size && present.length > 1 ? ["None of these records are linked to each other, so there is no path to draw."] : []),
  ];
  return col.result(ctx, {
    ordered: [...col.nodes.keys()], links, unconnected, ...(unchecked.length ? { unchecked } : {}), missing, ...(unseen.length ? { refused: unseen } : {}),
  }, problems.join(" ") || undefined);
}

export const showPath = defineTool({
  name: "show_path",
  description:
    "Call last with the ordered ids of your explanation (2-12), all returned by your tools this turn. Joins each pair by a current edge or a path of at most 4 hops; returns the path for the UI. An id no tool returned, or with no link, is left off and named in the note: say \"not linked in the records\". Example: {\"ids\":[\"decision:007-pause-daily-stories\",\"channel:instagram\",\"system:ig-connector\"]}",
  input: { ids: z.array(z.string()).min(1).max(12).describe("Node ids in explanation order") },
  run: runShowPath,
});
