// Small graph helpers the action layer (approvals, executors, learning) and the insight writers share.
import { agentById } from "../../shared/roster.js";
import type { GraphHandle } from "../graph/client.js";
import { businessId } from "../graph/tenants.js";
import { typeFromId } from "../util/ids.js";
import { upsertEdge, upsertNode } from "../graph/upsert.js";
import { isoDate } from "../util/time.js";
import { agentNodeId } from "../agent/memory.js";

type Read = Pick<GraphHandle, "roQuery">;

export { agentNodeId };

// An action payload as the approval card shows it: what is proposed (title, body), where it lands (target), plus the
// ids the executor needs (targetId, channelId, campaignId, format…).
export interface Payload {
  title: string;
  body: string;
  target?: string;
  targetId?: string;
  [k: string]: unknown;
}

// Approval.payload is stored as a JSON string. Anything missing falls back to the approval's own title and an empty
// body, so an executor always has a title and a body to work with.
export function parsePayload(raw: unknown, fallbackTitle: string): Payload {
  let obj: Record<string, unknown> = {};
  if (typeof raw === "string" && raw.trim()) {
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
      else obj = { body: String(v) };
    } catch {
      obj = { body: raw };
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { ...obj, title: str(obj.title)?.trim() || fallbackTitle, body: str(obj.body) ?? str(obj.text) ?? str(obj.caption) ?? "" };
}

export async function existingIds(g: Read, ids: string[]): Promise<Set<string>> {
  const want = [...new Set(ids.filter((x) => typeof x === "string" && x))];
  if (!want.length) return new Set();
  const rows = await g.roQuery<{ id: string }>("UNWIND $ids AS id MATCH (n:Entity {id:id}) RETURN n.id AS id", { ids: want });
  return new Set(rows.map((r) => r.id));
}

// The Agent node for a roster id (agent:allevia-<id>), created when missing, the way propose_action does it.
export async function ensureAgentNode(g: GraphHandle, rosterId: string, now: number): Promise<string> {
  const id = agentNodeId(rosterId);
  if ((await existingIds(g, [id])).has(id)) return id;
  const def = agentById(rosterId);
  await upsertNode(g, {
    type: "Agent", id, name: def?.name ?? rosterId,
    props: { kind: "allevia", rosterId, allevia: true, ...(def ? { title: def.title, department: def.department } : {}) },
  }, now);
  return id;
}

// Who decided: a Person or Agent id. Unknown ids that look like a person/agent are created as a plain node (the owner
// deciding from the web app may have no Person node yet); anything else becomes person:owner.
export async function ensureActor(g: GraphHandle, actor: string | undefined, now: number): Promise<string> {
  const type = actor ? typeFromId(actor) : undefined;
  const id = actor && (type === "Person" || type === "Agent") ? actor : "person:owner";
  if ((await existingIds(g, [id])).has(id)) return id;
  await upsertNode(g, { type: typeFromId(id) === "Agent" ? "Agent" : "Person", id, name: id === "person:owner" ? "Owner" : id.slice(id.indexOf(":") + 1), props: { role: "owner" } }, now);
  return id;
}

// The tenant's own Business node: businessId(tenant) or slug = tenant when present, else the best-connected Business
// (a graph can hold other businesses: vendors, partners).
export async function findBusinessId(g: Read, tenant?: string): Promise<string | null> {
  const rows = await g.roQuery<{ id: string; slug: string | null; degree: number }>(
    `MATCH (b:Business) OPTIONAL MATCH (b)-[r]-() WITH b, count(r) AS degree RETURN b.id AS id, b.slug AS slug, degree ORDER BY degree DESC, id LIMIT 50`);
  if (!rows.length) return null;
  if (tenant) {
    let own: string | undefined;
    try {
      own = businessId(tenant);
    } catch {
      own = undefined;
    }
    const hit = rows.find((r) => r.id === own || r.slug === tenant);
    if (hit) return hit.id;
  }
  return rows[0]!.id;
}

// The goals the card behind a piece of work ADVANCES: a Recommendation's own ADVANCES edges, and, from an Approval, those of the
// Recommendation that PROPOSES it (Approval <-PROPOSES- Recommendation -ADVANCES-> Goal). Current edges only.
export async function goalsOf(g: Read, o: { recommendationId?: string; approvalId?: string }): Promise<string[]> {
  const ids = new Set<string>();
  if (o.recommendationId) {
    const rows = await g.roQuery<{ id: string }>(
      "MATCH (:Entity:Recommendation {id:$id})-[a:ADVANCES]->(gl:Goal) WHERE a.until IS NULL RETURN DISTINCT gl.id AS id ORDER BY id", { id: o.recommendationId });
    for (const r of rows) ids.add(r.id);
  }
  if (o.approvalId) {
    const rows = await g.roQuery<{ id: string }>(
      `MATCH (r:Entity:Recommendation)-[p:PROPOSES]->(:Entity:Approval {id:$id}) WHERE p.until IS NULL
       MATCH (r)-[a:ADVANCES]->(gl:Goal) WHERE a.until IS NULL
       RETURN DISTINCT gl.id AS id ORDER BY id`, { id: o.approvalId });
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

// `from` (a Task or a Content the card made) ADVANCES every goal the card behind it advances, with the action or approval that
// made it as the source and the date it was written. Best effort: a goal edge never stops the action that made the work.
export async function advanceGoals(g: GraphHandle, o: { from: string; recommendationId?: string; approvalId?: string; src: string; now: number }): Promise<string[]> {
  try {
    const goals = await goalsOf(g, o);
    const done: string[] = [];
    for (const gl of goals) {
      await upsertEdge(g, { from: o.from, type: "ADVANCES", to: gl, since: o.now, src: o.src, asOf: isoDate(o.now) }, o.now);
      done.push(gl);
    }
    return done;
  } catch {
    return [];
  }
}
