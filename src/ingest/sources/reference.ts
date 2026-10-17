// General know-how, kept once for every business (src/graph/reference.ts). What it holds: the vendored playbooks (every pack,
// every industry's ad benchmark), their Rules, the reference Events (the Google update timeline) and Documents (the vendored
// files, the ad platforms' policy registries), and Allevia's own SEO checks. Until 17 Oct 2026 onboarding copied all of it
// into each business graph (about 200 Rules and 58 Events each), where it crowded the Brain map.
//
// A business graph keeps only business facts. When something of the business points at a reference node (a Page FAILS an SEO
// check, a Content USES_RULE a hook, an answer CITED a rule) the business graph holds a STUB with the same id: the type, the
// name, a short summary, the kind and severity, and `refStub: true`. The full text stays in the reference graph.
import type { EdgeInput, NodeInput, Prim } from "../../graph/upsert.js";
import type { GraphWrite } from "../types.js";
import { loadPlaybooks } from "./playbooks.js";
import { seoRulesWrite, type SeoReport } from "./website/seo.js";
import { channelNode } from "./channels.js";
import { sha256 } from "../../util/ids.js";

// Every vendored Document id starts with this (entityId("Document", "vendor/playbooks/…")), and every Rule and Event mapped
// from a vendored file has it as its `src`: the source test that also catches nodes of an older pack version.
export const VENDOR_DOC_PREFIX = "document:vendor-playbooks-";

let memo: { write: GraphWrite; ids: Set<string>; edges: Set<string>; byId: Map<string, NodeInput>; hash: string } | undefined;

function build() {
  if (memo) return memo;
  const pb = loadPlaybooks({ tenantSlug: "reference", allIndustries: true }).write;
  const seo = seoRulesWrite();
  const nodes = new Map<string, NodeInput>();
  for (const n of [...pb.nodes, ...seo.nodes]) if (!nodes.has(n.id)) nodes.set(n.id, n);
  const edges = new Map<string, EdgeInput>();
  for (const e of [...pb.edges, ...seo.edges]) edges.set(`${e.from}|${e.type}|${e.to}`, e);
  const write: GraphWrite = { nodes: [...nodes.values()], edges: [...edges.values()], observations: [] };
  // Channel anchors (channel:instagram, channel:website…) are the business's own vocabulary: they stay in every business graph.
  const ids = new Set(write.nodes.filter((n) => n.type !== "Channel").map((n) => n.id));
  memo = { write, ids, edges: new Set(edges.keys()), byId: nodes, hash: sha256(JSON.stringify(write)).slice(0, 16) };
  return memo;
}

// What the reference graph holds (nodes, edges), built from the vendored files: deterministic, no network.
export const referenceWrite = (): GraphWrite => build().write;
// A short hash of it: the reference graph is reloaded only when this changes.
export const referenceHash = (): string => build().hash;
// The ids of the reference nodes (not the Channel anchors).
export const referenceIds = (): ReadonlySet<string> => build().ids;
export const isReferenceId = (id: string): boolean => build().ids.has(id);
// "from|TYPE|to" of every edge the reference write holds: an edge of the copy, not of the business.
export const isReferenceEdge = (from: string, type: string, to: string): boolean => build().edges.has(`${from}|${type}|${to}`);
export const referenceNode = (id: string): NodeInput | undefined => build().byId.get(id);

// The small props a stub keeps: what the business-side reads filter or show (kind and severity for the SEO findings,
// howToFix for the insight that names the fix, the hook id for what worked).
const STUB_PROPS = ["kind", "severity", "weight", "issueType", "category", "hookId", "industry", "howToFix"] as const;
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

// The stub of a reference node for a business graph: same id and type, name, a short summary, the source and date, the light
// props and `refStub: true`. Undefined for an id that is not a reference node.
export function refStubNode(id: string, from?: NodeInput): NodeInput | undefined {
  const n = from ?? referenceNode(id);
  if (!n || n.type === "Channel") return undefined;
  const props: Record<string, Prim> = { refStub: true };
  for (const k of STUB_PROPS) {
    const v = n.props?.[k];
    if (v !== undefined && v !== null) props[k] = typeof v === "string" ? clip(v, 300) : v;
  }
  return {
    type: n.type, id: n.id, name: n.name, ...(n.summary ? { summary: clip(n.summary, 200) } : {}),
    src: n.src ?? "reference", ...(n.asOf ? { asOf: n.asOf } : {}), props,
  };
}

// The SEO audit's FAILS/PASSES point at Rules: a business graph gets stubs of just the rules its own audit used, plus the
// website channel anchor (what the audit's site score MEASURES).
export function seoRuleStubsWrite(report: Pick<SeoReport, "results">): GraphWrite {
  const used = [...new Set(report.results.map((r) => r.ruleId))];
  const nodes = used.map((id) => refStubNode(id)).filter((n): n is NodeInput => !!n);
  return { nodes: [channelNode("website"), ...nodes], edges: [], observations: [] };
}
