// The write gate (docs/product-plan-after-hackathon.md §9, phase 1): one check on what ingestion, onboarding and the agents add
// to a business graph, run by writeBatch (opts.gate) and by the write tools that call upsertNode themselves (gateNode).
//
// Every NEW node (an update of a node that exists is not gated):
//   - has a label from the schema (ENTITY_TYPES): an unknown label is refused;
//   - has a source (`src`) and a date (`asOf`): the node's own, else the write's (the run, the turn, the meeting note) when
//     the caller gives one; a node with neither is refused. Each refusal is logged with its reason and returned.
// Entity resolution: before a new Person, Business, Supplier, Partner, Client, Competitor or Product is created, the gate looks
// for one of the same type with the same normalised name (or alias), or, for a Person, the same email; a node the librarian
// merged answers as the one it was merged into (`mergedInto`). When there is one, nothing is created: the write's edges and
// numbers are pointed at the existing node instead. A Person is matched by name only when the name has two words or more ("Rahul"
// alone is not enough to say two notes mean the same Rahul; an email is).
import type { GraphHandle } from "./client.js";
import { InvalidWrite } from "./errors.js";
import { isEntityType, type EntityType } from "./schema.js";
import type { EdgeInput, NodeInput, ObservationInput } from "./validate.js";

export class RefusedWrite extends InvalidWrite {
  override name = "RefusedWrite";
}

export interface GateOpts {
  who: string;            // whose write, for the log: "ingest", "onboard", "turn", "meeting", "remember"
  src?: string;           // the write's own source, given to a new node that names none
  asOf?: string;          // the write's own date, likewise
  resolve?: boolean;      // entity resolution (default on)
  log?: (line: string) => void; // where refusals are logged (default console.warn)
}

export const RESOLVED_TYPES: readonly EntityType[] = ["Person", "Business", "Supplier", "Partner", "Client", "Competitor", "Product"];
const RESOLVED = new Set<string>(RESOLVED_TYPES);

export interface Refusal { id: string; type: string; reason: string }
export interface Resolution { from: string; to: string; type: string; by: "name" | "email" }
export interface Gated {
  write: { nodes: NodeInput[]; edges: EdgeInput[]; observations: ObservationInput[] };
  refused: Refusal[];
  resolved: Resolution[];
}

