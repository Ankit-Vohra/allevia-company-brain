// The librarian's merge pass (spec §6.4: an ambiguous mention is created, not merged; the librarian decides later).
// System, Channel and Product nodes that name the same thing become one, so impact_of and who_owns see one node with all
// its edges. Eval 2026-10-15 (ig-token-impact): the Instagram connector was two nodes (the registry's system:instagram
// and extraction's "Instagram API with Instagram Login") and its token two more ("IG token", "Instagram API token").
//
// Conservative:
// - same type only, never across types; simulated and real nodes never merge;
// - two nodes are the same when their names are equal, or the name of one is an alias of the other and the names agree
//   (sameThing), after normName and a few abbreviations (IG -> Instagram, FB, YT, WA). File names and paths ("ig-token.ts")
//   name a script, not the thing, and never match;
// - a group holding two registry entries is left alone (the registry lists distinct things), as is a group over
//   MAX_GROUP nodes, and a pair the owner unmerged (notSameAs);
// - the canonical node is the registry's, else the one with the most current edges, else the shorter id.
// Reversible: the duplicate keeps its own id and history. It gets (dup)-[:SAME_AS]->(canonical) and `mergedInto`; each
// of its current edges is re-asserted on the canonical node (props.mergedFrom = the duplicate) and closed on the
// duplicate ("merged into <id>"); the canonical node learns its names as aliases (recorded on the SAME_AS edge).
// unmerge() undoes all of it. History stays where it was: what a Turn TOUCHED or CITED, Versions, and the KNOWS_ABOUT the
// librarian derives (re-derived from the moved MENTIONS on the same run).
//
// Credentials: a System named "<connector> token|key|credentials" (after the qualifiers api/access/auth/login) is what
// that connector authenticates with, so the connector DEPENDS_ON it: when the token expires, everything that depends on
// the connector breaks too (impact_of follows DEPENDS_ON). Only when exactly one connector matches (a registry one wins).
// The edge is derivedBy 'librarian' (basis 'credential') and closed when it is no longer derived.
import type { GraphHandle } from "../graph/client.js";
import { MAX_PAGE } from "../graph/client.js";
import { EDGE_META_PROPS, typeOfLabels, type EntityType, type RelType } from "../graph/schema.js";
import { closeEdge, upsertEdge, type Prim } from "../graph/upsert.js";
import { noteGraphWrite } from "../graph/projection.js";
import { namesAgree, normName } from "./resolve-names.js";

export const MERGE_TYPES: readonly EntityType[] = ["System", "Channel", "Product"];
export const MAX_GROUP = 5;
const MAX_ALIASES = 12;
// Edges that record history rather than state what the thing is: they stay on the duplicate.
export const HISTORY_RELS: readonly RelType[] = ["SAME_AS", "TOUCHED", "CITED", "HAD_VERSION", "ASKED", "IN_SESSION", "HANDLED_BY", "REVIEWED"];
const ABBREVIATIONS: Record<string, string> = { ig: "instagram", insta: "instagram", fb: "facebook", yt: "youtube", wa: "whatsapp" };
const PATH_LIKE = /[\\/]|\.(?:ts|js|mjs|cjs|py|sh|ya?ml|json|md|txt|env)$/i;
const CREDENTIAL_WORDS = new Set(["token", "tokens", "key", "keys", "credential", "credentials", "secret"]);
const CREDENTIAL_QUALIFIERS = new Set(["api", "access", "auth", "oauth", "login", "bearer", "refresh", "long", "lived", "app"]);
const MERGED_REASON = (canonical: string) => `merged into ${canonical}`;

export interface MergeNode {
  id: string;
  type: EntityType;
  name: string;
  aliases: string[];
  registry: boolean;       // SOURCED_FROM a registry file
  degree: number;          // current edges, history aside
  simulated?: boolean;
  notSameAs?: string[];    // ids the owner said it is not (unmerge)
}

export interface MergeGroup { type: EntityType; canonical: string; members: Array<{ id: string; key: string }> }
export interface CredentialLink { connector: string; credential: string; key: string }
export interface MergePlan { groups: MergeGroup[]; links: CredentialLink[]; skipped: Array<{ ids: string[]; why: string }> }

// ---------- names ----------

// One normalised key for a name: normName, abbreviations spelled out. Undefined for a file name or path.
export function nameKey(name: string): string | undefined {
  if (PATH_LIKE.test(name.trim())) return undefined;
  const n = normName(name);
  if (!n) return undefined;
  return n.split(" ").map((t) => ABBREVIATIONS[t] ?? t).join(" ");
}

