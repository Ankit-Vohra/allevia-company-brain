// Static checks over the text of a Cypher query, for tests/graph/cypher-sources.test.ts (every query in src/) and for
// tests/graph/explain.test.ts. They read patterns, not plans: the plans themselves are checked against a real server.
//
//  idAnchorsWithoutEntity: a node looked up by id must carry the `Entity` label, because the id index is on Entity.id and
//    the planner picks an index per label in the pattern. `(d:Document {id:$x})` is a label scan of every Document;
//    `(d:Entity:Document {id:$x})` is an index lookup. Same for `WHERE d.id = $x` / `d.id IN $ids` on a node bound
//    without Entity (a template placeholder `__EXPR__` after the colon is read as a label that might be Entity).
//
//  unguardedEdgeAggregates: FalkorDB 6.0.2 collapses parallel edges between the same two nodes when the relationship is
//    not referenced anywhere in the query: `MATCH (a)-[:R]->(b) RETURN count(b)` is 1 for two R edges, and a bound but
//    unreferenced `-[e:R]->` does the same. Allevia keeps parallel edges on purpose (a fact that ended and was asserted
//    again is two edges), so a count, sum or collect over a traversal must bind the edge and use it:
//    `MATCH (a)-[e:R]->(b) WHERE ID(e) >= 0 RETURN count(b)` (or any test on e, such as e.until IS NULL).
//    Variable-length patterns of two or more hops (they count paths) and patterns inside NOT / EXISTS are not affected and are skipped.

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

interface NodePattern { alias: string; labels: string[]; at: number; hasIdMap: boolean }