// Case, punctuation, a leading "the" and a company suffix do not tell two names apart ("The Acme Co." = "acme").
const SUFFIX = /\s+(?:pvt|private|ltd|limited|llc|llp|inc|incorporated|co|company|corp|corporation|gmbh|plc)$/;
export function normalName(s: string): string {
  let n = s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim().replace(/^the /, "");
  for (let prev = ""; prev !== n;) { prev = n; n = n.replace(SUFFIX, "").trim(); }
  return n;
}
const normalEmail = (v: unknown): string | undefined => (typeof v === "string" && /^[^\s@]+@[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : undefined);

// The checks on one new node, without the graph: the label, then the source and date (filled from the write's own when the
// node has none). Throws RefusedWrite with the reason.
export function gateNode(n: NodeInput, o: Pick<GateOpts, "src" | "asOf">): NodeInput {
  if (!isEntityType(n.type)) throw new RefusedWrite(`unknown label ${JSON.stringify(n.type)}: not in the schema`);
  const src = n.src ?? o.src;
  const asOf = n.asOf ?? o.asOf;
  if (!src) throw new RefusedWrite("no source (src): every new node says where it came from");
  if (!asOf) throw new RefusedWrite("no date (asOf): every new node says as of when");
  return n.src === src && n.asOf === asOf ? n : { ...n, src, asOf };
}

interface Known { id: string; type: string; names: string[]; email?: string | undefined }

async function knownOfTypes(g: GraphHandle, types: string[]): Promise<Known[]> {
  const out: Known[] = [];
  for (const type of types) {
    if (!RESOLVED.has(type)) continue; // a schema type, so it is safe as a label in the query text
    const rows = await g.peek<{ id: string; name: string | null; aliases: unknown; email: unknown; into: string | null }>(
      `MATCH (n:Entity:${type}) RETURN n.id AS id, n.name AS name, n.aliases AS aliases, n.email AS email, n.mergedInto AS into LIMIT 10000`);
    for (const r of rows) {
      out.push({
        id: r.into ?? r.id, type,
        names: [r.name, ...(Array.isArray(r.aliases) ? r.aliases : [])].filter((x): x is string => typeof x === "string").map(normalName).filter(Boolean),
        email: normalEmail(r.email),
      });
    }
  }
  return out;
}

const nameKeyFor = (type: string, name: string): string | undefined => {
  const k = normalName(name);
  if (!k) return undefined;
  if (type === "Person" && k.split(" ").length < 2) return undefined; // a first name alone is not enough
  return k;
};

// Gates a whole write against the graph: new nodes checked (and stamped), new people, businesses and products resolved to the
// ones already there, the edges and numbers pointed at what they resolved to; what touches a refused node is left out too.
export async function gateWrite(
  g: GraphHandle, w: { nodes?: NodeInput[]; edges?: EdgeInput[]; observations?: ObservationInput[] }, o: GateOpts,
): Promise<Gated> {
  const log = o.log ?? ((l: string) => console.warn(l));
  const nodes = w.nodes ?? [];
  const ids = [...new Set(nodes.map((n) => n.id))];
  const existing = new Set(ids.length ? (await g.peek<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids })).map((r) => r.id) : []);
  const fresh = nodes.filter((n) => !existing.has(n.id));
  const resolveOn = o.resolve !== false;
  const types = resolveOn ? [...new Set(fresh.map((n) => n.type).filter((t) => RESOLVED.has(t)))] : [];
  const known = await knownOfTypes(g, types);
  const byName = new Map<string, string>(); // type|name -> id
  const byEmail = new Map<string, string>(); // type|email -> id
  for (const k of known) {
    for (const nm of k.names) if (k.type !== "Person" || nm.split(" ").length >= 2) { if (!byName.has(`${k.type}|${nm}`)) byName.set(`${k.type}|${nm}`, k.id); }
    if (k.email && !byEmail.has(`${k.type}|${k.email}`)) byEmail.set(`${k.type}|${k.email}`, k.id);
  }

  const out: NodeInput[] = [];
  const refused: Refusal[] = [];
  const resolved: Resolution[] = [];
  const remap = new Map<string, string>();
  const gone = new Set<string>();
  for (const n of nodes) {
    if (existing.has(n.id) || remap.has(n.id)) { if (!remap.has(n.id)) out.push(n); continue; }
    let ok: NodeInput;
    try {
      ok = gateNode(n, o);
    } catch (e) {
      const reason = (e as Error).message;
      refused.push({ id: n.id, type: String(n.type), reason });
      gone.add(n.id);
      log(`[gate] ${o.who} refused ${n.id}: ${reason}`);
      continue;
    }
    if (resolveOn && RESOLVED.has(n.type)) {
      const email = normalEmail(n.props?.email);
      const key = nameKeyFor(n.type, n.name);
      const hit = (email ? byEmail.get(`${n.type}|${email}`) : undefined) ?? (key ? byName.get(`${n.type}|${key}`) : undefined);
      if (hit && hit !== n.id) {
        remap.set(n.id, hit);
        resolved.push({ from: n.id, to: hit, type: n.type, by: email && byEmail.get(`${n.type}|${email}`) === hit ? "email" : "name" });
        continue;
      }
      // later nodes of this write resolve to this one
      if (key && !byName.has(`${n.type}|${key}`)) byName.set(`${n.type}|${key}`, n.id);
      if (email && !byEmail.has(`${n.type}|${email}`)) byEmail.set(`${n.type}|${email}`, n.id);
    }
    out.push(ok);
  }
  const to = (id: string): string => remap.get(id) ?? id;
  const edges = (w.edges ?? []).filter((e) => !gone.has(e.from) && !gone.has(e.to))
    .map((e) => (remap.has(e.from) || remap.has(e.to) ? { ...e, from: to(e.from), to: to(e.to) } : e))
    .filter((e) => e.from !== e.to);
  const observations = (w.observations ?? []).filter((x) => !gone.has(x.subject))
    .map((x) => (remap.has(x.subject) ? { ...x, subject: to(x.subject) } : x));
  return { write: { nodes: out, edges, observations }, refused, resolved };
}