export function nameKeys(n: Pick<MergeNode, "name" | "aliases">): string[] {
  return [...new Set([n.name, ...n.aliases].map(nameKey).filter((k): k is string => !!k))];
}

// "instagram api token" -> "instagram"; undefined when the name does not end in a credential word.
export function credentialBase(key: string): string | undefined {
  const ts = key.split(" ");
  if (!CREDENTIAL_WORDS.has(ts.at(-1) ?? "")) return undefined;
  ts.pop();
  while (ts.length && CREDENTIAL_QUALIFIERS.has(ts.at(-1)!)) ts.pop();
  return ts.length ? ts.join(" ") : undefined;
}

// The names a connector answers to: its keys, and the part of a name before a parenthesis ("Instagram (API with
// Instagram Login)" is Instagram).
function connectorKeys(n: MergeNode): string[] {
  const outside = [n.name, ...n.aliases].map((s) => s.replace(/\s*\([^)]*\)\s*/g, " ").trim()).map(nameKey).filter((k): k is string => !!k);
  return [...new Set([...nameKeys(n), ...outside])];
}

// ---------- planning (pure) ----------

// Do two nodes sharing the key `k` name the same thing? Their names are equal; or one's name is the other's alias, the
// key has two words or more, and the names agree as the resolver's names do (same words, an acronym, or one extends
// the other by a word: "IG token" / "Instagram API token"). Two aliases alone never do: extraction's aliases are
// noisy (a cron listed "insights cron" among its aliases; "Google" was an alias of both Google Search and Google Ads).
export function sameThing(x: Pick<MergeNode, "name">, y: Pick<MergeNode, "name">, k: string): boolean {
  const [a, b] = [nameKey(x.name), nameKey(y.name)];
  if (!a || !b) return false;
  if (a === b) return true;
  return (a === k || b === k) && k.split(" ").length >= 2 && namesAgree([a], [b]);
}

export function planMerges(nodes: readonly MergeNode[]): MergePlan {
  const groups: MergeGroup[] = [];
  const skipped: MergePlan["skipped"] = [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  for (const type of MERGE_TYPES) {
    const of = nodes.filter((n) => n.type === type).sort((a, b) => (a.id < b.id ? -1 : 1));
    // union-find over shared keys
    const parent = new Map(of.map((n) => [n.id, n.id] as const));
    const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(x, r); return r; };
    const keyOf = new Map<string, string>(); // member -> the key that joined it
    const withKey = new Map<string, MergeNode[]>();
    for (const n of of) for (const k of nameKeys(n)) withKey.set(k, [...(withKey.get(k) ?? []), n]);
    for (const [k, list] of withKey) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [x, y] = [list[i]!, list[j]!];
          if (!sameThing(x, y, k)) continue;
          const [a, b] = [find(x.id), find(y.id)];
          if (a === b) continue;
          parent.set(b < a ? a : b, b < a ? b : a);
          keyOf.set(y.id, keyOf.get(y.id) ?? k);
          keyOf.set(x.id, keyOf.get(x.id) ?? k);
        }
      }
    }
    const sets = new Map<string, MergeNode[]>();
    for (const n of of) { const r = find(n.id); sets.set(r, [...(sets.get(r) ?? []), n]); }
    for (const set of sets.values()) {
      if (set.length < 2) continue;
      const ids = set.map((n) => n.id);
      if (set.length > MAX_GROUP) { skipped.push({ ids, why: `more than ${MAX_GROUP} nodes share a name` }); continue; }
      if (set.filter((n) => n.registry).length > 1) { skipped.push({ ids, why: "two registry entries: the registry lists distinct things" }); continue; }
      if (new Set(set.map((n) => n.simulated === true)).size > 1) { skipped.push({ ids, why: "simulated and real nodes never merge" }); continue; }
      // the registry's entry; else a name written out in full ("Instagram API token" over "IG token"); else the most
      // connected; else the shorter id
      const abbreviated = (n: MergeNode) => Number(nameKey(n.name) !== normName(n.name));
      const canonical = [...set].sort((a, b) => Number(b.registry) - Number(a.registry) || abbreviated(a) - abbreviated(b) ||
        b.degree - a.degree || a.id.length - b.id.length || (a.id < b.id ? -1 : 1))[0]!;
      // a pair the owner unmerged stays apart: that member leaves the group
      const members = set.filter((n) => n.id !== canonical.id)
        .filter((n) => !n.notSameAs?.includes(canonical.id) && !canonical.notSameAs?.includes(n.id));
      if (!members.length) continue;
      const keys = new Set(nameKeys(canonical));
      groups.push({
        type, canonical: canonical.id,
        members: members.map((n) => ({ id: n.id, key: nameKeys(n).find((k) => keys.has(k)) ?? keyOf.get(n.id) ?? nameKeys(n)[0] ?? "" })),
      });
    }
  }

  // credentials -> the one connector they unlock (after the merges above: canonical nodes, with their group's names)
  const merged = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const withGroup = (n: MergeNode): MergeNode[] => [n, ...(groups.find((g) => g.canonical === n.id)?.members.map((m) => byId.get(m.id)!) ?? [])];
  const systems = nodes.filter((n) => n.type === "System" && !merged.has(n.id));
  const isCredential = (n: MergeNode) => withGroup(n).some((x) => nameKeys(x).some((k) => credentialBase(k) !== undefined));
  const connectors = systems.filter((n) => !isCredential(n)).map((n) => ({ n, keys: new Set(withGroup(n).flatMap(connectorKeys)) }));
  const links: CredentialLink[] = [];
  for (const c of systems.filter(isCredential)) {
    const bases = new Set(withGroup(c).flatMap((n) => nameKeys(n)).map(credentialBase).filter((b): b is string => !!b));
    const hits = connectors.filter((s) => s.n.id !== c.id && [...bases].some((b) => s.keys.has(b)));
    const reg = hits.filter((s) => s.n.registry);
    const pick = reg.length === 1 ? reg[0] : hits.length === 1 ? hits[0] : undefined;
    if (pick) links.push({ connector: pick.n.id, credential: c.id, key: [...bases].find((b) => pick.keys.has(b))! });
    else if (hits.length > 1) skipped.push({ ids: [c.id, ...hits.map((h) => h.n.id)], why: "a credential that matches more than one connector" });
  }
  return { groups, links, skipped };
}

