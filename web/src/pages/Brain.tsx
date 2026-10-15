// Brain: the whole company graph to explore. Search for anything, colour by type or by community, size by PageRank,
// hide types you don't need, and open any node to read its properties, where it came from, how it changed over time
// and what it connects to.
import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router";
import type { EdgeRef } from "@shared/contracts";
import { api } from "../api";
import { fmtDate } from "../components/bits";
import { Icon } from "../components/Icon";
import { fmtNum } from "../lib/format";
import { COMMUNITY_HUES, hueFor, labelOfId } from "../lib/labels";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import type { GraphNode, NodeDetail, SearchHit } from "../types-ext";
import "./brain.css";

const GraphView = lazy(() => import("../components/GraphView"));

/** BASED_ON → "based on": relationship names read as plain words. */
const relText = (type = "") => type.toLowerCase().replace(/_/g, " ");

export default function BrainPage() {
  const { tenant, effectiveTheme, reducedMotion } = useApp();
  const [params, setParams] = useSearchParams();
  const selected = params.get("node") ?? undefined;
  const phone = useMedia("(max-width: 760px)");
  const overview = useAsync(() => api.graphOverview(tenant.id), [tenant.id]);
  const detail = useAsync(() => (selected ? api.node(tenant.id, selected) : Promise.resolve(null)), [tenant.id, selected]);
  const [colorBy, setColorBy] = useState<"label" | "community">("label");
  const [sizeBy, setSizeBy] = useState<"rank" | "degree">("rank");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focusNeighbours, setFocusNeighbours] = useState(true);

  const select = (id: string | undefined) => {
    const next = new URLSearchParams(params);
    if (id) next.set("node", id); else next.delete("node");
    setParams(next, { replace: false });
  };

  // a new business: clear the selection if it isn't in this graph
  useEffect(() => { setHidden(new Set()); }, [tenant.id]);

  const all = overview.data;
  const labelCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of all?.nodes ?? []) m.set(n.label, (m.get(n.label) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [all]);
  // topics come from label propagation; each is named after its most central member
  const communities = useMemo(() => {
    const m = new Map<number, { count: number; lead?: GraphNode }>();
    for (const n of all?.nodes ?? []) {
      const c = m.get(n.community ?? 0) ?? { count: 0 };
      c.count++;
      if (!c.lead || (n.rank ?? 0) > (c.lead.rank ?? 0)) c.lead = n;
      m.set(n.community ?? 0, c);
    }
    return [...m.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [all]);

  const shown = useMemo(() => {
    if (!all) return { nodes: [] as GraphNode[], edges: [] as EdgeRef[] };
    const nodes = all.nodes.filter((n) => !hidden.has(n.label) || n.id === selected);
    const ids = new Set(nodes.map((n) => n.id));
    return { nodes, edges: all.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }, [all, hidden, selected]);

  const highlight = useMemo(() => {
    if (!selected || !focusNeighbours || !detail.data) return undefined;
    return [selected, ...detail.data.neighbors.map((n) => n.node.id)];
  }, [selected, focusNeighbours, detail.data]);

  const toggleLabel = (l: string) => setHidden((h) => { const n = new Set(h); if (n.has(l)) n.delete(l); else n.add(l); return n; });
  const top = useMemo(() => [...(all?.nodes ?? [])].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0)).slice(0, 8), [all]);

  return (
    <div className="brain-page">
      <section className="brain-stage" aria-labelledby="brain-title">
        <div className="brain-bar">
          <h1 id="brain-title" className="brain-title">{tenant.name}'s brain</h1>
          <SearchBox tenantId={tenant.id} onPick={(id) => { select(id); }} />
        </div>
        <div className="brain-controls">
          <div className="seg" role="group" aria-label="Colour nodes by">
            <button type="button" className={`seg-btn${colorBy === "label" ? " is-on" : ""}`} aria-pressed={colorBy === "label"} onClick={() => setColorBy("label")}>Type</button>
            <button type="button" className={`seg-btn${colorBy === "community" ? " is-on" : ""}`} aria-pressed={colorBy === "community"} onClick={() => setColorBy("community")}>Topic</button>
          </div>
          <div className="seg" role="group" aria-label="Size nodes by">
            <button type="button" className={`seg-btn${sizeBy === "rank" ? " is-on" : ""}`} aria-pressed={sizeBy === "rank"} onClick={() => setSizeBy("rank")}>PageRank</button>
            <button type="button" className={`seg-btn${sizeBy === "degree" ? " is-on" : ""}`} aria-pressed={sizeBy === "degree"} onClick={() => setSizeBy("degree")}>Links</button>
          </div>
          <p className="brain-count">
            {all ? <>{fmtNum(shown.nodes.length)} of {fmtNum(all.nodes.length)} nodes · {fmtNum(shown.edges.length)} links</> : "Loading the graph…"}
          </p>
        </div>
        <ul className="legend" aria-label={colorBy === "label" ? "Node types: click to show or hide" : "Topics found by label propagation"}>
          {colorBy === "label"
            ? labelCounts.map(([l, c]) => (
                <li key={l}>
                  <button type="button" className={`legend-chip${hidden.has(l) ? " is-off" : ""}`} aria-pressed={!hidden.has(l)} onClick={() => toggleLabel(l)} style={{ ["--hue" as string]: hueFor(l) }}>
                    <span className="legend-dot" aria-hidden="true" />{l}<span className="legend-n">{c}</span>
                  </button>
                </li>
              ))
            : communities.map(([c, { count, lead }]) => (
                <li key={c}>
                  <span className="legend-chip is-static" style={{ ["--hue" as string]: COMMUNITY_HUES[c % COMMUNITY_HUES.length] }}>
                    <span className="legend-dot" aria-hidden="true" />Around {lead?.name ?? `topic ${c + 1}`}<span className="legend-n">{count}</span>
                  </span>
                </li>
              ))}
        </ul>
        <div className="brain-canvas">
          {overview.error ? (
            <p className="empty">Couldn't load the graph: {overview.error}</p>
          ) : !all ? (
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
                dark={effectiveTheme === "dark"}
                reducedMotion={reducedMotion}
                onNodeClick={(id) => select(id)}
                fitPadding={phone ? 18 : 40}
                ariaLabel={`${tenant.name}'s knowledge graph: ${shown.nodes.length} nodes and ${shown.edges.length} links. Use the search box or the panel to explore it by keyboard.`}
              />
            </Suspense>
          )}
          <p className="brain-hint" aria-hidden="true">Scroll to zoom · drag to pan · click a node to open it</p>
        </div>
      </section>

      <aside className="brain-panel" aria-label={selected ? "Node details" : "About this graph"}>
        {selected ? (
          <NodePanel
            id={selected}
            detail={detail.data ?? undefined}
            loading={detail.loading}
            error={detail.error}
            onSelect={select}
            onClose={() => select(undefined)}
            focusNeighbours={focusNeighbours}
            setFocusNeighbours={setFocusNeighbours}
          />
        ) : (
          <div className="panel-body">
            <h2 className="panel-title">What {tenant.name}'s team can see</h2>
            <p className="panel-lede">Every document, decision, number, page and conversation becomes a node. Your team answers by walking these links, so every answer can show where it came from.</p>
            <section className="panel-section" aria-labelledby="bp-top">
              <h3 id="bp-top" className="section-title">Most central, by PageRank</h3>
              <ol className="rank-list">
                {top.map((n) => (
                  <li key={n.id}>
                    <button type="button" onClick={() => select(n.id)} className="rank-row">
                      <span className="rank-dot" style={{ ["--hue" as string]: hueFor(n.label) }} aria-hidden="true" />
                      <span className="rank-name">{n.name}</span>
                      <span className="rank-label">{n.label}</span>
                      <span className="meter" aria-label={`PageRank ${Math.round((n.rank ?? 0) * 100)} of 100`}><span style={{ width: `${(n.rank ?? 0) * 100}%` }} /></span>
                    </button>
                  </li>
                ))}
              </ol>
            </section>
            <section className="panel-section" aria-labelledby="bp-types">
              <h3 id="bp-types" className="section-title">By type</h3>
              <dl className="type-grid">
                {labelCounts.map(([l, c]) => (
                  <div key={l}><dt><span className="rank-dot" style={{ ["--hue" as string]: hueFor(l) }} aria-hidden="true" />{l}</dt><dd className="num">{c}</dd></div>
                ))}
              </dl>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

function SearchBox({ tenantId, onPick }: { tenantId: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits([]); return; }
    let live = true;
    const t = setTimeout(() => { api.search(tenantId, term).then((h) => { if (live) { setHits(h); setActive(0); } }, () => {}); }, 140);
    return () => { live = false; clearTimeout(t); };
  }, [q, tenantId]);

  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, [open]);

  const pick = (h: SearchHit | undefined) => {
    if (!h) return;
    onPick(h.node.id);
    setOpen(false);
    setQ(h.node.name);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(hits[active]); }
    else if (e.key === "Escape") setOpen(false);
  };
  const showList = open && q.trim().length > 0;

  return (
    <div className="brain-search" ref={wrap}>
      <Icon name="search" size={17} className="brain-search-icon" />
      <input
        className="field brain-search-input"
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && hits[active] ? `${listId}-${active}` : undefined}
        aria-label="Search the graph"
        placeholder="Search decisions, pages, people, numbers…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {showList && (
        <ul id={listId} className="search-list" role="listbox" aria-label="Matches">
          {hits.length === 0 ? (
            <li className="search-empty" role="presentation">Nothing matches “{q.trim()}”. Try a person, a page or a month.</li>
          ) : hits.map((h, i) => (
            <li
              key={h.node.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`search-hit${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
            >
              <span className="rank-dot" style={{ ["--hue" as string]: hueFor(h.node.label) }} aria-hidden="true" />
              <span className="search-hit-text">
                <span className="search-hit-name">{h.node.name}</span>
                {h.snippet && <span className="search-hit-snip">{h.snippet}</span>}
              </span>
              <span className="search-hit-label">{h.node.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "none";
  if (typeof v === "number") return fmtNum(v, 2);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}/.test(v) ? fmtDate(v) : v;
  return JSON.stringify(v);
}

/** decidedAt → "Decided at", lcp → "LCP": sentence case, with the usual acronyms kept. */
const ACRONYMS = new Set(["lcp", "ctr", "cpa", "seo", "url", "h1", "id", "kpi", "ga4"]);
const humanKey = (k: string) =>
  k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase()
    .split(" ").map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ")
    .replace(/^./, (c) => c.toUpperCase());

function NodePanel({ id, detail, loading, error, onSelect, onClose, focusNeighbours, setFocusNeighbours }: {
  id: string; detail?: NodeDetail; loading: boolean; error?: string; onSelect: (id: string) => void; onClose: () => void;
  focusNeighbours: boolean; setFocusNeighbours: (b: boolean) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, NodeDetail["neighbors"]>();
    for (const n of detail?.neighbors ?? []) {
      const k = `${n.direction}|${n.edge.type}`;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return [...m.entries()];
  }, [detail]);

  if (!detail) {
    return (
      <div className="panel-body">
        <div className="np-head">
          <p className="np-label">{labelOfId(id)}</p>
          <button type="button" className="btn btn-quiet btn-icon btn-sm" onClick={onClose} aria-label="Close node"><Icon name="close" size={16} /></button>
        </div>
        {loading ? <><span className="skeleton" style={{ display: "block", height: 28, width: "80%" }} /><span className="skeleton" style={{ display: "block", height: 80 }} /></> : (
          <p className="empty">{error ? `Couldn't open this node: ${error}` : "This node isn't in this business's graph."}</p>
        )}
      </div>
    );
  }
  const n = detail.node;
  const props = Object.entries(detail.props).filter(([k]) => k !== "asOf" && k !== "simulated");
  return (
    <div className="panel-body">
      <div className="np-head">
        <p className="np-label"><span className="rank-dot" style={{ ["--hue" as string]: hueFor(n.label) }} aria-hidden="true" />{n.label}{n.asOf ? ` · as of ${fmtDate(n.asOf)}` : ""}</p>
        <button type="button" className="btn btn-quiet btn-icon btn-sm" onClick={onClose} aria-label="Close node"><Icon name="close" size={16} /></button>
      </div>
      <h2 className="np-name">{n.name}</h2>
      {n.simulated && <span className="sim-badge">simulated data</span>}
      {n.summary && <p className="np-summary">{n.summary}</p>}
      <div className="np-actions">
        <label className="np-toggle">
          <input type="checkbox" checked={focusNeighbours} onChange={(e) => setFocusNeighbours(e.target.checked)} />
          Spotlight its neighbours
        </label>
        <Link className="btn btn-ghost btn-sm" to={`/ask?q=${encodeURIComponent(`What should I know about ${n.name}?`)}`}><Icon name="ask" size={14} /> Ask about this</Link>
      </div>

      {props.length > 0 && (
        <section className="panel-section" aria-labelledby="np-props">
          <h3 id="np-props" className="section-title">Properties</h3>
          <dl className="props">
            {props.map(([k, v]) => <div key={k}><dt>{humanKey(k)}</dt><dd>{fmtValue(v)}</dd></div>)}
            <div><dt>PageRank</dt><dd>{fmtNum(n.rank ?? 0, 2)}</dd></div>
          </dl>
        </section>
      )}

      {detail.versions.length > 0 && (
        <section className="panel-section" aria-labelledby="np-hist">
          <h3 id="np-hist" className="section-title">History</h3>
          <ol className="history">
            {[...detail.versions].reverse().map((v, i) => (
              <li key={i} className={v.until ? "" : "is-current"}>
                <p className="history-when">{fmtDate(v.since)} → {v.until ? fmtDate(v.until) : "now"}</p>
                <p className="history-what">{Object.entries(v.props).map(([k, val]) => `${humanKey(k)}: ${fmtValue(val)}`).join(" · ")}</p>
                {v.src && <button type="button" className="history-src" onClick={() => onSelect(v.src!)}>{v.src.split(":").slice(1).join(":")}</button>}
              </li>
            ))}
          </ol>
        </section>
      )}

      {detail.sources.length > 0 && (
        <section className="panel-section" aria-labelledby="np-src">
          <h3 id="np-src" className="section-title">Where it came from</h3>
          <ul className="sources">
            {detail.sources.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => onSelect(s.id)} className="source-row">
                  <Icon name="file" size={14} />
                  <span>{s.title}</span>
                  {s.asOf && <span className="muted">{fmtDate(s.asOf)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-section" aria-labelledby="np-nb">
        <h3 id="np-nb" className="section-title">Connected to · {detail.neighbors.length}</h3>
        {groups.length === 0 ? <p className="muted small">No links yet.</p> : (
          <div className="nb-groups">
            {groups.map(([k, list]) => {
              const [dir, type] = k.split("|");
              return (
                <div key={k} className="nb-group">
                  <p className="nb-rel" title={type}>{dir === "out" ? `${relText(type)} →` : `← ${relText(type)}`}</p>
                  <ul>
                    {list!.map((nb) => (
                      <li key={nb.node.id + k}>
                        <button type="button" className="nb-row" onClick={() => onSelect(nb.node.id)}>
                          <span className="rank-dot" style={{ ["--hue" as string]: hueFor(nb.node.label) }} aria-hidden="true" />
                          <span className="nb-name">{nb.node.name}</span>
                          <span className="nb-label">{nb.node.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
      <p className="np-id"><code>{n.id}</code></p>
    </div>
  );
}
