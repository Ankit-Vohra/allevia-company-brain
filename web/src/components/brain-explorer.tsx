// The map: everything your team knows, drawn as a web of connected things. It is the "Explore" view, behind a button on
// the summary. The controls (colour, size, hiding kinds) sit behind "Options"; the side panel is the readable card of
// whatever you click. Loaded only when Explore opens, so the summary stays light.
import { Suspense, lazy, useMemo, useState } from "react";
import type { EdgeRef } from "@shared/contracts";
import { fmtNum } from "../lib/format";
import { COMMUNITY_HUES, hueFor } from "../lib/labels";
import type { GraphData, GraphNode, NodeDetail } from "../types-ext";
import { Dot, NodeCard } from "./brain-card";
import { NOT_HEADLINES, kindName } from "./brain-words";
import { Icon } from "./Icon";
import { Reveal } from "./Reveal";

const GraphView = lazy(() => import("./GraphView"));

export default function BrainExplorer({ name, graph, loading, error, selected, detail, detailLoading, detailError, onSelect, onBack, dark, reducedMotion, phone }: {
  name: string;
  graph?: GraphData; loading: boolean; error?: string;
  selected?: string; detail?: NodeDetail; detailLoading: boolean; detailError?: string;
  onSelect: (id: string | undefined) => void; onBack: () => void;
  dark: boolean; reducedMotion: boolean; phone: boolean;
}) {
  const [colorBy, setColorBy] = useState<"label" | "community">("label");
  const [sizeBy, setSizeBy] = useState<"rank" | "degree">("rank");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [spotlight, setSpotlight] = useState(true);

  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of graph?.nodes ?? []) m.set(n.label, (m.get(n.label) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);
  const communities = useMemo(() => {
    const m = new Map<number, { count: number; lead?: GraphNode }>();
    for (const n of graph?.nodes ?? []) {
      const c = m.get(n.community ?? 0) ?? { count: 0 };
      c.count++;
      if (!c.lead || (n.rank ?? 0) > (c.lead.rank ?? 0)) c.lead = n;
      m.set(n.community ?? 0, c);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [graph]);

  const shown = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as EdgeRef[] };
    const nodes = graph.nodes.filter((n) => !hidden.has(n.label) || n.id === selected);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [graph, hidden, selected]);

  const highlight = useMemo(() => {
    if (!selected || !spotlight || !detail) return undefined;
    return [selected, ...detail.neighbors.map((n) => n.node.id)];
  }, [selected, spotlight, detail]);

  const top = useMemo(
    () => [...(graph?.nodes ?? [])].filter((n) => !NOT_HEADLINES.has(n.label)).sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 6),
    [graph],
  );
  const toggle = (l: string) => setHidden((h) => { const n = new Set(h); if (n.has(l)) n.delete(l); else n.add(l); return n; });

  return (
    <div className="bx">
      <section className="bx-stage" aria-labelledby="bx-title">
        <div className="bx-bar">
          <button type="button" className="btn btn-quiet btn-sm bx-back" onClick={onBack}><Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} /> What your team knows</button>
          <h1 id="bx-title" className="bx-title">Explore {name}</h1>
          <p className="bx-count">{graph ? `${fmtNum(shown.nodes.length)} things shown` : loading ? "Loading…" : ""}</p>
        </div>
        <Reveal label="Options" summary="colour, size, what to show" className="bx-options">
          <div className="bx-controls">
            <div className="seg" role="group" aria-label="Colour by">
              <button type="button" className={`seg-btn${colorBy === "label" ? " is-on" : ""}`} aria-pressed={colorBy === "label"} onClick={() => setColorBy("label")}>Kind</button>
              <button type="button" className={`seg-btn${colorBy === "community" ? " is-on" : ""}`} aria-pressed={colorBy === "community"} onClick={() => setColorBy("community")}>Topic</button>
            </div>
            <div className="seg" role="group" aria-label="Size by">
              <button type="button" className={`seg-btn${sizeBy === "rank" ? " is-on" : ""}`} aria-pressed={sizeBy === "rank"} onClick={() => setSizeBy("rank")}>Importance</button>
              <button type="button" className={`seg-btn${sizeBy === "degree" ? " is-on" : ""}`} aria-pressed={sizeBy === "degree"} onClick={() => setSizeBy("degree")}>Connections</button>
            </div>
            <label className="bx-toggle">
              <input type="checkbox" checked={spotlight} onChange={(e) => setSpotlight(e.target.checked)} />
              Highlight what a thing is connected to
            </label>
          </div>
          <ul className="bx-legend" aria-label={colorBy === "label" ? "Kinds of things: tap to show or hide" : "Topics"}>
            {colorBy === "label"
              ? labelCounts.map(([l, c]) => (
                  <li key={l}>
                    <button type="button" className={`bx-chip${hidden.has(l) ? " is-off" : ""}`} aria-pressed={!hidden.has(l)} onClick={() => toggle(l)} style={{ ["--hue" as string]: hueFor(l) }}>
                      <span className="bx-chip-dot" aria-hidden="true" />{kindName(l)}<span className="bx-chip-n">{c}</span>
                    </button>
                  </li>
                ))
              : communities.map(([c, { count, lead }]) => (
                  <li key={c}>
                    <span className="bx-chip is-static" style={{ ["--hue" as string]: COMMUNITY_HUES[c % COMMUNITY_HUES.length] }}>
                      <span className="bx-chip-dot" aria-hidden="true" />Around {lead?.name ?? `topic ${c + 1}`}<span className="bx-chip-n">{count}</span>
                    </span>
                  </li>
                ))}
          </ul>
        </Reveal>
        <div className="bx-canvas">
          {error ? (
            <p className="empty">We couldn't load the map: {error}</p>
          ) : !graph ? (
            <div className="skeleton" style={{ position: "absolute", inset: 0 }} />
          ) : (
            <Suspense fallback={<div className="skeleton" style={{ position: "absolute", inset: 0 }} />}>
              <GraphView
                nodes={shown.nodes}
                edges={shown.edges}
                focusId={selected}
                highlightIds={highlight}
                colorBy={colorBy}
                sizeBy={sizeBy}
                dark={dark}
                reducedMotion={reducedMotion}
                onNodeClick={(id) => onSelect(id)}
                fitPadding={phone ? 18 : 40}
                ariaLabel={`Map of what ${name}'s team knows: ${shown.nodes.length} things. Use the search on the previous page to find one by keyboard.`}
              />
            </Suspense>
          )}
          <p className="bx-hint" aria-hidden="true">Scroll to zoom · drag to move · tap a dot to read it</p>
        </div>
      </section>

      <aside className="bx-panel" aria-label={selected ? "About this thing" : "Where to start"}>
        {selected ? (
          <NodeCard id={selected} detail={detail} loading={detailLoading} error={detailError} onSelect={onSelect} onClose={() => onSelect(undefined)} variant="panel" />
        ) : (
          <div className="bn-card is-panel">
            <h2 className="bn-name bn-name-sm">Tap a dot to read about it</h2>
            <p className="bn-summary">Each dot is something your team knows. The lines show what is connected, so every answer can point back to where it came from.</p>
            <section className="bn-section" aria-labelledby="bx-top">
              <h3 id="bx-top" className="bn-section-title">Where to start</h3>
              <ul className="bn-sources">
                {top.map((n) => (
                  <li key={n.id}>
                    <button type="button" className="bn-row" onClick={() => onSelect(n.id)}>
                      <Dot label={n.label} />
                      <span className="bn-row-name">{n.name}</span>
                      <span className="bn-row-kind">{kindName(n.label)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
