// "What your team knows": the business's brain as a map first. One line with its real size, the kinds as chips that
// filter, search that finds anything and flies to it, and the map itself: coloured by kind, sized by importance, labelled
// where labels fit, with what the team is reading right now breathing in gold. Tap a thing for the slim panel (a bottom
// sheet on a phone): what it is, how we know, what it links to, "Ask about this" and "What breaks if this stops", which
// lights the chain on the map. "Watch it grow" replays the map in the order it was learned. Below the map, short tabs:
// recent decisions, most connected, what breaks, by kind, how it grew. ?node=<id> links (from Chat, Ask, Insights and a
// team member's profile) open that thing on the map.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { AgentId, EdgeRef, NodeRef } from "@shared/contracts";
import { api, getMode } from "../api";
import { ThingPanel, SearchBox, Dot, type ImpactShown } from "../components/brain-card";
import { NOT_HEADLINES, kindName, tidyName, whenWords } from "../components/brain-words";
import { agentDef, fmtDate } from "../components/bits";
import { GraphAtWorkPanel } from "../components/GraphAtWork";
import { GraphGrowthPanel } from "../components/GraphGrowth";
import { Icon } from "../components/Icon";
import { Reveal } from "../components/Reveal";
import {
  HIDDEN_AT_FIRST, centreOf, decodeMap, growFrames, growOrder, kindTotals, labelFloor, mapHeadline, pickForMap, readingWords, type MapNode,
} from "../lib/brain-map";
import { fmtNum } from "../lib/format";
import { kindOf } from "../lib/labels";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import { useReadingNow } from "../state/reading";
import type { Freshness } from "../types-ext";
import "./brain.css";

const GraphView = lazy(() => import("../components/GraphView"));

const PHONE = "(max-width: 760px)";
const edgeKey = (e: EdgeRef) => `${e.from}|${e.type}|${e.to}`;
type TabId = "decisions" | "top" | "breaks" | "kinds" | "growth";

