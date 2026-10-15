// What we noticed: the team's best ideas, strongest first. Each one says who suggests it, what it is, why, what is at
// stake and the one next step. The reasoning (the sources and the chain of facts) sits behind "Why we think this", the
// way Claude keeps its thinking one tap away. Today's note from Meera sits on top; where the numbers come from is at
// the bottom, and sample numbers are always said out loud (docs/owner-words.md).
import { useMemo, useState } from "react";
import type { NodeRef } from "@shared/contracts";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { AgentAvatar, agentDef } from "../components/bits";
import { EvidenceChain } from "../components/EvidenceChain";
import { Icon } from "../components/Icon";
import { firstSentence, likelihood, whenWords, withoutCites, withoutSim } from "../components/insights-words";
import { Markdown } from "../components/Markdown";
import { Reveal } from "../components/Reveal";
import { fmtMoney } from "../lib/format";
import { useApp, useAsync } from "../state/app";
import type { Approval, Freshness, Recommendation } from "../types-ext";
import "./insights.css";

const PER: Record<string, string> = { week: "a week", month: "a month", year: "a year" };
const TOP = 3;

function stake(r: Recommendation) {
  if (r.value) {
    return { label: "What's at stake", big: fmtMoney(r.value.amount, r.value.currency), small: r.value.per ? PER[r.value.per] : r.value.note };
  }
  return { label: "What you could gain", big: withoutSim(r.impact), small: undefined };
}

export default function InsightsPage() {
  const { tenant } = useApp();
  const nav = useNavigate();
  const overview = useAsync(() => api.overview(tenant.id), [tenant.id]);
  const recs = useAsync(() => api.recommendations(tenant.id), [tenant.id]);
  const approvals = useAsync(() => api.approvals(tenant.id), [tenant.id]);
  const graph = useAsync(() => api.graphOverview(tenant.id), [tenant.id]);
  const [all, setAll] = useState(false);

  // names for source chips: the graph overview, plus every node a recommendation already carries
  const names = useMemo(() => {
    const m: Record<string, NodeRef> = {};
    for (const n of graph.data?.nodes ?? []) m[n.id] = n;
    for (const r of recs.data ?? []) for (const n of r.evidence) m[n.id] ??= n;
    return m;
  }, [graph.data, recs.data]);
  const byApproval = useMemo(() => new Map((approvals.data ?? []).map((a) => [a.id, a])), [approvals.data]);
  const sorted = useMemo(() => [...(recs.data ?? [])].sort((a, b) => b.score - a.score), [recs.data]);
  const shown = all ? sorted : sorted.slice(0, TOP);
  const waiting = sorted.filter((r) => r.approvalId && byApproval.get(r.approvalId)?.status === "pending").length;
  const samples = (overview.data?.freshness ?? []).filter((f) => f.note === "simulated").map((f) => f.source);
  const hasSamples = samples.length > 0 || sorted.some((r) => r.simulated);

  const openNode = (id: string) => nav(`/brain?node=${encodeURIComponent(id)}`);

  return (
    <div className="insights-page">
      <header className="ins-head">
        <h1 className="page-title">What we noticed</h1>
        <p className="page-lede">
          {sorted.length ? (
            <>
              {sorted.length === 1 ? "One idea" : `${sorted.length} ideas`} for {tenant.name}, best first.
              {waiting > 0 && <> {waiting === 1 ? "One has a draft" : `${waiting} have a draft`} waiting for your OK.</>}
            </>
          ) : recs.loading ? "Looking at the latest numbers…" : `Nothing to suggest for ${tenant.name} yet.`}
        </p>
        {hasSamples && (
          <p className="sample-note">
            <span className="sample-dot" aria-hidden="true" />
            Includes sample numbers{samples.length ? ` (${samples.join(", ")})` : ""}. They are always marked.
          </p>
        )}
      </header>

      <TodayNote brief={overview.data?.brief} loading={overview.loading && !overview.data} pending={overview.data?.approvalsPending ?? 0} names={names} onOpen={openNode} />

      {recs.error && <p className="notice notice-bad" role="alert">Ideas did not load: {recs.error}</p>}
      {recs.loading && !recs.data && (
        <div className="ideas" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} className="skeleton idea-skel" />)}</div>
      )}

      {sorted.length > 0 && (
        <section aria-label="Ideas, best first">
          <ol className="ideas">
            {shown.map((r, i) => (
              <Idea key={r.id} rec={r} rank={i + 1} approval={r.approvalId ? byApproval.get(r.approvalId) : undefined} onOpen={openNode} names={names} tz={tenant.timeZone} locale={tenant.locale} />
            ))}
          </ol>
          {sorted.length > TOP && (
            <button type="button" className="ideas-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show only the top 3" : `See all ${sorted.length}`}
              <Icon name="chevron" size={16} className={all ? "is-up" : undefined} />
            </button>
          )}
        </section>
      )}

      {overview.data && overview.data.freshness.length > 0 && (
        <Reveal className="ins-sources" label="Where this comes from" summary={`${overview.data.freshness.length} sources`}>
          <ul className="source-list">
            {overview.data.freshness.map((f) => <SourceRow key={f.source} f={f} tz={tenant.timeZone} locale={tenant.locale} />)}
          </ul>
          <p className="small muted">Every number your team quotes names where it came from and how fresh it is.</p>
        </Reveal>
      )}
    </div>
  );
}

