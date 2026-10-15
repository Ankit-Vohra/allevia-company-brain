// The evidence behind an idea, drawn as one short line of stops: each fact it rests on, in order, with how it joins the
// next. It lives behind "Why we think this", so the technical labels (what kind of thing each stop is, how two are
// related) are fine here. It reads top to bottom on every screen size, which keeps it calm on a phone.
import type { EdgeRef, NodeRef } from "@shared/contracts";
import { hueFor } from "../lib/labels";

const human = (type: string) => type.toLowerCase().replace(/_/g, " ");

function linkBetween(a: string, b: string, edges: EdgeRef[]): { text: string; dir: "fwd" | "back" } | null {
  const f = edges.find((e) => e.from === a && e.to === b);
  if (f) return { text: human(f.type), dir: "fwd" };
  const r = edges.find((e) => e.from === b && e.to === a);
  if (r) return { text: human(r.type), dir: "back" };
  return null;
}

export function EvidenceChain({ nodes, edges, onOpen, label }: { nodes: NodeRef[]; edges: EdgeRef[]; onOpen?: (id: string) => void; label: string }) {
  if (!nodes.length) return null;
  return (
    <ol className="chain" aria-label={label}>
      {nodes.map((n, i) => {
        const next = nodes[i + 1];
        const link = next ? linkBetween(n.id, next.id, edges) : null;
        return (
          <li key={n.id} className={`station${next ? " has-next" : ""}${next && !link ? " is-loose" : ""}`} style={{ ["--hue" as string]: hueFor(n.label) }}>
            <span className="station-dot" aria-hidden="true" />
            <span className="station-text">
              {onOpen ? (
                <button type="button" className="station-name" onClick={() => onOpen(n.id)} title="See this in your company brain">
                  {n.name}
                </button>
              ) : (
                <span className="station-name">{n.name}</span>
              )}
              <span className="station-label">
                {n.label}
                {n.simulated ? " · sample numbers" : ""}
              </span>
              {link && (
                <span className="station-rel" aria-label={`${link.dir === "fwd" ? n.name : next!.name} ${link.text} ${link.dir === "fwd" ? next!.name : n.name}`}>
                  {link.dir === "back" ? "↑ " : "↓ "}{link.text}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
