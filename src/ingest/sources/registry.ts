// Registry mapper (spec 6.2): the vault's registry/{agents,departments,tools,connectors}/*.yaml becomes Agent, Team and
// System nodes, MEMBER_OF and DEPENDS_ON edges, and one Document per file. Deterministic: no LLM.
//
// Shapes seen in the real registry (names only, by design of the registry itself):
//   agents       id, name, department, kind, status, does, trigger, schedule, model, tools[], connectors[], reports_to,
//                delegates_to[], uses_agents[], replaced_by, retired_on, unverified, notes, plus host/path/docs/source…
//   departments  id, name, purpose, lead_agent, acting_lead, agents: {active|paused|retired|planned: [ids]} (or a list)
//   tools        id, name, type, status, purpose, used_by[], connectors[], schedule, runs_on, notes, …
//   connectors   id, name, purpose, status, status_how, last_verified, used_by[], credential_env_names[], credential_location[]…
//
// Only an allow-list of keys is read, so a key added to the registry tomorrow cannot leak through. Hosts, paths, ids of
// the underlying infrastructure, credential names and locations are never copied. Every string that is kept goes through
// `redact`. A reference to an id that is unknown, denied by the path policy, or reserved is dropped and counted.
//
// The registry never states who OWNS what, and the ontology has no "agent uses system" relation. So agent -> tool and
// agent -> connector links are kept as list props (`tools`, `connectors`, `usedByAgents`), and become edges only when the
// caller names a relation in ctx.agentSystemRel (e.g. KNOWS_ABOUT today, USES once the schema has it).
import { parse as parseYaml } from "yaml";
import type { EdgeInput, NodeInput, Prim } from "../../graph/upsert.js";
import { isAllowed, type EntityType, type RelType } from "../../graph/schema.js";
import type { SourceResult } from "../types.js";
import { entityId, sha256 } from "../../util/ids.js";
import { SENSITIVE, pathAllowed } from "../privacy.js";
import { redact } from "../redact.js";
import { isReservedId } from "../actors.js";

type Kind = "agent" | "team" | "tool" | "connector";
const FOLDERS: Record<string, Kind> = { agents: "agent", departments: "team", tools: "tool", connectors: "connector" };
const TYPE_OF: Record<Kind, EntityType> = { agent: "Agent", team: "Team", tool: "System", connector: "System" };
const NON_NODE_ACTORS = new Set(["founder"]); // legitimate in reports_to / used_by / lead_agent, never a registry entry

export interface RegistryCtx {
  asOf: string;
  agentSystemRel?: RelType;
}

interface Entry { kind: Kind; id: string; y: Record<string, unknown>; path: string; docId: string; nodeId: string }