// ---------- reading the graph ----------

export async function loadMergeNodes(g: Pick<GraphHandle, "roQuery">): Promise<MergeNode[]> {
  const labels = MERGE_TYPES.map((t) => `n:${t}`).join(" OR ");
  // Two reads: FalkorDB 6 miscounts a second pattern count in the same projection (seen 2026-10-15).
  const registry = new Set((await g.roQuery<{ id: string }>(
    `MATCH (n:Entity)-[s:SOURCED_FROM]->(d:Document) WHERE (${labels}) AND s.until IS NULL AND d.kind = 'registry' RETURN DISTINCT n.id AS id ORDER BY id`))
    .map((r) => r.id));
  const out: MergeNode[] = [];
  for (let after = ""; ;) {
    const rows = await g.roQuery<{ id: string; labels: string[]; name: string | null; aliases: unknown; simulated: boolean | null; notSameAs: unknown; degree: number }>(
      `MATCH (n:Entity) WHERE n.id > $after AND (${labels})
       WITH n ORDER BY n.id LIMIT $lim
       OPTIONAL MATCH (n)-[r]-(:Entity) WHERE r.until IS NULL AND NOT type(r) IN $history
       WITH n, count(r) AS degree
       RETURN n.id AS id, labels(n) AS labels, n.name AS name, n.aliases AS aliases, n.simulated AS simulated, n.notSameAs AS notSameAs, degree
       ORDER BY id`,
      { after, lim: MAX_PAGE, history: [...HISTORY_RELS] });
    for (const r of rows) {
      const type = typeOfLabels(r.labels);
      if (!type || !r.name) continue;
      const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      out.push({
        id: r.id, type, name: r.name, aliases: strs(r.aliases), registry: registry.has(r.id), degree: r.degree,
        ...(r.simulated === true ? { simulated: true } : {}), ...(strs(r.notSameAs).length ? { notSameAs: strs(r.notSameAs) } : {}),
      });
    }
    if (rows.length < MAX_PAGE) return out;
    after = rows[rows.length - 1]!.id;
  }
}

// ---------- writing ----------

export interface MergeReport {
  groups: number;
  merged: number;           // duplicates pointing at a canonical node
  edgesMoved: number;
  credentialLinks: number;
  linksClosed: number;
  skipped: MergePlan["skipped"];
  errors: string[];
}

const EDGE_META = new Set<string>(EDGE_META_PROPS);
const prim = (v: unknown): v is Prim =>
  v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ||
  (Array.isArray(v) && (v.every((x) => typeof x === "string") || v.every((x) => typeof x === "number")));

