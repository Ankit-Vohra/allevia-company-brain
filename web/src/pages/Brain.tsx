// "What your team knows": a plain summary first (how much your team knows, from where, how fresh), a few readable
// groups, the recent decisions and what comes up most. Search finds anything. The map ("Explore") sits behind a button
// and loads only when asked for; ?node=<id> links (from Ask, Insights and a team member's profile) open that thing's
// readable card, with "Explore around it" to see it on the map.
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { NodeCard, SearchBox } from "../components/brain-card";
import { BRAIN_GROUPS, GROUPED_LABELS, NOT_HEADLINES, groupHue, kindName, thingsCount, tidyName, whenWords } from "../components/brain-words";
import { Icon } from "../components/Icon";
import { Reveal } from "../components/Reveal";
import { fmtNum } from "../lib/format";
import { useMedia } from "../lib/useMedia";
import { useApp, useAsync } from "../state/app";
import type { GraphNode, Overview } from "../types-ext";
import "./brain.css";

const BrainExplorer = lazy(() => import("../components/brain-explorer"));

const byRank = (a: GraphNode, b: GraphNode) => (b.rank ?? 0) - (a.rank ?? 0);
const GROUP_ROWS = 8;

export default function BrainPage() {
  const { tenant, effectiveTheme, reducedMotion } = useApp();
  const [params, setParams] = useSearchParams();
  const selected = params.get("node") ?? undefined;
  const explore = params.get("explore") === "1";
  const phone = useMedia("(max-width: 860px)");

  const overview = useAsync(() => api.overview(tenant.id), [tenant.id]);
  const detail = useAsync(() => (selected ? api.node(tenant.id, selected) : Promise.resolve(null)), [tenant.id, selected]);

  // The list of things is only fetched when something needs it: Explore, an opened group, or (a moment after the
  // summary has drawn) the "recent decisions" and "comes up most" rows. The map itself loads only inside Explore.
  const [idle, setIdle] = useState(false);
  const [groupOpened, setGroupOpened] = useState(false);
  useEffect(() => {
    setIdle(false);
    if (explore || selected) return;
    const t = setTimeout(() => setIdle(true), 700);
    return () => clearTimeout(t);
  }, [explore, selected, tenant.id]);
  const wantGraph = explore || groupOpened || idle;
  const graph = useAsync(() => (wantGraph ? api.graphOverview(tenant.id) : Promise.resolve(undefined)), [tenant.id, wantGraph]);

  const set = useCallback((patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === null) next.delete(k); else next.set(k, v); }
    setParams(next, { replace });
  }, [params, setParams]);
  const select = (id: string | undefined) => set({ node: id ?? null });

  if (explore) {
    return (
      <Suspense fallback={<div className="page-loading"><span className="skeleton" /></div>}>
        <BrainExplorer
          name={tenant.name}
          graph={graph.data}
          loading={graph.loading}
          error={graph.error}
          selected={selected}
          detail={detail.data ?? undefined}
          detailLoading={detail.loading}
          detailError={detail.error}
          onSelect={select}
          onBack={() => set({ explore: null, node: null })}
          dark={effectiveTheme === "dark"}
          reducedMotion={reducedMotion}
          phone={phone}
        />
      </Suspense>
    );
  }

  if (selected) {
    return (
      <div className="brain-page">
        <button type="button" className="btn btn-quiet btn-sm brain-back" onClick={() => select(undefined)}>
          <Icon name="chevron-right" size={14} style={{ transform: "rotate(180deg)" }} /> What your team knows
        </button>
        <NodeCard
          id={selected}
          detail={detail.data ?? undefined}
          loading={detail.loading}
          error={detail.error}
          onSelect={select}
          onExplore={() => set({ explore: "1" })}
          variant="page"
        />
      </div>
    );
  }

  return <Summary
    tenantId={tenant.id}
    tenantName={tenant.name}
    overview={overview}
    nodes={graph.data?.nodes}
    graphLoading={wantGraph && (graph.loading || !graph.data) && !graph.error}
    onPick={select}
    onExplore={() => set({ explore: "1" })}
    onGroupOpen={() => setGroupOpened(true)}
  />;
}

// ---------------------------------------------------------------- the summary