const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function mapRegistry(files: Array<{ path: string; text: string }>, ctx: RegistryCtx): SourceResult {
  const skipped: SourceResult["skipped"] = [];
  const redactions: Record<string, number> = {};
  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];

  // ---- clean strings: collapse whitespace, redact (counting), cap the length ----
  const clean = (v: unknown, max = 300): string | undefined => {
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return undefined;
    const r = redact(String(v).replace(/\s+/g, " ").trim());
    for (const [k, n] of Object.entries(r.counts)) redactions[k] = (redactions[k] ?? 0) + n;
    const t = r.text.length > max ? `${r.text.slice(0, max - 1).replace(/\s+\S*$/, "")}…` : r.text;
    return t || undefined;
  };
  // Free-text commentary is the one registry field that can talk about credentials or infrastructure, so a note that
  // matches the sensitive-name pattern is dropped whole (the same rule the path and section policies apply).
  const note = (v: unknown): string | undefined => {
    const t = clean(v, 400);
    return t && !SENSITIVE.test(t) ? t : undefined;
  };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v])
    .filter((x): x is string | number => typeof x === "string" || typeof x === "number").map((x) => String(x).trim()).filter(Boolean);
  const idsIn = (v: unknown): string[] => (isMap(v) ? Object.values(v).flatMap(list) : list(v));

  // ---- 1. read and classify the files ----
  const entries: Entry[] = [];
  const taken = new Set<string>();
  const sorted = files.map((f) => {
    const rel = f.path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^registry\//, "");
    return { rel, path: `registry/${rel}`, text: f.text };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  for (const f of sorted) {
    const skip = (reason: string) => skipped.push({ ref: f.path, reason });
    const verdict = pathAllowed(f.path);
    if (!verdict.allowed) { skip(verdict.reason); continue; }
    if (!/\.ya?ml$/i.test(f.rel)) { skip("not a registry yaml file"); continue; }
    const kind = FOLDERS[f.rel.split("/")[0]!];
    if (!kind || !f.rel.includes("/")) { skip("not in a registry folder (agents, departments, tools, connectors)"); continue; }

    let y: unknown;
    try {
      y = parseYaml(f.text.slice(0, 500_000), { uniqueKeys: false });
    } catch (e) {
      const code = (e as { code?: string }).code;
      skip(`invalid yaml${code ? ` (${code})` : ""}`);
      continue;
    }
    if (!isMap(y)) { skip("not a YAML mapping"); continue; }

    const rawId = typeof y.id === "string" || typeof y.id === "number" ? String(y.id).trim() : "";
    const id = rawId || (f.rel.split("/").pop() ?? "").replace(/\.ya?ml$/i, "");
    if (!id) { skip("no id"); continue; }
    const type = TYPE_OF[kind];
    const nodeId = entityId(type, id);
    if (isReservedId(nodeId)) { skip("reserved id (Allevia's own staff namespace)"); continue; }
    if (taken.has(nodeId)) { skip("duplicate id"); continue; }
    taken.add(nodeId);
    entries.push({ kind, id, y, path: f.path, docId: entityId("Document", f.path), nodeId });

    nodes.push({
      type: "Document", id: entityId("Document", f.path), name: f.path,
      props: { kind: "registry", path: f.path, hash: sha256(redact(f.text).text) }, asOf: ctx.asOf,
    });
  }

  const byKind = (...ks: Kind[]) => new Map(entries.filter((e) => ks.includes(e.kind)).map((e) => [e.id, e]));
  const agents = byKind("agent");
  const teams = byKind("team");
  const systems = byKind("tool", "connector");

  // ---- unresolved references, reported once per file without echoing the values ----
  const unresolved = new Map<string, Map<string, number>>();
  const drop = (e: Entry, field: string) => {
    const m = unresolved.get(e.path) ?? new Map<string, number>();
    m.set(field, (m.get(field) ?? 0) + 1);
    unresolved.set(e.path, m);
  };
  const resolve = (e: Entry, field: string, ids: string[], known: Map<string, Entry>, allowActors = false): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      if (known.has(id)) out.push(id);
      else if (!(allowActors && NON_NODE_ACTORS.has(id))) drop(e, field);
    }
    return [...new Set(out)];
  };

  // ---- 2. nodes ----
  const put = (props: Record<string, Prim | undefined>): Record<string, Prim> =>
    Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0))) as Record<string, Prim>;
  const status = (v: unknown): string | undefined => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 40) || undefined : undefined);

  for (const e of entries) {
    const y = e.y;
    const base = { src: e.docId, asOf: ctx.asOf };
    const name = clean(y.name, 120) ?? e.id;
    if (e.kind === "agent") {
      const reportsTo = list(y.reports_to)[0];
      nodes.push({
        type: "Agent", id: e.nodeId, name, summary: clean(y.does ?? y.purpose, 500), ...base,
        props: put({
          kind: clean(y.kind, 60), status: status(y.status), department: clean(y.department, 60), model: clean(y.model, 60),
          schedule: clean(y.schedule, 100), repo: clean(y.repo, 80), trigger: clean(y.trigger, 200),
          reportsTo: reportsTo && (NON_NODE_ACTORS.has(reportsTo) || agents.has(reportsTo)) ? reportsTo : undefined,
          unverified: y.unverified === true ? true : undefined, retiredOn: clean(y.retired_on, 20),
          replacedBy: resolve(e, "replaced_by", list(y.replaced_by), agents)[0],
          delegatesTo: resolve(e, "delegates_to", list(y.delegates_to), agents),
          usesAgents: resolve(e, "uses_agents", list(y.uses_agents), agents),
          tools: resolve(e, "tools", list(y.tools), systems), connectors: resolve(e, "connectors", list(y.connectors), systems),
          notes: note(y.notes),
        }),
      });
      if (reportsTo && !NON_NODE_ACTORS.has(reportsTo) && !agents.has(reportsTo)) drop(e, "reports_to");
    } else if (e.kind === "team") {
      nodes.push({
        type: "Team", id: e.nodeId, name, summary: clean(y.purpose, 500), ...base,
        props: put({ leadAgent: clean(y.lead_agent, 60), actingLead: clean(y.acting_lead, 120) }),
      });
    } else {
      nodes.push({
        type: "System", id: e.nodeId, name, summary: clean(y.purpose ?? y.does, 500), ...base,
        props: put({
          kind: e.kind, toolType: clean(y.type, 40), status: status(y.status), repo: clean(y.repo, 80), schedule: clean(y.schedule, 100),
          unverified: y.unverified === true ? true : undefined, lastVerified: clean(y.last_verified, 60),
          usedByAgents: list(y.used_by).filter((u) => agents.has(u)), notes: note(y.notes),
        }),
      });
    }
    edges.push({ from: e.nodeId, type: "SOURCED_FROM", to: e.docId, src: e.docId, asOf: ctx.asOf });
  }

  // ---- 3. edges (deduplicated; the first file to state a fact is its source) ----
  const seen = new Set<string>();
  const types = new Map(entries.map((e) => [e.nodeId, TYPE_OF[e.kind]]));
  const link = (from: Entry, rel: RelType, to: Entry, src: Entry, props?: Record<string, Prim>): boolean => {
    if (from.nodeId === to.nodeId) return false;
    const key = `${from.nodeId}|${rel}|${to.nodeId}`;
    if (seen.has(key)) return true;
    if (!isAllowed(types.get(from.nodeId)!, rel, types.get(to.nodeId)!)) return false;
    seen.add(key);
    edges.push({ from: from.nodeId, type: rel, to: to.nodeId, ...(props ? { props } : {}), src: src.docId, asOf: ctx.asOf });
    return true;
  };

  // MEMBER_OF: an agent's `department`, a department's `agents` lists, and its lead (marked role: lead)
  const members = new Map<string, { a: Entry; t: Entry; src: Entry; lead: boolean }>();
  const member = (a: Entry, t: Entry, src: Entry, lead = false) => {
    const key = `${a.nodeId}|${t.nodeId}`;
    const m = members.get(key);
    if (m) m.lead ||= lead; else members.set(key, { a, t, src, lead });
  };
  for (const a of agents.values()) {
    const dept = typeof a.y.department === "string" ? a.y.department.trim() : "";
    if (!dept) continue;
    const t = teams.get(dept);
    if (t) member(a, t, a); else drop(a, "department");
  }
  for (const t of teams.values()) {
    for (const id of resolve(t, "agents", idsIn(t.y.agents), agents)) member(agents.get(id)!, t, t);
    const lead = list(t.y.lead_agent)[0];
    const leadEntry = lead ? agents.get(lead) : undefined;
    if (leadEntry) member(leadEntry, t, t, true);
    else if (lead && !NON_NODE_ACTORS.has(lead)) drop(t, "lead_agent");
  }
  for (const m of members.values()) link(m.a, "MEMBER_OF", m.t, m.src, m.lead ? { role: "lead" } : undefined);

  // DEPENDS_ON between systems: what a system lists under `connectors`, and who lists it under `used_by`
  for (const s of systems.values()) {
    for (const id of resolve(s, "connectors", list(s.y.connectors), systems)) link(s, "DEPENDS_ON", systems.get(id)!, s);
    for (const u of list(s.y.used_by)) {
      const user = systems.get(u);
      if (user) link(user, "DEPENDS_ON", s, s);
      else if (!agents.has(u) && !NON_NODE_ACTORS.has(u)) drop(s, "used_by");
    }
  }

  // Optional: agent -> system usage, with a relation the caller chose
  if (ctx.agentSystemRel) {
    let refused = false;
    for (const a of agents.values()) {
      for (const id of [...list(a.y.tools), ...list(a.y.connectors)]) {
        const s = systems.get(id);
        if (s && !link(a, ctx.agentSystemRel, s, a)) refused = true;
      }
    }
    for (const s of systems.values()) {
      for (const u of list(s.y.used_by)) {
        const a = agents.get(u);
        if (a && !link(a, ctx.agentSystemRel, s, s)) refused = true;
      }
    }
    if (refused) skipped.push({ ref: "registry", reason: `agent -> system edges not emitted: ${ctx.agentSystemRel} is not allowed from Agent to System` });
  }

  for (const [path, fields] of unresolved) {
    skipped.push({ ref: path, reason: `unresolved references dropped (unknown, denied or reserved ids): ${[...fields].map(([f, n]) => `${f}×${n}`).join(", ")}` });
  }

  return { source: "registry", docs: [], write: { nodes, edges, observations: [] }, skipped, redactions };
}