interface EdgeRow { dir: "out" | "in"; type: RelType; other: string; p: Record<string, unknown> }

// Moves `dup`'s current edges onto `canonical` and closes them on `dup`. Returns how many it moved.
async function moveEdges(g: GraphHandle, dup: string, canonical: string, group: ReadonlySet<string>, now: number): Promise<number> {
  const rows = await g.roQuery<EdgeRow>(
    `MATCH (d:Entity {id:$dup})-[r]->(x:Entity) WHERE r.until IS NULL AND NOT type(r) IN $history AND NOT (type(r) = 'KNOWS_ABOUT' AND r.derivedBy = 'librarian')
     RETURN 'out' AS dir, type(r) AS type, x.id AS other, properties(r) AS p
     UNION ALL
     MATCH (x:Entity)-[r]->(d:Entity {id:$dup}) WHERE r.until IS NULL AND NOT type(r) IN $history AND NOT (type(r) = 'KNOWS_ABOUT' AND r.derivedBy = 'librarian')
     RETURN 'in' AS dir, type(r) AS type, x.id AS other, properties(r) AS p`,
    { dup, history: [...HISTORY_RELS] });
  // What the canonical node already states is left as it is (re-asserting it would stamp mergedFrom on its own edge).
  const has = new Set((await g.roQuery<{ k: string }>(
    `MATCH (c:Entity {id:$c})-[r]->(x:Entity) WHERE r.until IS NULL RETURN 'out|' + type(r) + '|' + x.id AS k
     UNION ALL
     MATCH (x:Entity)-[r]->(c:Entity {id:$c}) WHERE r.until IS NULL RETURN 'in|' + type(r) + '|' + x.id AS k`, { c: canonical })).map((r) => r.k));
  let moved = 0;
  for (const r of rows.sort((a, b) => `${a.dir}${a.type}${a.other}`.localeCompare(`${b.dir}${b.type}${b.other}`))) {
    const [from, to] = r.dir === "out" ? [dup, r.other] : [r.other, dup];
    if (!group.has(r.other) && !has.has(`${r.dir}|${r.type}|${r.other}`)) {
      const props: Record<string, Prim> = {};
      for (const [k, v] of Object.entries(r.p)) if (!EDGE_META.has(k) && prim(v)) props[k] = v;
      props.mergedFrom = dup;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      await upsertEdge(g, {
        from: r.dir === "out" ? canonical : r.other, type: r.type, to: r.dir === "out" ? r.other : canonical, props,
        ...(num(r.p.since) !== undefined ? { since: num(r.p.since)! } : {}), ...(str(r.p.src) ? { src: str(r.p.src)! } : {}),
        ...(str(r.p.asOf) ? { asOf: str(r.p.asOf)! } : {}), ...(num(r.p.conf) !== undefined ? { conf: num(r.p.conf)! } : {}),
      }, now);
      moved++;
    }
    await closeEdge(g, from, r.type, to, now, MERGED_REASON(canonical));
  }
  return moved;
}

