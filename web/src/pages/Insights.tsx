// Insights: what the team recommends, ranked, each with its money at stake in the business's own currency, the agent
// who proposed it, and the chain of evidence it rests on. Meera's morning brief and source freshness sit alongside.
import { useMemo, useState } from "react";
import type { NodeRef } from "@shared/contracts";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { AgentAvatar, SimBadge, agentDef, deptOf } from "../components/bits";
import { EvidenceChain } from "../components/EvidenceChain";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { fmtAgo, fmtDate, fmtMoney, fmtPct } from "../lib/format";
import { useApp, useAsync } from "../state/app";
import type { Approval, Freshness, Recommendation } from "../types-ext";
import "./insights.css";

const AREA: Record<Recommendation["area"], string> = {
  seo: "Search", content: "Content", funnel: "Sign-up funnel", ads: "Ads", knowledge: "Knowledge", tech: "Tech",
};

const PER: Record<string, string> = { week: "a week", month: "a month", year: "a year" };

function money(r: Recommendation) {
  if (!r.value) return null;
  const amount = fmtMoney(r.value.amount, r.value.currency);
  return { amount, per: r.value.per ? PER[r.value.per] : undefined, note: r.value.note };
}

export default function InsightsPage() {
  const { tenant } = useApp();
  const nav = useNavigate();
  const overview = useAsync(() => api.overview(tenant.id), [tenant.id]);
  const recs = useAsync(() => api.recommendations(tenant.id), [tenant.id]);
  const approvals = useAsync(() => api.approvals(tenant.id), [tenant.id]);
  const graph = useAsync(() => api.graphOverview(tenant.id), [tenant.id]);
  const [area, setArea] = useState<"all" | Recommendation["area"]>("all");

  // names for citation chips: the graph overview, plus every node a recommendation already carries
  const names = useMemo(() => {
    const m: Record<string, NodeRef> = {};
    for (const n of graph.data?.nodes ?? []) m[n.id] = n;
    for (const r of recs.data ?? []) for (const n of r.evidence) m[n.id] ??= n;
    return m;
  }, [graph.data, recs.data]);
  const byApproval = useMemo(() => new Map((approvals.data ?? []).map((a) => [a.id, a])), [approvals.data]);
  const sorted = useMemo(() => [...(recs.data ?? [])].sort((a, b) => b.score - a.score), [recs.data]);
  const areas = useMemo(() => [...new Set(sorted.map((r) => r.area))], [sorted]);
  const shown = area === "all" ? sorted : sorted.filter((r) => r.area === area);
  const waiting = sorted.filter((r) => r.approvalId && byApproval.get(r.approvalId)?.status === "pending").length;
  const weekly = sorted.filter((r) => r.value?.per === "week" && r.status !== "dismissed");
  const weeklySum = weekly.reduce((s, r) => s + (r.value?.amount ?? 0), 0);

  const openNode = (id: string) => nav(`/brain?node=${encodeURIComponent(id)}`);

  return (
    <div className="insights-page">
      <div className="insights-main">
        <header className="page-head">
          <div>
            <h1 className="page-title">What the team recommends</h1>
            <p className="page-lede">
              {sorted.length ? (
                <>
                  {sorted.length} recommendations for {tenant.name}, strongest first.
                  {waiting > 0 && <> {waiting} {waiting === 1 ? "is" : "are"} drafted and waiting on you.</>}
                  {weeklySum > 0 && <> Acting on the costed ones saves about <b className="num">{fmtMoney(weeklySum, weekly[0]?.value?.currency)}</b> a week.</>}
                </>
              ) : recs.loading ? "Reading the latest findings…" : `Nothing to recommend for ${tenant.name} yet.`}
            </p>
          </div>
          {areas.length > 1 && (
            <div className="seg insights-filter" role="group" aria-label="Filter by area">
              <button type="button" className={`seg-btn${area === "all" ? " is-on" : ""}`} aria-pressed={area === "all"} onClick={() => setArea("all")}>All</button>
              {areas.map((a) => (
                <button key={a} type="button" className={`seg-btn${area === a ? " is-on" : ""}`} aria-pressed={area === a} onClick={() => setArea(a)}>{AREA[a]}</button>
              ))}
            </div>
          )}
        </header>

        {recs.error && <p className="notice notice-bad" role="alert">Recommendations did not load: {recs.error}</p>}
        {recs.loading && !recs.data && (
          <div className="rec-list" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="skeleton rec-skel" />)}</div>
        )}

        <ol className="rec-list">
          {shown.map((r) => (
            <RecCard key={r.id} rec={r} rank={sorted.indexOf(r) + 1} approval={r.approvalId ? byApproval.get(r.approvalId) : undefined} onOpen={openNode} names={names} />
          ))}
        </ol>
      </div>

      <aside className="insights-aside" aria-label="Morning brief and sources">
        <section className="brief panel" aria-labelledby="brief-title">
          <div className="brief-head">
            <AgentAvatar id="chief-of-staff" size={34} />
            <div>
              <h2 id="brief-title" className="section-title">Morning brief</h2>
              <p className="small muted">From Meera, Chief of Staff · {fmtDate(new Date().toISOString())}</p>
            </div>
          </div>
          {overview.data ? (
            <Markdown className="brief-md" text={overview.data.brief} onCite={openNode} nodes={names} />
          ) : (
            <span className="skeleton" style={{ display: "block", height: 120 }} />
          )}
          {overview.data && overview.data.approvalsPending > 0 && (
            <Link className="btn btn-ghost btn-sm brief-cta" to="/approvals">
              <Icon name="approvals" size={15} /> {overview.data.approvalsPending} waiting for approval
            </Link>
          )}
        </section>

        {overview.data && overview.data.freshness.length > 0 && (
          <section className="sources" aria-labelledby="src-title">
            <h2 id="src-title" className="section-title">Sources the team reads</h2>
            <ul className="source-list">
              {overview.data.freshness.map((f) => <SourceRow key={f.source} f={f} />)}
            </ul>
            <p className="small muted">Every figure in an answer names its source and date. Simulated sources are marked wherever they appear.</p>
          </section>
        )}
      </aside>
    </div>
  );
}