function TodayNote({ brief, loading, pending, names, onOpen }: { brief?: string; loading: boolean; pending: number; names: Record<string, NodeRef>; onOpen: (id: string) => void }) {
  if (!loading && !brief) return null;
  return (
    <section className="note" aria-labelledby="note-title">
      <div className="note-head">
        <AgentAvatar id="chief-of-staff" size={30} />
        <div>
          <h2 id="note-title" className="note-title">Today’s note</h2>
          <p className="small muted">From Meera, your chief of staff</p>
        </div>
      </div>
      {loading || !brief ? (
        <span className="skeleton" style={{ display: "block", height: 96 }} />
      ) : (
        <>
          <Markdown className="note-md" text={withoutCites(brief)} />
          <div className="note-foot">
            {pending > 0 && (
              <Link className="btn btn-ghost btn-sm" to="/approvals">
                <Icon name="approvals" size={15} /> {pending} waiting for your OK
              </Link>
            )}
            <Reveal label="How we know" summary="the sources">
              <Markdown className="note-md note-md-cited" text={brief} onCite={onOpen} nodes={names} />
            </Reveal>
          </div>
        </>
      )}
    </section>
  );
}

function SourceRow({ f, tz, locale }: { f: Freshness; tz?: string; locale?: string }) {
  const sim = f.note === "simulated";
  return (
    <li className="source-row">
      <span className={`source-dot is-${f.status}`} aria-hidden="true" />
      <span className="source-name">{f.source}</span>
      {sim && <span className="sample-tag">sample numbers</span>}
      <span className="source-asof">{f.status === "error" ? "Can’t reach it right now" : `updated ${whenWords(f.asOf, tz, locale)}`}</span>
    </li>
  );
}

function Idea({ rec: r, rank, approval, onOpen, names, tz, locale }: { rec: Recommendation; rank: number; approval?: Approval; onOpen: (id: string) => void; names: Record<string, NodeRef>; tz?: string; locale?: string }) {
  const a = agentDef(r.by);
  const s = stake(r);
  const waiting = approval?.status === "pending";
  const decided = approval && approval.status !== "pending";
  const askQ = `${withoutSim(r.title)}: what would it take, and what could go wrong?`;
  return (
    <li className={`idea${r.status === "dismissed" ? " is-dismissed" : ""}`} aria-labelledby={`idea-${rank}`}>
      <span className="idea-rank" aria-label={`Number ${rank}`}>{rank}</span>
      <div className="idea-body">
        <p className="idea-by">
          <AgentAvatar id={r.by} size={24} />
          <span><b>{a?.name ?? "Your team"}</b>{a ? `, ${a.title.toLowerCase()}` : ""} · {whenWords(r.createdAt, tz, locale)}</span>
        </p>
        <h2 id={`idea-${rank}`} className="idea-title">{withoutSim(r.title)}</h2>
        <p className="idea-why">{withoutCites(firstSentence(r.why))}</p>

        <p className="idea-stake">
          <span className="idea-stake-k">{s.label}</span>
          <span className="idea-stake-v">{s.big}</span>
          {s.small && <span className="idea-stake-s">{s.small}</span>}
          {r.simulated && <span className="sample-tag">sample numbers</span>}
        </p>

        <div className="idea-actions">
          {waiting ? (
            <Link className="btn btn-gold" to={`/approvals#${encodeURIComponent(approval!.id)}`}>
              Review the draft
            </Link>
          ) : decided ? (
            <span className={`idea-decided${approval!.status === "rejected" ? " is-no" : ""}`}>
              <Icon name={approval!.status === "rejected" ? "x" : "check"} size={14} />
              {approval!.status === "rejected" ? "You said no to the draft" : "You said OK"}
            </span>
          ) : (
            <Link className="btn btn-ghost" to={`/ask?q=${encodeURIComponent(askQ)}`}>
              Ask {a?.name ?? "your team"} about it
            </Link>
          )}
        </div>

        <Reveal className="idea-reveal" label="Why we think this" summary={`${likelihood(r.confidence)} · ${r.evidence.length} ${r.evidence.length === 1 ? "source" : "sources"}`}>
          <div className="idea-proof">
            <Markdown className="idea-proof-md" text={r.why} onCite={onOpen} nodes={names} />
            {r.evidence.length > 0 && (
              <>
                <p className="idea-proof-h">How the facts connect</p>
                <EvidenceChain nodes={r.evidence} edges={r.evidenceEdges} onOpen={onOpen} label={`How we know: ${withoutSim(r.title)}`} />
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => onOpen(r.evidence[0]?.id ?? "")}>
                  <Icon name="brain" size={15} /> Open in your company brain
                </button>
              </>
            )}
          </div>
        </Reveal>
      </div>
    </li>
  );
}