export async function applyMergePlan(g: GraphHandle, plan: MergePlan, now: number = Date.now()): Promise<MergeReport> {
  const report: MergeReport = { groups: plan.groups.length, merged: 0, edgesMoved: 0, credentialLinks: 0, linksClosed: 0, skipped: plan.skipped, errors: [] };
  for (const grp of plan.groups) {
    const ids = new Set([grp.canonical, ...grp.members.map((m) => m.id)]);
    for (const m of grp.members) {
      try {
        // the canonical node learns the duplicate's names (what was added is kept on SAME_AS, for unmerge)
        const [row] = await g.roQuery<{ cn: string; ca: unknown; dn: string; da: unknown; added: unknown }>(
          `MATCH (c:Entity {id:$c}), (d:Entity {id:$d}) OPTIONAL MATCH (d)-[s:SAME_AS]->(c) WHERE s.until IS NULL
           RETURN c.name AS cn, c.aliases AS ca, d.name AS dn, d.aliases AS da, s.aliasesAdded AS added`, { c: grp.canonical, d: m.id });
        if (!row) continue;
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        const have = [row.cn, ...strs(row.ca)];
        const fresh: string[] = [];
        for (const a of [row.dn, ...strs(row.da)]) {
          if (PATH_LIKE.test(a) || [...have, ...fresh].some((h) => normName(h) === normName(a))) continue;
          if (strs(row.ca).length + fresh.length >= MAX_ALIASES) break;
          fresh.push(a);
        }
        if (fresh.length) await g.query("MATCH (c:Entity {id:$c}) SET c.aliases = $aliases", { c: grp.canonical, aliases: [...strs(row.ca), ...fresh] });
        const added = [...new Set([...strs(row.added), ...fresh])];
        await upsertEdge(g, {
          from: m.id, type: "SAME_AS", to: grp.canonical,
          props: { derivedBy: "librarian", basis: m.key ? `same name: ${m.key}` : "same name", ...(added.length ? { aliasesAdded: added } : {}) },
        }, now);
        await g.query("MATCH (d:Entity {id:$d}) SET d.mergedInto = $c", { d: m.id, c: grp.canonical });
        report.edgesMoved += await moveEdges(g, m.id, grp.canonical, ids, now);
        report.merged++;
      } catch (e) {
        report.errors.push(`${m.id} -> ${grp.canonical}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // credential links: write the planned ones, close the ones derived earlier and no longer planned
  const want = new Set(plan.links.map((l) => `${l.connector}|${l.credential}`));
  for (const l of plan.links) {
    try {
      const r = await upsertEdge(g, { from: l.connector, type: "DEPENDS_ON", to: l.credential, props: { derivedBy: "librarian", basis: "credential", key: l.key } }, now);
      if (r.created) report.credentialLinks++;
    } catch (e) {
      report.errors.push(`${l.connector} DEPENDS_ON ${l.credential}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const derived = await g.roQuery<{ a: string; b: string }>(
    "MATCH (a:System)-[r:DEPENDS_ON]->(b:System) WHERE r.until IS NULL AND r.derivedBy = 'librarian' AND r.basis = 'credential' RETURN a.id AS a, b.id AS b ORDER BY a, b");
  for (const d of derived) {
    if (!want.has(`${d.a}|${d.b}`)) report.linksClosed += await closeEdge(g, d.a, "DEPENDS_ON", d.b, now, "no longer derived");
  }
  await noteGraphWrite(g.name);
  return report;
}

export async function mergeDuplicates(g: GraphHandle, now: number = Date.now()): Promise<MergeReport> {
  return applyMergePlan(g, planMerges(await loadMergeNodes(g)), now);
}

// ---------- undo ----------

// Undoes a merge: SAME_AS and mergedInto go, the edges moved onto the canonical node close there and reopen on the
// duplicate, the aliases it gave the canonical node are taken back, and the pair is marked notSameAs so the next
// librarian run leaves it apart. Returns the canonical id it was merged into, or undefined when it was not merged.
export async function unmerge(g: GraphHandle, dup: string, now: number = Date.now()): Promise<string | undefined> {
  const [s] = await g.roQuery<{ c: string; added: unknown }>(
    "MATCH (:Entity {id:$d})-[s:SAME_AS]->(c:Entity) WHERE s.until IS NULL RETURN c.id AS c, s.aliasesAdded AS added", { d: dup });
  if (!s) return undefined;
  const c = s.c;
  await closeEdge(g, dup, "SAME_AS", c, now, "unmerged");
  const moved = await g.roQuery<{ dir: string; type: RelType; other: string }>(
    `MATCH (c:Entity {id:$c})-[r]->(x:Entity) WHERE r.until IS NULL AND r.mergedFrom = $d RETURN 'out' AS dir, type(r) AS type, x.id AS other
     UNION ALL
     MATCH (x:Entity)-[r]->(c:Entity {id:$c}) WHERE r.until IS NULL AND r.mergedFrom = $d RETURN 'in' AS dir, type(r) AS type, x.id AS other`, { c, d: dup });
  for (const m of moved) await closeEdge(g, m.dir === "out" ? c : m.other, m.type, m.dir === "out" ? m.other : c, now, "unmerged");
  await g.query(
    `MATCH (d:Entity {id:$d})-[r]-(:Entity) WHERE r.closeReason = $reason
     SET r.until = null, r.retiredAt = null, r.retiredAsOfMs = null, r.closedCost = null, r.closeReason = null`,
    { d: dup, reason: MERGED_REASON(c) });
  const added = Array.isArray(s.added) ? s.added.filter((x): x is string => typeof x === "string") : [];
  await g.query(
    `MATCH (c:Entity {id:$c}), (d:Entity {id:$d})
     SET c.aliases = [a IN coalesce(c.aliases, []) WHERE NOT a IN $added], d.mergedInto = null,
         d.notSameAs = [x IN coalesce(d.notSameAs, []) WHERE x <> $c] + [$c]`,
    { c, d: dup, added });
  await noteGraphWrite(g.name);
  return c;
}
