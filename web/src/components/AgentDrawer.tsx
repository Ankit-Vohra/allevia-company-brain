// An agent's profile: who they are, what they can do, what they know (their KNOWS_ABOUT subgraph) and what they did.
import { Suspense, lazy, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import type { AgentId } from "@shared/contracts";
import { AGENTS, DEPARTMENTS } from "@shared/roster";
import { api } from "../api";
import { useApp, useAsync } from "../state/app";
import type { RunView } from "../state/derive";
import { laneOf } from "../state/derive";
import { avatarUrl } from "../office/sprites";
import { fmtAgo, fmtDate } from "./bits";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const GraphView = lazy(() => import("./GraphView"));

const MODEL: Record<string, string> = { haiku: "Haiku · quick desk", sonnet: "Sonnet · deep work", opus: "Opus" };

export function AgentDrawer({ agentId, onClose, view }: { agentId: AgentId | null; onClose: () => void; view?: RunView }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { tenant, effectiveTheme, reducedMotion } = useApp();
  const agent = AGENTS.find((a) => a.id === agentId);
  const dept = DEPARTMENTS.find((d) => d.id === agent?.department);
  const { data, loading, error } = useAsync(() => (agentId ? api.agent(tenant.id, agentId) : Promise.resolve(undefined)), [agentId, tenant.id]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (agentId && !d.open) d.showModal();
    if (!agentId && d.open) d.close();
  }, [agentId]);

  const knowledge = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return { nodes: data.knowledge.nodes.map((n) => ({ ...n, rank: n.weight })), edges: data.knowledge.edges };
  }, [data]);
  const reviewers = AGENTS.filter((a) => a.reviews?.includes(agentId ?? ""));
  const lane = view && agentId ? laneOf(view, agentId) : undefined;

  return (
    <dialog
      ref={ref}
      className="drawer agent-drawer"
      aria-labelledby="agent-drawer-title"
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {agent && (
        <>
          <header className="drawer-head" style={{ ["--hue" as string]: dept?.hue ?? 265 }}>
            <div className="portrait" aria-hidden="true">
              <img src={avatarUrl(agent.id, 6)} width={84} height={84} alt="" />
            </div>
            <div className="drawer-id">
              <h2 id="agent-drawer-title" className="drawer-name">{agent.name}</h2>
              <p className="drawer-title">{agent.title}</p>
              <p className="drawer-dept"><span className="chip-dot" style={{ ["--dot" as string]: `oklch(62% 0.11 ${dept?.hue ?? 265})` }} />{dept?.name} · {MODEL[agent.model] ?? agent.model}</p>
            </div>
            <button type="button" className="btn btn-quiet btn-icon drawer-close" onClick={onClose} aria-label="Close profile"><Icon name="close" /></button>
          </header>

          <div className="drawer-body">
            {lane?.phase === "working" && (
              <div className="now-card">
                <span className="now-dot" aria-hidden="true" />
                <div><b>Working now</b><p>{lane.status ?? lane.task}</p></div>
              </div>
            )}
            <p className="persona">{agent.persona}</p>

            <section className="drawer-section" aria-labelledby="ad-handles">
              <h3 id="ad-handles" className="section-title">Comes to {agent.name} for</h3>
              <ul className="chips">{agent.handles.map((h) => <li key={h} className="chip">{h}</li>)}</ul>
            </section>

            <section className="drawer-section" aria-labelledby="ad-tools">
              <h3 id="ad-tools" className="section-title">Tools on the desk</h3>
              <ul className="chips">{agent.tools.map((t) => <li key={t} className="chip chip-mono">{t}</li>)}</ul>
              {(agent.reviews?.length || reviewers.length > 0) && (
                <p className="drawer-note">
                  {agent.reviews?.length ? <>Reviews {agent.reviews.map((r) => AGENTS.find((a) => a.id === r)?.name).join(", ")}. </> : null}
                  {reviewers.length ? <>Reviewed by {reviewers.map((r) => r.name).join(", ")}.</> : null}
                </p>
              )}
            </section>

            <section className="drawer-section" aria-labelledby="ad-know">
              <div className="drawer-section-head">
                <h3 id="ad-know" className="section-title">What {agent.name} knows</h3>
                {data && <span className="muted small">{data.knowledge.nodes.length - 1} entities · grows with every finding</span>}
              </div>
              <div className="knowledge-map">
                {loading && !data ? <div className="skeleton" style={{ height: "100%" }} /> : error ? <p className="empty">Couldn't load the knowledge map: {error}</p> : knowledge.nodes.length <= 1 ? (
                  <p className="empty">Nothing yet. {agent.name}'s map fills in as findings cite the graph.</p>
                ) : (
                  <Suspense fallback={<div className="skeleton" style={{ height: "100%" }} />}>
                    <GraphView
                      nodes={knowledge.nodes}
                      edges={knowledge.edges}
                      centerId={`agent:${agent.id}`}
                      dark={effectiveTheme === "dark"}
                      reducedMotion={reducedMotion}
                      height={230}
                      labels="auto"
                      fitPadding={28}
                      ariaLabel={`${agent.name}'s knowledge map: ${knowledge.nodes.length - 1} entities they know about.`}
                    />
                  </Suspense>
                )}
              </div>
              {data && (
                <ul className="know-list">
                  {[...data.knowledge.nodes].slice(1).sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, 5).map((n) => (
                    <li key={n.id}>
                      <Link to={`/brain?node=${encodeURIComponent(n.id)}`} onClick={onClose}>{n.name}</Link>
                      <span className="meter" aria-label={`weight ${Math.round((n.weight ?? 0) * 100)}%`}><span style={{ width: `${(n.weight ?? 0) * 100}%` }} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {data && (
              <section className="drawer-section" aria-labelledby="ad-stats">
                <h3 id="ad-stats" className="section-title">Record</h3>
                <dl className="stats">
                  <div><dt>Requests</dt><dd className="num">{data.stats.requests}</dd></div>
                  <div><dt>Findings</dt><dd className="num">{data.stats.findings}</dd></div>
                  <div><dt>Passed review</dt><dd className="num">{data.stats.checksTotal ? Math.round((data.stats.checksPassed / data.stats.checksTotal) * 100) : 100}%</dd></div>
                  <div><dt>{data.stats.reviewsGiven ? "Reviews given" : "Proposals"}</dt><dd className="num">{data.stats.reviewsGiven || data.stats.proposals}</dd></div>
                </dl>
                {data.stats.lastActiveAt && <p className="drawer-note">Last on a request {fmtAgo(data.stats.lastActiveAt)}.</p>}
              </section>
            )}

            {data && data.playbooks.length > 0 && (
              <section className="drawer-section" aria-labelledby="ad-play">
                <h3 id="ad-play" className="section-title">Playbooks</h3>
                <ul className="playbooks">
                  {data.playbooks.map((p) => <li key={p.id}><b>{p.name}</b><span>{p.source}</span></li>)}
                </ul>
              </section>
            )}

            <section className="drawer-section" aria-labelledby="ad-find">
              <h3 id="ad-find" className="section-title">Recent findings</h3>
              {data?.findings.length ? (
                <ul className="findings">
                  {data.findings.map((f) => (
                    <li key={`${f.turnId}-${f.id}`} className="finding-card">
                      <p className="finding-q">{f.question}<span> · {fmtDate(f.at)}</span></p>
                      <Markdown text={f.text} className="finding-md" />
                      {f.verdicts.length > 0 && (
                        <p className="finding-verdicts">
                          {f.verdicts.map((v, i) => (
                            <span key={i} className={`badge ${v.verdict === "ok" ? "badge-ok" : "badge-warn"}`}>
                              <Icon name={v.verdict === "ok" ? "check" : "warn"} size={12} />
                              {AGENTS.find((a) => a.id === v.by)?.name}
                            </span>
                          ))}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">{loading ? "Loading…" : `No findings yet for ${tenant.name}.`}</p>
              )}
            </section>
          </div>
        </>
      )}
    </dialog>
  );
}