export default function BrainPage() {
  const { tenant, effectiveTheme, reducedMotion } = useApp();
  const [params, setParams] = useSearchParams();
  const selected = params.get("node") ?? undefined;
  const phone = useMedia(PHONE);
  const cap = phone ? 220 : 400;
  const live = getMode() === "live";

  const map = useAsync(() => api.brainMap(tenant.id, cap).then(decodeMap), [tenant.id, cap]);
  const overview = useAsync(() => api.overview(tenant.id), [tenant.id]);
  const detail = useAsync(() => (selected ? api.node(tenant.id, selected) : Promise.resolve(null)), [tenant.id, selected]);
  const reading = useReadingNow(tenant.id);

  const [hidden, setHidden] = useState<Set<string>>(() => new Set(HIDDEN_AT_FIRST));
  const [impact, setImpact] = useState<ImpactShown | null>(null);
  const [grow, setGrow] = useState<{ order: MapNode[]; frames: number[]; i: number } | null>(null);
  const [layoutKey, setLayoutKey] = useState("first");
  const [tab, setTab] = useState<TabId>("decisions");
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setHidden(new Set(HIDDEN_AT_FIRST)); setImpact(null); setGrow(null); }, [tenant.id]);
  useEffect(() => { setImpact((x) => (x && x.id !== selected ? null : x)); }, [selected]);

  const select = useCallback((id: string | undefined, opts: { scroll?: boolean } = {}) => {
    const next = new URLSearchParams(params);
    if (id) next.set("node", id); else next.delete("node");
    next.delete("explore");
    setParams(next, { replace: !!id && !!selected });
    if (id) setGrow(null);
    if (id && opts.scroll) stageRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  }, [params, setParams, selected, reducedMotion]);
  // on a phone the panel is a sheet over the bottom of the screen: keep the map at the top so the thing stays in view
  const pick = (id: string) => select(id, { scroll: true });
  const tap = (id: string) => select(id);
  useEffect(() => {
    if (phone && selected) stageRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone, selected]);

  // the thing that is open, when it is not among the top things: bring it and what it links to onto the map
  const inMap = !!selected && !!map.data?.nodes.some((n) => n.id === selected);
  const around = useAsync(
    () => (selected && map.data && !inMap ? api.graph(tenant.id, selected, 1).catch(() => undefined) : Promise.resolve(undefined)),
    [tenant.id, selected, !!map.data, inMap],
  );

  const all = useMemo(() => {
    if (!map.data) return undefined;
    const nodes = new Map<string, MapNode>(map.data.nodes.map((n) => [n.id, n]));
    const edges = new Map<string, EdgeRef>(map.data.edges.map((e) => [edgeKey(e), e]));
    const add = (ns: Array<NodeRef & { rank?: number }>, es: EdgeRef[]) => {
      for (const n of ns) if (!nodes.has(n.id)) nodes.set(n.id, { ...n, rank: n.rank ?? 0.06 });
      for (const e of es) edges.set(edgeKey(e), e);
    };
    if (around.data) add(around.data.nodes, around.data.edges);
    add(reading.nodes, reading.edges);
    if (impact) add(impact.nodes, impact.edges);
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }, [map.data, around.data, reading, impact]);

  const keep = useMemo(() => new Set<string>([
    ...(selected ? [selected] : []), ...reading.ids, ...(impact?.ids ?? []), ...(around.data?.nodes.map((n) => n.id) ?? []),
  ]), [selected, reading, impact, around.data]);
  const picked = useMemo(
    () => (all && map.data ? pickForMap(all.nodes, all.edges, { cap: map.data.nodes.length, hidden, keep }) : undefined),
    [all, map.data, hidden, keep],
  );

  // "Watch it grow": the same things, added in the order the team learned them
  const shown = useMemo(() => {
    if (!picked || !grow) return picked;
    const upTo = grow.order.slice(0, grow.frames[grow.i] ?? 0);
    const ids = new Set(upTo.map((n) => n.id));
    return { nodes: upTo, edges: picked.edges.filter((e) => ids.has(e.from) && ids.has(e.to)), trimmed: 0 };
  }, [picked, grow]);
  useEffect(() => {
    if (!grow) return;
    if (grow.i >= grow.frames.length - 1) { const t = setTimeout(() => setGrow(null), 1200); return () => clearTimeout(t); }
    const t = setTimeout(() => setGrow((g) => g && { ...g, i: g.i + 1 }), reducedMotion ? 700 : 110);
    return () => clearTimeout(t);
  }, [grow, reducedMotion]);
  const play = () => {
    if (grow) { setGrow(null); return; }
    if (!picked?.nodes.length) return;
    select(undefined);
    setImpact(null);
    const order = growOrder(picked.nodes);
    setLayoutKey(`grow-${Date.now()}`);
    setGrow({ order, frames: growFrames(order.length, reducedMotion), i: 0 });
  };
  const growLabel = (() => {
    if (!grow) return undefined;
    const n = grow.frames[grow.i] ?? 0;
    const last = grow.order[n - 1];
    const when = last?.learnedAt ? fmtDate(new Date(last.learnedAt).toISOString()) : undefined;
    return `${when ? `${when} · ` : ""}${fmtNum(n)} of ${fmtNum(grow.order.length)}`;
  })();

  // the open thing and what it links to come forward; what breaks, when asked, lights up instead
  const spotlight = useMemo(() => {
    if (impact) return impact.ids;
    if (!selected || !detail.data || !picked) return undefined;
    const on = new Set(picked.nodes.map((n) => n.id));
    const near = detail.data.neighbors.map((n) => n.node.id).filter((id) => on.has(id));
    return near.length && near.length <= 60 ? [selected, ...near] : undefined;
  }, [impact, selected, detail.data, picked]);

  const centre = useMemo(() => (map.data ? centreOf(map.data.nodes) : undefined), [map.data]);
  const floor = useMemo(() => (picked ? labelFloor(picked.nodes, phone ? 7 : 16) : 0.5), [picked, phone]);
  const chips = useMemo(() => kindTotals(map.data?.counts ?? overview.data?.counts ?? {}), [map.data, overview.data]);
  const toggle = (k: string) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const sources = overview.data?.freshness ?? [];
  const headline = mapHeadline({ things: map.data?.totals.things, links: map.data?.totals.links, sources: sources.length });
  const sample = sources.some((s) => s.note === "simulated");
  const dark = effectiveTheme === "dark";

  const panel = selected ? (
    <ThingPanel
      tenantId={tenant.id}
      id={selected}
      detail={detail.data ?? undefined}
      loading={detail.loading}
      error={detail.error}
      onSelect={(id) => select(id)}
      onClose={() => select(undefined)}
      onImpact={setImpact}
    />
  ) : null;

  return (
    <div className="brain-page">
      <header className="bm-head">
        <div className="bm-heading">
          <h1 className="page-title">What your team knows</h1>
          {map.data ? (
            <p className="bm-line">{headline.join(" · ")}{sample && <span className="bm-sample"> · some are sample numbers</span>}</p>
          ) : map.error ? null : <span className="skeleton bm-line-skel" />}
        </div>
        <div className="bm-search"><SearchBox tenantId={tenant.id} onPick={pick} placeholder="Find anything your team knows" /></div>
      </header>

      {chips.length > 0 && (
        <ul className="bm-chips" aria-label="Kinds of things: tap to show or hide">
          {chips.map((k) => (
            <li key={k.id}>
              <button type="button" className={`bm-chip${hidden.has(k.id) ? " is-off" : ""}`} aria-pressed={!hidden.has(k.id)} onClick={() => toggle(k.id)} style={{ ["--hue" as string]: k.hue }}>
                <span className="bm-chip-dot" aria-hidden="true" />{k.name}<span className="bm-chip-n">{fmtNum(k.count)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div ref={stageRef} className={`bm-stage${panel ? " has-panel" : ""}`}>
        <div className="bm-canvas">
          {map.error ? (
            <div className="bm-empty">
              <p>We couldn't draw the map just now.</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={map.reload}>Try again</button>
            </div>
          ) : !shown ? (
            <div className="skeleton bm-skel" aria-hidden="true" />
          ) : map.data!.nodes.length === 0 ? (
            <div className="bm-empty"><p>Nothing yet. Add your website and your team starts learning.</p></div>
          ) : (
            <Suspense fallback={<div className="skeleton bm-skel" aria-hidden="true" />}>
              <GraphView
                nodes={shown.nodes}
                edges={shown.edges}
                centerId={centre}
                focusId={grow ? undefined : selected}
                highlightIds={grow ? undefined : spotlight}
                activeIds={grow ? undefined : reading.ids}
                sizeBy="rank"
                rankScale={phone ? [2.4, 10] : [2.6, 12]}
                labelMinRank={floor}
                dark={dark}
                reducedMotion={reducedMotion}
                onNodeClick={tap}
                onBackgroundClick={() => { if (selected) select(undefined); }}
                followGrowth={!!grow}
                layoutKey={layoutKey}
                maxFitZoom={2.2}
                fitPadding={phone ? 16 : 36}
                ariaLabel={`Map of what ${tenant.name}'s team knows: ${fmtNum(shown.nodes.length)} of the most important things and how they link. Search above finds any of them by keyboard.`}
              />
            </Suspense>
          )}
          {shown && shown.nodes.length > 0 && (
            <div className="bm-foot">
              <button type="button" className={`bm-play${grow ? " is-on" : ""}`} onClick={play} aria-pressed={!!grow}>
                <Icon name={grow ? "stop" : "play"} size={12} />
                {grow ? <span className="bm-play-at">{growLabel}</span> : "Watch it grow"}
              </button>
              {!grow && <ReadingLine who={reading.who} count={reading.ids.length} />}
            </div>
          )}
          <p className="bm-powered">Powered by <b>FalkorDB</b></p>
        </div>
        {panel && <aside className="bm-panel" aria-label="About this thing">{panel}</aside>}
      </div>

      <BrainTabs
        tab={tab}
        setTab={setTab}
        live={live}
        tenantId={tenant.id}
        nodes={map.data?.nodes}
        chips={chips}
        sources={sources}
        onPick={pick}
        onShowKind={(k) => { setHidden((h) => { const n = new Set(h); n.delete(k); return n; }); stageRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" }); }}
      />
    </div>
  );
}

/** "Sara is reading 5 things" while a question is being worked on; nothing otherwise. */
function ReadingLine({ who, count }: { who: AgentId[]; count: number }) {
  if (!count || !who.length) return <span className="bm-reading" aria-live="polite" />;
  return (
    <span className="bm-reading is-on" aria-live="polite">
      <span className="bm-pulse" aria-hidden="true" />{readingWords(who.map((a) => agentDef(a)?.name ?? a), count)}
    </span>
  );
}

// ---------------------------------------------------------------- below the map

const ROWS = 5;

function BrainTabs({ tab, setTab, live, tenantId, nodes, chips, sources, onPick, onShowKind }: {
  tab: TabId; setTab: (t: TabId) => void; live: boolean; tenantId: string; nodes?: MapNode[];
  chips: ReturnType<typeof kindTotals>; sources: Freshness[]; onPick: (id: string) => void; onShowKind: (k: string) => void;
}) {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "decisions", label: "Recent decisions" },
    { id: "top", label: "Most connected" },
    ...(live ? [{ id: "breaks" as const, label: "What breaks" }] : []),
    { id: "kinds", label: "By kind" },
    { id: "growth", label: "How it grew" },
  ];
  const decisions = useMemo(
    () => (nodes ?? []).filter((n) => n.label === "Decision").sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? "") || b.rank - a.rank).slice(0, ROWS),
    [nodes],
  );
  const top = useMemo(() => (nodes ?? []).filter((n) => !NOT_HEADLINES.has(n.label)).slice(0, ROWS + 1), [nodes]);

  return (
    <section className="bt" aria-label="More about what your team knows">
      <div className="bt-tabs" role="tablist" aria-label="More">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`bt-${t.id}`} aria-selected={tab === t.id} aria-controls="bt-panel" className={`bt-tab${tab === t.id ? " is-on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="bt-panel" role="tabpanel" id="bt-panel" aria-labelledby={`bt-${tab}`}>
        {tab === "decisions" && <Rows list={decisions} note={(n) => (n.asOf ? whenWords(n.asOf) : "")} onPick={onPick} empty="No decisions recorded yet." loading={!nodes} />}
        {tab === "top" && <Rows list={top} note={(n) => kindName(n.label)} onPick={onPick} empty="Nothing yet." loading={!nodes} />}
        {tab === "breaks" && <GraphAtWorkPanel tenantId={tenantId} onPick={onPick} />}
        {tab === "kinds" && (
          <div className="bt-kinds">
            {chips.map((k) => {
              const items = (nodes ?? []).filter((n) => kindOf(n.label).id === k.id).slice(0, 8);
              return (
                <Reveal key={k.id} tone="row" label={<span className="bt-kind"><span className="bn-dot" style={{ ["--hue" as string]: k.hue }} aria-hidden="true" />{k.name}</span>} summary={fmtNum(k.count)}>
                  {items.length === 0 ? <p className="bt-muted">None among the most important things.</p> : (
                    <Rows list={items} note={(n) => kindName(n.label)} onPick={onPick} empty="" />
                  )}
                  <button type="button" className="btn btn-quiet btn-sm bt-more" onClick={() => onShowKind(k.id)}>Show on the map</button>
                </Reveal>
              );
            })}
          </div>
        )}
        {tab === "growth" && (
          <div className="bt-growth">
            <GraphGrowthPanel tenantId={tenantId} />
            {sources.length > 0 && (
              <div className="bt-sources">
                <h3 className="bt-h">Where it comes from</h3>
                <ul>
                  {sources.map((s) => (
                    <li key={s.source}>
                      <span>{s.source}</span>
                      <span className="bt-muted">
                        {s.note === "simulated" ? "Sample numbers · " : ""}updated {whenWords(s.asOf)}
                        {s.status === "stale" ? " · a bit out of date" : s.status === "error" ? " · not reachable" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Rows({ list, note, onPick, empty, loading }: { list: MapNode[]; note: (n: MapNode) => string; onPick: (id: string) => void; empty: string; loading?: boolean }) {
  if (loading) return <div className="bs-skel" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>;
  if (!list.length) return empty ? <p className="bt-muted">{empty}</p> : null;
  return (
    <ul className="bt-rows">
      {list.map((n) => (
        <li key={n.id}>
          <button type="button" className="bt-row" onClick={() => onPick(n.id)}>
            <Dot label={n.label} />
            <span className="bt-row-name">{tidyName(n.label, n.name)}</span>
            <span className="bt-row-note">{note(n)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