function nodePatterns(text: string): NodePattern[] {
  const out: NodePattern[] = [];
  // (alias:Label:Label {id: ...})  /  (:Label)  /  (alias)  /  ({id: ...}); not a function call: the char before `(` is not a word char
  const re = new RegExp(`(?<![\\w\`])\\(\\s*(${IDENT})?((?:\\s*:\\s*(?:${IDENT}|__EXPR__))*)\\s*(\\{[^{}]*\\})?\\s*\\)`, "g");
  for (const m of text.matchAll(re)) {
    const labels = [...(m[2] ?? "").matchAll(/:\s*([A-Za-z_][A-Za-z0-9_]*|__EXPR__)/g)].map((x) => x[1]!);
    out.push({ alias: m[1] ?? "", labels, at: m.index!, hasIdMap: /(^|[{,])\s*id\s*:/.test(m[3] ?? "") });
  }
  return out;
}

const labelOk = (labels: string[]): boolean => labels.includes("Entity") || labels.includes("__EXPR__");

export function idAnchorsWithoutEntity(text: string): string[] {
  const found: string[] = [];
  const nodes = nodePatterns(text);
  for (const n of nodes) {
    if (n.hasIdMap && !labelOk(n.labels)) found.push(`(${n.alias}${n.labels.map((l) => `:${l}`).join("")} {id: …}) has no Entity label`);
  }
  // WHERE alias.id = / IN / > ...: the alias must carry Entity in at least one of its patterns
  const aliases = new Set(nodes.filter((n) => n.alias).map((n) => n.alias));
  for (const alias of aliases) {
    if (!new RegExp(`(?<![\\w.])${alias}\\.id\\s*(?:=|<=|>=|<(?!>)|>|\\bIN\\b)`).test(text)) continue;
    const mine = nodes.filter((n) => n.alias === alias);
    if (!mine.some((n) => labelOk(n.labels))) found.push(`${alias}.id is compared but ${alias} is bound without an Entity label (${mine.map((n) => `(${alias}${n.labels.map((l) => `:${l}`).join("")})`).join(", ")})`);
  }
  return found;
}

// The node patterns of a query that look a node up by id: `(alias:… {id: …})`, or an alias that WHERE compares by id
// (`alias.id = $x`, `IN $ids`, a range on it). One entry per pattern, "" for an anonymous node.
export function idAnchors(text: string): string[] {
  const nodes = nodePatterns(text);
  const out = nodes.filter((n) => n.hasIdMap).map((n) => n.alias);
  for (const alias of new Set(nodes.filter((n) => n.alias).map((n) => n.alias))) {
    if (new RegExp(`(?<![\\w.])${alias}\\.id\\s*(?:=|<=|>=|<(?!>)|>|\\bIN\\b)`).test(text) && !out.includes(alias)) out.push(alias);
  }
  return out;
}

// Aggregates that see how many times a row repeats. count(DISTINCT x) and collect(DISTINCT x) do not (a collapsed
// parallel edge changes nothing), and min/max do not either.
const AGGREGATE = /\b(?:count|collect|sum|avg)\s*\(\s*(?!DISTINCT\b)/i;

// `*1..1`, `*1`, `*..1`, `*0..1`: a variable-length pattern that can only take one hop. A bound that is not a literal
// (`*1..__EXPR__`) is not judged.
function singleHop(body: string): boolean {
  const m = /\*\s*(\d*)\s*(\.\.\s*(\d*))?/.exec(body);
  if (!m) return false;
  const max = m[2] === undefined ? m[1] : m[3];
  return max === "1";
}

// The relationship patterns of a query that are exposed: no alias, or an alias nothing else in the text uses; and only those
// that come before the last count/sum/collect (a pattern after it is matched once its rows are already counted).
export function unguardedEdgeAggregates(text: string): string[] {
  const lastAggregate = Math.max(-1, ...[...text.matchAll(new RegExp(AGGREGATE.source, "gi"))].map((m) => m.index!));
  if (lastAggregate < 0) return [];
  const found: string[] = [];
  // `-[...]-`, `-[...]->`, `<-[...]-`, and the bare `--` / `-->` / `<--` forms
  const re = /(<?)-\s*(?:\[([^\]]*)\])?\s*-(>?)/g;
  for (const m of text.matchAll(re)) {
    const body = m[2];
    const at = m.index!;
    if (at > lastAggregate) continue;
    if (m[0] === "--" && /\w\s*$/.test(text.slice(Math.max(0, at - 1), at))) continue; // `x--y`, not a pattern
    // variable length: each path counts, except a single hop (`*1..1`, `*1`), which the server plans like a plain edge
    if (body !== undefined && body.includes("*") && !singleHop(body)) continue;
    const before = text.slice(Math.max(0, at - 120), at);
    // a pattern inside NOT ( … ) or EXISTS( … ) only asks whether an edge exists
    if (/(?:\bNOT\s*|\bEXISTS?\s*\()\(?\s*\([^)]*\)\s*$/i.test(before)) continue;
    const alias = body === undefined ? "" : (new RegExp(`^\\s*(${IDENT})\\s*(?::|\\{|$)`).exec(body)?.[1] ?? "");
    if (!alias) { found.push(`unbound relationship ${m[0].trim()}`); continue; }
    if (text.includes("__EXPR__")) continue; // a template placeholder may be the reference (edgeAt("r"), currentEdge("r"))
    const uses = text.match(new RegExp(`(?<![\\w.])${alias}(?![\\w])`, "g"))?.length ?? 0;
    if (uses < 2) found.push(`relationship ${alias} is bound but never referenced`);
  }
  return found;
}

// A node created with CREATE must carry its id in the pattern: FalkorDB Cloud (4.22) enforces the mandatory
// Entity.id constraint when the node is created, before any later `SET n += $props` runs ("mandatory constraint
// violation: node with label Entity missing property id"). Local 6.0.x checks at the end of the query, so only a text
// check catches it before it reaches the cloud. `CREATE (n:Entity) DELETE n` (the migration's probe) is not a node
// that stays, and MERGE with an id is fine.
export function entityCreateWithoutId(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\bCREATE\s+(?:\([^()]*\)\s*(?:<?-\s*\[[^\]]*\]\s*-\s*>?\s*))*(\(\s*[A-Za-z_]\w*?\s*((?::\s*\w+\s*)+)(\{[^{}]*\})?\s*\))/g)) {
    const labels = m[2] ?? "";
    if (!/:\s*Entity\b/.test(labels)) continue;
    if (/(^|[{,])\s*id\s*:/.test(m[3] ?? "")) continue;
    if (/\bDELETE\b/.test(text.slice(m.index!))) continue;
    found.push(`CREATE ${m[1]} has no id in its pattern`);
  }
  return found;
}