function Summary({ tenantId, tenantName, overview, nodes, graphLoading, onPick, onExplore, onGroupOpen }: {
  tenantId: string; tenantName: string;
  overview: { data?: Overview; error?: string };
  nodes?: GraphNode[]; graphLoading: boolean;
  onPick: (id: string) => void; onExplore: () => void; onGroupOpen: () => void;
}) {
  const data = overview.data;
  const groups = useMemo(() => {
    const counts = data?.counts ?? {};
    return BRAIN_GROUPS
      .map((g) => ({ g, n: g.labels.reduce((s, l) => s + (counts[l] ?? 0), 0) }))
      .filter((x) => x.n > 0);
  }, [data]);
  const total = groups.reduce((s, x) => s + x.n, 0);
  const sources = data?.freshness ?? [];
  const last = sources.map((s) => s.asOf).sort().at(-1);
  const sample = sources.some((s) => s.note === "simulated");

  const decisions = useMemo(
    () => (nodes ?? []).filter((n) => n.label === "Decision").sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? "") || byRank(a, b)).slice(0, 3),
    [nodes],
  );
  const headlines = useMemo(
    () => (nodes ?? []).filter((n) => !NOT_HEADLINES.has(n.label) && n.label !== "Decision" && GROUPED_LABELS.has(n.label)).sort(byRank).slice(0, 4),
    [nodes],
  );

  return (
    <div className="brain-page">
      <header className="bs-head">
        <div>
          <h1 className="page-title">What your team knows</h1>
          {data ? (
            <p className="bs-lede">
              Your team knows <b>{thingsCount(total)}</b> about {tenantName}
              {sources.length > 0 && <>, from <b>{sources.length} {sources.length === 1 ? "source" : "sources"}</b></>}
              {last && <>, last updated <b>{whenWords(last)}</b></>}.
            </p>
          ) : overview.error ? (
            <p className="bs-lede">We couldn't load this just now. {overview.error}</p>
          ) : (
            <span className="skeleton" style={{ display: "block", height: 28, width: "min(560px, 100%)", marginTop: 10 }} />
          )}
        </div>
        <button type="button" className="btn btn-ghost bs-explore" onClick={onExplore}><Icon name="brain" size={15} /> Explore</button>
      </header>

      <SearchBox tenantId={tenantId} onPick={onPick} />

      {sample && <p className="bs-note">Some of this is sample numbers, and says so wherever it shows up.</p>}

      {(decisions.length > 0 || headlines.length > 0 || graphLoading) && (
        <div className="bs-lists">
          {(decisions.length > 0 || graphLoading) && (
            <section className="bs-section" aria-labelledby="bs-dec">
              <h2 id="bs-dec" className="bs-section-title">Recent decisions</h2>
              {decisions.length === 0 ? <Rows loading /> : (
                <ul className="bs-rows">
                  {decisions.map((n) => (
                    <li key={n.id}>
                      <button type="button" className="bs-item" onClick={() => onPick(n.id)}>
                        <span className="bs-item-main">
                          <span className="bs-item-name">{tidyName(n.label, n.name)}</span>
                          {n.summary && <span className="bs-item-sub">{n.summary}</span>}
                        </span>
                        {n.asOf && <span className="bs-item-when">{whenWords(n.asOf)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {(headlines.length > 0 || graphLoading) && (
            <section className="bs-section" aria-labelledby="bs-top">
              <h2 id="bs-top" className="bs-section-title">What comes up most</h2>
              {headlines.length === 0 ? <Rows loading /> : (
                <ul className="bs-rows">
                  {headlines.map((n) => (
                    <li key={n.id}>
                      <button type="button" className="bs-item" onClick={() => onPick(n.id)}>
                        <span className="bs-item-main"><span className="bs-item-name">{n.name}</span></span>
                        <span className="bs-item-when">{kindName(n.label)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}

      <section className="bs-section" aria-labelledby="bs-groups">
        <h2 id="bs-groups" className="bs-section-title">Everything, by kind</h2>
        {!data ? <Rows loading /> : groups.length === 0 ? (
          <p className="empty">Nothing yet. Add your website and your team will start learning.</p>
        ) : (
          <div className="bs-groups">
            {groups.map(({ g, n }) => {
              const items = (nodes ?? []).filter((x) => g.labels.includes(x.label)).sort(byRank);
              return (
                <Reveal key={g.id} tone="row" label={<span className="bs-group-name"><span className="bn-dot" style={{ ["--hue" as string]: groupHue(g) }} aria-hidden="true" />{g.name}</span>} summary={fmtNum(n)} onToggle={(o) => o && onGroupOpen()}>
                  <p className="bs-group-blurb">{g.blurb}</p>
                  {items.length === 0 ? <Rows loading={graphLoading} /> : (
                    <ul className="bs-rows is-inset">
                      {items.slice(0, GROUP_ROWS).map((x) => (
                        <li key={x.id}>
                          <button type="button" className="bs-item" onClick={() => onPick(x.id)}>
                            <span className="bs-item-main"><span className="bs-item-name">{tidyName(x.label, x.name)}</span></span>
                            {g.labels.length > 1 && <span className="bs-item-when">{kindName(x.label)}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {n > GROUP_ROWS && items.length > 0 && (
                    <button type="button" className="btn btn-quiet btn-sm bs-more" onClick={onExplore}>See all {fmtNum(n)} in Explore</button>
                  )}
                </Reveal>
              );
            })}
          </div>
        )}
      </section>

      {sources.length > 0 && (
        <Reveal label="Show where this comes from" summary={`${sources.length} ${sources.length === 1 ? "source" : "sources"}`}>
          <ul className="bs-sources">
            {sources.map((s) => (
              <li key={s.source}>
                <span className="bs-source-name">{s.source}</span>
                <span className="bs-source-when">
                  {s.note === "simulated" ? "Sample numbers · " : ""}updated {whenWords(s.asOf)}
                  {s.status === "stale" ? " · a bit out of date" : s.status === "error" ? " · not reachable" : ""}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      )}
    </div>
  );
}

function Rows({ loading }: { loading?: boolean }) {
  if (!loading) return null;
  return <div className="bs-skel" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>;
}