function SourceRow({ f }: { f: Freshness }) {
  const sim = f.note === "simulated";
  return (
    <li className="source-row">
      <span className={`source-dot is-${f.status}`} aria-hidden="true" />
      <span className="source-name">{f.source}</span>
      {sim && <SimBadge />}
      <span className="source-asof num">{f.status === "error" ? "Not reachable" : `as of ${fmtDate(f.asOf)}`}</span>
    </li>
  );
}

function RecCard({ rec: r, rank, approval, onOpen, names }: { rec: Recommendation; rank: number; approval?: Approval; onOpen: (id: string) => void; names: Record<string, NodeRef> }) {
  const a = agentDef(r.by);
  const dept = deptOf(r.by);
  const m = money(r);
  const waiting = approval?.status === "pending";
  const decided = approval && approval.status !== "pending";
  const askQ = `${r.title}: what would it take, and what could go wrong?`;
  return (
    <li className={`rec${r.status === "dismissed" ? " is-dismissed" : ""}`} aria-labelledby={`rec-${rank}`}>
      <span className="rec-rank num" aria-label={`Priority ${rank}`}>{rank}</span>
      <div className="rec-body">
        <p className="rec-meta">
          <span className="rec-by">
            <AgentAvatar id={r.by} size={22} />
            <span><b>{a?.name ?? r.by}</b>, {a?.title}</span>
          </span>
          <span className="rec-area" style={{ ["--hue" as string]: dept?.hue ?? 265 }}>{AREA[r.area]}</span>
          <span className="muted">{fmtAgo(r.createdAt)}</span>
          {r.simulated && <SimBadge />}
        </p>
        <h2 id={`rec-${rank}`} className="rec-title">{r.title}</h2>
        <Markdown className="rec-why" text={r.why} onCite={onOpen} nodes={names} />
        <div className="rec-evidence">
          <span className="rec-evidence-head">The evidence, in order</span>
          <EvidenceChain nodes={r.evidence} edges={r.evidenceEdges} onOpen={onOpen} label={`Evidence for: ${r.title}`} />
        </div>
        <div className="rec-actions">
          {waiting ? (
            <Link className="btn btn-gold btn-sm" to={`/approvals#${encodeURIComponent(approval!.id)}`}>
              <Icon name="approvals" size={15} /> Review the draft
            </Link>
          ) : decided ? (
            <span className={`badge ${approval!.status === "rejected" ? "badge-ink" : "badge-ok"}`}>
              <Icon name={approval!.status === "rejected" ? "x" : "check"} size={13} />
              {approval!.status === "rejected" ? "You rejected the draft" : "Approved"}
            </span>
          ) : (
            <Link className="btn btn-ghost btn-sm" to={`/ask?q=${encodeURIComponent(askQ)}`}>
              <Icon name="ask" size={15} /> Ask {a?.name ?? "the team"} about it
            </Link>
          )}
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => onOpen(r.evidence[0]?.id ?? "")} disabled={!r.evidence.length}>
            <Icon name="brain" size={15} /> Open in the brain
          </button>
        </div>
      </div>
      <dl className="rec-figures">
        <div className="rec-fig">
          <dt>{m ? "At stake" : "Expected"}</dt>
          {m ? (
            <dd>
              <span className="rec-money num">{m.amount}</span>
              <span className="rec-per">{m.per ?? m.note}</span>
            </dd>
          ) : (
            <dd className="rec-impact">{r.impact}</dd>
          )}
        </div>
        {m && <p className="rec-impact-note">{r.impact}</p>}
        <div className="rec-fig">
          <dt>Confidence</dt>
          <dd className="rec-conf">
            <span className="meter" aria-hidden="true"><span style={{ width: `${Math.round(r.confidence * 100)}%` }} /></span>
            <span className="num">{fmtPct(r.confidence)}</span>
          </dd>
        </div>
      </dl>
    </li>
  );
}
