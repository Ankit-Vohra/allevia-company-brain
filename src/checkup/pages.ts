// One page, one name (graph audit G9, a live bug: the check-up renamed onboarding's Pages to their URL path, so avs_atelier
// showed three `Page[name]` Versions). Onboarding names a Page by its title; the check-up and the keyword rankings meet the
// same Pages later and used to write the path over that name. A writer that only knows a page by its address calls this
// before it writes: a Page that is already in the graph keeps the name it has, and only a Page the graph has never seen is
// named by the shared rule (website/urls.ts pageName: the title, else the path).
import type { GraphHandle } from "../graph/client.js";
import type { NodeInput } from "../graph/upsert.js";
import type { GraphWrite } from "../ingest/types.js";

type Read = Pick<GraphHandle, "roQuery">;

export async function keepPageNames(g: Read, w: GraphWrite): Promise<GraphWrite> {
  const pages = w.nodes.filter((n) => n.type === "Page");
  if (!pages.length) return w;
  const have = new Map<string, string>();
  const ids = [...new Set(pages.map((n) => n.id))];
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await g.roQuery<{ id: string; name: string | null }>(
      "MATCH (p:Entity:Page) WHERE p.id IN $ids RETURN p.id AS id, p.name AS name", { ids: ids.slice(i, i + 500) });
    for (const r of rows) if (typeof r.name === "string" && r.name.trim()) have.set(r.id, r.name);
  }
  if (!have.size) return w;
  const nodes = w.nodes.map((n): NodeInput => (n.type === "Page" && have.has(n.id) ? { ...n, name: have.get(n.id)! } : n));
  return { ...w, nodes };
}
